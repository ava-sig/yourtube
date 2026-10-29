import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.YOURTUBE_DATA_DIR || path.join(root, 'data');
const mediaDirectory = path.join(dataDirectory, 'media');
const database = new DatabaseSync(path.join(dataDirectory, 'yourtube.sqlite'));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

database.exec(`CREATE TABLE IF NOT EXISTS video_duration_lookups (
  video_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
)`);

function offlineWorkRequested() {
  const mode = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'network_mode'").get()?.value;
  const target = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'offline_preparation_target'").get()?.value;
  return mode === 'offline' || target === 'offline';
}

if (offlineWorkRequested()) {
  console.log('Paused because Offline mode or Offline preparation is active; no duration lookups were started.');
  database.close();
  process.exit(0);
}

database.prepare("UPDATE video_duration_lookups SET status = 'pending', message = 'Backfill resumed.', updated_at = ? WHERE status = 'running'")
  .run(new Date().toISOString());

function formatSeconds(input) {
  const seconds = Number(input);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function normalizeDuration(input) {
  const value = String(input || '').replace(/\s+/g, ' ').trim();
  if (/^(live|upcoming)$/i.test(value)) return value.toUpperCase();
  const match = value.match(/(?:^|\s)(\d{1,3}:\d{2}(?::\d{2})?)(?=$|\s)/);
  if (!match) return '';
  const parts = match[1].split(':').map(Number);
  if (parts.at(-1) > 59 || (parts.length === 3 && parts[1] > 59)) return '';
  return match[1];
}

function setStatus(id, status, message = '') {
  database.prepare(`INSERT INTO video_duration_lookups (video_id, status, message, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET status = excluded.status, message = excluded.message, updated_at = excluded.updated_at`)
    .run(id, status, String(message).slice(0, 500), new Date().toISOString());
}

function saveDuration(id, duration) {
  if (!duration) return false;
  database.prepare("UPDATE videos SET duration = ? WHERE video_id = ? AND trim(duration) = ''").run(duration, id);
  return true;
}

function probeLocal(id) {
  return new Promise(resolve => {
    const child = spawn(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1',
      path.join(mediaDirectory, `${id}.webm`)
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(''); }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-100); });
    child.once('error', () => { clearTimeout(timeout); resolve(''); });
    child.once('close', code => { clearTimeout(timeout); resolve(code === 0 ? formatSeconds(output.trim()) : ''); });
  });
}

function lookupRemote(video) {
  return new Promise(resolve => {
    setStatus(video.id, 'running');
    const child = spawn(process.env.YT_DLP_PATH || 'yt-dlp', [
      '--ignore-config', '--no-cookies', '--no-playlist', '--no-color', '--no-warnings',
      '--skip-download', '--dump-single-json', video.url
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    let finished = false;
    const done = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      setStatus(video.id, 'unavailable', 'Metadata lookup timed out.');
      done({ blocked: false, duration: '' });
    }, 25_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.once('error', error => {
      setStatus(video.id, 'unavailable', error.code === 'ENOENT' ? 'yt-dlp is unavailable.' : error.message);
      done({ blocked: false, fatal: error.code === 'ENOENT', duration: '' });
    });
    child.once('close', code => {
      if (finished) return;
      let info;
      try { if (code === 0 && output.length <= 2_000_000) info = JSON.parse(output.trim()); } catch {}
      const duration = info
        ? formatSeconds(info.duration) || normalizeDuration(info.duration_string) ||
          (info.is_live || info.live_status === 'is_live' ? 'LIVE' :
            info.is_upcoming || info.live_status === 'is_upcoming' ? 'UPCOMING' : '')
        : '';
      saveDuration(video.id, duration);
      const blocked = /HTTP Error 429|too many requests|rate.?limit|sign in to confirm|confirm you(?:'|’)re not a bot|temporarily blocked/i.test(stderr);
      setStatus(video.id, duration ? 'ready' : blocked ? 'pending' : 'unavailable', duration ? '' : stderr.trim() || 'No duration metadata was returned.');
      done({ blocked, duration });
    });
  });
}

const normalizeExisting = database.prepare('UPDATE videos SET duration = ? WHERE video_id = ?');
for (const video of database.prepare(`SELECT video_id AS id, duration FROM videos WHERE trim(duration) <> ''`).all()) {
  const clean = normalizeDuration(video.duration);
  if (clean !== video.duration) normalizeExisting.run(clean, video.id);
}

const findNext = database.prepare(`SELECT v.video_id AS id, v.url, v.duration, p.duration AS progressDuration, l.status AS lookupStatus
  FROM videos v LEFT JOIN video_progress p ON p.video_id = v.video_id
  LEFT JOIN video_duration_lookups l ON l.video_id = v.video_id
  WHERE trim(v.duration) = '' AND (l.status IS NULL OR l.status IN ('pending', 'running'))
  ORDER BY v.last_seen DESC LIMIT 1`);
const mediaNames = new Set(await readdir(mediaDirectory).catch(() => []));
let completed = 0;
let filled = 0;
let blocked = false;
const initialTotal = database.prepare(`SELECT COUNT(*) AS count FROM videos v
  LEFT JOIN video_duration_lookups l ON l.video_id = v.video_id
  WHERE trim(v.duration) = '' AND (l.status IS NULL OR l.status IN ('pending', 'running'))`).get().count;
console.log(`Backfilling durations for ${initialTotal} existing videos; local files and saved playback lengths come first.`);

while (true) {
  if (offlineWorkRequested()) {
    console.log('Paused because Offline mode or Offline preparation was requested.');
    break;
  }
  const video = findNext.get();
  if (!video) break;
  const localDuration = mediaNames.has(`${video.id}.webm`) ? await probeLocal(video.id) : '';
  const duration = localDuration || formatSeconds(video.progressDuration);
  if (duration) {
    saveDuration(video.id, duration);
    setStatus(video.id, 'ready');
    filled += 1;
  } else {
    if (offlineWorkRequested()) {
      console.log('Paused remote duration lookups because Offline mode or preparation is active. Remaining rows stay pending.');
      break;
    }
    const result = await lookupRemote(video);
    if (result.duration) filled += 1;
    if (result.blocked || result.fatal) {
      blocked = true;
      completed += 1;
      console.log(`Paused at ${completed}/${initialTotal}; metadata lookups were blocked or yt-dlp is unavailable. The remaining rows are left pending.`);
      break;
    }
    await delay(3000);
  }
  completed += 1;
  if (completed % 10 === 0 || !findNext.get()) {
    console.log(`Duration backfill: ${completed}/${initialTotal} checked; ${filled} lengths filled.`);
  }
}

const remaining = database.prepare("SELECT COUNT(*) AS count FROM videos WHERE trim(duration) = ''").get().count;
console.log(`${filled} durations filled in this pass; ${remaining} video cards still have no duration${blocked ? ' (the queue is paused)' : ''}.`);
database.close();
