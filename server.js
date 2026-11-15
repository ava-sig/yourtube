import { createServer } from 'node:http';
import { constants as fsConstants, createReadStream, existsSync, readFileSync, unlinkSync, watch as watchFileSystem } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inferVideoTopic, normalizeTopicLabel } from './lib/topic-classifier.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const repositoryDataDirectory = path.resolve(root, 'data');
const dataDirectory = path.resolve(process.env.YOURTUBE_DATA_DIR || repositoryDataDirectory);
const dataDirectoryIsRepositoryDefault = dataDirectory === repositoryDataDirectory;
// Keep the committed starter immutable; native runtime writes go to an ignored sibling database.
const databasePath = path.join(dataDirectory, dataDirectoryIsRepositoryDefault ? 'yourtube.runtime.sqlite' : 'yourtube.sqlite');
const legacyOrStarterDatabasePath = path.join(dataDirectory, 'yourtube.sqlite');
const configuredMediaDirectory = String(process.env.YOURTUBE_MEDIA_DIR || '').trim();
const mediaDirectory = path.resolve(configuredMediaDirectory || path.join(dataDirectory, 'media'));
const shortsMediaDirectory = path.join(mediaDirectory, 'shorts');
const transcriptionAudioDirectory = path.join(dataDirectory, 'transcription-audio');
const keepTranscriptionAudio = /^(1|true|yes|on)$/i.test(String(process.env.YOURTUBE_KEEP_TRANSCRIPTION_AUDIO || 'off').trim());
const mediaDirectoryIsExternal = Boolean(configuredMediaDirectory);
const imageCacheDirectory = path.join(dataDirectory, 'images');
const mediaContentTypes = Object.freeze({ webm: 'video/webm', mp4: 'video/mp4' });
const backgroundCaptureStaleMs = 5 * 60_000;
const downloadRetryDelay = 10_000;
await mkdir(dataDirectory, { recursive: true });
if (!mediaDirectoryIsExternal) await mkdir(mediaDirectory, { recursive: true });
if (!mediaDirectoryIsExternal) await mkdir(shortsMediaDirectory, { recursive: true });
else {
  try {
    const mediaRoot = await stat(mediaDirectory);
    if (mediaRoot.isDirectory()) await mkdir(shortsMediaDirectory, { recursive: true });
  } catch {}
}
await mkdir(imageCacheDirectory, { recursive: true });
if (keepTranscriptionAudio) await mkdir(transcriptionAudioDirectory, { recursive: true });
if (databasePath !== legacyOrStarterDatabasePath && !existsSync(databasePath) && existsSync(legacyOrStarterDatabasePath)) {
  // Checkpoint legacy WAL changes before making a one-time copy into the runtime database.
  const legacyDatabase = new DatabaseSync(legacyOrStarterDatabasePath);
  legacyDatabase.exec('PRAGMA busy_timeout = 5000;');
  let checkpoint;
  try {
    checkpoint = legacyDatabase.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } finally {
    legacyDatabase.close();
  }
  if (checkpoint?.busy) {
    throw new Error('The existing YourTube database is still in use. Stop the older YourTube server, then restart so the database can be copied safely.');
  }
  try {
    await copyFile(legacyOrStarterDatabasePath, databasePath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
const favicon = await readFile(path.join(root, 'public', 'favicon.ico'));
const vueRuntime = await readFile(path.join(root, 'public', 'vendor', 'vue.global.prod.js'));
const imagePlaceholder = await readFile(path.join(root, 'public', 'image-placeholder.svg'));
const database = new DatabaseSync(databasePath);
database.exec('PRAGMA busy_timeout = 5000;');
const port = Number(process.env.PORT || 4173);
const hostArgument = process.argv.slice(2).find(argument => argument.startsWith('--host='))?.slice('--host='.length);
const hostIndex = process.argv.indexOf('--host');
const host = hostArgument || (hostIndex >= 0 ? process.argv[hostIndex + 1] : '') || process.env.HOST || '127.0.0.1';
const jobs = new Map();
const downloadStartingIds = new Set();
const downloadedMediaFileSizeCache = new Map();
const downloadedMediaFileSizeCacheTtlMs = 30_000;
const commentJobs = new Map();
const channelLookups = new Map();
let shortsApiCache = null;
let shortsApiCacheExpiresAt = 0;
let downloadedMetadataWorkerRunning = false;
const ffmpegAvailable = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const ffprobeAvailable = spawnSync(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

function readDockerGatewayAddresses() {
  if (!existsSync('/.dockerenv')) return new Set();
  try {
    return new Set(readFileSync('/proc/net/route', 'utf8').split(/\r?\n/).slice(1).flatMap(line => {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[1] !== '00000000' || !(Number.parseInt(fields[3], 16) & 0x2)) return [];
      const value = Number.parseInt(fields[2], 16) >>> 0;
      return [[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff].join('.')];
    }));
  } catch { return new Set(); }
}
const dockerGatewayAddresses = readDockerGatewayAddresses();

function getStoredMediaPath(id, knownKind = '') {
  const kind = knownKind || database.prepare('SELECT kind FROM videos WHERE video_id = ?').get(id)?.kind;
  const directories = kind === 'short' ? [shortsMediaDirectory, mediaDirectory] : [mediaDirectory, shortsMediaDirectory];
  for (const directory of directories) {
    for (const extension of Object.keys(mediaContentTypes)) {
      const candidate = path.join(directory, `${id}.${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function getVideoMediaDirectory(id) {
  return database.prepare("SELECT 1 FROM videos WHERE video_id = ? AND kind = 'short'").get(id)
    ? shortsMediaDirectory
    : mediaDirectory;
}

async function ensureVideoMediaDirectory(id) {
  if (mediaDirectoryIsExternal) {
    const rootInfo = await stat(mediaDirectory);
    if (!rootInfo.isDirectory()) throw new Error('The configured media path is not a folder.');
  }
  const directory = getVideoMediaDirectory(id);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function migrateLegacyShortsMedia() {
  try {
    const rootInfo = await stat(mediaDirectory);
    if (!rootInfo.isDirectory()) return;
    await mkdir(shortsMediaDirectory, { recursive: true });
  } catch { return; }
  const ids = database.prepare("SELECT video_id AS id FROM videos WHERE kind = 'short'").all();
  for (const { id } of ids) {
    for (const extension of Object.keys(mediaContentTypes)) {
      const source = path.join(mediaDirectory, `${id}.${extension}`);
      const target = path.join(shortsMediaDirectory, `${id}.${extension}`);
      if (!existsSync(source) || existsSync(target)) continue;
      try { await rename(source, target); }
      catch (error) { console.warn(`[media-folder] Could not move legacy Short ${id} into shorts/:`, error.message || error); }
    }
  }
}

function getStoredMediaExtension(id) {
  const storedPath = getStoredMediaPath(id);
  return storedPath ? path.extname(storedPath).slice(1).toLowerCase() : '';
}

const integrityVerificationJobs = new Map();
const integrityCheckProcesses = new Set();
let integrityVerificationTail = Promise.resolve();

function integrityPauseError() {
  return Object.assign(new Error('The local integrity check was paused.'), { code: 'INTEGRITY_PAUSED' });
}

function throwIfIntegrityPaused(downloadJob) {
  if (downloadJob?.pauseRequested) throw integrityPauseError();
}

function trackIntegrityProcess(child, downloadJob = null) {
  integrityCheckProcesses.add(child);
  if (downloadJob) {
    downloadJob.integrityProcesses ||= new Set();
    downloadJob.integrityProcesses.add(child);
  }
}

function untrackIntegrityProcess(child, downloadJob = null) {
  integrityCheckProcesses.delete(child);
  downloadJob?.integrityProcesses?.delete(child);
}

function pauseIntegrityJob(downloadJob) {
  if (!downloadJob || downloadJob.pauseRequested) return false;
  downloadJob.pauseRequested = true;
  downloadJob.stage = 'Pausing integrity check…';
  for (const stream of downloadJob.integrityStreams || []) {
    stream.destroy(integrityPauseError());
  }
  for (const child of downloadJob.integrityProcesses || []) {
    try { child.kill('SIGINT'); } catch {}
  }
  return true;
}

async function checksumMediaFile(filePath, onProgress = null, totalBytes = 0, downloadJob = null) {
  throwIfIntegrityPaused(downloadJob);
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  let bytesRead = 0;
  return new Promise((resolve, reject) => {
    if (downloadJob) {
      downloadJob.integrityStreams ||= new Set();
      downloadJob.integrityStreams.add(stream);
    }
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      downloadJob?.integrityStreams?.delete(stream);
      if (error) reject(error);
      else resolve(result);
    };
    stream.on('data', chunk => {
      if (downloadJob?.pauseRequested) {
        stream.destroy(integrityPauseError());
        return;
      }
      hash.update(chunk);
      bytesRead += chunk.length;
      onProgress?.(bytesRead, totalBytes);
    });
    stream.once('error', error => finish(error));
    stream.once('end', () => finish(null, hash.digest('hex')));
  });
}

function transcriptionAudioPath(id) {
  return path.join(transcriptionAudioDirectory, `${id}.flac`);
}

function saveTranscriptionAsset(id, {
  status,
  audioPath = '',
  audioFormat = '',
  sampleRate = 0,
  channels = 0,
  audioSize = 0,
  audioChecksum = '',
  sourceChecksum = '',
  error = ''
}) {
  const now = new Date().toISOString();
  const relativePath = audioPath ? path.relative(dataDirectory, audioPath) : '';
  database.prepare(`INSERT INTO transcription_assets (
      video_id, status, audio_relative_path, audio_format, audio_sample_rate, audio_channels,
      audio_size, audio_checksum, source_checksum, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      status = excluded.status, audio_relative_path = excluded.audio_relative_path,
      audio_format = excluded.audio_format, audio_sample_rate = excluded.audio_sample_rate,
      audio_channels = excluded.audio_channels, audio_size = excluded.audio_size,
      audio_checksum = excluded.audio_checksum,
      transcript_text = CASE WHEN transcription_assets.source_checksum <> excluded.source_checksum AND excluded.source_checksum <> '' THEN '' ELSE transcription_assets.transcript_text END,
      transcript_segments_json = CASE WHEN transcription_assets.source_checksum <> excluded.source_checksum AND excluded.source_checksum <> '' THEN '[]' ELSE transcription_assets.transcript_segments_json END,
      transcription_model = CASE WHEN transcription_assets.source_checksum <> excluded.source_checksum AND excluded.source_checksum <> '' THEN '' ELSE transcription_assets.transcription_model END,
      language = CASE WHEN transcription_assets.source_checksum <> excluded.source_checksum AND excluded.source_checksum <> '' THEN '' ELSE transcription_assets.language END,
      transcribed_at = CASE WHEN transcription_assets.source_checksum <> excluded.source_checksum AND excluded.source_checksum <> '' THEN '' ELSE transcription_assets.transcribed_at END,
      source_checksum = excluded.source_checksum, error = excluded.error, updated_at = excluded.updated_at
  `).run(id, status, relativePath, audioFormat, sampleRate, channels, audioSize, audioChecksum, sourceChecksum, error, now, now);
}

async function hasReusableTranscriptionAudio(id, sourceChecksum) {
  const row = database.prepare(`SELECT status, audio_relative_path AS audioPath, source_checksum AS sourceChecksum
    FROM transcription_assets WHERE video_id = ?`).get(id);
  if (!row || !sourceChecksum || row.sourceChecksum !== sourceChecksum || !row.audioPath) return false;
  try { await access(path.resolve(dataDirectory, row.audioPath)); return true; } catch { return false; }
}

function runFfprobeHasAudio(filePath, downloadJob = null) {
  try { throwIfIntegrityPaused(downloadJob); } catch (error) { return Promise.reject(error); }
  if (!ffprobeAvailable) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    trackIntegrityProcess(child, downloadJob);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      untrackIntegrityProcess(child, downloadJob);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(Object.assign(new Error('Audio stream discovery timed out.'), { code: 'AUDIO_PROBE_TIMEOUT' }));
    }, 30_000);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-4000); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.once('error', error => finish(error));
    child.once('close', code => downloadJob?.pauseRequested
      ? finish(integrityPauseError())
      : code === 0
        ? finish(null, Boolean(stdout.trim()))
        : finish(Object.assign(new Error(stderr.trim() || 'Audio stream discovery failed.'), { code: 'AUDIO_PROBE_FAILED' })));
  });
}

function runFfmpegAudioExtract(filePath, outputPath, timeoutMs, onProgress = null, durationSeconds = 0, downloadJob = null) {
  try { throwIfIntegrityPaused(downloadJob); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-nostdin', '-v', 'error', '-stats_period', '0.5', '-progress', 'pipe:1', '-xerror', '-err_detect', 'explode',
      '-threads', '1', '-filter_threads', '1', '-i', filePath,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-compression_level', '5', outputPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    trackIntegrityProcess(child, downloadJob);
    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      untrackIntegrityProcess(child, downloadJob);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(Object.assign(new Error('Audio preparation exceeded its time limit.'), { code: 'AUDIO_EXTRACTION_TIMEOUT' }));
    }, timeoutMs);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const lines = (stdoutBuffer + chunk).split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      let elapsedSeconds = null;
      for (const line of lines) {
        const [key, rawValue] = line.split('=', 2);
        const value = String(rawValue || '').trim();
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const microseconds = Number(value);
          if (Number.isFinite(microseconds)) elapsedSeconds = microseconds / 1_000_000;
        } else if (key === 'progress' && value === 'end') onProgress?.(100);
      }
      if (elapsedSeconds !== null && durationSeconds > 0) onProgress?.(Math.max(0, Math.min(100, elapsedSeconds / durationSeconds * 100)));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once('error', error => finish(Object.assign(new Error(error.code === 'ENOENT'
      ? 'ffmpeg is unavailable to prepare local transcription audio.'
      : 'Could not start audio preparation.'), { code: 'AUDIO_EXTRACTION_FAILED', cause: error })));
    child.once('close', code => downloadJob?.pauseRequested
      ? finish(integrityPauseError())
      : code === 0
        ? finish(null, { status: 'awaiting_transcription' })
        : finish(Object.assign(new Error(stderr.trim() || 'ffmpeg could not prepare audio for transcription.'), { code: 'AUDIO_EXTRACTION_FAILED' })));
  });
}

function hasSavedIntegrityChecksum(id) {
  const integrity = database.prepare(`SELECT integrity_status AS status, integrity_checksum AS checksum
    FROM downloads WHERE video_id = ?`).get(id);
  return ['verified', 'container-checked'].includes(integrity?.status) && /^[a-f0-9]{64}$/i.test(String(integrity?.checksum || ''));
}

for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  process.once(signal, () => {
    for (const child of integrityCheckProcesses) {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(exitCode);
  });
}
process.once('exit', () => {
  for (const child of integrityCheckProcesses) {
    try { child.kill('SIGKILL'); } catch {}
  }
});

function runFfmpegIntegrityDecode(filePath, timeoutMs, { durationSeconds = 0, onProgress = null, audioOutputPath = '', downloadJob = null } = {}) {
  try { throwIfIntegrityPaused(downloadJob); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-v', 'error', '-stats_period', '0.5', '-progress', 'pipe:1', '-xerror', '-err_detect', 'explode',
      '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
      '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-f', 'null', '-'
    ];
    if (audioOutputPath) args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-compression_level', '5', audioOutputPath);
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
      ...args
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    trackIntegrityProcess(child, downloadJob);
    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      untrackIntegrityProcess(child, downloadJob);
      if (error && audioOutputPath) { try { unlinkSync(audioOutputPath); } catch {} }
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(Object.assign(new Error('The full media decode check exceeded its time limit.'), { code: 'INTEGRITY_TIMEOUT' }));
    }, timeoutMs);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const lines = (stdoutBuffer + chunk).split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      let elapsedSeconds = null;
      for (const line of lines) {
        const [key, rawValue] = line.split('=', 2);
        const value = String(rawValue || '').trim();
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const microseconds = Number(value);
          if (Number.isFinite(microseconds)) elapsedSeconds = microseconds / 1_000_000;
        } else if (key === 'out_time' && /^\d+:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
          const [hours, minutes, seconds] = value.split(':').map(Number);
          elapsedSeconds = hours * 3600 + minutes * 60 + seconds;
        } else if (key === 'progress' && value === 'end') {
          onProgress?.(100);
        }
      }
      if (elapsedSeconds !== null && durationSeconds > 0) {
        onProgress?.(Math.max(0, Math.min(100, elapsedSeconds / durationSeconds * 100)));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-6000); });
    child.once('error', error => {
      untrackIntegrityProcess(child, downloadJob);
      finish(Object.assign(new Error(error.code === 'ENOENT'
        ? 'ffmpeg is unavailable for the full audio/video integrity check.'
        : 'Could not start the full audio/video integrity check.'), { code: 'INTEGRITY_TOOL_MISSING', cause: error }));
    });
    child.once('close', code => {
      untrackIntegrityProcess(child, downloadJob);
      if (downloadJob?.pauseRequested) { finish(integrityPauseError()); return; }
      if (code === 0) { finish(null, { status: 'verified', detail: '' }); return; }
      const detail = stderr.trim().replace(/https?:\/\/\S+/g, '[URL]').slice(-900);
      finish(Object.assign(new Error(`The local file failed its full audio/video decode check${detail ? `: ${detail}` : '.'}`), { code: 'MEDIA_INTEGRITY' }));
    });
  });
}

function runFfprobeContainerCheck(filePath, downloadJob = null) {
  try { throwIfIntegrityPaused(downloadJob); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    trackIntegrityProcess(child, downloadJob);
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('The media container check timed out.'), { code: 'INTEGRITY_TIMEOUT' }));
    }, 30_000);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-20_000); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once('error', error => {
      clearTimeout(timeout);
      untrackIntegrityProcess(child, downloadJob);
      reject(Object.assign(new Error(error.code === 'ENOENT'
        ? 'Neither ffmpeg nor ffprobe is available to check this local media file.'
        : 'Could not start the media container check.'), { code: 'INTEGRITY_TOOL_MISSING', cause: error }));
    });
    child.once('close', code => {
      clearTimeout(timeout);
      untrackIntegrityProcess(child, downloadJob);
      if (downloadJob?.pauseRequested) { reject(integrityPauseError()); return; }
      if (code !== 0) {
        reject(Object.assign(new Error(`The local file failed its media container check${stderr.trim() ? `: ${stderr.trim().slice(-700)}` : '.'}`), { code: 'MEDIA_INTEGRITY' }));
        return;
      }
      try {
        const metadata = JSON.parse(stdout);
        const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
        if (!streams.some(stream => stream.codec_type === 'video')) throw new Error('No video stream was found.');
        resolve({ status: 'container-checked', detail: 'ffmpeg is unavailable; only the container and video stream could be checked.' });
      } catch (error) {
        reject(Object.assign(new Error(`The local file failed its media container check: ${error.message || 'No video stream was found.'}`), { code: 'MEDIA_INTEGRITY' }));
      }
    });
  });
}

function makeTranscriptionAudioTempPath(id) {
  return path.join(transcriptionAudioDirectory, `.${id}.${randomUUID()}.tmp.flac`);
}

async function commitTranscriptionAudio(id, tempPath, sourceChecksum, downloadJob = null) {
  const audioPath = transcriptionAudioPath(id);
  const audioStat = await stat(tempPath);
  if (audioStat.size <= 0) throw Object.assign(new Error('ffmpeg produced an empty transcription audio file.'), { code: 'AUDIO_EXTRACTION_FAILED' });
  const audioChecksum = await checksumMediaFile(tempPath, (read, total) => {
    if (downloadJob) {
      downloadJob.integrityPhase = 'Saving transcription audio checksum…';
      downloadJob.integrityProgress = total > 0 ? 85 + read / total * 15 : null;
    }
  }, audioStat.size, downloadJob);
  await rename(tempPath, audioPath);
  try {
    saveTranscriptionAsset(id, {
      status: 'awaiting_transcription', audioPath, audioFormat: 'flac', sampleRate: 16000,
      channels: 1, audioSize: audioStat.size, audioChecksum, sourceChecksum
    });
  } catch (error) {
    await unlink(audioPath).catch(() => {});
    throw error;
  }
  return { audioPath, audioSize: audioStat.size, audioChecksum };
}

async function recordTranscriptionAudioIssue(id, status, sourceChecksum, error = '') {
  try {
    const prior = database.prepare('SELECT source_checksum AS sourceChecksum FROM transcription_assets WHERE video_id = ?').get(id);
    if (prior?.sourceChecksum && prior.sourceChecksum !== sourceChecksum) {
      await unlink(transcriptionAudioPath(id)).catch(() => {});
    }
    saveTranscriptionAsset(id, { status, sourceChecksum, error: String(error || '').slice(0, 1200) });
  } catch (databaseError) {
    console.error(`[transcription-audio] Could not record ${status} for ${id}:`, databaseError.message || databaseError);
  }
}

async function ensureTranscriptionAudio(id, filePath, sourceChecksum, timeoutMs, durationSeconds, downloadJob = null) {
  if (!keepTranscriptionAudio) return;
  const existing = database.prepare(`SELECT status, source_checksum AS sourceChecksum FROM transcription_assets WHERE video_id = ?`).get(id);
  if (existing?.sourceChecksum === sourceChecksum && existing.status === 'no_audio_track') return;
  if (await hasReusableTranscriptionAudio(id, sourceChecksum)) return;
  let hasAudio = null;
  try { hasAudio = await runFfprobeHasAudio(filePath, downloadJob); }
  catch (error) { if (error.code === 'INTEGRITY_PAUSED') throw error; }
  if (hasAudio === false) {
    await recordTranscriptionAudioIssue(id, 'no_audio_track', sourceChecksum, 'This media file has no audio stream to transcribe.');
    return;
  }
  if (!ffmpegAvailable) {
    await recordTranscriptionAudioIssue(id, 'audio_extraction_failed', sourceChecksum, 'ffmpeg is unavailable to prepare the transcription audio file.');
    return;
  }
  const tempPath = makeTranscriptionAudioTempPath(id);
  try {
    if (downloadJob) {
      downloadJob.integrityPhase = 'Preparing audio for transcription…';
      downloadJob.integrityProgress = 0;
    }
    await runFfmpegAudioExtract(filePath, tempPath, timeoutMs, progress => {
      if (downloadJob) downloadJob.integrityProgress = Number.isFinite(progress) ? progress * 0.75 : null;
    }, durationSeconds, downloadJob);
    await commitTranscriptionAudio(id, tempPath, sourceChecksum, downloadJob);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    if (error.code === 'INTEGRITY_PAUSED') throw error;
    const noAudio = /matches no streams|does not contain any stream|map .* matches no streams/i.test(String(error.message || ''));
    await recordTranscriptionAudioIssue(id, noAudio ? 'no_audio_track' : 'audio_extraction_failed', sourceChecksum,
      noAudio ? 'This media file has no audio stream to transcribe.' : error.message || 'Audio extraction failed.');
  }
}

async function verifyLocalMediaIntegrityOnce(id, { downloadJob = null } = {}) {
  const filePath = getStoredMediaPath(id);
  if (!filePath) throw Object.assign(new Error('The local media file is missing.'), { code: 'MEDIA_MISSING' });
  const before = await stat(filePath);
  if (before.size <= 0) throw Object.assign(new Error('The local media file is empty.'), { code: 'MEDIA_INTEGRITY' });
  const now = new Date().toISOString();
  database.prepare(`INSERT OR IGNORE INTO downloads (video_id, status, message, progress, stage, updated_at, origin)
    VALUES (?, 'importing', 'Checking a local media file before saving it to the library.', 0, 'Checking file integrity', ?, 'media-folder')`).run(id, now);
  const previous = database.prepare(`SELECT integrity_status AS integrityStatus,
    integrity_checked_at AS checkedAt, integrity_checksum AS checksum
    FROM downloads WHERE video_id = ?`).get(id);
  const priorCheckValid = ['verified', 'container-checked'].includes(previous?.integrityStatus);
  if (downloadJob) {
    downloadJob.integrityChecking = true;
    downloadJob.integrityProgress = null;
    downloadJob.integrityPhase = 'Preparing local integrity check…';
    downloadJob.stage = keepTranscriptionAudio
      ? 'Verifying media and preparing transcription audio…'
      : 'Verifying media integrity…';
    saveDownload(id, downloadJob.mediaFolderImport ? 'importing' : 'downloading', '', downloadJob.progress, downloadJob.stage);
  }
  const reportIntegrityProgress = (progress, phase) => {
    if (!downloadJob) return;
    downloadJob.integrityPhase = phase;
    downloadJob.integrityProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;
  };

  if (priorCheckValid) {
    throwIfIntegrityPaused(downloadJob);
    reportIntegrityProgress(0, 'Rechecking saved SHA-256 checksum…');
    const checksum = await checksumMediaFile(filePath, (read, total) => {
      reportIntegrityProgress(total > 0 ? read / total * 100 : null, 'Rechecking saved SHA-256 checksum…');
    }, before.size, downloadJob);
    throwIfIntegrityPaused(downloadJob);
    const afterChecksum = await stat(filePath);
    if (!sameMediaFileVersion(before, afterChecksum)) {
      throw Object.assign(new Error('The local media file changed while its checksum was being checked.'), { code: 'MEDIA_INTEGRITY' });
    }
    const sameSavedContent = previous.checksum
      ? previous.checksum === checksum
      : false;
    if (sameSavedContent) {
      database.prepare(`UPDATE downloads SET integrity_checksum = ?, integrity_file_size = ?, integrity_file_mtime_ms = ?
        WHERE video_id = ?`).run(checksum, afterChecksum.size, afterChecksum.mtimeMs, id);
      await ensureTranscriptionAudio(id, filePath, checksum,
        Math.min(2 * 60 * 60_000, Math.max(10 * 60_000, before.size / (1024 * 1024) * 1000)),
        durationLabelSeconds(database.prepare('SELECT duration FROM videos WHERE video_id = ?').get(id)?.duration), downloadJob);
      const afterAssets = await stat(filePath).catch(() => null);
      if (!sameMediaFileVersion(before, afterAssets)) {
        throw Object.assign(new Error('The local media file changed while its saved checksum was being confirmed.'), { code: 'MEDIA_CHANGED' });
      }
      return {
        status: previous.integrityStatus,
        detail: 'SHA-256 matches the previously integrity-checked media file.',
        checkedAt: previous.checkedAt || '', filePath, checksum, cached: true
      };
    }
  }

  const timeoutMs = Math.min(2 * 60 * 60_000, Math.max(10 * 60_000, before.size / (1024 * 1024) * 1000));
  const videoDurationSeconds = durationLabelSeconds(database.prepare('SELECT duration FROM videos WHERE video_id = ?').get(id)?.duration);
  let audioTrackPresent = null;
  try { audioTrackPresent = await runFfprobeHasAudio(filePath, downloadJob); }
  catch (error) { if (error.code === 'INTEGRITY_PAUSED') throw error; }
  throwIfIntegrityPaused(downloadJob);
  let tempAudioPath = '';
  let audioExtractionError = '';
  const decodeProgress = progress => reportIntegrityProgress(videoDurationSeconds > 0 ? progress * 0.75 : null,
    keepTranscriptionAudio ? 'Decoding media and preparing transcription audio…' : 'Decoding media for integrity check…');
  let result;
  if (ffmpegAvailable) {
    if (keepTranscriptionAudio && audioTrackPresent !== false) {
      tempAudioPath = makeTranscriptionAudioTempPath(id);
      try {
        result = await runFfmpegIntegrityDecode(filePath, timeoutMs, {
          durationSeconds: videoDurationSeconds, onProgress: decodeProgress, audioOutputPath: tempAudioPath, downloadJob
        });
      } catch (extractionError) {
        if (extractionError.code === 'INTEGRITY_PAUSED') throw extractionError;
        tempAudioPath = '';
        try {
          result = await runFfmpegIntegrityDecode(filePath, timeoutMs, { durationSeconds: videoDurationSeconds, onProgress: decodeProgress, downloadJob });
          const message = String(extractionError.message || '');
          if (!/matches no streams|does not contain any stream|map .* matches no streams/i.test(message)) audioExtractionError = message;
          else audioTrackPresent = false;
        } catch (decodeError) {
          throw decodeError;
        }
      }
    } else {
      result = await runFfmpegIntegrityDecode(filePath, timeoutMs, { durationSeconds: videoDurationSeconds, onProgress: decodeProgress, downloadJob });
    }
  } else if (ffprobeAvailable) {
      result = await runFfprobeContainerCheck(filePath, downloadJob);
    if (keepTranscriptionAudio && audioTrackPresent !== false) audioExtractionError = 'ffmpeg is unavailable to prepare the transcription audio file.';
  } else {
    throw Object.assign(new Error('Install ffmpeg (or ffprobe) and restart YourTube before this media can be checked and played.'), { code: 'INTEGRITY_TOOL_MISSING' });
  }
  const afterDecode = await stat(filePath).catch(() => null);
  if (!sameMediaFileVersion(before, afterDecode)) {
    if (tempAudioPath) await unlink(tempAudioPath).catch(() => {});
    throw Object.assign(new Error('The local media file changed during integrity decoding. It will be checked again after the copy or download settles.'), { code: 'MEDIA_CHANGED' });
  }
  const sourceHashStart = 75;
  const sourceHashEnd = tempAudioPath ? 85 : 100;
  throwIfIntegrityPaused(downloadJob);
  reportIntegrityProgress(sourceHashStart, 'Saving media SHA-256 checksum…');
  let checksum;
  let after;
  try {
    checksum = await checksumMediaFile(filePath, (read, total) => {
      reportIntegrityProgress(total > 0 ? sourceHashStart + read / total * (sourceHashEnd - sourceHashStart) : null, 'Saving media SHA-256 checksum…');
    }, before.size, downloadJob);
    throwIfIntegrityPaused(downloadJob);
    after = await stat(filePath);
    if (!sameMediaFileVersion(before, after)) {
      throw Object.assign(new Error('The local media file changed while it was being checked.'), { code: 'MEDIA_INTEGRITY' });
    }
  } catch (error) {
    if (tempAudioPath) await unlink(tempAudioPath).catch(() => {});
    throw error;
  }
  const checkedAt = new Date().toISOString();
  try {
    database.prepare(`UPDATE downloads SET integrity_status = ?, integrity_checked_at = ?,
      integrity_file_size = ?, integrity_file_mtime_ms = ?, integrity_checksum = ? WHERE video_id = ?`)
      .run(result.status, checkedAt, after.size, after.mtimeMs, checksum, id);
  } catch (error) {
    if (tempAudioPath) await unlink(tempAudioPath).catch(() => {});
    throw error;
  }
  if (tempAudioPath) {
    try {
      await commitTranscriptionAudio(id, tempAudioPath, checksum, downloadJob);
      tempAudioPath = '';
    } catch (error) {
      await unlink(tempAudioPath).catch(() => {});
      tempAudioPath = '';
      audioExtractionError = error.message || 'Audio extraction failed.';
    }
  }
  if (keepTranscriptionAudio && audioTrackPresent === false) {
    await recordTranscriptionAudioIssue(id, 'no_audio_track', checksum, 'This media file has no audio stream to transcribe.');
  } else if (keepTranscriptionAudio && audioExtractionError) {
    await recordTranscriptionAudioIssue(id, 'audio_extraction_failed', checksum, audioExtractionError);
  }
  return { ...result, checkedAt, filePath, checksum, cached: false };
}

function verifyLocalMediaIntegrity(id, options = {}) {
  const active = integrityVerificationJobs.get(id);
  if (active) return active;
  const { downloadJob = null } = options;
  if (downloadJob) {
    downloadJob.integrityQueued = integrityVerificationJobs.size > 0;
    downloadJob.integrityChecking = false;
  }
  const verification = integrityVerificationTail.catch(() => {}).then(async () => {
    throwIfIntegrityPaused(downloadJob);
    if (downloadJob) {
      downloadJob.integrityQueued = false;
      downloadJob.integrityChecking = true;
    }
    return verifyLocalMediaIntegrityOnce(id, options);
  })
    .then(result => {
      if (downloadJob) {
        downloadJob.integrityProgress = 100;
        downloadJob.integrityPhase = 'Integrity check complete';
      }
      return result;
    })
    .finally(() => {
      if (downloadJob) downloadJob.integrityChecking = false;
      if (integrityVerificationJobs.get(id) === verification) integrityVerificationJobs.delete(id);
    });
  integrityVerificationJobs.set(id, verification);
  integrityVerificationTail = verification.catch(() => {});
  return verification;
}

async function quarantineMediaFile(id) {
  const filePath = getStoredMediaPath(id);
  if (!filePath) return '';
  const quarantineDirectory = path.join(dataDirectory, 'quarantine');
  await mkdir(quarantineDirectory, { recursive: true });
  const names = await readdir(quarantineDirectory);
  await Promise.all(names.filter(name => name.startsWith(`${id}-`)).map(name => unlink(path.join(quarantineDirectory, name)).catch(() => {})));
  const target = path.join(quarantineDirectory, `${id}-${Date.now()}${path.extname(filePath)}`);
  try { await rename(filePath, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(filePath, target);
    const [sourceInfo, targetInfo] = await Promise.all([stat(filePath), stat(target)]);
    if (sourceInfo.size !== targetInfo.size) {
      await unlink(target).catch(() => {});
      throw new Error('The damaged media could not be copied completely into quarantine.');
    }
    await unlink(filePath);
  }
  database.prepare(`UPDATE downloads SET integrity_status = 'failed', integrity_checked_at = ?,
    integrity_file_size = 0, integrity_file_mtime_ms = 0, integrity_checksum = '' WHERE video_id = ?`)
    .run(new Date().toISOString(), id);
  return target;
}

function hasFiniteVideoDuration(duration) {
  return /^\d{1,3}:\d{2}(?::\d{2})?$/.test(String(duration || '').trim());
}

database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS videos (
    video_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    channel TEXT NOT NULL,
    channel_key TEXT NOT NULL DEFAULT '',
    channel_url TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL,
    avatar TEXT NOT NULL,
    duration TEXT NOT NULL,
    meta TEXT NOT NULL,
    kind TEXT NOT NULL,
    section TEXT NOT NULL,
    topic TEXT NOT NULL,
    position INTEGER NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT '',
    published_at_precision TEXT NOT NULL DEFAULT '',
    published_age TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    channel_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    position INTEGER NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channels (
    channel_key TEXT PRIMARY KEY,
    channel_url TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    banner TEXT NOT NULL DEFAULT '',
    subscriber_count TEXT NOT NULL DEFAULT '',
    video_count TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_items (
    channel_key TEXT NOT NULL,
    video_id TEXT NOT NULL,
    tab_key TEXT NOT NULL DEFAULT 'videos',
    position INTEGER NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (channel_key, video_id, tab_key)
  );
  CREATE INDEX IF NOT EXISTS channel_items_order ON channel_items (channel_key, tab_key, position);
  CREATE TABLE IF NOT EXISTS channel_captures (
    capture_id TEXT PRIMARY KEY,
    channel_key TEXT NOT NULL,
    tab_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'opening',
    phase TEXT NOT NULL DEFAULT 'opening',
    video_count INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playlists (
    playlist_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'local',
    kind TEXT NOT NULL DEFAULT 'playlist',
    source_url TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL DEFAULT '',
    declared_item_count INTEGER NOT NULL DEFAULT 0,
    is_complete INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playlist_items (
    item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    source_key TEXT NOT NULL,
    added_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playback_queue (
    item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    added_at TEXT NOT NULL,
    source_playlist_id TEXT NOT NULL DEFAULT '',
    source_playlist_position INTEGER NOT NULL DEFAULT -1
  );
  CREATE TABLE IF NOT EXISTS video_preferences (
    video_id TEXT PRIMARY KEY,
    not_interested INTEGER NOT NULL DEFAULT 0,
    liked INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocked_channels (
    channel_key TEXT PRIMARY KEY,
    channel_name TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS downloads (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    progress REAL NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT '',
    expiry_paused_ms INTEGER,
    integrity_status TEXT NOT NULL DEFAULT 'unchecked',
    integrity_checked_at TEXT NOT NULL DEFAULT '',
    integrity_file_size INTEGER NOT NULL DEFAULT 0,
    integrity_file_mtime_ms REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transcription_assets (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending_audio',
    audio_relative_path TEXT NOT NULL DEFAULT '',
    audio_format TEXT NOT NULL DEFAULT '',
    audio_sample_rate INTEGER NOT NULL DEFAULT 0,
    audio_channels INTEGER NOT NULL DEFAULT 0,
    audio_size INTEGER NOT NULL DEFAULT 0,
    audio_checksum TEXT NOT NULL DEFAULT '',
    source_checksum TEXT NOT NULL DEFAULT '',
    transcript_text TEXT NOT NULL DEFAULT '',
    transcript_segments_json TEXT NOT NULL DEFAULT '[]',
    transcription_model TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT '',
    transcribed_at TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transcription_assets_status ON transcription_assets (status, updated_at);
  CREATE TABLE IF NOT EXISTS download_retry_queue (
    video_id TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    next_retry_at TEXT NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playlist_download_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE,
    playlist_id TEXT NOT NULL,
    queued_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_comments (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    comments_json TEXT NOT NULL DEFAULT '[]',
    message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comment_backfill_queue (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comment_backfill_queue_due ON comment_backfill_queue (status, next_attempt_at, created_at);
  CREATE TABLE IF NOT EXISTS download_metadata (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    phase TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_metadata (
    video_id TEXT PRIMARY KEY,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    local_assets_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cached_images (
    image_key TEXT PRIMARY KEY,
    source_url TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    cached_at TEXT NOT NULL
  );
  -- First successfully cached video thumbnail is the video's permanent local thumbnail.
  CREATE TABLE IF NOT EXISTS video_thumbnail_assets (
    video_id TEXT PRIMARY KEY,
    source_url TEXT NOT NULL,
    image_key TEXT NOT NULL,
    stored_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_views (
    video_id TEXT PRIMARY KEY,
    view_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_progress (
    video_id TEXT PRIMARY KEY,
    current_time REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_duration_lookups (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    extension_attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS video_provisions (
    video_id TEXT NOT NULL,
    category TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (video_id, category)
  );
  CREATE TABLE IF NOT EXISTS video_provenance (
    video_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_key TEXT NOT NULL DEFAULT '',
    source_label TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    observations INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (video_id, source_type, source_key)
  );
  CREATE INDEX IF NOT EXISTS video_provenance_latest ON video_provenance (video_id, last_seen DESC);
  CREATE TABLE IF NOT EXISTS homepage_captures (
    capture_id TEXT PRIMARY KEY,
    captured_at TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS homepage_sections (
    capture_id TEXT NOT NULL,
    section_key TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    section_position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (capture_id, section_key)
  );
  CREATE TABLE IF NOT EXISTS homepage_placements (
    capture_id TEXT NOT NULL,
    section_key TEXT NOT NULL,
    video_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    mix_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (capture_id, section_key, video_id)
  );
  CREATE TABLE IF NOT EXISTS homepage_categories (
    category_key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    sort_position INTEGER NOT NULL DEFAULT 0,
    discovered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    last_captured_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS homepage_category_videos (
    category_key TEXT NOT NULL,
    video_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (category_key, video_id)
  );
  CREATE INDEX IF NOT EXISTS homepage_captures_latest ON homepage_captures (last_seen DESC);
  CREATE INDEX IF NOT EXISTS homepage_placements_order ON homepage_placements (capture_id, section_key, position);
  CREATE INDEX IF NOT EXISTS homepage_category_videos_order ON homepage_category_videos (category_key, last_seen DESC, position);
  CREATE TABLE IF NOT EXISTS acquisition_exclusions (
    video_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    excluded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS excluded_acquisition_metadata (
    video_id TEXT PRIMARY KEY,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    saved_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS extension_duration_baseline (
    extension_version TEXT NOT NULL,
    video_id TEXT NOT NULL,
    category TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    first_has_duration INTEGER NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_has_duration INTEGER NOT NULL,
    last_duration TEXT NOT NULL DEFAULT '',
    observations INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (extension_version, video_id)
  );
  CREATE TABLE IF NOT EXISTS search_history (
    search_id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    normalized_query TEXT NOT NULL,
    searched_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'youtube'
  );
  CREATE TABLE IF NOT EXISTS search_history_results (
    search_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (search_id, video_id)
  );
  CREATE TABLE IF NOT EXISTS search_history_clicks (
    search_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    clicked_at TEXT NOT NULL,
    PRIMARY KEY (search_id, video_id)
  );
  CREATE TABLE IF NOT EXISTS search_sessions (
    search_id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS search_results (
    search_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (search_id, video_id)
  );
`);
try { database.exec('ALTER TABLE video_preferences ADD COLUMN liked INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
database.exec('CREATE INDEX IF NOT EXISTS video_preferences_liked_updated ON video_preferences (liked, updated_at DESC)');
await migrateLegacyShortsMedia();
if (keepTranscriptionAudio) {
  database.prepare(`INSERT OR IGNORE INTO transcription_assets (video_id, status, created_at, updated_at)
    SELECT video_id, 'pending_audio', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM downloads WHERE status = 'ready'`).run();
}
// Older builds treated permanently unavailable live recordings like paid-content exclusions.
// Keep those entries eligible for metadata recapture; only paid/movie content is blocklisted.
database.prepare("DELETE FROM acquisition_exclusions WHERE reason = 'unavailable-source'").run();
database.prepare(`INSERT OR IGNORE INTO download_metadata (video_id, status, phase, attempts, next_attempt_at, message, updated_at)
  SELECT video_id, 'pending', 'queued', 0, '', 'Preparing local metadata for this media.', updated_at
  FROM downloads WHERE status = 'ready'`).run();
database.prepare("UPDATE download_metadata SET status = 'retry', phase = 'queued', message = 'Metadata preparation was interrupted by a server restart.', next_attempt_at = '', updated_at = ? WHERE status = 'running'")
  .run(new Date().toISOString());
database.prepare(`UPDATE download_metadata SET status = 'pending', phase = 'queued', attempts = 0, next_attempt_at = '',
  message = 'Rechecking local metadata completeness.', updated_at = ?
  WHERE status = 'retry' AND message LIKE 'Local metadata is incomplete:%source metadata%'`).run(new Date().toISOString());
database.prepare(`UPDATE download_metadata SET status = 'pending', phase = 'queued', attempts = 0, next_attempt_at = '',
  message = 'Requesting rendered YouTube metadata for the missing channel name.', updated_at = ?
  WHERE status = 'retry' AND message LIKE 'Local metadata is incomplete:%channel name%'`).run(new Date().toISOString());
for (const [column, definition] of [['channel_key', "TEXT NOT NULL DEFAULT ''"], ['channel_url', "TEXT NOT NULL DEFAULT ''"]]) {
  try { database.exec(`ALTER TABLE videos ADD COLUMN ${column} ${definition}`); }
  catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
}
for (const [column, definition] of [
  ['published_at', "TEXT NOT NULL DEFAULT ''"],
  ['published_at_precision', "TEXT NOT NULL DEFAULT ''"],
  ['published_age', "TEXT NOT NULL DEFAULT ''"]
]) {
  try { database.exec(`ALTER TABLE videos ADD COLUMN ${column} ${definition}`); }
  catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
}
for (const [column, definition] of [['source_playlist_id', "TEXT NOT NULL DEFAULT ''"], ['source_playlist_position', 'INTEGER NOT NULL DEFAULT -1']]) {
  try { database.exec(`ALTER TABLE playback_queue ADD COLUMN ${column} ${definition}`); }
  catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
}
database.exec(`DROP TRIGGER IF EXISTS enqueue_download_metadata_after_video_update;
  CREATE TRIGGER enqueue_download_metadata_after_video_update
  AFTER UPDATE OF title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, published_at, published_at_precision, published_age ON videos
  WHEN EXISTS (SELECT 1 FROM downloads WHERE video_id = NEW.video_id AND status = 'ready')
    AND (OLD.title <> NEW.title OR OLD.channel <> NEW.channel OR OLD.channel_key <> NEW.channel_key
      OR OLD.channel_url <> NEW.channel_url OR OLD.thumbnail <> NEW.thumbnail OR OLD.avatar <> NEW.avatar
      OR OLD.duration <> NEW.duration OR OLD.meta <> NEW.meta
      OR OLD.published_at <> NEW.published_at OR OLD.published_at_precision <> NEW.published_at_precision
      OR OLD.published_age <> NEW.published_age)
  BEGIN
    INSERT INTO download_metadata (video_id, status, phase, attempts, next_attempt_at, message, updated_at)
      VALUES (NEW.video_id, 'pending', 'queued', 0, '', 'Video metadata changed; refreshing locally stored assets.', CURRENT_TIMESTAMP)
      ON CONFLICT(video_id) DO UPDATE SET status = 'pending', phase = 'queued', attempts = 0,
        next_attempt_at = '', message = 'Video metadata changed; refreshing locally stored assets.', updated_at = CURRENT_TIMESTAMP
      WHERE download_metadata.status = 'ready';
  END;`);
try { database.exec("ALTER TABLE channel_captures ADD COLUMN message TEXT NOT NULL DEFAULT ''"); }
catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
try { database.exec('ALTER TABLE video_duration_lookups ADD COLUMN extension_attempts INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
try { database.exec("ALTER TABLE video_duration_lookups ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT ''"); }
catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
for (const [column, definition] of [['progress', "REAL NOT NULL DEFAULT 0"], ['stage', "TEXT NOT NULL DEFAULT ''"], ['acquired_at', "TEXT NOT NULL DEFAULT ''"], ['started_at', "TEXT NOT NULL DEFAULT ''"], ['expires_at', "TEXT NOT NULL DEFAULT ''"], ['expiry_paused_ms', 'INTEGER'], ['integrity_status', "TEXT NOT NULL DEFAULT 'unchecked'"], ['integrity_checked_at', "TEXT NOT NULL DEFAULT ''"], ['integrity_file_size', 'INTEGER NOT NULL DEFAULT 0'], ['integrity_file_mtime_ms', 'REAL NOT NULL DEFAULT 0'], ['integrity_checksum', "TEXT NOT NULL DEFAULT ''"], ['origin', "TEXT NOT NULL DEFAULT 'yourtube'"]]) {
  try { database.exec(`ALTER TABLE downloads ADD COLUMN ${column} ${definition}`); } catch (error) {
    if (!String(error.message).includes('duplicate column name')) throw error;
  }
}
const legacyReadyDownloads = database.prepare("SELECT video_id AS id, updated_at AS updatedAt FROM downloads WHERE status = 'ready' AND acquired_at = ''").all();
const setAcquiredAt = database.prepare('UPDATE downloads SET acquired_at = ? WHERE video_id = ? AND acquired_at = \'\'');
await Promise.all(legacyReadyDownloads.map(async row => {
  let acquiredAt = row.updatedAt;
  try {
    const storedPath = getStoredMediaPath(row.id);
    if (!storedPath) throw new Error('Local media file not found.');
    const file = await stat(storedPath);
    acquiredAt = (file.birthtimeMs > 0 ? file.birthtime : file.mtime).toISOString();
  } catch {}
  setAcquiredAt.run(acquiredAt, row.id);
}));
const legacyActiveDownloads = database.prepare(`
  SELECT d.video_id AS id, d.updated_at AS updatedAt, q.updated_at AS retryUpdatedAt, q.status AS retryStatus
  FROM downloads d LEFT JOIN download_retry_queue q ON q.video_id = d.video_id
  WHERE d.status = 'downloading' AND d.started_at = ''
`).all();
const setDownloadStartedAt = database.prepare("UPDATE downloads SET started_at = ? WHERE video_id = ? AND started_at = ''");
await Promise.all(legacyActiveDownloads.map(async row => {
  const times = [Date.parse(row.updatedAt)];
  if (row.retryStatus === 'running' && row.retryUpdatedAt) times.push(Date.parse(row.retryUpdatedAt));
  try {
    const mediaDirs = [mediaDirectory, shortsMediaDirectory];
    const mediaStats = (await Promise.all(mediaDirs.map(async directory => {
      const names = (await readdir(directory).catch(() => [])).filter(name => name.startsWith(`${row.id}.`) && !name.includes('.finalizing.'));
      return Promise.all(names.map(name => stat(path.join(directory, name)).catch(() => null)));
    }))).flat();
    for (const file of mediaStats) if (file?.birthtimeMs > 0) times.push(file.birthtimeMs);
  } catch {}
  const startedAtMs = Math.min(...times.filter(Number.isFinite));
  if (Number.isFinite(startedAtMs)) setDownloadStartedAt.run(new Date(startedAtMs).toISOString(), row.id);
}));
try { database.exec("ALTER TABLE search_history ADD COLUMN selected_video_id TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { database.exec("ALTER TABLE search_history ADD COLUMN source TEXT NOT NULL DEFAULT 'youtube'"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
database.prepare(`INSERT OR IGNORE INTO search_history_clicks (search_id, video_id, clicked_at)
  SELECT search_id, selected_video_id, searched_at FROM search_history WHERE selected_video_id <> ''`).run();
try { database.exec('ALTER TABLE video_progress ADD COLUMN completed INTEGER NOT NULL DEFAULT 0'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { database.exec("ALTER TABLE playlists ADD COLUMN kind TEXT NOT NULL DEFAULT 'playlist'"); } catch (error) {
  if (!String(error.message).includes('duplicate column name') && !String(error.message).includes('no such table')) throw error;
}
database.prepare("UPDATE playlists SET kind = 'mix', source_url = 'https://www.youtube.com/watch?list=' || playlist_id WHERE source = 'youtube' AND playlist_id GLOB 'RD*'").run();
database.prepare("UPDATE playlists SET source_url = 'https://www.youtube.com/playlist?list=' || playlist_id WHERE source = 'youtube' AND kind <> 'mix' AND source_url = ''").run();
const playlistItemColumns = database.prepare('PRAGMA table_info(playlist_items)').all().map(column => column.name);
if (playlistItemColumns.length && (!playlistItemColumns.includes('item_id') || !playlistItemColumns.includes('source_key'))) {
  database.exec(`ALTER TABLE playlist_items RENAME TO playlist_items_legacy;
    CREATE TABLE playlist_items (
      item_id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      added_at TEXT NOT NULL
    );
    INSERT INTO playlist_items (playlist_id, video_id, position, source_key, added_at)
      SELECT playlist_id, video_id, position, 'legacy:' || position, added_at FROM playlist_items_legacy;
    DROP TABLE playlist_items_legacy;`);
}
database.exec('CREATE UNIQUE INDEX IF NOT EXISTS playlist_items_source_key ON playlist_items (playlist_id, source_key)');
database.prepare("DELETE FROM playlist_items WHERE video_id IN (SELECT video_id FROM videos WHERE kind = 'short')").run();
database.prepare("DELETE FROM playback_queue WHERE video_id IN (SELECT video_id FROM videos WHERE kind = 'short')").run();
database.prepare("DELETE FROM playlist_download_queue WHERE video_id IN (SELECT video_id FROM videos WHERE kind = 'short')").run();
database.prepare(`UPDATE playlists SET declared_item_count = (
  SELECT COUNT(*) FROM playlist_items i JOIN videos v ON v.video_id = i.video_id
  WHERE i.playlist_id = playlists.playlist_id AND v.kind <> 'short'
) WHERE source = 'youtube' AND is_complete = 1`).run();
const removeShortPlaylistItems = database.prepare('DELETE FROM playlist_items WHERE video_id = ?');
const removeShortPlaybackQueueItems = database.prepare('DELETE FROM playback_queue WHERE video_id = ?');
const removeShortPlaylistDownloadItems = database.prepare('DELETE FROM playlist_download_queue WHERE video_id = ?');
const removeShortPlaylistProvisions = database.prepare("DELETE FROM video_provisions WHERE video_id = ? AND category = 'playlist'");
function isolateShortFromStandardFlows(id) {
  removeShortPlaylistItems.run(id);
  removeShortPlaybackQueueItems.run(id);
  removeShortPlaylistDownloadItems.run(id);
  removeShortPlaylistProvisions.run(id);
}
const watchLaterCreatedAt = new Date().toISOString();
database.prepare(`INSERT OR IGNORE INTO playlists (playlist_id, title, source, kind, created_at, updated_at)
  VALUES ('watch-later', 'Watch later', 'local', 'watch-later', ?, ?)`).run(watchLaterCreatedAt, watchLaterCreatedAt);
database.prepare(`INSERT OR IGNORE INTO video_provisions (video_id, category, first_seen, last_seen)
  SELECT video_id, CASE WHEN section = 'search' THEN 'search' ELSE 'homepage' END, first_seen, last_seen FROM videos`).run();
database.prepare(`INSERT OR IGNORE INTO homepage_captures (capture_id, captured_at, first_seen, last_seen)
  SELECT 'legacy-homepage', COALESCE(MAX(last_seen), ?), COALESCE(MIN(first_seen), ?), COALESCE(MAX(last_seen), ?)
  FROM videos WHERE section NOT IN ('search', 'playlist', 'channel')`).run(watchLaterCreatedAt, watchLaterCreatedAt, watchLaterCreatedAt);
database.prepare(`INSERT OR IGNORE INTO homepage_sections (capture_id, section_key, title, kind, topic, section_position)
  SELECT 'legacy-homepage',
    CASE WHEN kind = 'short' THEN 'legacy-shorts'
      WHEN section = 'news' THEN 'top-news'
      WHEN trim(topic) <> '' THEN 'topic:' || lower(trim(topic)) ELSE 'for-you' END,
    CASE WHEN kind = 'short' THEN 'Shorts'
      WHEN section = 'news' THEN 'Top News'
      WHEN trim(topic) <> '' THEN topic ELSE 'For you' END,
    CASE WHEN kind = 'short' THEN 'shorts'
      WHEN section = 'news' THEN 'feed'
      WHEN trim(topic) <> '' THEN 'topic' ELSE 'for-you' END,
    topic, MIN(position)
  FROM videos WHERE section NOT IN ('search', 'playlist', 'channel')
  GROUP BY CASE WHEN kind = 'short' THEN 'legacy-shorts'
    WHEN section = 'news' THEN 'top-news'
    WHEN trim(topic) <> '' THEN 'topic:' || lower(trim(topic)) ELSE 'for-you' END`).run();
database.prepare(`INSERT OR IGNORE INTO homepage_placements (capture_id, section_key, video_id, position, mix_id)
  SELECT 'legacy-homepage',
    CASE WHEN kind = 'short' THEN 'legacy-shorts'
      WHEN section = 'news' THEN 'top-news'
      WHEN trim(topic) <> '' THEN 'topic:' || lower(trim(topic)) ELSE 'for-you' END,
    video_id, position, ''
  FROM videos WHERE section NOT IN ('search', 'playlist', 'channel')`).run();
database.prepare(`UPDATE video_progress SET completed = 1 WHERE current_time = 0 AND duration > 0 AND completed = 0
  AND video_id IN (SELECT video_id FROM video_views WHERE view_count > 0)`).run();
database.prepare("DELETE FROM videos WHERE lower(trim(title)) = 'watch'").run();
database.prepare('DELETE FROM video_thumbnail_assets WHERE video_id NOT IN (SELECT video_id FROM videos)').run();
const interruptedFinishRecoveries = database.prepare(`
  SELECT d.video_id AS id, d.progress, d.started_at AS startedAt, v.url
  FROM downloads d JOIN videos v ON v.video_id = d.video_id
  WHERE (
    d.status = 'downloading' AND (
      d.stage LIKE 'Finishing the audio track%' OR
      d.stage LIKE 'Stopping video transfer to save%' OR
      d.stage LIKE 'Downloading audio track to finish%' OR
      d.stage LIKE 'Merging the saved video and audio%'
    )
  ) OR (
    d.status = 'paused' AND (
      d.message LIKE 'Could not finish and save this partial yet:%' OR
      d.stage = 'Waiting to finish and save while Online'
    )
  )
`).all();
const interruptedFinishIds = new Set(interruptedFinishRecoveries.map(item => item.id));
const interruptedDownloads = database.prepare("SELECT video_id AS id FROM downloads WHERE status = 'downloading'").all()
  .filter(({ id }) => !interruptedFinishIds.has(id));
const restartRecoveryMessage = 'YourTube stopped while this download was running. It is queued to resume; this does not count as a failed attempt.';
const markRestartInterrupted = database.prepare("UPDATE downloads SET status = 'error', message = ?, stage = 'Restart recovery', updated_at = ? WHERE video_id = ?");
const findRetryForRestart = database.prepare('SELECT video_id FROM download_retry_queue WHERE video_id = ?');
const queueRestartInterrupted = database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
  VALUES (?, 0, 'pending', ?, ?, ?) ON CONFLICT(video_id) DO NOTHING`);
for (const { id } of interruptedDownloads) {
  const now = new Date();
  const updatedAt = now.toISOString();
  markRestartInterrupted.run(restartRecoveryMessage, updatedAt, id);
  if (!findRetryForRestart.get(id)) {
    queueRestartInterrupted.run(id, new Date(now.getTime() + downloadRetryDelay).toISOString(), restartRecoveryMessage, updatedAt);
  }
}
const interruptedMediaFolderImports = database.prepare("SELECT video_id AS id FROM downloads WHERE status = 'importing'").all();
if (interruptedMediaFolderImports.length) {
  const recoveryTime = new Date().toISOString();
  database.prepare(`UPDATE downloads SET status = 'error',
    message = 'The local integrity check stopped with the previous server. YourTube will scan the media folder and resume it if the file is still present.',
    progress = 0, stage = 'Waiting for media-folder scan', updated_at = ? WHERE status = 'importing'`).run(recoveryTime);
}
const clearInterruptedMediaImportRetries = database.prepare(`DELETE FROM download_retry_queue
  WHERE video_id IN (SELECT video_id FROM downloads WHERE origin = 'media-folder'
    AND status = 'error' AND stage = 'Waiting for media-folder scan'
    AND message LIKE 'The local integrity check stopped with the previous server.%')`);
clearInterruptedMediaImportRetries.run();
database.prepare("UPDATE video_comments SET status = 'error', message = 'Comment lookup was interrupted. Reload to try again.', updated_at = ? WHERE status = 'loading'").run(new Date().toISOString());
database.prepare("UPDATE video_duration_lookups SET status = 'pending', message = 'Lookup interrupted by restart.', updated_at = ? WHERE status = 'running' AND updated_at < ?")
  .run(new Date().toISOString(), new Date(Date.now() - 60_000).toISOString());

const upsertVideo = database.prepare(`
  INSERT INTO videos (video_id, url, title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, kind, section, topic, position, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(video_id) DO UPDATE SET
    url = excluded.url, title = excluded.title,
    channel = CASE WHEN trim(excluded.channel) <> '' THEN excluded.channel
      WHEN lower(trim(videos.channel)) IN ('youtube', 'channel unavailable') THEN '' ELSE videos.channel END,
    channel_key = CASE WHEN excluded.channel_key <> '' THEN excluded.channel_key ELSE videos.channel_key END,
    channel_url = CASE WHEN excluded.channel_url <> '' THEN excluded.channel_url ELSE videos.channel_url END,
    thumbnail = CASE WHEN EXISTS (SELECT 1 FROM video_thumbnail_assets WHERE video_id = videos.video_id)
      THEN videos.thumbnail ELSE excluded.thumbnail END,
    avatar = CASE WHEN trim(excluded.avatar) <> '' THEN excluded.avatar ELSE videos.avatar END,
    duration = CASE WHEN trim(excluded.duration) <> '' THEN excluded.duration ELSE videos.duration END,
    meta = excluded.meta, kind = CASE WHEN videos.kind = 'short' OR excluded.kind = 'short' THEN 'short' ELSE excluded.kind END, section = excluded.section,
    topic = CASE WHEN trim(excluded.topic) <> '' THEN excluded.topic ELSE videos.topic END,
    position = excluded.position, last_seen = excluded.last_seen
`);
const upsertSubscription = database.prepare(`
  INSERT INTO subscriptions (channel_key, name, avatar, position, last_seen)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(channel_key) DO UPDATE SET
    name = excluded.name,
    avatar = CASE WHEN trim(excluded.avatar) <> '' THEN excluded.avatar ELSE subscriptions.avatar END,
    position = excluded.position, last_seen = excluded.last_seen
`);
const upsertPlaylistVideo = database.prepare(`
  INSERT INTO videos (video_id, url, title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, kind, section, topic, position, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'playlist', '', ?, ?, ?)
  ON CONFLICT(video_id) DO UPDATE SET
    url = excluded.url, title = excluded.title,
    channel = CASE WHEN trim(excluded.channel) <> '' THEN excluded.channel
      WHEN lower(trim(videos.channel)) IN ('youtube', 'channel unavailable') THEN '' ELSE videos.channel END,
    channel_key = CASE WHEN excluded.channel_key <> '' THEN excluded.channel_key ELSE videos.channel_key END,
    channel_url = CASE WHEN excluded.channel_url <> '' THEN excluded.channel_url ELSE videos.channel_url END,
    thumbnail = CASE WHEN EXISTS (SELECT 1 FROM video_thumbnail_assets WHERE video_id = videos.video_id)
      THEN videos.thumbnail WHEN excluded.thumbnail <> '' THEN excluded.thumbnail ELSE videos.thumbnail END,
    avatar = CASE WHEN excluded.avatar <> '' THEN excluded.avatar ELSE videos.avatar END,
    duration = CASE WHEN trim(excluded.duration) <> '' THEN excluded.duration ELSE videos.duration END,
    meta = CASE WHEN excluded.meta <> '' THEN excluded.meta ELSE videos.meta END,
    last_seen = excluded.last_seen
`);

function safeImage(input) {
  try {
    const image = new URL(input);
    return image.protocol === 'https:' ? image.href.slice(0, 2048) : '';
  } catch { return ''; }
}

function cleanPublishedAt(value, precision = '') {
  const raw = String(value || '').trim();
  if (!raw) return { publishedAt: '', precision: '' };
  const dateOnly = /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    const parsed = Date.parse(`${dateOnly}T00:00:00Z`);
    if (!Number.isFinite(parsed) || parsed > Date.now() + 5 * 60_000) return { publishedAt: '', precision: '' };
    return { publishedAt: dateOnly, precision: 'date' };
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed > Date.now() + 5 * 60_000) return { publishedAt: '', precision: '' };
  const requestedPrecision = precision === 'date' ? 'date' : 'exact';
  return { publishedAt: requestedPrecision === 'date' ? new Date(parsed).toISOString().slice(0, 10) : new Date(parsed).toISOString(), precision: requestedPrecision };
}

function publicationFromInfo(info) {
  const direct = cleanPublishedAt(info?.published_at || info?.publishedAt, info?.published_at_precision || info?.publishedAtPrecision);
  if (direct.publishedAt) return { ...direct, publishedAge: String(info?.published_age || info?.publishedAge || '').trim().slice(0, 100) };
  const timestamp = Number(info?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const parsed = cleanPublishedAt(new Date(timestamp > 1e12 ? timestamp : timestamp * 1000).toISOString(), 'exact');
    if (parsed.publishedAt) return { ...parsed, publishedAge: String(info?.published_age || info?.publishedAge || '').trim().slice(0, 100) };
  }
  for (const value of [info?.upload_date, info?.release_date]) {
    const parsed = cleanPublishedAt(value, 'date');
    if (parsed.publishedAt) return { ...parsed, publishedAge: String(info?.published_age || info?.publishedAge || '').trim().slice(0, 100) };
  }
  return { publishedAt: '', precision: '', publishedAge: String(info?.published_age || info?.publishedAge || '').trim().slice(0, 100) };
}

function saveVideoPublication(id, value) {
  const publication = value && typeof value === 'object' && 'publishedAt' in value
    ? { ...cleanPublishedAt(value.publishedAt, value.publishedAtPrecision), publishedAge: String(value.publishedAge || '').trim().slice(0, 100) }
    : publicationFromInfo(value);
  database.prepare(`UPDATE videos SET
    published_at = CASE WHEN ? <> '' THEN ? ELSE published_at END,
    published_at_precision = CASE WHEN ? <> '' THEN ? ELSE published_at_precision END,
    published_age = CASE WHEN ? <> '' THEN ? ELSE published_age END
    WHERE video_id = ?`).run(
      publication.publishedAt, publication.publishedAt,
      publication.precision, publication.precision,
      publication.publishedAge, publication.publishedAge, id
    );
}

function cleanRepeatedLabel(input) {
  const value = String(input || '').replace(/\s+/g, ' ').trim();
  const words = value.split(' ');
  if (words.length > 1 && words.length % 2 === 0) {
    const middle = words.length / 2;
    if (words.slice(0, middle).join(' ').toLowerCase() === words.slice(middle).join(' ').toLowerCase()) return words.slice(0, middle).join(' ');
  }
  return value;
}

function cleanDurationLabel(input) {
  const value = cleanRepeatedLabel(input);
  if (/^(live|upcoming)$/i.test(value)) return value.toUpperCase();
  const match = value.match(/(?:^|\s)(\d{1,3}:\d{2}(?::\d{2})?)(?=$|\s)/);
  if (!match) return '';
  const parts = match[1].split(':').map(Number);
  if (parts.some(part => !Number.isInteger(part)) || parts.at(-1) > 59 || (parts.length === 3 && parts[1] > 59)) return '';
  return match[1].slice(0, 24);
}

function durationLabelSeconds(input) {
  const duration = cleanDurationLabel(input);
  if (!duration || /^(live|upcoming)$/i.test(duration)) return 0;
  const parts = duration.split(':').map(Number);
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

function cleanChannelKey(input) {
  let value = String(input || '').trim();
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname.toLowerCase())) return '';
      value = url.pathname;
    }
  } catch { return ''; }
  try { value = value.replace(/^\/+|\/+$/g, '').split('/').map(part => decodeURIComponent(part)).join('/'); }
  catch { return ''; }
  if (/^@[\p{L}\p{N}._-]{3,100}$/u.test(value)) return value;
  if (/^channel\/UC[A-Za-z0-9_-]{20,32}$/.test(value)) return value;
  if (/^(?:user|c)\/[\p{L}\p{N}._-]{1,100}$/u.test(value)) return value;
  return '';
}

function cleanChannelName(input) {
  const name = cleanRepeatedLabel(input).slice(0, 200);
  return /^(?:youtube|channel unavailable)$/i.test(name) ? '' : name;
}

function knownChannelName(channelKey) {
  if (!channelKey) return '';
  const row = database.prepare(`SELECT name FROM channels WHERE channel_key = ? AND trim(name) <> ''
    UNION ALL SELECT name FROM subscriptions WHERE channel_key = ? AND trim(name) <> '' LIMIT 1`).get(channelKey, channelKey);
  return cleanChannelName(row?.name);
}

function channelAvatarSelect(videoAlias = 'v') {
  return `COALESCE(
    NULLIF(trim(${videoAlias}.avatar), ''),
    (SELECT NULLIF(trim(c.avatar), '') FROM channels c
      WHERE trim(${videoAlias}.channel_key) <> ''
        AND lower(trim(c.channel_key, '/')) = lower(trim(${videoAlias}.channel_key, '/'))
        AND trim(c.avatar) <> '' LIMIT 1),
    (SELECT NULLIF(trim(s.avatar), '') FROM subscriptions s
      WHERE trim(${videoAlias}.channel_key) <> ''
        AND lower(trim(s.channel_key, '/')) = lower(trim(${videoAlias}.channel_key, '/'))
        AND trim(s.avatar) <> '' LIMIT 1),
    (SELECT NULLIF(trim(other.avatar), '') FROM videos other
      WHERE trim(${videoAlias}.channel_key) <> '' AND other.video_id <> ${videoAlias}.video_id
        AND lower(trim(other.channel_key, '/')) = lower(trim(${videoAlias}.channel_key, '/'))
        AND trim(other.avatar) <> '' ORDER BY other.last_seen DESC LIMIT 1),
    ''
  )`;
}

function channelUrlForKey(channelKey, tab = 'videos') {
  const key = cleanChannelKey(channelKey);
  if (!key) return '';
  const suffix = ['home', 'videos', 'shorts', 'streams', 'playlists', 'community'].includes(tab) ? tab : 'videos';
  return `https://www.youtube.com/${key}/${suffix}`;
}

function formatDurationSeconds(input) {
  const seconds = Number(input);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

const acquisitionExclusionReasons = new Set(['movie-listing', 'paid-content']);
function normalizeAcquisitionExclusionReason(value) {
  const reason = String(value?.acquisitionExclusionReason || value?.exclusionReason || '').trim();
  return acquisitionExclusionReasons.has(reason) ? reason : '';
}

function isAcquisitionExcluded(id) {
  return Boolean(database.prepare('SELECT 1 FROM acquisition_exclusions WHERE video_id = ?').get(id));
}

function finalizeStalledCaptures() {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - backgroundCaptureStaleMs).toISOString();
  const channelMessage = 'Capture timed out after five minutes without extension progress. Captured videos remain saved; revisit the channel to retry.';
  const searchMessage = 'Search capture timed out after five minutes without new results. Captured results remain saved; run the search again to continue.';
  const stalledSections = database.prepare(`UPDATE channel_captures
    SET status = 'stale', phase = 'stalled', message = ?, updated_at = ?
    WHERE status IN ('opening', 'collecting') AND updated_at <= ?`).run(channelMessage, now, staleBefore).changes;
  const orphanedSections = database.prepare(`UPDATE channel_captures AS queued
    SET status = 'stale', phase = 'stalled', message = ?, updated_at = ?
    WHERE status = 'queued' AND updated_at <= ? AND NOT EXISTS (
      SELECT 1 FROM channel_captures AS active
      WHERE active.channel_key = queued.channel_key
        AND active.status IN ('opening', 'collecting') AND active.updated_at > ?
    )`).run(channelMessage, now, staleBefore, staleBefore).changes;
  const stalledSearches = database.prepare(`UPDATE search_sessions
    SET status = 'stale', updated_at = ? WHERE status = 'collecting' AND updated_at <= ?`).run(now, staleBefore).changes;
  return { channel: stalledSections + orphanedSections, searches: stalledSearches };
}

function excludeAcquisitionVideo(id, reason) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || '')) || !acquisitionExclusionReasons.has(reason)) return false;
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO acquisition_exclusions (video_id, reason, excluded_at) VALUES (?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET reason = excluded.reason, excluded_at = MIN(acquisition_exclusions.excluded_at, excluded.excluded_at)`)
    .run(id, reason, now);

  const activeJob = jobs.get(id);
  if (activeJob?.process && activeJob.process.exitCode === null && activeJob.process.signalCode === null) {
    activeJob.acquisitionExclusionReason = reason;
    activeJob.discardRequested = true;
    activeJob.process.kill('SIGTERM');
    return true;
  }

  const dependentTables = [
    'channel_items', 'playlist_items', 'playback_queue', 'search_results',
    'search_history_results', 'search_history_clicks', 'video_provisions', 'video_provenance',
    'video_duration_lookups', 'video_metadata', 'video_thumbnail_assets', 'video_comments', 'comment_backfill_queue', 'video_progress',
    'video_views', 'video_preferences', 'download_metadata', 'download_retry_queue',
    'playlist_download_queue', 'extension_duration_baseline', 'downloads'
  ];
  const existingSnapshot = database.prepare('SELECT metadata_json FROM excluded_acquisition_metadata WHERE video_id = ?').get(id);
  const hasActiveMetadata = Boolean(database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(id));
  if (hasActiveMetadata && (!existingSnapshot || existingSnapshot.metadata_json === '{}')) {
    const snapshot = {
      video: database.prepare('SELECT * FROM videos WHERE video_id = ?').get(id) || null,
      related: Object.fromEntries(dependentTables.map(table => [table, database.prepare(`SELECT * FROM ${table} WHERE video_id = ?`).all(id)]))
    };
    database.prepare(`INSERT INTO excluded_acquisition_metadata (video_id, metadata_json, saved_at) VALUES (?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET metadata_json = excluded.metadata_json, saved_at = excluded.saved_at`)
      .run(id, JSON.stringify(snapshot), now);
  }
  for (const table of dependentTables) database.prepare(`DELETE FROM ${table} WHERE video_id = ?`).run(id);
  database.prepare('DELETE FROM videos WHERE video_id = ?').run(id);
  void discardDownloadFiles(id).catch(error => console.error(`Could not clear excluded media for ${id}:`, error));
  return true;
}

function cleanVideo(value, position) {
  if (!value || typeof value !== 'object') return null;
  try {
    const url = new URL(value.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.protocol !== 'https:' || !['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return null;
    const id = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    const exclusionReason = normalizeAcquisitionExclusionReason(value);
    if (exclusionReason) {
      excludeAcquisitionVideo(id, exclusionReason);
      return null;
    }
    if (isAcquisitionExcluded(id)) return null;
    const title = String(value.title || '').trim().slice(0, 500);
    if (!title || /^watch$/i.test(title)) return null;
    const channelKey = cleanChannelKey(value.channelKey || value.channelUrl);
    const channel = cleanChannelName(value.channel) || knownChannelName(channelKey);
    return {
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title,
      channel,
      channelKey,
      channelUrl: channelKey ? `https://www.youtube.com/${channelKey}` : '',
      thumbnail: safeImage(value.thumbnail),
      avatar: safeImage(value.avatar),
      duration: cleanDurationLabel(value.duration),
      meta: String(value.meta || '').slice(0, 200),
      publishedAt: cleanPublishedAt(value.publishedAt, value.publishedAtPrecision).publishedAt,
      publishedAtPrecision: cleanPublishedAt(value.publishedAt, value.publishedAtPrecision).precision,
      publishedAge: String(value.publishedAge || '').trim().slice(0, 100),
      kind: value.kind === 'short' ? 'short' : 'normal',
      section: value.section === 'news' ? 'news' : value.section === 'search' ? 'search' : value.section === 'playlist' ? 'playlist' : value.section === 'channel' ? 'channel' : 'home',
      topic: (inferVideoTopic({ topic: value.topic, title, channel, queries: value.topicQuery || value.searchQuery || value.query || '' })?.topic || '').slice(0, 80),
      position: Number.isInteger(value.position) ? Math.max(0, Math.min(value.position, 10000)) : position
    };
  } catch { return null; }
}

const videoProvenanceTypes = new Set(['homepage', 'homepage-section', 'search', 'channel', 'playlist', 'shorts', 'watch', 'youtube-page', 'direct-id', 'media-folder']);
const saveVideoProvenance = database.prepare(`INSERT INTO video_provenance
  (video_id, source_type, source_key, source_label, source_url, first_seen, last_seen, observations)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(video_id, source_type, source_key) DO UPDATE SET
    source_label = CASE WHEN excluded.source_label <> '' THEN excluded.source_label ELSE video_provenance.source_label END,
    source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE video_provenance.source_url END,
    last_seen = excluded.last_seen,
    observations = video_provenance.observations + 1`);

function recordVideoProvenance(videoId, rawContext, seenAt, fallback = {}) {
  const context = rawContext && typeof rawContext === 'object' ? rawContext : {};
  const fallbackType = videoProvenanceTypes.has(fallback.sourceType) ? fallback.sourceType : 'youtube-page';
  const requestedType = String(context.sourceType || '').trim();
  const sourceType = videoProvenanceTypes.has(requestedType) ? requestedType : fallbackType;
  const sourceKey = String(context.sourceKey || fallback.sourceKey || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
  const sourceLabel = String(context.sourceLabel || fallback.sourceLabel || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  let sourceUrl = '';
  try {
    const url = new URL(String(context.sourceUrl || fallback.sourceUrl || ''));
    if (url.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname.toLowerCase())) {
      sourceUrl = `https://www.youtube.com${url.pathname.slice(0, 300)}`;
      if (sourceType === 'playlist') {
        const listId = url.searchParams.get('list') || (sourceKey && !sourceKey.includes(':') ? sourceKey : '');
        if (listId && /^[A-Za-z0-9_-]{5,120}$/.test(listId)) sourceUrl += `?list=${encodeURIComponent(listId)}`;
      }
    }
  } catch {}
  const labels = {
    homepage: 'YouTube homepage', 'homepage-section': 'YouTube homepage section', search: 'YouTube search',
    channel: 'YouTube channel', playlist: 'YouTube playlist', shorts: 'YouTube Shorts feed',
    watch: 'YouTube watch page', 'youtube-page': 'YouTube page', 'direct-id': 'Direct video ID', 'media-folder': 'Media folder'
  };
  saveVideoProvenance.run(videoId, sourceType, sourceKey, sourceLabel || labels[sourceType], sourceUrl, seenAt, seenAt);
}

function backfillVideoProvenance() {
  const marker = 'video_provenance_backfill_v1';
  if (database.prepare('SELECT 1 FROM app_settings WHERE setting_key = ?').get(marker)) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`INSERT OR IGNORE INTO video_provenance
      (video_id, source_type, source_key, source_label, source_url, first_seen, last_seen, observations)
      SELECT video_id,
        CASE category WHEN 'other' THEN 'youtube-page' WHEN 'direct' THEN 'direct-id' ELSE category END,
        '',
        CASE category WHEN 'homepage' THEN 'YouTube homepage' WHEN 'other' THEN 'YouTube page'
          WHEN 'direct' THEN 'Direct video ID' WHEN 'media-folder' THEN 'Media folder'
          WHEN 'search' THEN 'YouTube search' WHEN 'playlist' THEN 'YouTube playlist' ELSE 'YouTube page' END,
        '', first_seen, last_seen, 1 FROM video_provisions;

      INSERT OR IGNORE INTO video_provenance
        (video_id, source_type, source_key, source_label, source_url, first_seen, last_seen, observations)
      SELECT ci.video_id, 'channel', ci.channel_key || ':' || ci.tab_key,
        'Channel · ' || COALESCE(NULLIF(ch.name, ''), ci.channel_key) || ' · ' ||
          CASE ci.tab_key WHEN 'home' THEN 'Home' WHEN 'shorts' THEN 'Shorts' WHEN 'streams' THEN 'Live'
            WHEN 'playlists' THEN 'Playlists' WHEN 'community' THEN 'Community' ELSE 'Videos' END,
        COALESCE(ch.channel_url, ''), MIN(ci.added_at), MAX(ci.added_at), COUNT(*)
      FROM channel_items ci LEFT JOIN channels ch ON ch.channel_key = ci.channel_key
      GROUP BY ci.video_id, ci.channel_key, ci.tab_key;

      INSERT OR IGNORE INTO video_provenance
        (video_id, source_type, source_key, source_label, source_url, first_seen, last_seen, observations)
      SELECT hp.video_id, 'homepage-section', hp.section_key, 'Homepage · ' || hs.title,
        'https://www.youtube.com/', MIN(hc.first_seen), MAX(hc.last_seen), COUNT(*)
      FROM homepage_placements hp JOIN homepage_sections hs ON hs.capture_id = hp.capture_id AND hs.section_key = hp.section_key
      JOIN homepage_captures hc ON hc.capture_id = hp.capture_id
      GROUP BY hp.video_id, hp.section_key, hs.title;

      INSERT OR IGNORE INTO video_provenance
        (video_id, source_type, source_key, source_label, source_url, first_seen, last_seen, observations)
      SELECT cv.video_id, 'homepage-section', 'category:' || cv.category_key, 'Homepage category · ' || hc.title,
        'https://www.youtube.com/', MIN(cv.first_seen), MAX(cv.last_seen), COUNT(*)
      FROM homepage_category_videos cv JOIN homepage_categories hc ON hc.category_key = cv.category_key
      GROUP BY cv.video_id, cv.category_key, hc.title;

      INSERT OR IGNORE INTO video_provenance
        (video_id, source_type, source_key, source_label, source_url, first_seen, last_seen, observations)
      SELECT sr.video_id, 'search', ss.search_id, 'YouTube search · ' || ss.query,
        'https://www.youtube.com/results', ss.updated_at, ss.updated_at, 1
      FROM search_results sr JOIN search_sessions ss ON ss.search_id = sr.search_id;

      INSERT OR IGNORE INTO video_provenance
        (video_id, source_type, source_key, source_label, source_url, first_seen, last_seen, observations)
      SELECT pi.video_id, 'playlist', p.playlist_id, 'YouTube playlist · ' || p.title,
        'https://www.youtube.com/playlist?list=' || p.playlist_id, MIN(pi.added_at), MAX(pi.added_at), COUNT(*)
      FROM playlist_items pi JOIN playlists p ON p.playlist_id = pi.playlist_id
      WHERE p.source = 'youtube'
      GROUP BY pi.video_id, p.playlist_id, p.title, p.source_url;`);
    database.prepare(`INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, '1', ?)`)
      .run(marker, new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

backfillVideoProvenance();

function recordExtensionDuration(extensionVersion, video, category, seenAt) {
  const version = String(extensionVersion || '').trim().slice(0, 40) || 'unknown';
  const hasDuration = video.duration ? 1 : 0;
  database.prepare(`INSERT INTO extension_duration_baseline
    (extension_version, video_id, category, first_seen_at, first_has_duration, last_seen_at, last_has_duration, last_duration, observations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(extension_version, video_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      last_has_duration = excluded.last_has_duration,
      last_duration = CASE WHEN excluded.last_has_duration = 1 THEN excluded.last_duration ELSE extension_duration_baseline.last_duration END,
      observations = extension_duration_baseline.observations + 1`)
    .run(version, video.id, category, seenAt, hasDuration, seenAt, hasDuration, video.duration);
}

function cleanSubscription(value, position) {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name || '').trim().slice(0, 200);
  if (!name) return null;
  const channelKey = String(value.key || name.toLowerCase()).slice(0, 240);
  return { key: channelKey, name, avatar: safeImage(value.avatar), position };
}

function cleanPlaylist(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim().slice(0, 160);
  const title = cleanRepeatedLabel(value.title).slice(0, 300);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return null;
  const items = (Array.isArray(value.items) ? value.items : []).slice(0, 500)
    .map((item, position) => cleanVideo({ ...item, section: 'playlist' }, position))
    .filter(Boolean);
  if (!title && !items.length) return null;
  const kind = value.kind === 'mix' || /^RD/i.test(id) ? 'mix' : 'playlist';
  const sourceUrl = kind === 'mix'
    ? `https://www.youtube.com/watch?list=${encodeURIComponent(id)}`
    : `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`;
  const declaredItemCount = Number.isInteger(value.itemCount)
    ? Math.max(items.length, Math.min(100000, value.itemCount))
    : items.length;
  return {
    id,
    title,
    source: 'youtube',
    kind,
    sourceUrl,
    channel: cleanRepeatedLabel(value.channel).slice(0, 200),
    thumbnail: safeImage(value.thumbnail),
    itemCount: declaredItemCount,
    complete: value.complete === true,
    items
  };
}

async function readBody(request, maxCharacters = 2_000_000) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxCharacters) throw new RangeError('Request too large');
  }
  return JSON.parse(body);
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(localizeCachedImages(value)));
}

const modeSetting = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'network_mode'").get();
let networkMode = modeSetting?.value === 'offline' ? 'offline' : 'online';
const explicitOfflineSetting = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'explicit_offline_preference'").get();
let explicitOfflinePreference = explicitOfflineSetting ? explicitOfflineSetting.value === 'true' : networkMode === 'offline';
const reconnectOnlineSetting = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'auto_online_after_connectivity_loss'").get();
let autoOnlineAfterConnectivityLoss = reconnectOnlineSetting?.value === 'true' && networkMode === 'offline';
const youtubeRateLimitUntilKey = 'youtube_rate_limit_until';
const youtubeRateLimitReasonKey = 'youtube_rate_limit_reason';
const youtubeRateLimitCooldownMs = 30 * 60_000;
let youtubeRateLimitUntil = Date.parse(database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(youtubeRateLimitUntilKey)?.value || '') || 0;
let youtubeRateLimitReason = database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(youtubeRateLimitReasonKey)?.value || '';
let youtubeRateLimitResumePending = youtubeRateLimitUntil > 0;
const persistAppSetting = (key, value) => database.prepare(`INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`)
  .run(key, String(value), new Date().toISOString());
if (!explicitOfflineSetting) persistAppSetting('explicit_offline_preference', explicitOfflinePreference);
if (reconnectOnlineSetting?.value === 'true' && !autoOnlineAfterConnectivityLoss) persistAppSetting('auto_online_after_connectivity_loss', false);
const autoDeleteSetting = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'auto_delete_enabled'").get();
let autoDeleteEnabled = autoDeleteSetting?.value === 'true';
const mediaLifetimeMs = 24 * 60 * 60 * 1000;
const autoDeletePostponeWindowMs = 5 * 60 * 1000;
const finishDownloadAfterMs = 20 * 60 * 1000;
function finishWindowElapsed(startedAt) {
  const startedAtMs = Date.parse(startedAt || '');
  return Number.isFinite(startedAtMs) && Date.now() - startedAtMs >= finishDownloadAfterMs;
}
function expiryFromAcquisition(acquiredAt) {
  const acquiredAtMs = Date.parse(acquiredAt);
  return Number.isFinite(acquiredAtMs) ? new Date(acquiredAtMs + mediaLifetimeMs).toISOString() : '';
}
if (autoDeleteEnabled) {
  const readyMedia = database.prepare("SELECT video_id AS id, acquired_at AS acquiredAt, expires_at AS expiresAt, expiry_paused_ms AS pausedMs FROM downloads WHERE status = 'ready' AND origin <> 'media-folder'").all();
  const updateReadyExpiry = database.prepare("UPDATE downloads SET expires_at = ?, expiry_paused_ms = ? WHERE video_id = ? AND status = 'ready'");
  for (const media of readyMedia) {
    if (media.expiresAt) continue;
    const now = Date.now();
    const expiresAt = media.pausedMs !== null ? new Date(now + Math.max(0, media.pausedMs)).toISOString() : expiryFromAcquisition(media.acquiredAt);
    updateReadyExpiry.run(expiresAt, null, media.id);
  }
} else {
  // Older versions left active deadlines in place while Auto-delete was off.
  // Freeze those remaining durations during upgrade so re-enabling resumes them.
  const readyMedia = database.prepare("SELECT video_id AS id, expires_at AS expiresAt FROM downloads WHERE status = 'ready' AND origin <> 'media-folder' AND expires_at <> '' AND expiry_paused_ms IS NULL").all();
  const pauseReadyExpiry = database.prepare("UPDATE downloads SET expires_at = '', expiry_paused_ms = ? WHERE video_id = ? AND status = 'ready' AND expires_at = ?");
  const now = Date.now();
  for (const media of readyMedia) {
    const deadline = Date.parse(media.expiresAt);
    pauseReadyExpiry.run(Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0, media.id, media.expiresAt);
  }
}
const offlinePreparationTarget = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'offline_preparation_target'").get()?.value || 'online';
const skipCommentAvatarPreparationSetting = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'skip_comment_avatar_preparation'").get();
let skipCommentAvatarPreparation = skipCommentAvatarPreparationSetting?.value === 'true';
const savedOfflinePreparation = {
  phase: database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'offline_preparation_phase'").get()?.value || 'video lengths',
  completed: Number(database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'offline_preparation_completed'").get()?.value) || 0,
  total: Number(database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'offline_preparation_total'").get()?.value) || 0
};
let offlinePreparationPaused = offlinePreparationTarget === 'paused' && networkMode === 'offline';
let offlinePreparationBackground = networkMode !== 'offline' && ['paused', 'background'].includes(offlinePreparationTarget);
let offlinePreparationRequested = offlinePreparationTarget === 'offline';
let offlinePreparation = offlinePreparationPaused
  ? { ...savedOfflinePreparation, status: 'paused', message: 'Preparation paused. It will resume in the background when you switch Online.' }
  : offlinePreparationBackground
    ? { ...savedOfflinePreparation, status: 'queued', message: 'Resuming local preparation in the background…' }
    : offlinePreparationRequested && networkMode !== 'offline'
      ? { status: 'queued', phase: 'comments', completed: 0, total: 0, message: 'Resuming offline preparation…' }
      : { status: 'idle', phase: 'comments', completed: 0, total: 0, message: '' };
let offlinePreparationRun = 0;
let networkModeRequestGeneration = 0;
let noInternetFallback = false;
let connectivityNotice = '';
let connectivityStatus = { available: null, checkedAt: '' };
let connectivityCheck = null;
let connectivityFailureCount = 0;
const connectivityFailuresBeforeOffline = 3;
const youtubeRateLimitIsActive = () => youtubeRateLimitUntil > Date.now();
function youtubeRateLimitMessage() {
  const source = youtubeRateLimitReason || 'YouTube returned HTTP 429 Too Many Requests.';
  return `${source} YourTube switched to Local mode and paused new YouTube captures and downloads for 30 minutes. Existing transfers can finish; local media remains available. YourTube will return Online after the pause unless you chose Offline.`;
}
const reportedNetworkMode = () => networkMode !== 'offline' && (offlinePreparationRequested || !offlinePreparationBackground && ['queued', 'running'].includes(offlinePreparation.status)) ? 'preparing' : networkMode;
const mediaDiscoveryPaused = () => reportedNetworkMode() !== 'online';
function setOfflinePreparationTarget(target) {
  persistAppSetting('offline_preparation_target', target);
}
function setExplicitOfflinePreference(enabled) {
  explicitOfflinePreference = Boolean(enabled);
  persistAppSetting('explicit_offline_preference', explicitOfflinePreference);
}
function setAutoOnlineAfterConnectivityLoss(enabled) {
  autoOnlineAfterConnectivityLoss = Boolean(enabled);
  persistAppSetting('auto_online_after_connectivity_loss', autoOnlineAfterConnectivityLoss);
}
function saveOfflinePreparationCheckpoint(preparation = offlinePreparation) {
  const now = new Date().toISOString();
  const update = database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at");
  update.run('offline_preparation_phase', String(preparation.phase || 'video lengths'), now);
  update.run('offline_preparation_completed', String(Number(preparation.completed) || 0), now);
  update.run('offline_preparation_total', String(Number(preparation.total) || 0), now);
}
const connectivityEndpoints = [
  'https://www.google.com/generate_204',
  'https://connectivitycheck.gstatic.com/generate_204',
  'https://www.youtube.com/generate_204'
];
async function checkInternetConnectivity() {
  if (connectivityCheck) return connectivityCheck;
  connectivityCheck = Promise.any(connectivityEndpoints.map(async endpoint => {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(4500), redirect: 'manual', cache: 'no-store' });
    if (response.status !== 204) throw new Error(`Connectivity probe returned ${response.status}`);
    return true;
  })).then(() => {
    connectivityFailureCount = 0;
    connectivityStatus = { available: true, checkedAt: new Date().toISOString() };
    return true;
  }).catch(() => {
    connectivityFailureCount += 1;
    if (connectivityFailureCount >= connectivityFailuresBeforeOffline) {
      connectivityStatus = { available: false, checkedAt: new Date().toISOString() };
    } else {
      connectivityStatus = { ...connectivityStatus, checkedAt: new Date().toISOString() };
    }
    return false;
  }).finally(() => { connectivityCheck = null; });
  return connectivityCheck;
}
function switchOfflineForConnectionLoss() {
  networkModeRequestGeneration += 1;
  offlinePreparationRun += 1;
  const preservePreparation = offlinePreparationPaused || offlinePreparationBackground || offlinePreparationRequested || ['queued', 'running'].includes(offlinePreparation.status);
  const pausedPreparation = preservePreparation ? { ...offlinePreparation } : null;
  offlinePreparationRequested = false;
  offlinePreparationBackground = false;
  offlinePreparationPaused = Boolean(pausedPreparation);
  networkMode = 'offline';
  const shouldReconnectOnline = !explicitOfflinePreference;
  setAutoOnlineAfterConnectivityLoss(shouldReconnectOnline);
  offlinePreparation = pausedPreparation
    ? { ...pausedPreparation, status: 'paused', message: shouldReconnectOnline
      ? 'Preparation is paused while the internet is unavailable. It will resume when YourTube returns Online.'
      : 'Preparation remains paused. Reconnect, then switch Online to resume it in the background.' }
    : { status: 'idle', phase: 'comments', completed: 0, total: 0, message: '' };
  noInternetFallback = true;
  connectivityNotice = shouldReconnectOnline
    ? 'No internet connection detected. YourTube switched Offline and will return Online when the connection is restored.'
    : 'No internet connection detected. YourTube switched Offline and will stay Offline until you turn Online on.';
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('network_mode', 'offline', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = 'offline', updated_at = excluded.updated_at").run(now);
  if (offlinePreparationPaused) {
    setOfflinePreparationTarget('paused');
  } else {
    setOfflinePreparationTarget('online');
  }
  database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('offline_preparation_phase', ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at").run(offlinePreparation.phase, now);
  database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('offline_preparation_completed', ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at").run(String(offlinePreparation.completed || 0), now);
  database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('offline_preparation_total', ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at").run(String(offlinePreparation.total || 0), now);
  if (offlinePreparationPaused) saveOfflinePreparationCheckpoint(offlinePreparation);
  pauseRetryQueueForOffline();
}
function switchOnlineAfterConnectivityRestore(automatic = false) {
  const resumePreparation = offlinePreparationPaused;
  const resumePhase = offlinePreparation.phase || 'video lengths';
  const resumeCompleted = Number(offlinePreparation.completed) || 0;
  const resumeTotal = Number(offlinePreparation.total) || 0;
  offlinePreparationRun += 1;
  offlinePreparationRequested = false;
  offlinePreparationPaused = false;
  offlinePreparationBackground = resumePreparation;
  networkMode = 'online';
  setExplicitOfflinePreference(false);
  setAutoOnlineAfterConnectivityLoss(false);
  noInternetFallback = false;
  connectivityNotice = automatic ? 'Internet restored · Online automatically.' : '';
  const now = new Date().toISOString();
  // Resume the original schedule. Resetting next_retry_at here made every
  // Online toggle extend the wait, even when the retry was already due.
  database.prepare("UPDATE download_retry_queue SET status = 'pending', updated_at = ? WHERE status = 'paused-offline'").run(now);
  database.prepare("UPDATE downloads SET status = 'error', message = 'Retry queued after returning Online.', stage = 'Waiting to retry', updated_at = ? WHERE status = 'paused-offline'").run(now);
  setOfflinePreparationTarget(resumePreparation ? 'background' : 'online');
  offlinePreparation = resumePreparation
    ? { status: 'queued', phase: resumePhase, completed: resumeCompleted, total: resumeTotal, message: 'Resuming preparation in the background while YourTube stays Online.' }
    : { status: 'idle', phase: 'comments', completed: 0, total: 0, message: '' };
  persistAppSetting('network_mode', 'online');
  if (resumePreparation) saveOfflinePreparationCheckpoint(offlinePreparation);
  if (resumePreparation) setTimeout(() => {
    if (networkMode === 'online' && offlinePreparationBackground) prepareOfflineCache({ backgroundOnly: true }).catch(error => console.error('Background preparation:', error));
  }, 0);
}
function reportYouTubeRateLimit(reason = 'YouTube returned HTTP 429 Too Many Requests.') {
  if (youtubeRateLimitIsActive()) return;
  const now = Date.now();
  youtubeRateLimitUntil = now + youtubeRateLimitCooldownMs;
  youtubeRateLimitReason = String(reason || 'YouTube returned HTTP 429 Too Many Requests.').replace(/\s+/g, ' ').slice(0, 220);
  youtubeRateLimitResumePending = !explicitOfflinePreference;
  const updatedAt = new Date(now).toISOString();
  const setting = database.prepare(`INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`);
  setting.run(youtubeRateLimitUntilKey, new Date(youtubeRateLimitUntil).toISOString(), updatedAt);
  setting.run(youtubeRateLimitReasonKey, youtubeRateLimitReason, updatedAt);
  if (!explicitOfflinePreference) {
    if (networkMode !== 'offline') switchOfflineForConnectionLoss();
    setAutoOnlineAfterConnectivityLoss(true);
    noInternetFallback = false;
    if (offlinePreparationPaused) {
      offlinePreparation = { ...offlinePreparation, status: 'paused', message: 'Background preparation is paused because YouTube is rate limiting requests. It will resume when the Online pause ends.' };
      setOfflinePreparationTarget('paused');
      saveOfflinePreparationCheckpoint(offlinePreparation);
    }
  }
  connectivityNotice = youtubeRateLimitMessage();
}
async function finishYouTubeRateLimitPause(probeAvailable) {
  if (!youtubeRateLimitUntil || youtubeRateLimitUntil > Date.now()) return;
  database.prepare('DELETE FROM app_settings WHERE setting_key IN (?, ?)').run(youtubeRateLimitUntilKey, youtubeRateLimitReasonKey);
  youtubeRateLimitUntil = 0;
  youtubeRateLimitReason = '';
  if (explicitOfflinePreference) {
    youtubeRateLimitResumePending = false;
    setAutoOnlineAfterConnectivityLoss(false);
    connectivityNotice = 'The YouTube request pause ended. YourTube remains Local because Offline was selected.';
    return;
  }
  youtubeRateLimitResumePending = true;
  setAutoOnlineAfterConnectivityLoss(true);
  if (probeAvailable && networkMode === 'offline') {
    switchOnlineAfterConnectivityRestore(true);
    connectivityNotice = 'The YouTube request pause ended. YourTube is Online again.';
    youtubeRateLimitResumePending = false;
  }
}
async function monitorInternetConnectivity() {
  const requestGeneration = networkModeRequestGeneration;
  const probeAvailable = await checkInternetConnectivity();
  if (requestGeneration !== networkModeRequestGeneration) return;
  if (connectivityStatus.available === false && networkMode === 'online') switchOfflineForConnectionLoss();
  await finishYouTubeRateLimitPause(probeAvailable);
  if (probeAvailable && autoOnlineAfterConnectivityLoss && !explicitOfflinePreference && !youtubeRateLimitIsActive() && networkMode === 'offline') {
    networkModeRequestGeneration += 1;
    switchOnlineAfterConnectivityRestore(true);
    if (youtubeRateLimitResumePending) connectivityNotice = 'The YouTube request pause ended and your connection is available. YourTube is Online again.';
    youtubeRateLimitResumePending = false;
  }
}
const imageKey = source => createHash('sha256').update(source).digest('hex');
const imageFields = new Set(['thumbnail', 'avatar', 'authorThumbnail', 'banner', 'channelBanner']);
const cachedImageLookup = database.prepare('SELECT image_key AS key FROM cached_images WHERE source_url = ?');
const videoThumbnailAssetLookup = database.prepare('SELECT source_url AS sourceUrl, image_key AS key FROM video_thumbnail_assets WHERE video_id = ?');
const insertVideoThumbnailAsset = database.prepare(`INSERT OR IGNORE INTO video_thumbnail_assets (video_id, source_url, image_key, stored_at)
  SELECT ?, source_url, image_key, ? FROM cached_images WHERE source_url = ?`);
const updateVideoThumbnailCanonical = database.prepare('UPDATE videos SET thumbnail = ? WHERE video_id = ? AND thumbnail <> ?');
const deleteVideoThumbnailAsset = database.prepare('DELETE FROM video_thumbnail_assets WHERE video_id = ?');
const downloadedMetadataLookup = database.prepare(`SELECT m.status, m.phase, m.message
  FROM downloads d LEFT JOIN download_metadata m ON m.video_id = d.video_id
  WHERE d.video_id = ? AND d.status = 'ready'`);
const omittedExtractorMetadataFields = new Set([
  'comments', 'formats', 'requested_formats', 'requested_downloads', 'url', 'urls', 'manifest_url',
  'fragment_base_url', 'fragments', 'http_headers', 'headers', 'cookies', 'protocol', 'filename',
  'filepath', '_filename', 'downloader_options'
]);
function existingCachedImage(source) {
  if (!source) return null;
  const cached = cachedImageLookup.get(source);
  if (!cached) return null;
  if (existsSync(path.join(imageCacheDirectory, cached.key))) return cached;
  database.prepare('DELETE FROM cached_images WHERE source_url = ?').run(source);
  return null;
}
function existingVideoThumbnail(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || ''))) return null;
  const asset = videoThumbnailAssetLookup.get(id);
  if (!asset) return null;
  const cached = existingCachedImage(asset.sourceUrl);
  if (!cached || cached.key !== asset.key) {
    deleteVideoThumbnailAsset.run(id);
    return null;
  }
  return { ...cached, sourceUrl: asset.sourceUrl };
}
function rememberVideoThumbnail(id, source) {
  // INSERT OR IGNORE deliberately keeps the first local thumbnail chosen for this video.
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || '')) || !source) return null;
  const existing = existingVideoThumbnail(id);
  if (existing) return existing;
  const cached = existingCachedImage(source);
  if (!cached) return null;
  insertVideoThumbnailAsset.run(id, new Date().toISOString(), source);
  const linked = existingVideoThumbnail(id);
  if (linked) updateVideoThumbnailCanonical.run(linked.sourceUrl, id, linked.sourceUrl);
  return linked;
}
function localizeCachedImages(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(localizeCachedImages);
  const result = {};
  const videoId = String(value.id || value.video_id || '');
  for (const [key, item] of Object.entries(value)) {
    const source = key === 'thumbnail' && !item && /^[A-Za-z0-9_-]{11}$/.test(videoId)
      ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      : item;
    if (imageFields.has(key) && typeof source === 'string' && source.trim()) {
      if (source.startsWith('//')) {
        result[key] = '';
        continue;
      }
      if (source.startsWith('/') || !/^[a-z][a-z0-9+.-]*:/i.test(source)) {
        result[key] = source;
        continue;
      }
      let imageUrl;
      try { imageUrl = new URL(source); } catch {}
      if (imageUrl?.protocol !== 'https:') {
        result[key] = '';
        continue;
      }
      const normalizedSource = imageUrl.href;
      const isVideoThumbnail = key === 'thumbnail' && /^[A-Za-z0-9_-]{11}$/.test(videoId);
      const linkedThumbnail = isVideoThumbnail ? existingVideoThumbnail(videoId) : null;
      const cached = linkedThumbnail || existingCachedImage(normalizedSource);
      if (cached) {
        if (isVideoThumbnail && !linkedThumbnail) rememberVideoThumbnail(videoId, normalizedSource);
        result[key] = `/api/images/${cached.key}`;
      } else if (networkMode === 'offline' || youtubeRateLimitIsActive() || !isAllowedYoutubeImageSource(normalizedSource)) result[key] = '';
      else result[key] = `/api/remote-image?src=${encodeURIComponent(normalizedSource)}${isVideoThumbnail ? `&video_id=${encodeURIComponent(videoId)}` : ''}`;
    } else result[key] = localizeCachedImages(item);
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    const metadata = downloadedMetadataLookup.get(videoId);
    if (metadata) {
      result.metadataStatus = metadata.status || 'pending';
      result.metadataPhase = metadata.phase || 'queued';
      result.metadataMessage = metadata.message || 'Preparing local metadata for this media.';
    }
  }
  return result;
}

// Recover image ownership for thumbnails cached before the per-video invariant was added.
for (const row of database.prepare('SELECT video_id AS id, local_assets_json AS assets FROM video_metadata').all()) {
  let assets = [];
  try { assets = JSON.parse(row.assets || '[]'); } catch {}
  const thumbnail = Array.isArray(assets) ? assets.find(asset => asset?.type === 'thumbnail' && asset.sourceUrl) : null;
  if (thumbnail) rememberVideoThumbnail(row.id, thumbnail.sourceUrl);
}
for (const row of database.prepare(`SELECT v.video_id AS id, v.thumbnail FROM videos v
  JOIN cached_images ci ON ci.source_url = v.thumbnail WHERE trim(v.thumbnail) <> ''`).all()) {
  rememberVideoThumbnail(row.id, row.thumbnail);
}
function isAllowedYoutubeImageSource(source) {
  try {
    const image = new URL(source);
    return image.protocol === 'https:' && /(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com|youtube\.com)$/i.test(image.hostname);
  } catch { return false; }
}
const remoteImageInFlight = new Map();
const remoteImageRetryAfter = new Map();
let remoteImageActive = 0;
let remoteImageWaiting = 0;
let remoteImageNextStartAt = 0;
async function acquireRemoteImageSlot() {
  if (remoteImageWaiting >= 160) return false;
  remoteImageWaiting += 1;
  while (remoteImageActive >= 2) await waitForBackground(50);
  remoteImageWaiting -= 1;
  remoteImageActive += 1;
  const startAt = Math.max(Date.now(), remoteImageNextStartAt);
  remoteImageNextStartAt = startAt + 400;
  if (startAt > Date.now()) await waitForBackground(startAt - Date.now());
  if (youtubeRateLimitIsActive()) {
    remoteImageActive -= 1;
    return false;
  }
  return true;
}
async function cacheRemoteImage(source) {
  if (!source || !/^https:\/\//i.test(source)) return false;
  if (existingCachedImage(source)) return true;
  if (youtubeRateLimitIsActive() || !isAllowedYoutubeImageSource(source)) return false;
  const retryAt = remoteImageRetryAfter.get(source) || 0;
  if (retryAt > Date.now()) return false;
  if (retryAt) remoteImageRetryAfter.delete(source);
  if (remoteImageInFlight.has(source)) return remoteImageInFlight.get(source);
  const pending = (async () => {
    let current;
    try { current = new URL(source); } catch { return false; }
    if (!await acquireRemoteImageSlot()) return false;
    try {
      let response;
      for (let redirects = 0; redirects <= 4; redirects += 1) {
        response = await fetch(current, { signal: AbortSignal.timeout(12_000), redirect: 'manual', cache: 'no-store' });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || redirects === 4) return false;
        current = new URL(location, current);
        if (!isAllowedYoutubeImageSource(current.href)) return false;
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => {});
        reportYouTubeRateLimit('YouTube’s image service returned HTTP 429 Too Many Requests.');
        remoteImageRetryAfter.set(source, youtubeRateLimitUntil);
        return false;
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() || '';
      if (!response.ok || !contentType.startsWith('image/')) {
        remoteImageRetryAfter.set(source, Date.now() + (response.status === 404 ? 6 * 60 * 60_000 : 60_000));
        return false;
      }
      const declaredSize = Number(response.headers.get('content-length')) || 0;
      if (declaredSize > 8_000_000) return false;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 8_000_000) return false;
      const key = imageKey(source);
      await writeFile(path.join(imageCacheDirectory, key), bytes);
      database.prepare('INSERT OR REPLACE INTO cached_images (image_key, source_url, content_type, cached_at) VALUES (?, ?, ?, ?)')
        .run(key, source, contentType.split(';')[0], new Date().toISOString());
      remoteImageRetryAfter.delete(source);
      return true;
    } catch {
      remoteImageRetryAfter.set(source, Date.now() + 60_000);
      return false;
    } finally {
      remoteImageActive = Math.max(0, remoteImageActive - 1);
    }
  })().finally(() => remoteImageInFlight.delete(source));
  remoteImageInFlight.set(source, pending);
  return pending;
}
const waitForBackground = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function pauseRetryQueueForOffline() {
  const now = new Date().toISOString();
  const pending = database.prepare("SELECT video_id AS id FROM download_retry_queue WHERE status IN ('pending', 'waiting-live')").all();
  database.prepare("UPDATE download_retry_queue SET status = 'paused-offline', updated_at = ? WHERE status IN ('pending', 'waiting-live')").run(now);
  for (const { id } of pending) {
    database.prepare("UPDATE downloads SET status = 'paused-offline', message = 'Paused for Offline mode. It will resume when Online.', stage = 'Paused for Offline mode', updated_at = ? WHERE video_id = ? AND status = 'error'").run(now, id);
  }
}

function markDownloadPausedOffline(id) {
  const now = new Date().toISOString();
  const attempts = database.prepare('SELECT attempts FROM download_retry_queue WHERE video_id = ?').get(id)?.attempts || 0;
  const message = 'Paused for Offline mode. It will resume when Online.';
  database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
    VALUES (?, ?, 'paused-offline', ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET
    status = 'paused-offline', next_retry_at = excluded.next_retry_at, last_error = excluded.last_error, updated_at = excluded.updated_at`)
    .run(id, attempts, now, message, now);
  saveDownload(id, 'paused-offline', message, 0, 'Paused for Offline mode');
}

function queueCancelledDownloadForOnline(id) {
  const now = new Date();
  const attempts = database.prepare('SELECT attempts FROM download_retry_queue WHERE video_id = ?').get(id)?.attempts || 0;
  const retryAt = new Date(now.getTime() + downloadRetryDelay).toISOString();
  const message = 'Retry queued after returning Online.';
  database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
    VALUES (?, ?, 'pending', ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET
    status = 'pending', next_retry_at = excluded.next_retry_at, last_error = excluded.last_error, updated_at = excluded.updated_at`)
    .run(id, attempts, retryAt, message, now.toISOString());
  saveDownload(id, 'error', message, 0, 'Waiting to retry');
}

function markDownloadPausedByUser(id, progress, message = 'Paused by you. Choose Retry to resume this download.') {
  const now = new Date().toISOString();
  const attempts = database.prepare('SELECT attempts FROM download_retry_queue WHERE video_id = ?').get(id)?.attempts || 0;
  database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
    VALUES (?, ?, 'paused', ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET
    attempts = excluded.attempts, status = 'paused', next_retry_at = excluded.next_retry_at,
    last_error = excluded.last_error, updated_at = excluded.updated_at`)
    .run(id, attempts, now, message, now);
  saveDownload(id, 'paused', message, progress, 'Paused by you');
}

function markFinishWaitingForOnline(id, progress) {
  const now = new Date().toISOString();
  const attempts = database.prepare('SELECT attempts FROM download_retry_queue WHERE video_id = ?').get(id)?.attempts || 0;
  const message = 'Finish and save is waiting for Online mode. The captured video is preserved.';
  database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
    VALUES (?, ?, 'paused', ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET
    status = 'paused', next_retry_at = excluded.next_retry_at, last_error = excluded.last_error, updated_at = excluded.updated_at`)
    .run(id, attempts, now, message, now);
  saveDownload(id, 'paused', message, progress, 'Waiting to finish and save while Online');
}

async function pauseMetadataOnlyDownloads() {
  for (const [id, job] of jobs) {
    if (job.transferStarted || job.finishRequested || job.endRequested || job.discardRequested) continue;
    if (await currentDownloadBytes(id) > 0) {
      job.transferStarted = true;
      continue;
    }
    job.offlinePauseRequested = true;
    job.stage = 'Pausing before media transfer for Offline mode…';
    saveDownload(id, 'downloading', '', job.progress, job.stage);
    try { job.process.kill('SIGINT'); } catch {}
  }
}

async function waitForDownloadsBeforeOffline(runId) {
  const initial = jobs.size;
  if (!initial) return;
  while (runId === offlinePreparationRun && (jobs.size || downloadedMetadataWorkerRunning)) {
    const activeTransfers = [...jobs.values()].filter(job => job.transferStarted && !job.offlinePauseRequested).length;
    offlinePreparation = {
      status: 'running', phase: 'downloads', completed: Math.max(0, initial - jobs.size), total: initial + (downloadedMetadataWorkerRunning ? 1 : 0),
      message: activeTransfers ? `Waiting for ${activeTransfers} active media ${activeTransfers === 1 ? 'download' : 'downloads'} to finish…` : downloadedMetadataWorkerRunning ? 'Finishing the current local metadata pass before Offline mode…' : 'Pausing download attempts before Offline mode…'
    };
    await waitForBackground(500);
  }
}

async function prepareOfflineCache({ backgroundOnly = false } = {}) {
  if (offlinePreparation.status === 'running' && !offlinePreparationPaused) return;
  const runId = ++offlinePreparationRun;
  offlinePreparationPaused = false;
  offlinePreparationBackground = backgroundOnly;
  offlinePreparation = {
    status: 'running', phase: backgroundOnly ? 'video lengths' : 'downloads', completed: 0, total: backgroundOnly ? 0 : jobs.size,
    message: backgroundOnly ? 'Resuming local preparation in the background…' : 'Waiting for active media downloads…'
  };
  (async () => {
    if (!backgroundOnly) {
      await waitForDownloadsBeforeOffline(runId);
      if (runId !== offlinePreparationRun) return;
    }
    const durationRows = database.prepare(`SELECT v.video_id AS id, v.url FROM videos v
      LEFT JOIN video_duration_lookups l ON l.video_id = v.video_id
      WHERE trim(v.duration) = '' AND (l.status IS NULL OR l.status IN ('pending', 'running')
        OR l.status = 'ready'
        OR EXISTS (SELECT 1 FROM downloads d WHERE d.video_id = v.video_id AND d.status = 'ready')
        OR EXISTS (SELECT 1 FROM video_progress p WHERE p.video_id = v.video_id AND p.duration > 0))
      ORDER BY v.last_seen DESC`).all();
    offlinePreparation = { status: 'running', phase: 'video lengths', completed: 0, total: durationRows.length, message: 'Preparing video lengths…' };
    let durationWarning = '';
    for (const video of durationRows) {
      if (runId !== offlinePreparationRun) return;
      const currentLengthIndex = Math.min(offlinePreparation.completed + 1, offlinePreparation.total);
      offlinePreparation.current = currentLengthIndex;
      offlinePreparation.message = `Preparing video lengths · ${currentLengthIndex}/${offlinePreparation.total}`;
      const existingLookupWaitStarted = Date.now();
      while (runId === offlinePreparationRun) {
        const activeLookup = database.prepare("SELECT video_id AS id, updated_at AS updatedAt FROM video_duration_lookups WHERE status = 'running' ORDER BY updated_at LIMIT 1").get();
        if (!activeLookup) break;
        if (Date.now() - existingLookupWaitStarted >= 35_000) {
          setDurationLookup(activeLookup.id, 'pending', 'Previous metadata lookup did not finish; retrying.');
          break;
        }
        offlinePreparation.message = `Preparing video lengths · ${currentLengthIndex}/${offlinePreparation.total} · waiting for an active lookup…`;
        await waitForBackground(500);
      }
      if (runId !== offlinePreparationRun) return;
      const existingDuration = database.prepare('SELECT duration FROM videos WHERE video_id = ?').get(video.id)?.duration;
      const lookupStatus = database.prepare('SELECT status FROM video_duration_lookups WHERE video_id = ?').get(video.id)?.status;
      if (String(existingDuration || '').trim()) {
        offlinePreparation.completed += 1;
        offlinePreparation.current = offlinePreparation.completed;
        offlinePreparation.message = `Preparing video lengths · ${offlinePreparation.completed}/${offlinePreparation.total}`;
        continue;
      }
      const progressDuration = database.prepare('SELECT duration FROM video_progress WHERE video_id = ?').get(video.id)?.duration;
      const knownDuration = formatDurationSeconds(progressDuration);
      const localDuration = knownDuration || await probeLocalDuration(video.id);
      if (localDuration) saveDurationLabel(video.id, localDuration);
      else {
        if (lookupStatus === 'unavailable') {
          offlinePreparation.completed += 1;
          offlinePreparation.current = offlinePreparation.completed;
          offlinePreparation.message = `Preparing video lengths · ${offlinePreparation.completed}/${offlinePreparation.total}`;
          continue;
        }
        const result = await lookupVideoDuration(video.id, video.url);
        if (result.blocked || result.fatal) {
          durationWarning = result.fatal ? 'yt-dlp is unavailable; some video lengths could not be prepared.' : 'YouTube temporarily limited metadata lookups; some video lengths could not be prepared.';
          offlinePreparation.completed += 1;
          offlinePreparation.current = offlinePreparation.completed;
          offlinePreparation.message = `Preparing video lengths · ${offlinePreparation.completed}/${offlinePreparation.total}`;
          break;
        }
      }
      offlinePreparation.completed += 1;
      offlinePreparation.current = offlinePreparation.completed;
      offlinePreparation.message = `Preparing video lengths · ${offlinePreparation.completed}/${offlinePreparation.total}`;
      await waitForBackground(1800);
    }
    if (runId !== offlinePreparationRun) return;
    const ids = database.prepare("SELECT d.video_id AS id FROM downloads d WHERE d.status = 'ready' ORDER BY d.acquired_at DESC").all().map(row => row.id);
    const subscriptions = database.prepare('SELECT avatar FROM subscriptions WHERE length(avatar) > 0').all().map(row => row.avatar);
    const videoRows = database.prepare("SELECT video_id AS id, thumbnail, avatar FROM videos WHERE video_id IN (SELECT video_id FROM downloads WHERE status = 'ready')").all();
    const videoThumbnails = videoRows.map(row => existingVideoThumbnail(row.id)?.sourceUrl || row.thumbnail || `https://i.ytimg.com/vi/${row.id}/hqdefault.jpg`);
    const channelAvatars = videoRows.map(row => row.avatar).filter(Boolean).concat(subscriptions);
    offlinePreparation = { status: 'running', phase: 'comments', completed: 0, total: ids.length, message: 'Preparing comments…' };
    const commentImages = new Set();
    let nextVideo = 0;
    const commentWorkers = Array.from({ length: Math.min(3, ids.length) }, async () => {
      while (runId === offlinePreparationRun) {
        const index = nextVideo++;
        if (index >= ids.length) return;
        const id = ids[index];
        const current = database.prepare('SELECT status FROM video_comments WHERE video_id = ?').get(id);
        if (!current || current.status === 'error') beginComments(id);
        const deadline = Date.now() + 95_000;
        while (runId === offlinePreparationRun && commentJobs.has(id) && Date.now() < deadline) await waitForBackground(500);
        if (runId !== offlinePreparationRun) return;
        for (const comment of getComments(id)?.comments || []) {
          if (comment.authorThumbnail) commentImages.add(comment.authorThumbnail);
        }
        offlinePreparation.completed += 1;
      }
    });
    await Promise.all(commentWorkers);
    if (runId !== offlinePreparationRun) return;
    const seenImages = new Set();
    async function cacheImagePhase(phase, sourceImages) {
      const shouldSkipPhase = () => phase === 'comment avatars' && skipCommentAvatarPreparation;
      if (shouldSkipPhase()) {
        offlinePreparation = { status: 'running', phase, completed: 0, total: 0, skippedPhases: [phase], message: 'Comment avatar caching is skipped by your setting; continuing preparation.' };
        return;
      }
      const images = [...new Set(sourceImages.filter(Boolean))].filter(source => {
        if (seenImages.has(source)) return false;
        seenImages.add(source);
        return !existingCachedImage(source);
      });
      offlinePreparation = { status: 'running', phase, completed: 0, total: images.length, message: `Preparing ${phase}…` };
      let nextImage = 0;
      const imageWorkers = Array.from({ length: Math.min(6, images.length) }, async () => {
        while (runId === offlinePreparationRun && !shouldSkipPhase()) {
          const index = nextImage++;
          if (index >= images.length) return;
          await cacheRemoteImage(images[index]);
          if (runId !== offlinePreparationRun) return;
          offlinePreparation.completed += 1;
        }
      });
      await Promise.all(imageWorkers);
      if (shouldSkipPhase() && runId === offlinePreparationRun) {
        offlinePreparation.skippedPhases = [...new Set([...(offlinePreparation.skippedPhases || []), phase])];
        offlinePreparation.message = 'Comment avatar caching skipped by your setting; continuing preparation.';
      }
    }
    await cacheImagePhase('thumbnails', videoThumbnails);
    if (runId !== offlinePreparationRun) return;
    for (const video of videoRows) {
      const source = existingVideoThumbnail(video.id)?.sourceUrl || video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
      if (!existingCachedImage(source)) continue;
      rememberVideoThumbnail(video.id, source);
      if (video.thumbnail !== source) database.prepare('UPDATE videos SET thumbnail = ? WHERE video_id = ?').run(source, video.id);
    }
    await cacheImagePhase('avatars', channelAvatars);
    if (runId !== offlinePreparationRun) return;
    await cacheImagePhase('comment avatars', [...commentImages]);
    if (runId !== offlinePreparationRun) return;
    const localMetadataPending = reconcileDownloadedMetadata(ids);
    if (!backgroundOnly) {
      networkMode = 'offline';
      database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('network_mode', 'offline', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = 'offline', updated_at = excluded.updated_at").run(new Date().toISOString());
    }
    offlinePreparationRequested = false;
    offlinePreparationPaused = false;
    offlinePreparationBackground = false;
    setOfflinePreparationTarget('online');
    const missingDurations = database.prepare("SELECT COUNT(*) AS count FROM videos WHERE trim(duration) = ''").get().count;
    const durationSummary = missingDurations ? ` ${missingDurations} video lengths remain unavailable.` : '';
    const metadataSummary = localMetadataPending ? ` ${localMetadataPending} downloaded videos still need local metadata; YourTube will retry when Online.` : '';
    offlinePreparation = {
      ...offlinePreparation, status: 'complete', phase: 'complete', completed: offlinePreparation.total,
      message: backgroundOnly
        ? `Background preparation is complete. YourTube remains Online.${durationWarning ? ` ${durationWarning}` : durationSummary}${metadataSummary}`
        : `Offline mode is ready.${durationWarning ? ` ${durationWarning}` : durationSummary}${metadataSummary}`
    };
    saveOfflinePreparationCheckpoint(offlinePreparation);
  })().catch(error => {
    if (runId !== offlinePreparationRun) return;
    if (backgroundOnly) {
      offlinePreparationRequested = false;
      offlinePreparationPaused = false;
      offlinePreparationBackground = false;
      setOfflinePreparationTarget('online');
      offlinePreparation = { ...offlinePreparation, status: 'complete', phase: 'complete', message: `Background preparation stopped with some unavailable items: ${error.message}. YourTube remains Online.` };
      saveOfflinePreparationCheckpoint(offlinePreparation);
      return;
    }
    waitForDownloadsBeforeOffline(runId).then(() => {
      if (runId !== offlinePreparationRun) return;
      networkMode = 'offline';
      database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('network_mode', 'offline', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = 'offline', updated_at = excluded.updated_at").run(new Date().toISOString());
      offlinePreparationRequested = false;
      offlinePreparationPaused = false;
      offlinePreparationBackground = false;
      setOfflinePreparationTarget('online');
      offlinePreparation = { ...offlinePreparation, status: 'complete', message: `Offline mode ready with some unavailable items: ${error.message}` };
      saveOfflinePreparationCheckpoint(offlinePreparation);
    });
  });
}

function saveDownload(id, status, message = '', progress = 0, stage = '') {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const savedDownload = database.prepare('SELECT status, acquired_at AS acquiredAt, started_at AS startedAt, expires_at AS expiresAt, expiry_paused_ms AS pausedMs, origin FROM downloads WHERE video_id = ?').get(id) || null;
  const previous = savedDownload && ['deleted', 'expired'].includes(savedDownload.status) ? null : savedDownload;
  const mediaFolderImport = savedDownload?.origin === 'media-folder' && status !== 'downloading';
  const acquiredAt = status === 'ready' ? previous?.acquiredAt || now : '';
  const startedAt = previous?.startedAt || (status === 'downloading' ? now : '');
  let expiresAt = '';
  let pausedMs = previous?.pausedMs ?? null;
  if (status === 'ready' && mediaFolderImport) {
    expiresAt = '';
    pausedMs = null;
  } else if (status === 'ready' && autoDeleteEnabled) {
    if (previous?.expiresAt) expiresAt = previous.expiresAt;
    else if (previous && previous.pausedMs !== null) {
      expiresAt = new Date(nowMs + Math.max(0, previous.pausedMs)).toISOString();
      pausedMs = null;
    } else expiresAt = expiryFromAcquisition(acquiredAt);
  } else if (status === 'ready' && previous?.expiresAt) {
    const priorExpiryMs = Date.parse(previous.expiresAt);
    const fallbackExpiryMs = Date.parse(expiryFromAcquisition(acquiredAt));
    pausedMs = Math.max(0, (Number.isFinite(priorExpiryMs) ? priorExpiryMs : fallbackExpiryMs) - nowMs);
  }
  database.prepare(`
    INSERT INTO downloads (video_id, status, message, progress, stage, updated_at, acquired_at, expires_at, expiry_paused_ms, started_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'yourtube')
    ON CONFLICT(video_id) DO UPDATE SET status = excluded.status, message = excluded.message,
      progress = excluded.progress, stage = excluded.stage, updated_at = excluded.updated_at,
      origin = CASE WHEN excluded.status = 'downloading' THEN 'yourtube' ELSE downloads.origin END,
      acquired_at = CASE WHEN downloads.status IN ('deleted', 'expired') AND excluded.status IN ('downloading', 'ready') THEN excluded.acquired_at
        WHEN downloads.acquired_at = '' AND excluded.status = 'ready' THEN excluded.acquired_at ELSE downloads.acquired_at END,
      expires_at = CASE WHEN downloads.status IN ('deleted', 'expired') AND excluded.status IN ('downloading', 'ready') THEN excluded.expires_at
        WHEN excluded.status = 'ready' THEN excluded.expires_at ELSE downloads.expires_at END,
      expiry_paused_ms = CASE WHEN downloads.status IN ('deleted', 'expired') AND excluded.status IN ('downloading', 'ready') THEN excluded.expiry_paused_ms
        WHEN excluded.status = 'ready' THEN excluded.expiry_paused_ms ELSE downloads.expiry_paused_ms END,
      started_at = CASE WHEN downloads.status IN ('deleted', 'expired') AND excluded.status IN ('downloading', 'ready') THEN excluded.started_at
        WHEN downloads.started_at = '' AND excluded.started_at <> '' THEN excluded.started_at ELSE downloads.started_at END,
      integrity_status = CASE WHEN excluded.status = 'downloading' THEN 'unchecked' ELSE downloads.integrity_status END,
      integrity_checked_at = CASE WHEN excluded.status = 'downloading' THEN '' ELSE downloads.integrity_checked_at END,
      integrity_file_size = CASE WHEN excluded.status = 'downloading' THEN 0 ELSE downloads.integrity_file_size END,
      integrity_file_mtime_ms = CASE WHEN excluded.status = 'downloading' THEN 0 ELSE downloads.integrity_file_mtime_ms END,
      integrity_checksum = CASE WHEN excluded.status = 'downloading' THEN '' ELSE downloads.integrity_checksum END
  `).run(id, status, message, progress, stage, now, acquiredAt, expiresAt, pausedMs, startedAt);
  if (status === 'ready') {
    database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
    queueDownloadedMetadata(id);
  }
}

const mediaFolderStableMs = 10_000;
const mediaFolderScanMs = 30_000;
const mediaFolderQuietPeriodMs = 2 * 60_000;
const mediaFolderMissingGraceMs = 5 * 60_000;
let mediaFolderLastChangeAt = Date.now();
const mediaFolderCandidates = new Map();
const mediaFolderMissingCandidates = new Map();
const mediaFolderDeferredRechecks = new Set();
const mediaFolderFailedFingerprints = new Map();
const mediaFolderImports = new Set();
const mediaFolderImportJobs = new Map();
const mediaFolderScanState = { available: false, lastScanAt: '', recognizedFiles: 0, unmatchedFiles: [], error: '' };
let mediaFolderScanPromise = null;
let mediaFolderScanAgain = false;
let mediaFolderScanTimer = null;
let mediaFolderWatcher = null;
let shortsMediaFolderWatcher = null;
let mediaFolderWatcherRetryTimer = null;

function releaseDownloadJob(id) {
  jobs.delete(id);
  if (!mediaFolderDeferredRechecks.delete(id)) return;
  mediaFolderCandidates.delete(id);
  mediaFolderFailedFingerprints.delete(id);
  mediaFolderMissingCandidates.delete(id);
  scheduleMediaFolderScan(500);
}

function createMediaFolderIntegrityJob() {
  return {
    mediaFolderImport: true,
    progress: 0,
    integrityChecking: false,
    integrityProgress: null,
    integrityPhase: 'Preparing local integrity check…',
    stage: 'Checking file integrity',
    integrityProcesses: new Set(),
    integrityStreams: new Set(),
    pauseRequested: false
  };
}

function markMediaIntegrityPaused(id) {
  const now = new Date().toISOString();
  const message = 'Integrity check paused. Choose Retry to resume checking this local file.';
  saveDownload(id, 'paused', message, 0, 'Integrity check paused');
  database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
    VALUES (?, 0, 'paused', '', ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET attempts = 0, status = 'paused', next_retry_at = '',
      last_error = excluded.last_error, updated_at = excluded.updated_at`).run(id, message, now);
  return message;
}

function parseMediaFilename(name) {
  const match = /^([A-Za-z0-9_-]{11})\.(webm|mp4)$/.exec(String(name || ''));
  return match ? { id: match[1], extension: match[2].toLowerCase() } : null;
}

function sameMediaFileVersion(left, right) {
  return Boolean(left && right
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino);
}

function scheduleMediaFolderScan(delay = 500) {
  clearTimeout(mediaFolderScanTimer);
  mediaFolderScanTimer = setTimeout(() => {
    mediaFolderScan().catch(error => console.warn('[media-folder] Scan failed:', error.message || error));
  }, delay);
  mediaFolderScanTimer.unref?.();
}

function markMediaFileMissing(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || '')) || jobs.has(id) || downloadStartingIds.has(id) || mediaFolderImports.has(id) || getStoredMediaPath(id)) return false;
  const result = database.prepare(`UPDATE downloads SET status = 'deleted',
    message = 'The media file is no longer in the media folder. Saved video metadata was retained.',
    progress = 0, stage = 'File missing from media folder', updated_at = ?
    WHERE video_id = ? AND status = 'ready'`).run(new Date().toISOString(), id);
  if (result.changes) {
    mediaFolderCandidates.delete(id);
    mediaFolderFailedFingerprints.delete(id);
  }
  return result.changes > 0;
}

function ensureMediaFolderStub(id, now, kind = 'normal') {
  const existing = database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(id);
  if (existing) {
    if (kind === 'short') {
      database.prepare("UPDATE videos SET kind = 'short' WHERE video_id = ?").run(id);
      isolateShortFromStandardFlows(id);
    }
    return false;
  }
  database.prepare(`INSERT OR IGNORE INTO videos
    (video_id, url, title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, kind, section, topic, position, first_seen, last_seen)
    VALUES (?, ?, ?, '', '', '', ?, '', '', 'Imported from the YourTube media folder.', ?, 'search', '', 0, ?, ?)`)
    .run(id, `https://www.youtube.com/watch?v=${id}`, id, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, kind, now, now);
  database.prepare(`INSERT OR IGNORE INTO video_provisions (video_id, category, first_seen, last_seen)
    VALUES (?, 'media-folder', ?, ?)`).run(id, now, now);
  recordVideoProvenance(id, null, now, { sourceType: 'media-folder', sourceKey: id, sourceLabel: 'Media folder' });
  return true;
}

async function importMediaFolderFile(id, filePath, observedStats, fingerprint, kind = 'normal') {
  if (mediaFolderImports.has(id) || integrityVerificationJobs.has(id) || jobs.has(id) || downloadStartingIds.has(id) || isAcquisitionExcluded(id)) return;
  mediaFolderImports.add(id);
  try {
    const activeDownload = database.prepare("SELECT status FROM downloads WHERE video_id = ?").get(id);
    if (activeDownload?.status === 'downloading') return;
    const before = await stat(filePath).catch(() => null);
    if (!before || !sameMediaFileVersion(before, observedStats)) return;

    // The stable final file is now owned by the local integrity queue. Any
    // leftover retry record must not compete with this work as a downloader job.
    database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
    const now = new Date().toISOString();
    ensureMediaFolderStub(id, now, kind);
    const prior = database.prepare(`SELECT status, integrity_status AS integrityStatus FROM downloads WHERE video_id = ?`).get(id);
    if (prior?.status === 'ready' && ['verified', 'container-checked'].includes(prior.integrityStatus)) {
      try {
        await verifyLocalMediaIntegrity(id);
        mediaFolderCandidates.set(id, { fingerprint, firstSeenAt: Date.now(), checked: true });
      } catch (error) {
        const message = await recordMediaIntegrityFailure(id, error);
        if (getStoredMediaPath(id)) mediaFolderFailedFingerprints.set(id, fingerprint);
        else mediaFolderCandidates.delete(id);
        console.warn(`[media-folder] Could not refresh integrity for ${id}:`, message);
      }
      return;
    }
    if (mediaFolderFailedFingerprints.get(id) === fingerprint) return;

    database.prepare(`INSERT INTO downloads (video_id, status, message, progress, stage, updated_at, origin)
      VALUES (?, 'importing', 'Checking a media file found in the media folder.', 0, 'Checking file integrity', ?, 'media-folder')
      ON CONFLICT(video_id) DO UPDATE SET status = 'importing', message = excluded.message,
        progress = 0, stage = excluded.stage, updated_at = excluded.updated_at, origin = 'media-folder'`)
      .run(id, now);
    const integrityJob = createMediaFolderIntegrityJob();
    mediaFolderImportJobs.set(id, integrityJob);
    try {
      const verification = verifyLocalMediaIntegrity(id, { downloadJob: integrityJob });
      if (integrityJob.integrityQueued) {
        database.prepare(`UPDATE downloads SET stage = 'Queued for integrity check',
          message = 'Waiting for the current local integrity check to finish.', updated_at = ? WHERE video_id = ?`)
          .run(new Date().toISOString(), id);
      }
      await verification;
      throwIfIntegrityPaused(integrityJob);
      const currentPath = getStoredMediaPath(id);
      const after = currentPath ? await stat(currentPath).catch(() => null) : null;
      if (!after || !sameMediaFileVersion(after, before)) {
        throw Object.assign(new Error('The media file changed while YourTube was checking it. It will be checked again once copying finishes.'), { code: 'MEDIA_CHANGED' });
      }
      throwIfIntegrityPaused(integrityJob);
      const acquiredAt = new Date().toISOString();
      database.prepare(`UPDATE downloads SET status = 'ready', message = 'Imported from the YourTube media folder.',
        progress = 100, stage = 'Ready to play', updated_at = ?, acquired_at = ?, expires_at = '',
        expiry_paused_ms = NULL, started_at = '', origin = 'media-folder' WHERE video_id = ?`)
        .run(acquiredAt, acquiredAt, id);
      database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
      database.prepare('DELETE FROM playlist_download_queue WHERE video_id = ?').run(id);
      queueDownloadedMetadata(id);
      mediaFolderFailedFingerprints.delete(id);
      mediaFolderCandidates.set(id, { fingerprint, firstSeenAt: Date.now(), checked: true });
      console.log(`[media-folder] Added local media ${id} to the library.`);
    } catch (error) {
      if (error.code === 'INTEGRITY_PAUSED') {
        markMediaIntegrityPaused(id);
        mediaFolderCandidates.set(id, { fingerprint, firstSeenAt: Date.now(), checked: true });
      } else if (error.code === 'MEDIA_CHANGED') {
        database.prepare(`UPDATE downloads SET status = 'error', message = ?, progress = 0,
          stage = 'Waiting for a stable file', updated_at = ?, origin = 'media-folder' WHERE video_id = ?`)
          .run(String(error.message || 'The media file changed while it was being checked.').slice(0, 1000), new Date().toISOString(), id);
      } else {
        const message = await recordMediaIntegrityFailure(id, error);
        if (getStoredMediaPath(id)) mediaFolderFailedFingerprints.set(id, fingerprint);
        else mediaFolderCandidates.delete(id);
        console.warn(`[media-folder] Could not import ${id}:`, message);
      }
    }
  } catch (error) {
    console.warn(`[media-folder] Could not inspect ${id}:`, error.message || error);
  } finally {
    mediaFolderImportJobs.delete(id);
    mediaFolderImports.delete(id);
    if (mediaFolderDeferredRechecks.delete(id)) {
      mediaFolderCandidates.delete(id);
      mediaFolderFailedFingerprints.delete(id);
      mediaFolderMissingCandidates.delete(id);
    }
    scheduleMediaFolderScan(500);
  }
}

async function scanMediaFolderOnce() {
  clearInterruptedMediaImportRetries.run();
  let entries;
  try {
    const directoryInfo = await stat(mediaDirectory);
    if (!directoryInfo.isDirectory()) throw new Error('The configured media path is not a folder.');
    entries = await readdir(mediaDirectory, { withFileTypes: true });
    await mkdir(shortsMediaDirectory, { recursive: true });
    mediaFolderScanState.available = true;
    mediaFolderScanState.error = '';
  } catch (error) {
    mediaFolderScanState.available = false;
    mediaFolderScanState.error = error.code === 'ENOENT'
      ? 'The configured media folder is unavailable.'
      : String(error.message || 'The media folder could not be read.');
    mediaFolderScanState.lastScanAt = new Date().toISOString();
    return;
  }

  let shortsEntries;
  try {
    shortsEntries = await readdir(shortsMediaDirectory, { withFileTypes: true });
  } catch (error) {
    // A transiently missing or unreadable Shorts directory is not evidence that
    // its files were deleted. Skip this scan so it cannot tombstone the whole
    // Shorts library while a volume is being mounted or copied.
    mediaFolderScanState.error = `The Shorts media folder could not be read: ${String(error.message || 'unknown filesystem error')}`;
    mediaFolderScanState.lastScanAt = new Date().toISOString();
    return;
  }

  const mediaEntries = new Map();
  const unmatchedFiles = [];
  for (const source of [
    { directory: mediaDirectory, entries, kind: 'normal' },
    { directory: shortsMediaDirectory, entries: shortsEntries, kind: 'short' }
  ]) {
    for (const entry of source.entries) {
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).slice(1).toLowerCase();
      if (!Object.hasOwn(mediaContentTypes, extension)) continue;
      const parsed = parseMediaFilename(entry.name);
      if (!parsed) { if (unmatchedFiles.length < 100) unmatchedFiles.push(entry.name); continue; }
      const current = mediaEntries.get(parsed.id);
      if (!current || current.kind !== source.kind && source.kind === 'short' || current.kind === source.kind && parsed.extension === 'webm' && current.extension !== 'webm') {
        mediaEntries.set(parsed.id, { ...parsed, kind: source.kind, filePath: path.join(source.directory, entry.name) });
      }
    }
  }
  mediaFolderScanState.recognizedFiles = mediaEntries.size;
  mediaFolderScanState.unmatchedFiles = unmatchedFiles;
  const nowMs = Date.now();
  const pausedMediaFolderImports = new Set(database.prepare(`SELECT d.video_id AS id
    FROM downloads d JOIN download_retry_queue q ON q.video_id = d.video_id
    WHERE d.origin = 'media-folder' AND d.status = 'paused' AND q.status = 'paused'`).all().map(row => row.id));
  let queuedImport = false;
  for (const [id, entry] of mediaEntries) {
    if (jobs.has(id) || downloadStartingIds.has(id) || mediaFolderImports.has(id) || mediaFolderImportJobs.has(id) || pausedMediaFolderImports.has(id)) continue;
    const info = await stat(entry.filePath).catch(() => null);
    if (!info || info.size <= 0) continue;
    const fingerprint = `${entry.filePath}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const previous = mediaFolderCandidates.get(id);
    const priorDownload = database.prepare(`SELECT status, stage FROM downloads WHERE video_id = ?`).get(id);
    const restoreExistingLibraryItem = ['deleted', 'expired'].includes(priorDownload?.status)
      || priorDownload?.status === 'error' && priorDownload.stage === 'Waiting for media-folder scan';
    if (!previous || previous.fingerprint !== fingerprint) {
      mediaFolderCandidates.set(id, { fingerprint, firstSeenAt: nowMs, checked: false });
      queuedImport = true;
      continue;
    }
    // A checked fingerprint only means this file was checked once. If the
    // library row was later marked deleted/expired while a copy was restored
    // into the media folder, revalidate it and restore its ready state.
    if (previous.checked && !restoreExistingLibraryItem) continue;
    if (mediaFolderFailedFingerprints.get(id) === fingerprint && !restoreExistingLibraryItem) continue;
    if (nowMs - previous.firstSeenAt < mediaFolderStableMs) { queuedImport = true; continue; }
    // Keep a small visible queue of local integrity work. Verification itself is
    // serialized by verifyLocalMediaIntegrity; the cap avoids creating thousands
    // of pending jobs when a large media volume is attached.
    if (mediaFolderImports.size >= 3) { queuedImport = true; continue; }
    void importMediaFolderFile(id, entry.filePath, info, fingerprint, entry.kind);
  }

  if (!mediaDirectoryIsExternal) {
    const readyRows = database.prepare("SELECT video_id AS id FROM downloads WHERE status = 'ready'").all();
    const readyIds = new Set(readyRows.map(row => row.id));
    for (const id of mediaFolderMissingCandidates.keys()) {
      if (!readyIds.has(id)) mediaFolderMissingCandidates.delete(id);
    }
    for (const row of readyRows) {
      if (mediaEntries.has(row.id)) {
        mediaFolderMissingCandidates.delete(row.id);
        continue;
      }
      // During a bulk copy, files arrive in waves. Do not interpret the gaps
      // between those arrivals as deletions; wait for a quiet folder window.
      if (nowMs - mediaFolderLastChangeAt < mediaFolderQuietPeriodMs) {
        queuedImport = true;
        continue;
      }
      const firstMissingAt = mediaFolderMissingCandidates.get(row.id);
      if (!firstMissingAt) {
        mediaFolderMissingCandidates.set(row.id, nowMs);
        queuedImport = true;
        continue;
      }
      if (nowMs - firstMissingAt < mediaFolderMissingGraceMs) {
        queuedImport = true;
        continue;
      }
      if (markMediaFileMissing(row.id)) mediaFolderMissingCandidates.delete(row.id);
    }
  }
  mediaFolderScanState.lastScanAt = new Date().toISOString();
  if (queuedImport) scheduleMediaFolderScan(mediaFolderImports.size > 0 ? 15_000 : mediaFolderStableMs);
  else if (mediaFolderMissingCandidates.size) scheduleMediaFolderScan(15_000);
}

function mediaFolderScan() {
  if (mediaFolderScanPromise) {
    mediaFolderScanAgain = true;
    return mediaFolderScanPromise;
  }
  mediaFolderScanPromise = (async () => {
    do {
      mediaFolderScanAgain = false;
      await scanMediaFolderOnce();
    } while (mediaFolderScanAgain);
  })();
  return mediaFolderScanPromise.finally(() => { mediaFolderScanPromise = null; });
}

function attachMediaFolderWatcher() {
  const scheduleWatcherRetry = () => {
    if (mediaFolderWatcherRetryTimer) return;
    mediaFolderWatcherRetryTimer = setTimeout(() => {
      mediaFolderWatcherRetryTimer = null;
      attachMediaFolderWatcher();
    }, 10_000);
    mediaFolderWatcherRetryTimer.unref?.();
  };
  const attach = (directory, isShorts) => {
    const existing = isShorts ? shortsMediaFolderWatcher : mediaFolderWatcher;
    if (existing) return;
    try {
      const watcher = watchFileSystem(directory, { persistent: false }, (eventType, filename) => {
        mediaFolderLastChangeAt = Date.now();
        const name = filename?.toString() || '';
        const parsed = parseMediaFilename(name);
        if (parsed) {
          const activeJob = jobs.get(parsed.id);
          if (downloadStartingIds.has(parsed.id) || activeJob?.integrityChecking || mediaFolderImports.has(parsed.id)) {
            // A copy that overlaps a download start or the final integrity pass
            // must be checked again after that operation releases the file.
            mediaFolderDeferredRechecks.add(parsed.id);
          } else if (!activeJob && !mediaFolderImports.has(parsed.id)) {
            // USB/rsync tools may preserve mtime. Invalidate the observed file
            // signature so the stored SHA-256 is compared with the new bytes.
            mediaFolderCandidates.delete(parsed.id);
            mediaFolderFailedFingerprints.delete(parsed.id);
            mediaFolderMissingCandidates.delete(parsed.id);
          }
        }
        scheduleMediaFolderScan(600);
      });
      if (isShorts) shortsMediaFolderWatcher = watcher;
      else mediaFolderWatcher = watcher;
      watcher.on('error', error => {
        console.warn(`[media-folder] ${isShorts ? 'Shorts ' : ''}watcher disconnected:`, error.message || error);
        watcher.close();
        if (isShorts) shortsMediaFolderWatcher = null;
        else mediaFolderWatcher = null;
        scheduleWatcherRetry();
      });
    } catch { scheduleWatcherRetry(); }
  };
  attach(mediaDirectory, false);
  attach(shortsMediaDirectory, true);
}

function handleMediaFolderChange() {
  attachMediaFolderWatcher();
  mediaFolderScan().catch(error => console.warn('[media-folder] Scan failed:', error.message || error));
}

function mediaFolderStatus() {
  const imports = database.prepare(`SELECT d.video_id AS videoId, COALESCE(v.title, d.video_id) AS title,
    COALESCE(v.channel, '') AS channel, d.status, d.stage AS phase, d.message, d.updated_at AS updatedAt
    FROM downloads d LEFT JOIN videos v ON v.video_id = d.video_id WHERE d.status = 'importing'
    ORDER BY d.updated_at DESC LIMIT 20`).all();
  const integrityJobs = [...mediaFolderImportJobs.entries()];
  const checkingFiles = integrityJobs.slice(0, 20).map(([videoId, job]) => {
    const video = database.prepare('SELECT title, channel FROM videos WHERE video_id = ?').get(videoId);
    return {
      videoId, title: video?.title || videoId, channel: video?.channel || '',
      status: job.integrityChecking ? 'checking' : 'queued'
    };
  });
  return {
    available: mediaFolderScanState.available,
    configuredSeparately: mediaDirectoryIsExternal,
    lastScanAt: mediaFolderScanState.lastScanAt,
    recognizedFiles: mediaFolderScanState.recognizedFiles,
    unmatchedFiles: mediaFolderScanState.unmatchedFiles,
    error: mediaFolderScanState.error,
    checkingCount: integrityJobs.filter(([, job]) => job.integrityChecking).length,
    queuedCount: integrityJobs.filter(([, job]) => job.integrityQueued).length,
    checkingFiles,
    importing: imports
  };
}

function markFreshMediaAcquisition(id) {
  const acquiredAt = new Date().toISOString();
  const expiresAt = autoDeleteEnabled ? expiryFromAcquisition(acquiredAt) : '';
  try {
    database.prepare(`UPDATE downloads SET acquired_at = ?, expires_at = ?, expiry_paused_ms = NULL
      WHERE video_id = ? AND status = 'ready'`).run(acquiredAt, expiresAt, id);
  } catch (error) { console.warn(`[downloads] Could not refresh acquisition time for ${id}:`, error.message || error); }
}

let recentAcquisitionReconcileAt = 0;
let recentAcquisitionReconcilePromise = null;

async function reconcileRecentlyReacquiredMedia(recentCutoff) {
  if (recentAcquisitionReconcilePromise) return recentAcquisitionReconcilePromise;
  if (Date.now() - recentAcquisitionReconcileAt < 10_000) return;
  recentAcquisitionReconcilePromise = (async () => {
    const candidates = database.prepare(`SELECT video_id AS id, acquired_at AS acquiredAt
      FROM downloads WHERE status = 'ready' AND acquired_at < ? AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT 250`).all(recentCutoff, recentCutoff);
    await Promise.all(candidates.map(async item => {
      const mediaPath = getStoredMediaPath(item.id);
      if (!mediaPath) return;
      let mediaStat;
      try { mediaStat = await stat(mediaPath); } catch { return; }
      const previousAcquiredAt = Date.parse(item.acquiredAt || '');
      if (!Number.isFinite(previousAcquiredAt) || mediaStat.mtimeMs <= previousAcquiredAt + 5000) return;
      const acquiredAt = new Date(mediaStat.mtimeMs).toISOString();
      const expiresAt = autoDeleteEnabled ? expiryFromAcquisition(acquiredAt) : '';
      database.prepare(`UPDATE downloads SET acquired_at = ?, expires_at = ?, expiry_paused_ms = NULL
        WHERE video_id = ? AND status = 'ready' AND acquired_at = ?`)
        .run(acquiredAt, expiresAt, item.id, item.acquiredAt);
    }));
  })();
  try { await recentAcquisitionReconcilePromise; }
  catch (error) { console.warn('[downloads-recent] Could not reconcile a redownload timestamp:', error.message || error); }
  finally {
    recentAcquisitionReconcileAt = Date.now();
    recentAcquisitionReconcilePromise = null;
  }
}

function getDownload(id) {
  const result = database.prepare(`SELECT d.status, d.message, d.progress, d.stage, d.updated_at AS updatedAt,
    d.integrity_status AS integrityStatus, d.integrity_checked_at AS integrityCheckedAt,
    d.integrity_checksum AS integrityChecksum,
    r.attempts AS retryAttempts, r.next_retry_at AS retryAt, r.last_error AS retryError, r.status AS retryStatus,
    m.status AS metadataStatus, m.phase AS metadataPhase, m.message AS metadataMessage
    FROM downloads d LEFT JOIN download_retry_queue r ON r.video_id = d.video_id
    LEFT JOIN download_metadata m ON m.video_id = d.video_id WHERE d.video_id = ?`).get(id) || null;
  const job = jobs.get(id) || mediaFolderImportJobs.get(id);
  return result ? {
    ...result,
    youtubeCooldownUntil: getEnforcedYoutubeDownloadCooldownUntil(),
    mediaExtension: getStoredMediaExtension(id),
    integrityChecking: Boolean(job?.integrityChecking),
    integrityProgress: Number.isFinite(job?.integrityProgress) ? job.integrityProgress : null,
    integrityPhase: job?.integrityPhase || ''
  } : null;
}

const maxDownloadRetryDelay = 30 * 60_000;
const maxDownloadAttempts = 10;
const youtubeCooldownKey = 'youtube_download_cooldown_until';
const youtubeCooldownDuration = 30 * 60_000;
function getYoutubeDownloadCooldownUntil() {
  const value = Date.parse(database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(youtubeCooldownKey)?.value || '');
  return Number.isFinite(value) && value > Date.now() ? new Date(value).toISOString() : '';
}
const downloadProtectionMode = ['off', 'auto', 'always'].includes(process.env.YOURTUBE_DOWNLOAD_PROTECTIONS)
  ? process.env.YOURTUBE_DOWNLOAD_PROTECTIONS
  : 'off';
function areDownloadProtectionsActive() {
  if (downloadProtectionMode === 'always') return true;
  if (downloadProtectionMode !== 'auto') return false;
  const until = Date.parse(getYoutubeDownloadCooldownUntil());
  return Number.isFinite(until) && until > Date.now();
}
function getEnforcedYoutubeDownloadCooldownUntil() {
  return areDownloadProtectionsActive() ? getYoutubeDownloadCooldownUntil() : '';
}
const retryDelayForAttempt = attempts => Math.min(maxDownloadRetryDelay, downloadRetryDelay * (2 ** Math.max(0, Math.min(8, (Number(attempts) || 1) - 1))));
function startYoutubeDownloadCooldown() {
  const now = Date.now();
  const current = Date.parse(database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(youtubeCooldownKey)?.value || '');
  const cooldownUntil = new Date(Math.max(now + youtubeCooldownDuration, Number.isFinite(current) ? current : 0)).toISOString();
  const updatedAt = new Date(now).toISOString();
  const message = 'YouTube is asking this connection to sign in. Automatic downloads are paused for 30 minutes to avoid repeated requests.';
  database.prepare(`INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`)
    .run(youtubeCooldownKey, cooldownUntil, updatedAt);
  const queued = database.prepare("SELECT video_id AS id FROM download_retry_queue WHERE status IN ('pending', 'waiting-live')").all();
  database.prepare("UPDATE download_retry_queue SET status = 'paused-limit', updated_at = ? WHERE status IN ('pending', 'waiting-live')").run(updatedAt);
  const updatePaused = database.prepare("UPDATE downloads SET status = 'paused', message = ?, stage = 'Paused while YouTube cools down', updated_at = ? WHERE video_id = ? AND status <> 'ready'");
  for (const { id } of queued) updatePaused.run(message, updatedAt, id);
}

function explainDownloadFailure(rawMessage) {
  const raw = String(rawMessage || '').replace(/https?:\/\/\S+/g, '').trim();
  const normalized = raw.replace(/^ERROR:\s*/i, '');
  if (/this video requires payment to watch|requires a payment|paid content|purchase this video|members[- ]only|only available to (?:paid )?members|requires (?:a )?(?:youtube )?premium|available only with (?:youtube )?premium|included with (?:youtube )?premium/i.test(raw)) {
    return { retryable: false, acquisitionExclusionReason: 'paid-content', message: 'YouTube marks this as paid content; YourTube removed it from acquisition.' };
  }
  if (/requested format is not available|requested format not available|no video formats found|did not offer a compatible (?:webm|mp4) format/i.test(raw)) {
    return { retryable: false, message: 'YouTube did not offer a compatible WebM or MP4 format for this video. The download is paused because repeating the same format request will not help. Choose Retry later if YouTube makes another format available.' };
  }
  if (/yt-dlp (?:is )?not installed|not available on PATH|ENOENT|could not start yt-dlp/i.test(raw)) {
    return { retryable: false, message: 'YourTube could not find yt-dlp. Install it or add it to the server PATH, restart YourTube, then choose Retry.' };
  }
  if (/ffmpeg|requested format is not available|no video formats found|requested format not available/i.test(raw) && !ffmpegAvailable) {
    return { retryable: false, message: 'This video needs separate video and audio tracks, but ffmpeg is unavailable. Install ffmpeg, restart YourTube, then choose Retry.' };
  }
  if (/no space left on device|enospc|disk is full/i.test(raw)) {
    return { retryable: false, message: 'Your media drive is out of space. Free some space, then choose Retry.' };
  }
  if (/eacces|permission denied|operation not permitted/i.test(raw)) {
    return { retryable: false, message: 'YourTube cannot write this video to its media folder. Check the folder permissions, then choose Retry.' };
  }
  if (/private video|video unavailable|has been removed|video has been deleted|this video is unavailable/i.test(raw)) {
    return { retryable: false, message: 'YouTube reports that this video is private, removed, or unavailable. Check that it can still be viewed, then choose Retry.' };
  }
  if (/members-only|members only|age-restricted|age restricted|sign in to view this video|confirm your age/i.test(raw)) {
    return { retryable: false, message: 'YouTube limits this video to signed-in or age-verified viewers. YourTube does not use browser sign-in credentials; this video needs to be publicly available to the downloader.' };
  }
  if (/sign in to confirm|requires a signed-in session|signed-in session is required/i.test(raw)) {
    return { retryable: true, message: 'YouTube requires sign-in for this video. YourTube keeps browser credentials out of the download backend.' };
  }
  if (/429|too many requests|rate.?limit|HTTP Error 503/i.test(raw)) {
    return { retryable: true, message: 'YouTube is temporarily limiting download requests. YourTube will wait longer between retries.' };
  }
  if (/HTTP Error 403|forbidden/i.test(raw)) {
    return { retryable: true, message: 'YouTube refused this download request. The restriction may be temporary; YourTube will retry with increasing delays.' };
  }
  if (/timed? ?out|network is unreachable|could not resolve|temporary failure in name resolution|connection (?:reset|refused|closed)|TLS|SSL|network.*(?:error|unavailable)/i.test(raw)) {
    return { retryable: true, message: 'The connection to YouTube was interrupted. YourTube will retry automatically when the connection is available.' };
  }
  if (/no WebM file was produced/i.test(raw)) {
    return { retryable: false, message: 'yt-dlp finished without creating a playable WebM file. Check that ffmpeg is installed and that this video has a supported format, then choose Retry.' };
  }
  const detail = normalized.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').slice(0, 220);
  return {
    retryable: true,
    message: detail
      ? `The download did not finish: ${detail}. YourTube will retry automatically.`
      : 'The download did not finish. YourTube will retry automatically.'
  };
}

function recordDownloadFailure(id, message) {
  const previous = database.prepare('SELECT attempts FROM download_retry_queue WHERE video_id = ?').get(id);
  const attempts = (previous?.attempts || 0) + 1;
  const now = new Date();
  const requiresSignIn = /sign in to confirm (?:you(?:'|’)re|you are) not a bot|requires a signed-in session|signed-in session is required/i.test(String(message || ''));
  const requiresProtectionPause = requiresSignIn && downloadProtectionMode !== 'off';
  const explanation = explainDownloadFailure(message);
  const permanentFailure = !explanation.retryable;
  const paused = attempts >= maxDownloadAttempts || requiresProtectionPause || permanentFailure;
  const pausedOffline = !paused && (offlinePreparationRequested || networkMode === 'offline');
  const nextRetryAt = new Date(now.getTime() + retryDelayForAttempt(attempts)).toISOString();
  const storedMessage = requiresSignIn
    ? requiresProtectionPause
      ? 'YouTube requires a signed-in session for this video. YourTube keeps browser credentials out of the download backend, so automatic retries are paused.'
      : attempts >= maxDownloadAttempts
      ? `Paused after ${maxDownloadAttempts} attempts. YouTube asked for sign-in; YourTube keeps browser credentials out of the download backend. Choose Retry to try again later.`
      : 'YouTube asked for sign-in. YourTube does not pass browser credentials to the downloader; this item remains queued for its scheduled retry.'
    : permanentFailure
    ? explanation.message
    : attempts >= maxDownloadAttempts
    ? `Paused after ${maxDownloadAttempts} attempts. Last issue: ${explanation.message} Choose Retry to try again.`
    : pausedOffline
    ? `Paused for Offline mode. Last issue: ${explanation.message}`
    : `${explanation.message} Attempt ${attempts} of ${maxDownloadAttempts} failed; another retry is scheduled.`;
  if (paused || pausedOffline) saveDownload(id, paused ? 'paused' : 'paused-offline', storedMessage, 0, requiresSignIn ? 'Sign-in required' : permanentFailure ? 'Needs attention before retry' : paused ? `Paused after ${maxDownloadAttempts} attempts` : 'Paused for Offline mode');
  database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET attempts = excluded.attempts,
    status = excluded.status, next_retry_at = excluded.next_retry_at, last_error = excluded.last_error, updated_at = excluded.updated_at`)
    .run(id, attempts, paused ? 'paused' : pausedOffline ? 'paused-offline' : 'pending', nextRetryAt, storedMessage, now.toISOString());
  if (explanation.acquisitionExclusionReason) excludeAcquisitionVideo(id, explanation.acquisitionExclusionReason);
  if (requiresSignIn && downloadProtectionMode !== 'off') startYoutubeDownloadCooldown();
}

async function recordMediaIntegrityFailure(id, error, { paused = false, progress = 0 } = {}) {
  let quarantined = false;
  const shouldQuarantine = ['MEDIA_INTEGRITY', 'INTEGRITY_TIMEOUT'].includes(error.code);
  if (shouldQuarantine) {
    try { quarantined = Boolean(await quarantineMediaFile(id)); }
    catch (quarantineError) { console.error(`[media-integrity] Could not quarantine damaged media ${id}:`, quarantineError); }
  }
  const message = shouldQuarantine
    ? `The local copy ${error.code === 'INTEGRITY_TIMEOUT' ? 'could not finish its integrity check' : 'failed its integrity check'}${quarantined ? ' and was moved to the YourTube quarantine folder' : ''}. ${error.message} ${paused ? 'It is paused; choose Retry when ready.' : 'YourTube will retry the download.'}`
    : error.message || 'The local media could not be checked.';
  if (paused || error.code === 'INTEGRITY_TOOL_MISSING') {
    markDownloadPausedByUser(id, progress, message);
  } else {
    saveDownload(id, 'error', message, progress, 'Integrity check failed');
    recordDownloadFailure(id, message);
  }
  return message;
}

let playlistDownloadQueueRunning = false;

async function runPlaylistDownloadQueue() {
  if (playlistDownloadQueueRunning) return false;
  playlistDownloadQueueRunning = true;
  try {
    if (networkMode === 'offline' || offlinePreparationRequested || jobs.size) return false;
    const next = database.prepare(`SELECT q.video_id AS id FROM playlist_download_queue q
      ORDER BY q.queue_id LIMIT 1`).get();
    if (!next) return false;
    const { id } = next;
    if (mediaFolderImports.has(id)) return false;
    if (getStoredMediaPath(id)) {
      const currentDownload = database.prepare('SELECT status, stage FROM downloads WHERE video_id = ?').get(id);
      if (currentDownload?.status === 'importing' && currentDownload.stage === 'Queued for integrity check'
        && !mediaFolderImportJobs.has(id) && !integrityVerificationJobs.has(id)) return false;
      // Leave this playlist item queued while a different local file owns the
      // serialized integrity worker. It is local verification work, not a retry.
      if (integrityVerificationJobs.size && !integrityVerificationJobs.has(id)) return false;
      const previous = database.prepare('SELECT status FROM downloads WHERE video_id = ?').get(id);
      if (previous?.status !== 'ready' || !hasSavedIntegrityChecksum(id)) {
        // Let the media-folder scanner own this check and keep the playlist
        // entry parked until the local file has passed integrity validation.
        return handoffRetryToLocalIntegrity(id);
      }
      database.prepare('DELETE FROM playlist_download_queue WHERE video_id = ?').run(id);
      database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
      saveDownload(id, 'ready', '', 100, 'Ready to play');
      return true;
    }
    if (isAcquisitionExcluded(id) || !database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(id)) {
      const message = isAcquisitionExcluded(id) ? 'This video is excluded from YourTube acquisition.' : 'Video stub is no longer available.';
      database.prepare('DELETE FROM playlist_download_queue WHERE video_id = ?').run(id);
      database.prepare("UPDATE download_retry_queue SET status = 'exhausted', last_error = ?, updated_at = ? WHERE video_id = ?")
        .run(message, new Date().toISOString(), id);
      saveDownload(id, 'paused', message, 0, 'Needs attention before retry');
      return true;
    }
    const now = new Date().toISOString();
    database.prepare("UPDATE download_retry_queue SET status = 'running', next_retry_at = ?, updated_at = ? WHERE video_id = ?")
      .run(now, now, id);
    try {
      const result = await beginDownload(id);
      database.prepare('DELETE FROM playlist_download_queue WHERE video_id = ?').run(id);
      if (!result) {
        database.prepare("UPDATE download_retry_queue SET status = 'exhausted', last_error = 'Video stub is no longer available.', updated_at = ? WHERE video_id = ?")
          .run(new Date().toISOString(), id);
        saveDownload(id, 'paused', 'Video stub is no longer available.', 0, 'Needs attention before retry');
        return true;
      }
      return true;
    } catch (error) {
      database.prepare('DELETE FROM playlist_download_queue WHERE video_id = ?').run(id);
      recordDownloadFailure(id, error.message);
      return true;
    }
  } finally {
    playlistDownloadQueueRunning = false;
  }
}

function handoffRetryToLocalIntegrity(id) {
  if (jobs.has(id)) return false;
  const filePath = getStoredMediaPath(id);
  if (!filePath) return false;
  database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
  if (mediaFolderImports.has(id) || integrityVerificationJobs.has(id)) return true;
  const previous = database.prepare('SELECT status FROM downloads WHERE video_id = ?').get(id);
  if (previous?.status === 'ready' && hasSavedIntegrityChecksum(id)) return true;
  const now = new Date().toISOString();
  database.prepare(`UPDATE downloads SET status = 'importing',
    message = 'Local media is present. Waiting for its integrity check.', progress = 0,
    stage = 'Queued for integrity check', updated_at = ? WHERE video_id = ?`).run(now, id);
  mediaFolderCandidates.delete(id);
  mediaFolderFailedFingerprints.delete(id);
  scheduleMediaFolderScan(0);
  return true;
}

async function runDownloadRetries() {
  // Local integrity recovery is independent of network mode and YouTube's
  // cooldown. Reconcile any present files before evaluating download retries.
  const retryCandidates = database.prepare(`SELECT q.video_id AS id FROM download_retry_queue q
    LEFT JOIN downloads d ON d.video_id = q.video_id
    WHERE q.status IN ('pending', 'waiting-live')
      AND COALESCE(d.status, '') IN ('error', 'importing', 'ready')
    ORDER BY q.updated_at LIMIT 50`).all();
  for (const { id } of retryCandidates) handoffRetryToLocalIntegrity(id);
  if (networkMode === 'offline' || offlinePreparationRequested) return;
  const cooldownUntil = Date.parse(database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(youtubeCooldownKey)?.value || '');
  const protectionsActive = areDownloadProtectionsActive();
  if (protectionsActive && Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) return;
  if (protectionsActive && Number.isFinite(cooldownUntil)) {
    const now = new Date().toISOString();
    database.prepare("UPDATE download_retry_queue SET status = 'pending', updated_at = ? WHERE status = 'paused-limit'").run(now);
    database.prepare("UPDATE downloads SET status = 'error', message = 'Cooldown ended. Waiting for the next retry.', stage = 'Waiting to retry', updated_at = ? WHERE stage = 'Paused while YouTube cools down'").run(now);
    database.prepare('DELETE FROM app_settings WHERE setting_key = ?').run(youtubeCooldownKey);
  }
  // Playlist batches advance one item at a time and wait for any active media
  // transfer to finish. They remain inside the existing persistent retry queue.
  if (protectionsActive && jobs.size) return;
  if (!jobs.size && await runPlaylistDownloadQueue()) return;
  const now = new Date().toISOString();
  const due = database.prepare(`SELECT video_id AS id FROM download_retry_queue
    WHERE status IN ('pending', 'waiting-live') AND next_retry_at <= ?
      AND video_id NOT IN (SELECT video_id FROM playlist_download_queue)
      AND NOT EXISTS (SELECT 1 FROM downloads d WHERE d.video_id = download_retry_queue.video_id
        AND d.origin = 'media-folder' AND d.status = 'error' AND d.stage = 'Waiting for media-folder scan')
    ORDER BY next_retry_at LIMIT ${protectionsActive ? 1 : 3}`).all(now);
  for (const { id } of due) {
    if (jobs.has(id)) continue;
    // A retry row can survive a server interruption even when the final media
    // file is already on disk. Hand it to local integrity work before marking
    // it running, so this does not become another yt-dlp attempt.
    if (handoffRetryToLocalIntegrity(id)) continue;
    database.prepare("UPDATE download_retry_queue SET status = 'running', updated_at = ? WHERE video_id = ? AND status IN ('pending', 'waiting-live')").run(now, id);
    try {
      const result = await beginDownload(id);
      if (!result) database.prepare("UPDATE download_retry_queue SET status = 'exhausted', last_error = 'Video stub is no longer available.', updated_at = ? WHERE video_id = ?").run(new Date().toISOString(), id);
    } catch (error) {
      recordDownloadFailure(id, error.message);
    }
  }
}

const commentThreadStructureVersion = 'comment-threads-v4';
const commentSnapshotLimit = 1000;
const commentSnapshotVersion = 'comments-v5-limit-1000';
const commentBackfillPaceMs = 60_000;
const commentBackfillConcurrencyKey = 'comment_backfill_max_concurrency';
const commentBackfillDefaultConcurrency = 2;
const commentBackfillMaximumConcurrency = 5;
let commentBackfillWorkerRunning = false;

function commentBackfillConcurrency() {
  const stored = Number(database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(commentBackfillConcurrencyKey)?.value);
  return Number.isInteger(stored)
    ? Math.max(1, Math.min(commentBackfillMaximumConcurrency, stored))
    : commentBackfillDefaultConcurrency;
}

function getComments(id) {
  const row = database.prepare('SELECT status, comments_json AS commentsJson, message, updated_at AS updatedAt FROM video_comments WHERE video_id = ?').get(id);
  if (!row) return null;
  let comments = [];
  try { comments = JSON.parse(row.commentsJson); } catch {}
  const channel = database.prepare('SELECT channel FROM videos WHERE video_id = ?').get(id)?.channel || '';
  const channelStatus = channel ? 'ready' : channelLookups.get(id)?.status || (commentJobs.has(id) ? 'loading' : 'unavailable');
  return { status: row.status, comments, message: row.message, updatedAt: row.updatedAt, channel, channelStatus };
}

function commentsNeedThreadRefresh(cached) {
  const comments = Array.isArray(cached?.comments) ? cached.comments : [];
  const message = String(cached?.message || '');
  if (cached?.status !== 'ready' || comments.length < 45 || message.includes(commentThreadStructureVersion) || message.includes(commentSnapshotVersion)) return false;
  const roots = comments.filter(comment => !comment.parent || String(comment.parent).toLowerCase() === 'root');
  if (roots.length !== 1 || !roots[0].id) return false;
  const repliesToOnlyRoot = comments.filter(comment => String(comment.parent || '') === String(roots[0].id)).length;
  return repliesToOnlyRoot >= comments.length - 1;
}

function saveComments(id, status, comments = [], message = '') {
  database.prepare(`
    INSERT INTO video_comments (video_id, status, comments_json, message, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET status = excluded.status, comments_json = excluded.comments_json,
      message = excluded.message, updated_at = excluded.updated_at
  `).run(id, status, JSON.stringify(comments), message, new Date().toISOString());
  if (status === 'ready' && comments.length > 0 && !String(message).includes(commentSnapshotVersion)) {
    const now = new Date().toISOString();
    database.prepare(`INSERT OR IGNORE INTO comment_backfill_queue
      (video_id, status, attempts, next_attempt_at, message, created_at, updated_at)
      VALUES (?, 'queued', 0, '', 'Comment snapshot queued for expansion to 1,000.', ?, ?)`).run(id, now, now);
    database.prepare(`UPDATE comment_backfill_queue SET status = 'queued', attempts = 0, next_attempt_at = '',
      message = 'New smaller comment snapshot queued for expansion to 1,000.', updated_at = ?
      WHERE video_id = ? AND status IN ('complete', 'skipped')`).run(now, id);
  }
  if (status !== 'loading') markDownloadedMetadataDirty(id);
}

function updateCommentBackfill(id, status, message = '', nextAttemptAt = '') {
  database.prepare(`UPDATE comment_backfill_queue SET status = ?, next_attempt_at = ?, message = ?, updated_at = ? WHERE video_id = ?`)
    .run(status, nextAttemptAt, String(message || '').slice(0, 500), new Date().toISOString(), id);
}

function limitCommentSnapshot(comments, limit = commentSnapshotLimit) {
  if (comments.length <= limit) return comments;
  const entries = comments.map((comment, index) => ({ comment, index, parent: null, children: [] }));
  const byId = new Map();
  for (const entry of entries) {
    const id = String(entry.comment.id || '').trim();
    if (id && !byId.has(id)) byId.set(id, entry);
  }
  for (const entry of entries) {
    const parentId = String(entry.comment.parent || '').trim();
    if (!parentId || parentId.toLowerCase() === 'root') continue;
    const parent = byId.get(parentId);
    if (!parent || parent === entry) continue;
    let ancestor = parent;
    let cycle = false;
    let steps = 0;
    while (ancestor && steps < limit) {
      if (ancestor === entry) { cycle = true; break; }
      ancestor = ancestor.parent;
      steps += 1;
    }
    if (!cycle) entry.parent = parent;
  }
  for (const entry of entries) {
    if (entry.parent) entry.parent.children.push(entry);
  }
  const roots = entries.filter(entry => !entry.parent);
  if (!roots.length) return comments.slice(0, limit);

  // Reserve room for distinct top-level comments, then spread replies round-robin.
  // Breadth-first ordering keeps each selected reply's full parent chain available.
  const initialRootCount = Math.min(15, limit, roots.length);
  const selected = new Set(roots.slice(0, initialRootCount));
  const replyQueues = roots.slice(0, initialRootCount).map(root => [...root.children]);
  let nextRootIndex = initialRootCount;
  while (selected.size < limit) {
    let added = false;
    for (let index = 0; index < replyQueues.length && selected.size < limit; index += 1) {
      const queue = replyQueues[index];
      const reply = queue.shift();
      if (reply) {
        selected.add(reply);
        queue.push(...reply.children);
        added = true;
      } else if (nextRootIndex < roots.length) {
        const root = roots[nextRootIndex++];
        selected.add(root);
        queue.push(...root.children);
        added = true;
      }
    }
    if (!added) break;
  }
  return entries.filter(entry => selected.has(entry)).map(entry => entry.comment);
}

function cleanComments(rawComments) {
  const comments = (Array.isArray(rawComments) ? rawComments : []).slice(0, commentSnapshotLimit * 2).map(comment => ({
    id: String(comment.id || '').slice(0, 300),
    parent: String(comment.parent || '').slice(0, 300),
    author: String(comment.author || 'YouTube user').slice(0, 200),
    authorId: String(comment.author_id || comment.authorId || '').slice(0, 300),
    authorUrl: String(comment.author_url || comment.authorUrl || '').slice(0, 2000),
    authorIsVerified: Boolean(comment.author_is_verified ?? comment.authorIsVerified),
    authorIsUploader: Boolean(comment.author_is_uploader ?? comment.authorIsUploader),
    text: String(comment.text || '').slice(0, 4000),
    likes: Number.isFinite(Number(comment.like_count ?? comment.likes)) ? Math.max(0, Number(comment.like_count ?? comment.likes)) : 0,
    published: String(comment.time_text || comment.published || '').slice(0, 100),
    timestamp: Number.isFinite(Number(comment.timestamp)) ? Number(comment.timestamp) : null,
    replyCount: Number.isFinite(Number(comment.reply_count ?? comment.replyCount)) ? Math.max(0, Number(comment.reply_count ?? comment.replyCount)) : 0,
    isPinned: Boolean(comment.is_pinned ?? comment.isPinned),
    authorThumbnail: safeImage(comment.author_thumbnail || comment.authorThumbnail || '')
  })).filter(comment => comment.text.trim());
  const seen = new Set();
  const uniqueComments = comments.filter(comment => {
    const key = comment.id || `${comment.authorUrl}\u0000${comment.author}\u0000${comment.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return limitCommentSnapshot(uniqueComments, commentSnapshotLimit);
}

function stableExtractorMetadata(value, key = '', depth = 0) {
  if (omittedExtractorMetadataFields.has(String(key).toLowerCase()) || depth > 8) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, key === 'description' ? 20_000 : 4_000);
  if (Array.isArray(value)) return value.slice(0, 500).map(item => stableExtractorMetadata(item, '', depth + 1)).filter(item => item !== undefined);
  if (typeof value !== 'object') return undefined;
  const result = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 500)) {
    const clean = stableExtractorMetadata(childValue, childKey, depth + 1);
    if (clean !== undefined) result[childKey] = clean;
  }
  return result;
}

function saveVideoMetadataFromInfo(id, info) {
  if (!info || typeof info !== 'object') return;
  saveVideoPublication(id, info);
  const publication = publicationFromInfo(info);
  const channel = String(info.channel || info.uploader || '').trim().slice(0, 200);
  const channelId = String(info.channel_id || info.uploader_id || '').trim();
  const channelKey = cleanChannelKey(info.channel_url || info.uploader_url || (/^UC[A-Za-z0-9_-]{20,32}$/.test(channelId) ? `channel/${channelId}` : ''));
  const channelUrl = channelKey ? `https://www.youtube.com/${channelKey}` : '';
  const duration = formatDurationSeconds(info.duration) || cleanDurationLabel(info.duration_string) ||
    (info.is_live || info.live_status === 'is_live' ? 'LIVE' : info.is_upcoming || info.live_status === 'is_upcoming' ? 'UPCOMING' : '');
  const thumbnailVariants = Array.isArray(info.thumbnails) ? [...info.thumbnails].sort((a, b) => (Number(b.width) || 0) * (Number(b.height) || 0) - (Number(a.width) || 0) * (Number(a.height) || 0)) : [];
  const thumbnail = safeImage(info.thumbnail) || thumbnailVariants.map(item => safeImage(item?.url)).find(Boolean) || '';
  const avatar = safeImage(info.channel_thumbnail || info.uploader_thumbnail || info.channel_avatar || info.uploader_avatar || '');
  const title = String(info.title || '').trim().slice(0, 500);
  database.prepare(`UPDATE videos SET
    title = CASE WHEN ? <> '' AND (trim(title) = '' OR lower(trim(title)) = lower(video_id)) THEN ? ELSE title END,
    channel = CASE WHEN ? <> '' AND lower(?) NOT IN ('youtube', 'channel unavailable')
      AND (trim(channel) = '' OR lower(trim(channel)) IN ('youtube', 'channel unavailable')) THEN ? ELSE channel END,
    channel_key = CASE WHEN trim(channel_key) = '' AND ? <> '' THEN ? ELSE channel_key END,
    channel_url = CASE WHEN trim(channel_url) = '' AND ? <> '' THEN ? ELSE channel_url END,
    thumbnail = CASE WHEN trim(thumbnail) = '' AND ? <> '' THEN ? ELSE thumbnail END,
    avatar = CASE WHEN trim(avatar) = '' AND ? <> '' THEN ? ELSE avatar END,
    duration = CASE WHEN ? <> '' AND (trim(duration) = '' OR upper(trim(duration)) IN ('LIVE', 'UPCOMING') AND ? NOT IN ('LIVE', 'UPCOMING')) THEN ? ELSE duration END
    WHERE video_id = ?`).run(
      title, title, channel, channel, channel, channelKey, channelKey, channelUrl, channelUrl,
      thumbnail, thumbnail, avatar, avatar, duration, duration, duration, id
    );

  const text = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : '';
  const numbers = ['duration', 'timestamp', 'release_timestamp', 'view_count', 'like_count', 'comment_count', 'channel_follower_count', 'age_limit'];
  const capturedAt = new Date().toISOString();
  const metadata = {
    extractorMetadataCaptured: info.extractorMetadataCaptured !== false,
    metadataSource: text(info.metadata_source, 80) || 'yt-dlp',
    capturedAt,
    id: text(info.id || id, 40), title, fulltitle: text(info.fulltitle, 1000), alt_title: text(info.alt_title, 1000),
    description: text(info.description, 20_000), extractor: text(info.extractor, 100), extractor_key: text(info.extractor_key, 100),
    webpage_url: text(info.webpage_url, 2_000), original_url: text(info.original_url, 2_000),
    uploader: text(info.uploader, 500), uploader_id: text(info.uploader_id, 300), uploader_url: text(info.uploader_url, 2_000),
    channel: text(info.channel, 500), channel_id: text(info.channel_id, 300), channel_url: text(info.channel_url, 2_000), channel_follower_count: Number(info.channel_follower_count) || null,
    duration_string: text(info.duration_string, 80), upload_date: text(info.upload_date, 40), release_date: text(info.release_date, 40), modified_date: text(info.modified_date, 40),
    publishedAt: publication.publishedAt, publishedAtPrecision: publication.precision, publishedAge: publication.publishedAge,
    live_status: text(info.live_status, 80), availability: text(info.availability, 80), language: text(info.language, 80), license: text(info.license, 200),
    release_year: Number(info.release_year) || null, artist: text(info.artist, 500), album: text(info.album, 500), track: text(info.track, 500),
    series: text(info.series, 500), season_number: Number(info.season_number) || null, episode_number: Number(info.episode_number) || null, episode: text(info.episode, 500),
    thumbnail, thumbnails: thumbnailVariants.slice(0, 12).map(item => ({ url: safeImage(item?.url), width: Number(item?.width) || 0, height: Number(item?.height) || 0 })).filter(item => item.url),
    categories: Array.isArray(info.categories) ? info.categories.slice(0, 50).map(item => text(String(item), 200)) : [],
    tags: Array.isArray(info.tags) ? info.tags.slice(0, 250).map(item => text(String(item), 200)) : [],
    chapters: Array.isArray(info.chapters) ? info.chapters.slice(0, 200).map(chapter => ({ start_time: Number(chapter?.start_time) || 0, end_time: Number(chapter?.end_time) || 0, title: text(chapter?.title, 500) })) : [],
    commentsCaptureLimit: commentSnapshotLimit,
    commentsReturnedByExtractor: Array.isArray(info.comments) ? info.comments.length : null,
    extractorFields: stableExtractorMetadata(info)
  };
  for (const key of numbers) metadata[key] = Number.isFinite(Number(info[key])) ? Number(info[key]) : null;
  const prior = database.prepare('SELECT metadata_json AS value FROM video_metadata WHERE video_id = ?').get(id)?.value;
  let previous = {};
  try { previous = JSON.parse(prior || '{}'); } catch {}
  const metricKeys = ['view_count', 'like_count', 'comment_count', 'channel_follower_count'];
  for (const key of metricKeys) {
    if (metadata[key] === null && previous[key] !== undefined && previous[key] !== null) metadata[key] = previous[key];
  }
  const topicInference = inferVideoTopic({
    topic: info.topic,
    title: metadata.title || title,
    channel: metadata.channel || channel,
    categories: [...(Array.isArray(metadata.categories) ? metadata.categories : []), ...(Array.isArray(previous.categories) ? previous.categories : [])],
    tags: [...(Array.isArray(metadata.tags) ? metadata.tags : []), ...(Array.isArray(previous.tags) ? previous.tags : [])],
    description: metadata.description || previous.description || '',
    artist: metadata.artist,
    album: metadata.album,
    track: metadata.track
  });
  if (topicInference) {
    metadata.topicClassification = { ...topicInference, version: 1, classifiedAt: capturedAt };
    database.prepare('UPDATE videos SET topic = ? WHERE video_id = ? AND trim(topic) = ?').run(topicInference.topic, id, '');
  }
  const observedMetrics = Object.fromEntries(metricKeys.filter(key => metadata[key] !== null).map(key => [key, metadata[key]]));
  if (Object.values(observedMetrics).some(value => Number.isFinite(Number(value)))) {
    let previousMetrics = {};
    try { previousMetrics = previous.publicMetrics && typeof previous.publicMetrics === 'object' ? previous.publicMetrics : {}; } catch {}
    metadata.publicMetrics = { ...previousMetrics, ...observedMetrics, capturedAt, source: metadata.metadataSource };
  }
  database.prepare(`INSERT INTO video_metadata (video_id, metadata_json, local_assets_json, updated_at) VALUES (?, ?, '[]', ?)
    ON CONFLICT(video_id) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
    .run(id, JSON.stringify({ ...previous, ...metadata }), new Date().toISOString());
}

function saveLocalVideoMetadataSnapshot(id, localAssets = []) {
  const video = database.prepare(`SELECT video_id AS id, url, title, channel, channel_key AS channelKey, channel_url AS channelUrl,
    thumbnail, avatar, duration, meta, kind, section, topic, published_at AS publishedAt,
    published_at_precision AS publishedAtPrecision, published_age AS publishedAge FROM videos WHERE video_id = ?`).get(id);
  if (!video) return;
  const prior = database.prepare('SELECT metadata_json AS value FROM video_metadata WHERE video_id = ?').get(id)?.value;
  let metadata = {};
  try { metadata = JSON.parse(prior || '{}'); } catch {}
  const updatedAt = new Date().toISOString();
  database.prepare(`INSERT INTO video_metadata (video_id, metadata_json, local_assets_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET metadata_json = excluded.metadata_json, local_assets_json = excluded.local_assets_json, updated_at = excluded.updated_at`)
    .run(id, JSON.stringify({ ...metadata, ...video }), JSON.stringify(localAssets), updatedAt);
}

function saveVideoChannel(id, info) {
  saveVideoMetadataFromInfo(id, info);
  return database.prepare('SELECT channel FROM videos WHERE video_id = ?').get(id)?.channel || '';
}

function saveVideoDuration(id, info) {
  const duration = formatDurationSeconds(info.duration) || cleanDurationLabel(info.duration_string) ||
    (info.is_live || info.live_status === 'is_live' ? 'LIVE' :
      info.is_upcoming || info.live_status === 'is_upcoming' ? 'UPCOMING' : '');
  if (duration) database.prepare("UPDATE videos SET duration = ? WHERE video_id = ? AND (trim(duration) = '' OR upper(trim(duration)) IN ('LIVE', 'UPCOMING') AND upper(?) NOT IN ('LIVE', 'UPCOMING'))").run(duration, id, duration);
  return duration;
}

function setDurationLookup(id, status, message = '', nextAttemptAt = '') {
  database.prepare(`INSERT INTO video_duration_lookups (video_id, status, message, updated_at, next_attempt_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET status = excluded.status, message = excluded.message,
      updated_at = excluded.updated_at, next_attempt_at = excluded.next_attempt_at`)
    .run(id, status, String(message).slice(0, 500), new Date().toISOString(), String(nextAttemptAt || ''));
}

const ageConfirmationPattern = /sign in to confirm your age|confirm your age|age[- ]restricted/i;
function classifyDurationFailure(reason, referenceAt = Date.now()) {
  const raw = String(reason || '').replace(/\s+/g, ' ').trim();
  const human = raw.replace(/^ERROR:\s*/i, '').replace(/^\[youtube\]\s*[A-Za-z0-9_-]+:\s*/i, '').trim();
  const humanFailure = human
    .replace(/\s+No duration lookup will be retried automatically[\s\S]*$/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  const upcoming = raw.match(/(?:this live event will begin|premieres?)\s+in\s+(\d+(?:\.\d+)?)\s+(seconds?|minutes?|hours?|days?|weeks?)\b/i);
  if (upcoming) {
    const amount = Number(upcoming[1]);
    const unit = upcoming[2].toLowerCase();
    const multiplier = unit.startsWith('second') ? 1_000 : unit.startsWith('minute') ? 60_000 : unit.startsWith('hour') ? 3_600_000 : unit.startsWith('day') ? 86_400_000 : 604_800_000;
    const referenceMs = typeof referenceAt === 'number' ? referenceAt : Date.parse(referenceAt);
    const nextAttemptAt = new Date((Number.isFinite(referenceMs) ? referenceMs : Date.now()) + amount * multiplier + 15 * 60_000).toISOString();
    return {
      status: 'upcoming',
      label: 'UPCOMING',
      nextAttemptAt,
      message: `${human ? `${human.replace(/[.!?]+$/, '')}.` : 'This live event or premiere is not available yet.'} Video length will be checked again shortly after it begins.`
    };
  }
  if (/this video requires payment to watch|requires a payment|paid content|purchase this video|members[- ]only|only available to (?:paid )?members|requires (?:a )?(?:youtube )?premium|available only with (?:youtube )?premium|included with (?:youtube )?premium/i.test(raw)) {
    return {
      status: 'unavailable', nextAttemptAt: 'never', acquisitionExclusionReason: 'paid-content',
      message: `${humanFailure || 'This video requires payment to watch'} No duration lookup will be retried automatically.`
    };
  }
  if (/this live stream recording is not available|live stream recording.*(?:unavailable|not available)/i.test(raw)) {
    return {
      status: 'unavailable', nextAttemptAt: 'never',
      message: `${humanFailure || 'This live stream recording is not available'} No duration lookup will be retried automatically.`
    };
  }
  return null;
}

function saveClassifiedDurationFailure(id, classification) {
  if (classification.acquisitionExclusionReason) {
    excludeAcquisitionVideo(id, classification.acquisitionExclusionReason);
    return;
  }
  if (classification.status === 'upcoming') {
    database.prepare("UPDATE videos SET duration = 'UPCOMING' WHERE video_id = ? AND (trim(duration) = '' OR upper(trim(duration)) = 'UPCOMING')").run(id);
    setDurationLookup(id, 'upcoming', classification.message, classification.nextAttemptAt);
  } else {
    setDurationLookup(id, 'unavailable', classification.message, 'never');
  }
}

function queueExtensionMetadataCapture(id, reason = '', { force = false } = {}) {
  const savedDuration = database.prepare('SELECT duration FROM videos WHERE video_id = ?').get(id)?.duration || '';
  if (!force && String(savedDuration).trim() && !/^UPCOMING$/i.test(String(savedDuration).trim())) {
    setDurationLookup(id, 'ready', 'Video length is already present in the local library.');
    return;
  }
  const detail = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const reasonText = ageConfirmationPattern.test(detail)
    ? 'YouTube requires age confirmation.'
    : /channel name.*missing|missing.*channel name/i.test(detail)
      ? 'The channel name is missing from local metadata.'
    : /dns|resolve|nodename|transporterror|network|connection/i.test(detail)
      ? 'The server could not reach YouTube because of a DNS or network error.'
    : /no duration metadata|no video length/i.test(detail)
      ? 'yt-dlp returned no video length.'
      : /timed? ?out/i.test(detail)
        ? 'yt-dlp metadata lookup timed out.'
        : /enoent|not installed|unavailable/i.test(detail)
          ? 'yt-dlp could not provide metadata.'
          : detail ? `yt-dlp metadata lookup failed: ${detail}` : 'yt-dlp did not provide complete metadata.';
  const message = `${reasonText} Waiting for the extension to capture rendered details from the signed-in YouTube page.`;
  const previous = database.prepare('SELECT status, next_attempt_at AS nextAttemptAt FROM video_duration_lookups WHERE video_id = ?').get(id);
  if (!force && previous?.status === 'unavailable' && previous.nextAttemptAt === 'never') return;
  if (force || !['extension', 'capturing', 'extension-retry', 'ready'].includes(previous?.status)) {
    database.prepare('UPDATE video_duration_lookups SET extension_attempts = 0 WHERE video_id = ?').run(id);
  }
  setDurationLookup(id, 'extension', message);
  const downloaded = database.prepare("SELECT 1 FROM downloads WHERE video_id = ? AND status = 'ready'").get(id);
  if (downloaded) updateDownloadedMetadata(id, 'waiting-extension', 'extension capture', message, { nextAttemptAt: '' });
}

for (const lookup of database.prepare("SELECT video_id AS id, message, updated_at AS updatedAt FROM video_duration_lookups WHERE status IN ('pending', 'unavailable')").all()) {
  const classified = classifyDurationFailure(lookup.message, lookup.updatedAt);
  if (classified) {
    saveClassifiedDurationFailure(lookup.id, classified);
    database.prepare('UPDATE video_duration_lookups SET updated_at = ? WHERE video_id = ?').run(lookup.updatedAt, lookup.id);
  } else if (ageConfirmationPattern.test(lookup.message || '') || /no duration metadata was returned|metadata lookup timed out|yt-dlp is unavailable|failed to resolve|nodename nor servname|transporterror|dns|network is unreachable/i.test(lookup.message || '')) {
    queueExtensionMetadataCapture(lookup.id, lookup.message);
  }
}

function lookupVideoDuration(id, url) {
  return new Promise(resolve => {
    database.prepare("UPDATE videos SET duration = '' WHERE video_id = ? AND upper(trim(duration)) = 'UPCOMING'").run(id);
    setDurationLookup(id, 'running');
    const child = spawn(process.env.YT_DLP_PATH || 'yt-dlp', [
      '--ignore-config', '--no-cookies', '--no-playlist', '--no-color', '--no-warnings',
      '--skip-download', '--dump-single-json', url
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    let finished = false;
    const complete = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      queueExtensionMetadataCapture(id, 'Metadata lookup timed out.');
      complete({ duration: '', blocked: false, extensionQueued: true });
    }, 30_000);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 2_000_000) child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.once('error', error => {
      queueExtensionMetadataCapture(id, error.code === 'ENOENT' ? 'yt-dlp is unavailable.' : error.message);
      complete({ duration: '', blocked: false, fatal: error.code === 'ENOENT', extensionQueued: true });
    });
    child.once('close', code => {
      if (finished) return;
      let info;
      try { if (code === 0 && output.length <= 2_000_000) info = JSON.parse(output.trim()); } catch {}
      if (info) saveVideoMetadataFromInfo(id, info);
      const duration = info ? saveVideoDuration(id, info) : '';
      const ageRestricted = !duration && ageConfirmationPattern.test(stderr);
      const rateLimited = /HTTP Error 429|too many requests|rate.?limit/i.test(stderr);
      if (rateLimited) reportYouTubeRateLimit('YouTube returned HTTP 429 Too Many Requests during a video-length lookup.');
      const blocked = rateLimited || /sign in to confirm|confirm you(?:'|’)re not a bot|temporarily blocked/i.test(stderr);
      if (duration === 'UPCOMING') {
        const releaseTimestamp = Number(info?.release_timestamp || info?.release_time || info?.timestamp);
        const retryAt = Number.isFinite(releaseTimestamp) && releaseTimestamp > Date.now() / 1000
          ? new Date(releaseTimestamp * 1000 + 15 * 60_000).toISOString()
          : new Date(Date.now() + 6 * 60 * 60_000).toISOString();
        setDurationLookup(id, 'upcoming', 'Upcoming live event or premiere. Video length will be checked again after it begins.', retryAt);
      } else if (duration) setDurationLookup(id, 'ready');
      else if (rateLimited) setDurationLookup(id, 'pending', 'YouTube is rate limiting requests. The length lookup will retry after the Local-mode pause.', new Date(youtubeRateLimitUntil).toISOString());
      else {
        const classified = classifyDurationFailure(stderr);
        if (classified) saveClassifiedDurationFailure(id, classified);
        else queueExtensionMetadataCapture(id, ageRestricted ? stderr : stderr.trim() || 'No duration metadata was returned.');
      }
      complete({ duration, blocked, ageRestricted, terminal: !duration && classifyDurationFailure(stderr)?.status === 'unavailable', extensionQueued: !duration && !rateLimited && !classifyDurationFailure(stderr) });
    });
  });
}

function probeLocalDuration(id) {
  return new Promise(resolve => {
    const filePath = getStoredMediaPath(id);
    if (!filePath) { resolve(''); return; }
    const probe = spawn(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timeout = setTimeout(() => { probe.kill('SIGKILL'); resolve(''); }, 10_000);
    timeout.unref();
    probe.stdout.setEncoding('utf8');
    probe.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-100); });
    probe.once('error', () => { clearTimeout(timeout); resolve(''); });
    probe.once('close', code => {
      clearTimeout(timeout);
      resolve(code === 0 ? formatDurationSeconds(output.trim()) : '');
    });
  });
}

function saveDurationLabel(id, duration) {
  if (duration) database.prepare("UPDATE videos SET duration = ? WHERE video_id = ? AND trim(duration) = ''").run(duration, id);
}

const backgroundDurationLookupIntervalMs = 5 * 60_000;
const backgroundDurationPendingRetryMs = 30 * 60_000;
const backgroundDurationUnavailableRetryMs = 7 * 24 * 60 * 60_000;
let lastBackgroundDurationLookupAt = 0;
let backgroundDurationLookupRunning = false;
let backgroundDurationLookupCooldownUntil = 0;

function scheduleBackgroundDurationLookup(currentVideoId = '') {
  const now = Date.now();
  if (backgroundDurationLookupRunning || downloadedMetadataWorkerRunning || networkMode !== 'online' || offlinePreparationRequested || offlinePreparation.status === 'running' || jobs.size || commentJobs.size) return;
  if (now - lastBackgroundDurationLookupAt < backgroundDurationLookupIntervalMs || now < backgroundDurationLookupCooldownUntil) return;
  const youtubeCooldown = Date.parse(database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(youtubeCooldownKey)?.value || '');
  if (Number.isFinite(youtubeCooldown) && youtubeCooldown > now) return;
  lastBackgroundDurationLookupAt = now;
  backgroundDurationLookupRunning = true;
  (async () => {
    const pendingBefore = new Date(now - backgroundDurationPendingRetryMs).toISOString();
    const unavailableBefore = new Date(now - backgroundDurationUnavailableRetryMs).toISOString();
    const nowIso = new Date(now).toISOString();
    const candidate = database.prepare(`
      SELECT v.video_id AS id, v.url, COALESCE(p.duration, 0) AS progressDuration,
        CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS hasLocalMedia,
        COALESCE(l.status, '') AS lookupStatus
      FROM videos v
      LEFT JOIN video_duration_lookups l ON l.video_id = v.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id
      WHERE (trim(v.duration) = '' OR l.status = 'upcoming') AND v.video_id <> ?
        AND (l.video_id IS NULL OR l.status = 'ready'
          OR (l.status = 'pending' AND l.updated_at <= ?)
          OR (l.status = 'unavailable' AND l.next_attempt_at <> 'never' AND l.updated_at <= ?)
          OR (l.status = 'upcoming' AND l.next_attempt_at <> '' AND l.next_attempt_at <= ?))
      ORDER BY CASE WHEN l.status = 'upcoming' AND l.next_attempt_at <= ? THEN 0 ELSE 1 END,
        CASE WHEN COALESCE(p.duration, 0) > 0 OR d.status = 'ready' THEN 0 ELSE 1 END,
        CASE WHEN l.video_id IS NULL THEN 0 WHEN l.status = 'pending' THEN 1 ELSE 2 END,
        MAX(v.last_seen,
          COALESCE((SELECT MAX(ci.added_at) FROM channel_items ci WHERE ci.video_id = v.video_id), ''),
          COALESCE((SELECT MAX(vp.last_seen) FROM video_provisions vp WHERE vp.video_id = v.video_id), '')) DESC
      LIMIT 1
    `).get(currentVideoId, pendingBefore, unavailableBefore, nowIso, nowIso);
    if (!candidate) return;

    let duration = formatDurationSeconds(candidate.progressDuration);
    if (!duration && candidate.hasLocalMedia) duration = await probeLocalDuration(candidate.id);
    if (duration) {
      saveDurationLabel(candidate.id, duration);
      setDurationLookup(candidate.id, 'ready', 'Duration recovered from local playback or media.');
      return;
    }

    const result = await lookupVideoDuration(candidate.id, candidate.url);
    if (result.blocked) backgroundDurationLookupCooldownUntil = Date.now() + youtubeCooldownDuration;
    else if (result.fatal) backgroundDurationLookupCooldownUntil = Date.now() + 6 * 60 * 60_000;
    if (result.duration) console.log(`Prepared video length for ${candidate.id} from yt-dlp metadata.`);
  })().catch(error => {
    backgroundDurationLookupCooldownUntil = Date.now() + 30 * 60_000;
    console.error('Background duration lookup:', error);
  }).finally(() => { backgroundDurationLookupRunning = false; });
}

function beginChannelLookup(id) {
  if (channelLookups.get(id)?.status === 'loading' || commentJobs.has(id)) return;
  const video = database.prepare('SELECT url, channel FROM videos WHERE video_id = ?').get(id);
  if (!video || video.channel.trim()) return;
  const lookup = { status: 'loading' };
  channelLookups.set(id, lookup);
  const child = spawn(process.env.YT_DLP_PATH || 'yt-dlp', [
    '--ignore-config', '--no-cookies', '--no-color', '--no-warnings', '--skip-download', '--dump-single-json', video.url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > 2_000_000) child.kill();
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-1000); });
  const timeout = setTimeout(() => {
    if (channelLookups.get(id) !== lookup) return;
    lookup.status = 'unavailable';
    child.kill();
  }, 30_000);
  timeout.unref();
  child.on('error', () => {
    clearTimeout(timeout);
    lookup.status = 'unavailable';
  });
  child.on('close', code => {
    clearTimeout(timeout);
    if (lookup.status !== 'loading') return;
    if (/HTTP Error 429|too many requests|rate.?limit/i.test(stderr)) {
      reportYouTubeRateLimit('YouTube returned HTTP 429 Too Many Requests during a channel lookup.');
      lookup.status = 'unavailable';
      return;
    }
    try {
      if (output.length > 2_000_000) throw new Error('Metadata exceeded the size limit.');
      const info = JSON.parse(output.trim());
      lookup.status = saveVideoChannel(id, info) ? 'ready' : 'unavailable';
    } catch {
      lookup.status = 'unavailable';
    }
  });
}

function beginComments(id, { preserveExisting = false, refreshThreadStructure = false, backfill = false } = {}) {
  if (commentJobs.has(id)) return;
  const video = database.prepare('SELECT url FROM videos WHERE video_id = ?').get(id);
  if (!video) {
    if (backfill) updateCommentBackfill(id, 'skipped', 'The video stub no longer exists.');
    return;
  }
  const previousComments = preserveExisting ? getComments(id)?.comments || [] : [];
  const finishBackfill = (status, message, delayMs = 0) => {
    if (!backfill) return;
    const nextAttemptAt = delayMs > 0 ? new Date(Date.now() + delayMs).toISOString() : '';
    updateCommentBackfill(id, status, message, nextAttemptAt);
  };
  const preserveOnError = message => {
    const preservedComments = getComments(id)?.comments || previousComments;
    if (preservedComments.length) {
      saveComments(id, 'ready', preservedComments, `${commentThreadStructureVersion}: refresh pending; ${message}`);
      return;
    }
    saveComments(id, 'error', [], message);
  };
  if (!backfill) {
    saveComments(id, 'loading', previousComments, refreshThreadStructure ? 'Refreshing reply threads; keeping the saved comments visible.' : 'Loading comments…');
  }
  const args = [
    '--ignore-config', '--no-cookies', '--no-color', '--no-warnings', '--no-progress',
    '--skip-download', '--write-comments', '--dump-single-json',
    '--extractor-args', `youtube:comment_sort=top;max_comments=${commentSnapshotLimit},${commentSnapshotLimit},${commentSnapshotLimit},${commentSnapshotLimit},all`, video.url
  ];
  const child = spawn(process.env.YT_DLP_PATH || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  commentJobs.set(id, child);
  let output = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > 24_000_000) child.kill();
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-3000); });
  const timeout = setTimeout(() => {
    if (!commentJobs.has(id)) return;
    const message = 'Comment lookup timed out before the larger sample finished.';
    preserveOnError(backfill ? message : `${message} Trying the rendered YouTube page through the extension.`);
    if (backfill) finishBackfill('retry', message, 30 * 60_000);
    else queueExtensionMetadataCapture(id, message);
    commentJobs.delete(id);
    child.kill();
  }, 5 * 60_000);
  timeout.unref();
  child.on('error', error => {
    clearTimeout(timeout);
    const message = error.code === 'ENOENT' ? 'yt-dlp is unavailable; comments could not be loaded.' : 'Could not start comment lookup.';
    preserveOnError(message);
    if (backfill) finishBackfill('retry', message, 60 * 60_000);
    else queueExtensionMetadataCapture(id, message);
    commentJobs.delete(id);
  });
  child.on('close', code => {
    clearTimeout(timeout);
    if (!commentJobs.has(id)) return;
    try {
      if (output.length > 24_000_000) throw new Error('Comment data exceeded the size limit.');
      const info = JSON.parse(output.trim());
      const fetchedComments = cleanComments(info.comments);
      const latestComments = getComments(id)?.comments || [];
      const comments = cleanComments([...fetchedComments, ...latestComments, ...previousComments]);
      saveVideoChannel(id, info);
      if (fetchedComments.length || (!previousComments.length && !latestComments.length)) {
        const message = `${commentSnapshotVersion}; ${fetchedComments.length} fetched, ${comments.length} saved.`;
        saveComments(id, 'ready', comments, message);
        finishBackfill('complete', message);
      } else {
        preserveOnError('No updated comments were returned; kept the previous saved snapshot.');
        finishBackfill('retry', 'No updated comments were returned; the previous snapshot was kept.', 60 * 60_000);
      }
    } catch {
      const blocked = /comments? (?:are )?disabled|comments? (?:are )?turned off/i.test(stderr);
      const ageRestricted = ageConfirmationPattern.test(stderr);
      const rateLimited = /HTTP Error 429|too many requests|rate.?limit/i.test(stderr);
      if (rateLimited) reportYouTubeRateLimit('YouTube returned HTTP 429 Too Many Requests during a comments lookup.');
      const message = rateLimited
        ? 'YouTube is rate limiting requests. Comments will retry after the Local-mode pause.'
        : blocked
        ? 'Comments are disabled for this video.'
        : ageRestricted
          ? 'YouTube requires age confirmation. Waiting for the extension to capture metadata from the signed-in browser page.'
          : code === 0 ? 'yt-dlp returned unusable comment metadata.' : 'Comments could not be loaded. Trying the rendered YouTube page through the extension.';
      const isReady = blocked;
      if (isReady) {
        if (previousComments.length) preserveOnError(message);
        else saveComments(id, 'ready', [], `${commentSnapshotVersion}; comments are disabled.`);
        finishBackfill('complete', message);
      } else {
        if (previousComments.length) preserveOnError(message);
        else saveComments(id, 'error', [], message);
        if (backfill) {
          const delay = rateLimited ? Math.max(30 * 60_000, youtubeRateLimitUntil - Date.now() + 60_000) : ageRestricted ? 6 * 60 * 60_000 : 60 * 60_000;
          finishBackfill('retry', message, delay);
        } else if (!rateLimited) queueExtensionMetadataCapture(id, ageRestricted ? stderr : message);
      }
    }
    commentJobs.delete(id);
  });
}

function seedCommentBackfillQueue() {
  const restartRetryAt = new Date(Date.now() + commentBackfillPaceMs).toISOString();
  database.prepare(`UPDATE comment_backfill_queue SET status = 'retry', next_attempt_at = ?,
    message = 'Comment expansion resumed after the server restarted.', updated_at = ? WHERE status = 'running'`)
    .run(restartRetryAt, new Date().toISOString());
  const insert = database.prepare(`INSERT OR IGNORE INTO comment_backfill_queue
    (video_id, status, attempts, next_attempt_at, message, created_at, updated_at)
    VALUES (?, 'queued', 0, '', ?, ?, ?)`);
  const now = new Date().toISOString();
  const rows = database.prepare(`SELECT video_id AS id, comments_json AS commentsJson, message
    FROM video_comments WHERE status = 'ready' AND instr(message, ?) = 0`).all(commentSnapshotVersion);
  let added = 0;
  for (const row of rows) {
    let comments = [];
    try { comments = JSON.parse(row.commentsJson); } catch {}
    if (!Array.isArray(comments) || !comments.length) continue;
    const result = insert.run(row.id, 'Existing comment sample queued for expansion to 1,000.', now, now);
    added += Number(result.changes) || 0;
  }
  if (added) console.info(`[comments] Queued ${added} existing snapshots for gradual expansion to ${commentSnapshotLimit}.`);
}
seedCommentBackfillQueue();

function runCommentBackfillQueue() {
  if (commentBackfillWorkerRunning || networkMode !== 'online' || offlinePreparationRequested || offlinePreparation.status === 'running' ||
      connectivityStatus.available !== true || youtubeRateLimitIsActive()) return;
  const availableSlots = commentBackfillConcurrency() - commentJobs.size;
  if (availableSlots <= 0) return;
  const nowMs = Date.now();
  const nextStartAt = Date.parse(database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'comment_backfill_next_start_at'").get()?.value || '');
  if (Number.isFinite(nextStartAt) && nextStartAt > nowMs) return;
  const now = new Date(nowMs).toISOString();
  const items = database.prepare(`SELECT q.video_id AS id, q.attempts, c.message AS commentsMessage
    FROM comment_backfill_queue q LEFT JOIN video_comments c ON c.video_id = q.video_id
    WHERE q.status IN ('queued', 'retry') AND (q.next_attempt_at = '' OR q.next_attempt_at <= ?)
    ORDER BY CASE q.status WHEN 'retry' THEN 0 ELSE 1 END, q.created_at LIMIT 100`).all(now);
  if (!items.length) return;
  commentBackfillWorkerRunning = true;
  let started = 0;
  try {
    for (const item of items) {
      if (started >= availableSlots) break;
      if (commentJobs.has(item.id)) continue;
      if (String(item.commentsMessage || '').includes(commentSnapshotVersion)) {
        updateCommentBackfill(item.id, 'complete', 'This snapshot already has the 1,000-comment capture version.');
        continue;
      }
      if (!database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(item.id)) {
        updateCommentBackfill(item.id, 'skipped', 'The video stub no longer exists.');
        continue;
      }
      const attempts = (Number(item.attempts) || 0) + 1;
      database.prepare(`UPDATE comment_backfill_queue SET status = 'running', attempts = ?, next_attempt_at = '',
        message = ?, updated_at = ? WHERE video_id = ?`).run(attempts, `Fetching a larger comment sample (attempt ${attempts}).`, now, item.id);
      try {
        beginComments(item.id, { preserveExisting: true, refreshThreadStructure: true, backfill: true });
        if (commentJobs.has(item.id)) started += 1;
      } catch (error) {
        const delay = Math.min(24 * 60 * 60_000, 15 * 60_000 * (2 ** Math.min(attempts - 1, 6)));
        updateCommentBackfill(item.id, 'retry', error.message || 'Comment expansion could not start.', new Date(Date.now() + delay).toISOString());
      }
    }
    if (started) {
      const nextAllowedAt = new Date(nowMs + commentBackfillPaceMs).toISOString();
      persistAppSetting('comment_backfill_next_start_at', nextAllowedAt);
    }
  } finally {
    commentBackfillWorkerRunning = false;
  }
}

function updateDownloadedMetadata(id, status, phase, message, { attempts, nextAttemptAt } = {}) {
  const previous = database.prepare('SELECT attempts FROM download_metadata WHERE video_id = ?').get(id);
  const count = Number.isInteger(attempts) ? attempts : Number(previous?.attempts) || 0;
  const retryAt = nextAttemptAt === undefined ? '' : nextAttemptAt;
  database.prepare(`INSERT INTO download_metadata (video_id, status, phase, attempts, next_attempt_at, message, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET
      status = excluded.status, phase = excluded.phase, attempts = excluded.attempts,
      next_attempt_at = excluded.next_attempt_at, message = excluded.message, updated_at = excluded.updated_at`)
    .run(id, status, phase, count, retryAt, String(message || '').slice(0, 1000), new Date().toISOString());
}

function queueDownloadedMetadata(id) {
  const now = new Date().toISOString();
  database.prepare(`INSERT OR IGNORE INTO download_metadata (video_id, status, phase, attempts, next_attempt_at, message, updated_at)
    VALUES (?, 'pending', 'queued', 0, '', 'Preparing local metadata for this media.', ?)`)
    .run(id, now);
}

function markDownloadedMetadataDirty(id) {
  const current = database.prepare('SELECT status FROM download_metadata WHERE video_id = ?').get(id);
  if (current?.status === 'ready') updateDownloadedMetadata(id, 'pending', 'queued', 'Video comments changed; refreshing locally stored assets.', { attempts: 0, nextAttemptAt: '' });
}

function commentsForMetadata(id) {
  const row = database.prepare('SELECT status, comments_json AS commentsJson, message FROM video_comments WHERE video_id = ?').get(id);
  if (!row) return null;
  let comments = [];
  try { comments = JSON.parse(row.commentsJson); } catch {}
  return { ...row, comments: Array.isArray(comments) ? comments : [] };
}

function metadataThumbnailCandidates(video) {
  const id = String(video?.id || video?.video_id || '');
  let storedMetadata = {};
  try { storedMetadata = JSON.parse(database.prepare('SELECT metadata_json AS value FROM video_metadata WHERE video_id = ?').get(id)?.value || '{}'); } catch {}
  const variants = Array.isArray(storedMetadata.thumbnails) ? storedMetadata.thumbnails.map(item => item?.url) : [];
  const defaults = /^[A-Za-z0-9_-]{11}$/.test(id)
    ? [`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, `https://i.ytimg.com/vi/${id}/sddefault.jpg`]
    : [];
  return [...new Set([video?.thumbnail, storedMetadata.thumbnail, ...variants, ...defaults].filter(value => typeof value === 'string' && value.startsWith('https://')))];
}

const viewedThumbnailRetryAt = new Map();
async function cacheNextViewedStubThumbnail() {
  if (networkMode !== 'online' || offlinePreparationRequested || connectivityStatus.available === false) return false;
  const now = Date.now();
  const rows = database.prepare(`SELECT v.video_id AS id, v.thumbnail, w.view_count AS viewCount
    FROM videos v JOIN video_views w ON w.video_id = v.video_id
    WHERE w.view_count > 0
      AND NOT EXISTS (SELECT 1 FROM video_thumbnail_assets ta WHERE ta.video_id = v.video_id)
      AND NOT EXISTS (SELECT 1 FROM cached_images ci WHERE ci.source_url = v.thumbnail)
    ORDER BY w.view_count DESC, w.updated_at DESC, v.video_id LIMIT 250`).all();
  for (const video of rows) {
    if ((viewedThumbnailRetryAt.get(video.id) || 0) > now) continue;
    const candidates = metadataThumbnailCandidates(video);
    const cached = candidates.find(source => existingCachedImage(source));
    if (cached) {
      rememberVideoThumbnail(video.id, cached);
      if (video.thumbnail !== cached) database.prepare('UPDATE videos SET thumbnail = ? WHERE video_id = ?').run(cached, video.id);
      viewedThumbnailRetryAt.delete(video.id);
      continue;
    }
    for (const source of candidates) {
      if (!await cacheRemoteImage(source)) continue;
      rememberVideoThumbnail(video.id, source);
      if (video.thumbnail !== source) database.prepare('UPDATE videos SET thumbnail = ? WHERE video_id = ?').run(source, video.id);
      viewedThumbnailRetryAt.delete(video.id);
      return true;
    }
    viewedThumbnailRetryAt.set(video.id, now + 15 * 60_000);
    return false;
  }
  return false;
}

function downloadedMetadataGaps(id) {
  const video = database.prepare(`SELECT video_id AS id, title, channel, channel_key AS channelKey, thumbnail, avatar, duration
    FROM videos WHERE video_id = ?`).get(id);
  if (!video) return ['video metadata row is missing'];
  const gaps = [];
  if (!String(video.title || '').trim()) gaps.push('title');
  if (!String(video.channel || '').trim() || /^(youtube|channel unavailable)$/i.test(String(video.channel).trim())) gaps.push('channel name');
  const duration = String(video.duration || '').trim();
  if (!duration || /^(LIVE|UPCOMING)$/i.test(duration)) gaps.push('video length');
  const comments = commentsForMetadata(id);
  if (!comments || comments.status !== 'ready') gaps.push('comments');
  let thumbnailAsset = existingVideoThumbnail(id);
  if (!thumbnailAsset) {
    const source = metadataThumbnailCandidates(video).find(candidate => existingCachedImage(candidate));
    if (source) thumbnailAsset = rememberVideoThumbnail(id, source);
  }
  if (!thumbnailAsset) gaps.push('thumbnail');
  const commentImages = comments?.comments?.map(comment => comment.authorThumbnail).filter(Boolean) || [];
  for (const source of [video.avatar, ...commentImages].filter(Boolean)) {
    if (!existingCachedImage(source)) gaps.push(source === video.avatar ? 'channel avatar' : 'commenter avatar');
  }
  let storedMetadata = {};
  let localAssets = [];
  const metadataRow = database.prepare('SELECT metadata_json AS metadataJson, local_assets_json AS localAssetsJson FROM video_metadata WHERE video_id = ?').get(id);
  try { storedMetadata = JSON.parse(metadataRow?.metadataJson || '{}'); } catch {}
  try { localAssets = JSON.parse(metadataRow?.localAssetsJson || '[]'); } catch {}
  if (!metadataRow) gaps.push('metadata record');
  const indexedAssets = new Set(Array.isArray(localAssets) ? localAssets.map(asset => asset?.sourceUrl).filter(Boolean) : []);
  for (const source of [thumbnailAsset?.sourceUrl, video.avatar, ...commentImages].filter(Boolean)) {
    if (existingCachedImage(source) && !indexedAssets.has(source)) gaps.push('local asset index');
  }
  return [...new Set(gaps)];
}

function reconcileDownloadedMetadata(ids) {
  let pending = 0;
  for (const id of ids) {
    const video = database.prepare('SELECT thumbnail, avatar FROM videos WHERE video_id = ?').get(id);
    const comments = commentsForMetadata(id);
    let cachedThumbnail = existingVideoThumbnail(id)?.sourceUrl || '';
    if (!cachedThumbnail) {
      cachedThumbnail = metadataThumbnailCandidates({ id, thumbnail: video?.thumbnail }).find(source => existingCachedImage(source)) || '';
      if (cachedThumbnail) rememberVideoThumbnail(id, cachedThumbnail);
    }
    if (cachedThumbnail && video?.thumbnail !== cachedThumbnail) database.prepare('UPDATE videos SET thumbnail = ? WHERE video_id = ?').run(cachedThumbnail, id);
    const localAssets = [];
    for (const [type, source] of [['thumbnail', cachedThumbnail], ['channel-avatar', video?.avatar], ...((comments?.comments || []).map(comment => ['commenter-avatar', comment.authorThumbnail]))]) {
      if (!source) continue;
      const cached = existingCachedImage(source);
      if (cached) localAssets.push({ type, sourceUrl: source, cacheKey: cached.key });
    }
    saveLocalVideoMetadataSnapshot(id, localAssets);
    const gaps = downloadedMetadataGaps(id);
    if (gaps.length) {
      pending += 1;
      updateDownloadedMetadata(id, 'pending', 'queued', `Waiting for local metadata: ${gaps.join(', ')}.`, { nextAttemptAt: '' });
    } else {
      updateDownloadedMetadata(id, 'ready', 'complete', 'Video details, comments, and referenced images are stored locally.', { attempts: 0, nextAttemptAt: '' });
    }
  }
  return pending;
}

async function waitForComments(id, timeoutMs = 100_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const comments = commentsForMetadata(id);
    if (comments && comments.status !== 'loading') return comments;
    if (!commentJobs.has(id) && comments?.status !== 'loading') return comments;
    await waitForBackground(500);
  }
  return commentsForMetadata(id);
}

async function ensureDownloadedMetadata(id, reportPhase) {
  const mediaPath = getStoredMediaPath(id);
  if (!mediaPath) throw new Error('The downloaded media file is missing.');
  let video = database.prepare(`SELECT video_id AS id, url, title, channel, channel_key AS channelKey, channel_url AS channelUrl,
    thumbnail, avatar, duration, meta, kind, section, topic FROM videos WHERE video_id = ?`).get(id);
  if (!video) throw new Error('The video metadata row is missing.');

  const channelMissing = !String(video.channel || '').trim() || /^(youtube|channel unavailable)$/i.test(String(video.channel || '').trim());
  if (channelMissing && networkMode === 'online' && !offlinePreparationRequested) {
    queueExtensionMetadataCapture(id, 'The channel name is missing from local metadata.', { force: true });
    throw new Error('Channel name is missing; requesting rendered details from the signed-in YouTube page.');
  }

  await reportPhase('video length', 'Checking the saved video length…');
  if (!video.duration || /^(LIVE|UPCOMING)$/i.test(String(video.duration).trim())) {
    const playbackDuration = database.prepare('SELECT duration FROM video_progress WHERE video_id = ?').get(id)?.duration;
    const localDuration = await probeLocalDuration(id) || formatDurationSeconds(playbackDuration);
    if (localDuration) {
      database.prepare(`UPDATE videos SET duration = ? WHERE video_id = ? AND (trim(duration) = '' OR upper(trim(duration)) IN ('LIVE', 'UPCOMING'))`).run(localDuration, id);
    }
  }

  await reportPhase('comments', 'Storing comments and commenter details…');
  let comments = commentsForMetadata(id);
  if (!comments || comments.status !== 'ready') {
    if (!commentJobs.has(id)) beginComments(id);
    comments = await waitForComments(id);
  }
  if (!comments || comments.status !== 'ready') throw new Error(comments?.message || 'Comments are not stored yet.');

  video = database.prepare(`SELECT video_id AS id, url, title, channel, channel_key AS channelKey, channel_url AS channelUrl,
    thumbnail, avatar, duration, meta, kind, section, topic FROM videos WHERE video_id = ?`).get(id);
  if (!video) throw new Error('The video metadata row disappeared.');
  if (!video.avatar && video.channelKey) {
    const knownAvatar = database.prepare(`SELECT ${channelAvatarSelect('v')} AS avatar FROM videos v WHERE v.video_id = ?`).get(id)?.avatar;
    if (knownAvatar) {
      database.prepare('UPDATE videos SET avatar = ? WHERE video_id = ? AND trim(avatar) = \'\'').run(knownAvatar, id);
      video.avatar = knownAvatar;
    }
  }
  let storedMetadata = {};
  try { storedMetadata = JSON.parse(database.prepare('SELECT metadata_json AS value FROM video_metadata WHERE video_id = ?').get(id)?.value || '{}'); } catch {}
  const missingVideoDetails = !String(video.title || '').trim() || !String(video.channel || '').trim() ||
    /^(youtube|channel unavailable)$/i.test(String(video.channel || '').trim()) || !video.thumbnail ||
    !video.duration || /^(LIVE|UPCOMING)$/i.test(String(video.duration).trim());
  if (missingVideoDetails && networkMode === 'online' && !offlinePreparationRequested) {
    await reportPhase('video details', 'Filling missing video details from yt-dlp…');
    const result = await lookupVideoDuration(id, video.url);
    if (result.blocked) throw new Error('YouTube temporarily limited metadata lookup; this video will retry later.');
    if (result.fatal) throw new Error('yt-dlp is unavailable; this video will retry when it is available.');
    video = database.prepare(`SELECT video_id AS id, url, title, channel, channel_key AS channelKey, channel_url AS channelUrl,
      thumbnail, avatar, duration, meta, kind, section, topic FROM videos WHERE video_id = ?`).get(id);
  }

  await reportPhase('thumbnails', 'Caching the video thumbnail and channel image…');
  const thumbnailCandidates = metadataThumbnailCandidates(video);
  let localThumbnail = existingVideoThumbnail(id)?.sourceUrl || thumbnailCandidates.find(source => existingCachedImage(source)) || '';
  for (const source of thumbnailCandidates) {
    if (localThumbnail) break;
    if (await cacheRemoteImage(source)) localThumbnail = source;
  }
  if (!localThumbnail) throw new Error('The video thumbnail could not be stored locally; it will retry later.');
  rememberVideoThumbnail(id, localThumbnail);
  if (video.thumbnail !== localThumbnail) database.prepare('UPDATE videos SET thumbnail = ? WHERE video_id = ?').run(localThumbnail, id);

  const imageSources = [video.avatar, ...(comments.comments || []).map(comment => comment.authorThumbnail)].filter(Boolean);
  const localAssets = [{ type: 'thumbnail', sourceUrl: localThumbnail, cacheKey: existingCachedImage(localThumbnail)?.key }];
  for (const source of [...new Set(imageSources)]) {
    await reportPhase(source === video.avatar ? 'channel avatar' : 'comment avatars', source === video.avatar ? 'Caching the channel avatar…' : 'Caching commenter avatars…');
    if (!await cacheRemoteImage(source)) throw new Error(`An image used by this video's comments or channel could not be stored locally; it will retry later.`);
    localAssets.push({ type: source === video.avatar ? 'channel-avatar' : 'commenter-avatar', sourceUrl: source, cacheKey: existingCachedImage(source)?.key });
  }
  saveLocalVideoMetadataSnapshot(id, localAssets);
  const gaps = downloadedMetadataGaps(id);
  if (gaps.length) throw new Error(`Local metadata is incomplete: ${gaps.join(', ')}.`);
}

async function runDownloadedMetadataQueue() {
  if (downloadedMetadataWorkerRunning || backgroundDurationLookupRunning || networkMode !== 'online' || offlinePreparationRequested || offlinePreparation.status === 'running' || jobs.size || commentJobs.size || [...channelLookups.values()].some(lookup => lookup.status === 'loading')) return;
  if (connectivityStatus.available === false) return;
  const cooldownUntil = Date.parse(database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(youtubeCooldownKey)?.value || '');
  if (areDownloadProtectionsActive() && Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) return;
  const now = new Date().toISOString();
  const item = database.prepare(`SELECT d.video_id AS id, m.attempts
    FROM downloads d LEFT JOIN download_metadata m ON m.video_id = d.video_id
    WHERE d.status = 'ready' AND (m.video_id IS NULL OR m.status IN ('pending', 'retry'))
      AND (COALESCE(m.next_attempt_at, '') = '' OR m.next_attempt_at <= ?)
    ORDER BY d.acquired_at ASC LIMIT 1`).get(now);
  if (!item) {
    downloadedMetadataWorkerRunning = true;
    try { await cacheNextViewedStubThumbnail(); }
    catch (error) { console.warn('[stub-thumbnail-cache]', error.message || error); }
    finally { downloadedMetadataWorkerRunning = false; }
    return;
  }

  downloadedMetadataWorkerRunning = true;
  const attempts = Number(item.attempts) || 0;
  const reportPhase = async (phase, message) => updateDownloadedMetadata(item.id, 'running', phase, message, { attempts, nextAttemptAt: '' });
  updateDownloadedMetadata(item.id, 'running', 'starting', 'Checking locally stored media metadata…', { attempts, nextAttemptAt: '' });
  try {
    await ensureDownloadedMetadata(item.id, reportPhase);
    updateDownloadedMetadata(item.id, 'ready', 'complete', 'Video details, comments, and referenced images are stored locally.', { attempts: 0, nextAttemptAt: '' });
  } catch (error) {
    const lookupStatus = database.prepare('SELECT status FROM video_duration_lookups WHERE video_id = ?').get(item.id)?.status;
    if (lookupStatus === 'extension' || lookupStatus === 'capturing' || lookupStatus === 'extension-retry') {
      updateDownloadedMetadata(item.id, 'waiting-extension', 'extension capture', 'Waiting for the extension to capture metadata from the signed-in browser page.', { attempts, nextAttemptAt: '' });
      console.info(`[download-metadata] ${item.id}: waiting for extension page capture.`);
      return;
    }
    const nextAttempts = attempts + 1;
    const retryDelay = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(nextAttempts - 1, 10));
    const retryAt = new Date(Date.now() + retryDelay).toISOString();
    updateDownloadedMetadata(item.id, 'retry', 'queued', error.message || 'Metadata preparation failed; it will retry.', { attempts: nextAttempts, nextAttemptAt: retryAt });
    console.warn(`[download-metadata] ${item.id}: ${error.message || 'metadata preparation failed'}`);
  } finally {
    downloadedMetadataWorkerRunning = false;
    setTimeout(() => runDownloadedMetadataQueue().catch(error => console.error('Downloaded metadata preparation:', error)), 2500).unref();
  }
}

async function beginDownload(id) {
  if (mediaFolderImports.has(id)) return getDownload(id) || { status: 'importing', message: 'Checking the media file already present in the library folder.' };
  if (downloadStartingIds.has(id)) return { status: 'downloading', message: 'Preparing the local media destination.' };
  if (getStoredMediaPath(id)) {
    const previousStatus = database.prepare('SELECT status FROM downloads WHERE video_id = ?').get(id)?.status;
    if (previousStatus !== 'ready' || !hasSavedIntegrityChecksum(id)) {
      try { await verifyLocalMediaIntegrity(id); }
      catch (error) {
        if (String(error.code || '').startsWith('INTEGRITY_') || ['MEDIA_INTEGRITY', 'MEDIA_MISSING'].includes(error.code)) {
          const message = await recordMediaIntegrityFailure(id, error);
          return getDownload(id) || { status: 'error', message };
        }
        throw error;
      }
    }
    saveDownload(id, 'ready', '', 100, 'Ready to play');
    return { status: 'ready', message: '', progress: 100, stage: 'Ready to play', mediaExtension: getStoredMediaExtension(id) };
  }

  if (isAcquisitionExcluded(id)) return null;
  if (jobs.has(id)) return getDownload(id) || { status: 'downloading', message: '' };
  const video = database.prepare('SELECT url, duration FROM videos WHERE video_id = ?').get(id);
  if (!video) return null;

  const allowMp4Fallback = hasFiniteVideoDuration(video.duration);
  const format = ffmpegAvailable
    ? `bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]${allowMp4Fallback ? '/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]' : ''}`
    : `best[ext=webm]${allowMp4Fallback ? '/best[ext=mp4]' : ''}`;
  downloadStartingIds.add(id);
  let outputDirectory;
  try {
    outputDirectory = await ensureVideoMediaDirectory(id);
  } catch (error) {
    downloadStartingIds.delete(id);
    mediaFolderDeferredRechecks.delete(id);
    throw error;
  }
  if (jobs.has(id) || mediaFolderImports.has(id)) {
    downloadStartingIds.delete(id);
    return getDownload(id) || { status: 'importing', message: 'Another local media operation is already active.' };
  }
  if (getStoredMediaPath(id)) {
    downloadStartingIds.delete(id);
    mediaFolderDeferredRechecks.delete(id);
    mediaFolderCandidates.delete(id);
    mediaFolderFailedFingerprints.delete(id);
    try {
      database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
      saveDownload(id, 'importing', 'A local copy appeared while the download was being prepared. Checking that file first.', 0, 'Queued for integrity check');
      database.prepare("UPDATE downloads SET origin = 'media-folder' WHERE video_id = ?").run(id);
    } catch (error) {
      scheduleMediaFolderScan(500);
      throw error;
    }
    scheduleMediaFolderScan(0);
    return { status: 'importing', message: 'A local copy appeared while the download was being prepared. Checking that file first.', stage: 'Queued for integrity check' };
  }
  const args = [
    '--ignore-config', '--no-cookies', '--no-playlist', '--no-color', '--newline', '--progress', '--progress-delta', '0.5',
    '--progress-template', 'download:YT_PROGRESS:%(progress._percent_str)s', '--format', format,
    '--print', 'before_dl:YT_LIVE:%(live_status)s', '--merge-output-format', 'webm/mp4', '--output', path.join(outputDirectory, '%(id)s.%(ext)s'), video.url
  ];
  let job;
  try {
    saveDownload(id, 'downloading', '', 0, 'Checking video formats…');
    const startedAt = database.prepare('SELECT started_at AS value FROM downloads WHERE video_id = ?').get(id)?.value || new Date().toISOString();
    job = { status: 'downloading', progress: 0, stage: 'Checking video formats…', startedAt, transferStarted: false, offlinePauseRequested: false, pauseRequested: false, finishRequested: false, finishPhase: '', isLive: false, endRequested: false, discardRequested: false };
    jobs.set(id, job);
  } catch (error) {
    downloadStartingIds.delete(id);
    mediaFolderDeferredRechecks.delete(id);
    throw error;
  }
  downloadStartingIds.delete(id);
  const downloadProcess = spawn(process.env.YT_DLP_PATH || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.process = downloadProcess;
  let ytOutput = '';
  const progressBuffers = { stdout: '', stderr: '' };
  const consumeProgress = (stream, chunk) => {
    const lines = (progressBuffers[stream] + chunk).split(/\r\n|\n|\r/);
    progressBuffers[stream] = lines.pop() || '';
    for (const line of lines) {
      let stage = job.stage;
      let progress = job.progress;
      const cleanLine = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      const liveStatus = cleanLine.match(/YT_LIVE:(is_live|is_upcoming|was_live|post_live|not_live)/i);
      if (liveStatus && liveStatus[1].toLowerCase() === 'is_live') {
        job.isLive = true;
        stage = 'Recording live stream…';
      }
      if (cleanLine.includes('YT_PROGRESS:') || /\[download\].*Destination:/i.test(cleanLine) || /\[Merger\]|Merging formats/i.test(cleanLine)) {
        job.transferStarted = true;
      }
      const match = cleanLine.match(/YT_PROGRESS:\s*([\d.]+)%|\[download\]\s+([\d.]+)%/i);
      if (match && !job.isLive) {
        progress = Math.max(progress, Math.min(99, Number(match[1] || match[2]) || 0));
        stage = progress >= 99 ? 'Download complete; finalizing the local file…' : `Downloading video… ${Math.floor(progress)}%`;
      } else if (/\[Merger\]|Merging formats/i.test(cleanLine)) {
        stage = 'Merging video and audio…';
      } else if (/\[download\].*Destination:/i.test(cleanLine)) {
        stage = 'Starting video download…';
      } else if (/\[youtube\]|\[extractor/i.test(cleanLine)) {
        stage = 'Checking video formats…';
      }
      if (job.finishRequested && !job.isLive) {
        stage = job.finishPhase === 'audio'
          ? `Downloading audio track to finish… ${Math.floor(progress)}%`
          : job.finishPhase === 'merge'
            ? 'Merging the saved video and audio…'
            : 'Stopping video transfer to save the current footage…';
      }
      if (stage !== job.stage || progress !== job.progress) {
        job.stage = stage;
        job.progress = progress;
        saveDownload(id, 'downloading', '', progress, stage);
      }
    }
  };
  downloadProcess.stdout.setEncoding('utf8');
  downloadProcess.stderr.setEncoding('utf8');
  downloadProcess.stdout.on('data', chunk => {
    ytOutput = `${ytOutput}${chunk}`.slice(-6000);
    consumeProgress('stdout', chunk);
  });
  downloadProcess.stderr.on('data', chunk => {
    ytOutput = `${ytOutput}${chunk}`.slice(-6000);
    consumeProgress('stderr', chunk);
  });
  downloadProcess.on('error', error => {
    const message = error.code === 'ENOENT' ? 'yt-dlp is not installed or not available on PATH.' : 'Could not start yt-dlp.';
    saveDownload(id, 'error', message, 0, 'Could not start download');
    recordDownloadFailure(id, message);
    releaseDownloadJob(id);
  });
  downloadProcess.on('close', async code => {
    if (!jobs.has(id)) return;
    if (job.acquisitionExclusionReason) {
      try { await discardDownloadFiles(id); } catch (error) { console.error(`Could not clear excluded media fragments for ${id}:`, error); }
      releaseDownloadJob(id);
      excludeAcquisitionVideo(id, job.acquisitionExclusionReason);
      return;
    }
    for (const stream of ['stdout', 'stderr']) {
      if (progressBuffers[stream]) consumeProgress(stream, '\n');
    }
    if (job.finishRequested) {
      try {
        if (job.isLive) {
          job.stage = 'Finalizing the captured live audio and video…';
          saveDownload(id, 'downloading', '', job.progress, job.stage);
          await finalizePartialWebm(id, { allowLongerAudio: true });
        } else {
          const video = database.prepare('SELECT url FROM videos WHERE video_id = ?').get(id);
          await finishPartialDownload(id, video?.url || '', job);
        }
        await verifyLocalMediaIntegrity(id, { downloadJob: job });
        saveDownload(id, 'ready', '', 100, 'Ready to play');
        markFreshMediaAcquisition(id);
      } catch (error) {
        if (error.code === 'WAITING_FOR_ONLINE') markFinishWaitingForOnline(id, job.progress);
        else if (String(error.code || '').startsWith('INTEGRITY_') || error.code === 'MEDIA_INTEGRITY') {
          await recordMediaIntegrityFailure(id, error, { progress: job.progress });
        }
        else {
          const message = `Finish and save could not complete yet: ${error.message} The captured files are preserved; retry when ready.`;
          markDownloadPausedByUser(id, job.progress, message);
        }
      }
      releaseDownloadJob(id);
      return;
    }
    if (job.endRequested) {
      try {
        await finalizePartialWebm(id, { allowLongerAudio: true });
        await verifyLocalMediaIntegrity(id, { downloadJob: job });
        saveDownload(id, 'ready', '', 100, 'Ready to play');
        markFreshMediaAcquisition(id);
      } catch (error) {
        if (String(error.code || '').startsWith('INTEGRITY_') || error.code === 'MEDIA_INTEGRITY') {
          await recordMediaIntegrityFailure(id, error, { progress: job.progress });
          releaseDownloadJob(id);
          return;
        }
        const message = `Could not finish and save this live capture: ${error.message} The captured files are paused; retry to continue downloading.`;
        markDownloadPausedByUser(id, job.progress, message);
      }
      releaseDownloadJob(id);
      return;
    }
    if (job.pauseRequested) {
      if (getStoredMediaPath(id)) {
        try {
          await verifyLocalMediaIntegrity(id, { downloadJob: job });
          saveDownload(id, 'ready', '', 100, 'Ready to play');
        } catch (error) {
          await recordMediaIntegrityFailure(id, error, { paused: true, progress: job.progress });
        }
      } else {
        markDownloadPausedByUser(id, job.progress);
      }
      releaseDownloadJob(id);
      return;
    }
    if (job.offlinePauseRequested) {
      if (getStoredMediaPath(id)) {
        try {
          await verifyLocalMediaIntegrity(id, { downloadJob: job });
          saveDownload(id, 'ready', '', 100, 'Ready to play');
        } catch (error) {
          await recordMediaIntegrityFailure(id, error, { progress: job.progress });
        }
      } else {
        if (offlinePreparationRequested || networkMode === 'offline') markDownloadPausedOffline(id);
        else queueCancelledDownloadForOnline(id);
      }
      releaseDownloadJob(id);
      return;
    }
    if (job.discardRequested) {
      try { await discardDownloadFiles(id); } catch (error) { console.error(`Could not discard live capture ${id}:`, error); }
      database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
      saveDownload(id, 'discarded', 'Live capture discarded.', 0, 'Discarded');
      releaseDownloadJob(id);
      return;
    }
    try {
      if (!getStoredMediaPath(id)) throw new Error('No complete local media file was created.');
      await verifyLocalMediaIntegrity(id, { downloadJob: job });
      saveDownload(id, 'ready', '', 100, 'Ready to play');
      markFreshMediaAcquisition(id);
    } catch (error) {
      if (String(error.code || '').startsWith('INTEGRITY_') || error.code === 'MEDIA_INTEGRITY' || error.code === 'MEDIA_MISSING') {
        await recordMediaIntegrityFailure(id, error, { progress: job.progress });
        releaseDownloadJob(id);
        return;
      }
      const unsupported = /requested format is not available|no video formats found|requested format not available/i.test(ytOutput);
      const signInRequired = /sign in to confirm (?:you(?:'|’)re|you are) not a bot/i.test(ytOutput);
      const lastErrorLine = ytOutput.split(/\r?\n/).map(line => line.trim()).filter(line => /^ERROR:/i.test(line)).at(-1)?.replace(/https?:\/\/\S+/g, '[URL]');
      if (/HTTP Error 429|too many requests|rate.?limit/i.test(ytOutput)) {
        reportYouTubeRateLimit('YouTube returned HTTP 429 Too Many Requests during a media download.');
      }
      const message = signInRequired
        ? 'YouTube requires a signed-in session for this video. YourTube keeps browser credentials out of the download backend, so automatic retries are paused.'
        : unsupported
        ? 'YouTube did not offer a compatible WebM or MP4 format for this video.'
        : code === 0
          ? 'yt-dlp finished, but no playable WebM or MP4 file was produced.'
          : lastErrorLine || 'This video could not be acquired as a local WebM or MP4. It may be unavailable or require unsupported access.';
      saveDownload(id, 'error', message, job.progress, 'Download failed');
      recordDownloadFailure(id, message);
    }
    releaseDownloadJob(id);
  });
  return { status: 'downloading', message: '' };
}

async function serveMedia(request, response, id) {
  const filePath = getStoredMediaPath(id);
  if (!filePath) { response.writeHead(404).end('Media not found'); return; }
  let fileInfo;
  try { fileInfo = await stat(filePath); } catch { response.writeHead(404).end('Media not found'); return; }
  const range = request.headers.range;
  response.setHeader('Accept-Ranges', 'bytes');
  const extension = path.extname(filePath).slice(1).toLowerCase();
  response.setHeader('Content-Type', mediaContentTypes[extension] || 'application/octet-stream');
  response.setHeader('Cache-Control', 'no-store');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) { response.writeHead(416, { 'Content-Range': `bytes */${fileInfo.size}` }).end(); return; }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), fileInfo.size - 1) : fileInfo.size - 1;
    if (start > end || start >= fileInfo.size) { response.writeHead(416, { 'Content-Range': `bytes */${fileInfo.size}` }).end(); return; }
    response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${fileInfo.size}` });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { 'Content-Length': fileInfo.size });
  createReadStream(filePath).pipe(response);
}

async function currentDownloadBytes(id) {
  const directories = [...new Set([getVideoMediaDirectory(id), mediaDirectory, shortsMediaDirectory])];
  const paths = (await Promise.all(directories.map(async directory => {
    const entries = await readdir(directory).catch(() => []);
    return entries.filter(name => name.startsWith(`${id}.`) && !name.endsWith('.ytdl') && !name.includes('.finalizing.'))
      .map(name => path.join(directory, name));
  }))).flat();
  const sizes = await Promise.all(paths.map(async filePath => {
    try { return (await stat(filePath)).size; } catch { return 0; }
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

async function discardDownloadFiles(id) {
  const directories = [...new Set([mediaDirectory, shortsMediaDirectory])];
  for (const directory of directories) {
    const entries = await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    await Promise.all(entries.filter(name => name.startsWith(`${id}.`)).map(name => unlink(path.join(directory, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    })));
  }
  const quarantineDirectory = path.join(dataDirectory, 'quarantine');
  try {
    const quarantined = await readdir(quarantineDirectory);
    await Promise.all(quarantined.filter(name => name.startsWith(`${id}-`)).map(name => unlink(path.join(quarantineDirectory, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    })));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function cleanupExpiredMedia() {
  if (!autoDeleteEnabled) return;
  const now = new Date().toISOString();
  const expired = database.prepare("SELECT video_id AS id, expires_at AS expiresAt FROM downloads WHERE status = 'ready' AND expires_at <> '' AND expires_at <= ? ORDER BY expires_at").all(now);
  for (const item of expired) {
    if (!autoDeleteEnabled) return;
    if (jobs.has(item.id)) continue;
    // Recheck the persisted setting and expiry immediately before unlinking.
    // Keep this section synchronous: an awaited unlink allowed the user to turn
    // Auto-delete off after the check but before the file was actually removed.
    database.exec('BEGIN IMMEDIATE');
    try {
      const savedSetting = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'auto_delete_enabled'").get();
      const current = database.prepare("SELECT expires_at AS expiresAt FROM downloads WHERE video_id = ? AND status = 'ready'").get(item.id);
      if (savedSetting?.value !== 'true') {
        autoDeleteEnabled = false;
        database.exec('COMMIT');
        return;
      }
      if (!autoDeleteEnabled || !current || current.expiresAt !== item.expiresAt || current.expiresAt > new Date().toISOString()) {
        database.exec('COMMIT');
        continue;
      }
      const mediaPath = getStoredMediaPath(item.id);
      if (mediaPath) {
        try { unlinkSync(mediaPath); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const deleted = database.prepare(`UPDATE downloads SET status = 'expired', message = 'The local media copy expired; saved video metadata was retained.',
        progress = 0, stage = 'Expired', updated_at = ? WHERE video_id = ? AND status = 'ready' AND expires_at = ?`)
        .run(new Date().toISOString(), item.id, item.expiresAt);
      database.exec('COMMIT');
      if (deleted.changes) console.log(`Auto-deleted expired local media ${item.id}; retained its metadata.`);
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      console.error(`Could not auto-delete expired local video ${item.id}:`, error);
    }
  }
}

async function finalizePartialWebm(id, { allowLongerAudio = false, requireAudioThroughVideo = false } = {}) {
  const directory = await ensureVideoMediaDirectory(id);
  const outputPath = path.join(directory, `${id}.webm`);
  const finalizeError = (code, message) => Object.assign(new Error(message), { code });
  const names = await readdir(directory);
  const candidates = names
    .filter(name => name.startsWith(`${id}.`) && /\.webm(?:\.part)?$/i.test(name) && !name.includes('.finalizing.'))
    .map(name => path.join(directory, name));
  if (!candidates.length) throw finalizeError('NO_MEDIA', 'No partial WebM media files were found.');

  const inspectStreams = filePath => new Promise((resolve, reject) => {
    const probe = spawn(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,duration:format=duration', '-of', 'json', filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => {
      probe.kill('SIGKILL');
      reject(new Error('Media track inspection timed out.'));
    }, 30_000);
    timeout.unref();
    probe.stdout.setEncoding('utf8');
    probe.stderr.setEncoding('utf8');
    probe.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-20_000); });
    probe.stderr.on('data', chunk => { errors = `${errors}${chunk}`.slice(-20_000); });
    probe.once('error', error => { clearTimeout(timeout); reject(new Error(error.code === 'ENOENT' ? 'ffprobe is unavailable to check audio and video tracks.' : 'Could not inspect the partial media tracks.')); });
    probe.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(errors.trim() || 'Could not inspect the partial media tracks.')); return; }
      try {
        const metadata = JSON.parse(output);
        const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
        const types = new Set(streams.map(stream => stream.codec_type).filter(Boolean));
        const durationOf = value => {
          const duration = Number(value);
          return Number.isFinite(duration) && duration > 0 ? duration : null;
        };
        const formatDuration = durationOf(metadata.format?.duration);
        const durations = {};
        for (const type of types) {
          durations[type] = durationOf(streams.find(stream => stream.codec_type === type)?.duration) || formatDuration;
        }
        resolve({ types, durations });
      } catch { reject(new Error('Could not read the partial media track information.')); }
    });
  });
  const inspected = [];
  for (const filePath of candidates) {
    try { inspected.push({ filePath, ...(await inspectStreams(filePath)) }); }
    catch (error) {
      if (filePath === outputPath) throw error;
    }
  }
  const videoSource = inspected.find(item => item.types.has('video'));
  const audioSource = inspected
    .filter(item => item.types.has('audio'))
    .sort((first, second) => Number(second.filePath.includes('.finish-audio.')) - Number(first.filePath.includes('.finish-audio.')))[0];
  if (!videoSource) throw finalizeError('MISSING_VIDEO', 'No playable video track is available yet.');
  if (!audioSource) throw finalizeError('MISSING_AUDIO', 'The audio track is not available yet.');
  if (videoSource.filePath !== audioSource.filePath) {
    const videoDuration = videoSource.durations.video;
    const audioDuration = audioSource.durations.audio;
    if (!Number.isFinite(videoDuration) || !Number.isFinite(audioDuration)) {
      throw finalizeError('UNKNOWN_TRACK_DURATION', 'Could not verify the separate video and audio track lengths.');
    }
    const durationDifference = Math.abs(videoDuration - audioDuration);
    const longerAudioIsExpected = allowLongerAudio && audioDuration > videoDuration;
    const allowedDifference = requireAudioThroughVideo
      ? Math.max(5, videoDuration * 0.003)
      : Math.max(120, Math.max(videoDuration, audioDuration) * 0.05);
    if (requireAudioThroughVideo && audioDuration + allowedDifference < videoDuration) {
      throw finalizeError('AUDIO_TOO_SHORT', `The available audio track is shorter than the captured video (${Math.floor(videoDuration / 60)} min video, ${Math.floor(audioDuration / 60)} min audio).`);
    }
    if (durationDifference > allowedDifference && !longerAudioIsExpected) {
      throw finalizeError('TRACK_LENGTH_MISMATCH', `The video and audio tracks are still downloading at different lengths (${Math.floor(videoDuration / 60)} min video, ${Math.floor(audioDuration / 60)} min audio).`);
    }
  }

  if (videoSource.filePath === outputPath && audioSource.filePath === outputPath) {
    await Promise.all(candidates.filter(filePath => filePath !== outputPath).map(filePath => unlink(filePath).catch(() => {})));
    return true;
  }
  if (videoSource.filePath !== audioSource.filePath && !ffmpegAvailable) {
    throw new Error('ffmpeg is required to combine the available video and audio tracks.');
  }
  if (videoSource.filePath === audioSource.filePath && !ffmpegAvailable) {
    await rename(videoSource.filePath, outputPath);
    await Promise.all(candidates.filter(filePath => filePath !== outputPath).map(filePath => unlink(filePath).catch(() => {})));
    return true;
  }
  const temporaryPath = path.join(directory, `${id}.finalizing.webm`);
  const inputs = videoSource.filePath === audioSource.filePath
    ? [videoSource.filePath]
    : [videoSource.filePath, audioSource.filePath];
  const args = ['-y', '-fflags', '+genpts'];
  for (const input of inputs) args.push('-i', input);
  if (inputs.length === 1) args.push('-map', '0:v:0', '-map', '0:a:0');
  else args.push('-map', '0:v:0', '-map', '1:a:0');
  args.push('-c', 'copy', '-shortest', '-f', 'webm', temporaryPath);
  try {
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: 'ignore' });
      ffmpeg.once('error', error => reject(new Error(error.code === 'ENOENT' ? 'ffmpeg is unavailable to combine the partial tracks.' : 'Could not start ffmpeg to combine the partial tracks.')));
      ffmpeg.once('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg could not combine the partial video and audio tracks.')));
    });
    const outputStreams = await inspectStreams(temporaryPath);
    if (!outputStreams.types.has('video') || !outputStreams.types.has('audio')) {
      throw new Error('The saved file is missing its video or audio track. The original partial tracks are preserved.');
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  await rename(temporaryPath, outputPath);
  await Promise.all(candidates.filter(filePath => filePath !== outputPath).map(filePath => unlink(filePath).catch(() => {})));
  return true;
}

async function downloadAudioTrackForFinish(id, url, job) {
  if (networkMode !== 'online' || offlinePreparationRequested) {
    throw Object.assign(new Error('The missing audio track needs an online request.'), { code: 'WAITING_FOR_ONLINE' });
  }
  const directory = await ensureVideoMediaDirectory(id);
  const outputPath = path.join(directory, `${id}.finish-audio.webm`);
  const files = await readdir(directory);
  await Promise.all(files
    .filter(name => name.startsWith(`${id}.finish-audio.`))
    .map(name => unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; })));

  const args = [
    '--ignore-config', '--no-cookies', '--no-playlist', '--no-color', '--newline', '--progress', '--progress-delta', '0.5',
    '--progress-template', 'download:YT_PROGRESS:%(progress._percent_str)s',
    '--format', 'bestaudio[ext=webm]', '--output', outputPath, url
  ];
  job.finishPhase = 'audio';
  job.progress = 0;
  job.stage = 'Downloading the complete audio track… 0%';
  saveDownload(id, 'downloading', '', job.progress, job.stage);

  await new Promise((resolve, reject) => {
    const audioProcess = spawn(process.env.YT_DLP_PATH || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.audioProcess = audioProcess;
    let output = '';
    const buffers = { stdout: '', stderr: '' };
    const consume = (stream, chunk) => {
      output = `${output}${chunk}`.slice(-6000);
      const lines = (buffers[stream] + chunk).split(/\r\n|\n|\r/);
      buffers[stream] = lines.pop() || '';
      for (const line of lines) {
        const cleanLine = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        const match = cleanLine.match(/YT_PROGRESS:\s*([\d.]+)%|\[download\]\s+([\d.]+)%/i);
        if (match) {
          job.progress = Math.max(0, Math.min(99, Number(match[1] || match[2]) || 0));
          job.stage = `Downloading the complete audio track… ${Math.floor(job.progress)}%`;
          saveDownload(id, 'downloading', '', job.progress, job.stage);
        } else if (/\[Merger\]|Merging formats/i.test(cleanLine)) {
          job.finishPhase = 'merge';
          job.stage = 'Merging the saved video and audio…';
          saveDownload(id, 'downloading', '', job.progress, job.stage);
        }
      }
    };
    audioProcess.stdout.setEncoding('utf8');
    audioProcess.stderr.setEncoding('utf8');
    audioProcess.stdout.on('data', chunk => consume('stdout', chunk));
    audioProcess.stderr.on('data', chunk => consume('stderr', chunk));
    audioProcess.once('error', error => {
      job.audioProcess = null;
      reject(new Error(error.code === 'ENOENT' ? 'yt-dlp is not installed or not available on PATH.' : 'Could not start the audio-track download.'));
    });
    audioProcess.once('close', async code => {
      job.audioProcess = null;
      try {
        const info = await stat(outputPath);
        if (code !== 0 || info.size === 0) {
          const lastError = output.split(/\r?\n/).map(line => line.trim()).filter(line => /^ERROR:/i.test(line)).at(-1);
          reject(new Error(lastError?.replace(/https?:\/\/\S+/g, '[URL]') || 'Could not download a complete WebM audio track.'));
          return;
        }
        resolve();
      } catch {
        reject(new Error(code === 0 ? 'yt-dlp finished without producing the WebM audio track.' : 'The WebM audio-track download was interrupted.'));
      }
    });
  });
}

async function finishPartialDownload(id, url, job) {
  job.finishPhase = 'merge';
  job.stage = 'Checking the captured audio and video tracks…';
  saveDownload(id, 'downloading', '', job.progress, job.stage);
  try {
    await finalizePartialWebm(id, { allowLongerAudio: true, requireAudioThroughVideo: true });
    return;
  } catch (error) {
    if (!['MISSING_AUDIO', 'AUDIO_TOO_SHORT', 'TRACK_LENGTH_MISMATCH'].includes(error.code)) throw error;
    if (!ffmpegAvailable) throw new Error('ffmpeg is required to add the complete audio track to this partial video. The captured files are preserved.');
    if (!url) throw new Error('The saved video has no source URL, so its audio track could not be retrieved.');
    await downloadAudioTrackForFinish(id, url, job);
  }

  job.finishPhase = 'merge';
  job.stage = 'Merging the saved video and audio…';
  saveDownload(id, 'downloading', '', job.progress, job.stage);
  await finalizePartialWebm(id, { allowLongerAudio: true, requireAudioThroughVideo: true });
}

function resumePendingFinishRecoveries() {
  if (jobs.size) return;
  if (networkMode !== 'online' || offlinePreparationRequested) {
    const item = database.prepare(`
      SELECT d.video_id AS id, d.progress
      FROM downloads d
      WHERE (d.status = 'downloading' AND (
        d.stage LIKE 'Finishing the audio track%' OR
        d.stage LIKE 'Stopping video transfer to save%' OR
        d.stage LIKE 'Downloading audio track to finish%' OR
        d.stage LIKE 'Merging the saved video and audio%'
      )) OR (d.status = 'paused' AND d.message LIKE 'Could not finish and save this partial yet:%')
      ORDER BY d.updated_at LIMIT 1
    `).get();
    if (item) markFinishWaitingForOnline(item.id, Number(item.progress) || 0);
    return;
  }
  const item = database.prepare(`
    SELECT d.video_id AS id, d.progress, d.started_at AS startedAt, v.url
    FROM downloads d JOIN videos v ON v.video_id = d.video_id
    WHERE (d.status = 'downloading' AND (
      d.stage LIKE 'Finishing the audio track%' OR
      d.stage LIKE 'Stopping video transfer to save%' OR
      d.stage LIKE 'Downloading audio track to finish%' OR
      d.stage LIKE 'Merging the saved video and audio%'
    )) OR (d.status = 'paused' AND (
      d.stage = 'Waiting to finish and save while Online' OR
      d.message LIKE 'Could not finish and save this partial yet:%'
    ))
    ORDER BY d.updated_at LIMIT 1
  `).get();
  if (!item || jobs.has(item.id)) return;

  const job = {
    status: 'downloading', progress: Number(item.progress) || 0,
    stage: 'Checking the captured audio and video tracks…', startedAt: item.startedAt,
    transferStarted: true, offlinePauseRequested: false, pauseRequested: false,
    finishRequested: true, finishPhase: 'merge', isLive: false,
    endRequested: false, discardRequested: false
  };
  jobs.set(item.id, job);
  saveDownload(item.id, 'downloading', '', job.progress, job.stage);
  void finishPartialDownload(item.id, item.url, job)
    .then(async () => {
      await verifyLocalMediaIntegrity(item.id, { downloadJob: job });
      saveDownload(item.id, 'ready', '', 100, 'Ready to play');
      markFreshMediaAcquisition(item.id);
    })
    .catch(async error => {
      if (error.code === 'WAITING_FOR_ONLINE') {
        markFinishWaitingForOnline(item.id, job.progress);
        return;
      }
      if (String(error.code || '').startsWith('INTEGRITY_') || error.code === 'MEDIA_INTEGRITY' || error.code === 'MEDIA_MISSING') {
        await recordMediaIntegrityFailure(item.id, error, { progress: job.progress });
        return;
      }
      const message = `Finish and save could not complete yet: ${error.message} The captured files are preserved; retry when ready.`;
      markDownloadPausedByUser(item.id, job.progress, message);
    })
    .finally(() => jobs.delete(item.id));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  response.setHeader('X-Content-Type-Options', 'nosniff');

  const origin = request.headers.origin || '';
  const extensionOrigin = origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
  const remoteAddress = request.socket.remoteAddress || '';
  const loopbackAddress = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';

  if (request.method === 'GET' && url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('ok');
    return;
  }

  // Some Chromium extension service-worker requests reach loopback without an Origin header.
  // In Docker, the host's localhost port-forward reaches the container from its bridge gateway,
  // so accept that gateway only when the request itself targets a loopback Host.
  let loopbackHost = false;
  try {
    const requestHostname = new URL(`http://${request.headers.host || 'localhost'}`).hostname;
    loopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(requestHostname);
  } catch {}
  const normalizedRemoteAddress = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress;
  const dockerForwardedLoopbackRequest = !origin && loopbackHost && dockerGatewayAddresses.has(normalizedRemoteAddress);
  const localExtensionRequest = extensionOrigin || (!origin && loopbackAddress) || dockerForwardedLoopbackRequest;
  const extensionOnlyRoute = ['/api/extension/metadata-capture-jobs', '/api/extension/video-metadata', '/api/extension/diagnostics'].includes(url.pathname);
  if (extensionOrigin && (extensionOnlyRoute || url.pathname === '/api/sync' || url.pathname === '/api/search-sync' || url.pathname === '/api/channel-sync' || url.pathname === '/api/mode' || /^\/api\/(?:search-sessions\/[a-f0-9-]{36}|channel-captures\/(?:[a-f0-9-]{36}(?:\/status)?|batch))$/i.test(url.pathname))) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (request.method === 'OPTIONS' && (extensionOnlyRoute || url.pathname === '/api/sync' || url.pathname === '/api/search-sync' || url.pathname === '/api/channel-sync' || url.pathname === '/api/mode' || /^\/api\/(?:search-sessions\/[a-f0-9-]{36}|channel-captures\/(?:[a-f0-9-]{36}(?:\/status)?|batch))$/i.test(url.pathname)) && extensionOrigin) {
    response.writeHead(204).end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(200, { 'content-type': 'image/x-icon', 'cache-control': 'public, max-age=86400' });
    response.end(favicon);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/vendor/vue.global.prod.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' });
    response.end(vueRuntime);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/app-router.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(path.join(root, 'public', 'app-router.js')));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/header-value-ticker.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(path.join(root, 'public', 'header-value-ticker.js')));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/design-system.css') {
    response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(path.join(root, 'public', 'design-system.css')));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/__app/player-template') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(path.join(root, 'public', 'player.html')));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/image-placeholder.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' });
    response.end(imagePlaceholder);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/auto-delete') {
    const savedSetting = database.prepare("SELECT updated_at AS updatedAt FROM app_settings WHERE setting_key = 'auto_delete_enabled'").get();
    sendJson(response, 200, { enabled: autoDeleteEnabled, updatedAt: savedSetting?.updatedAt || '', lifetimeHours: 24 });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auto-delete') {
    try {
      const body = await readBody(request);
      if (typeof body.enabled !== 'boolean') { sendJson(response, 400, { error: 'Auto-delete enabled must be true or false.' }); return; }
      if (typeof body.expectedUpdatedAt !== 'string') { sendJson(response, 428, { error: 'Refresh the Auto-delete setting before changing it.' }); return; }
      const now = new Date().toISOString();
      const nowMs = Date.parse(now);
      database.exec('BEGIN IMMEDIATE');
      try {
        const savedSetting = database.prepare("SELECT setting_value AS value, updated_at AS updatedAt FROM app_settings WHERE setting_key = 'auto_delete_enabled'").get();
        if ((savedSetting?.updatedAt || '') !== body.expectedUpdatedAt) {
          database.exec('ROLLBACK');
          sendJson(response, 409, { error: 'Auto-delete changed in another YourTube tab. The current setting has been refreshed.', enabled: savedSetting?.value === 'true', updatedAt: savedSetting?.updatedAt || '', lifetimeHours: 24 });
          return;
        }
        const readyMedia = database.prepare("SELECT video_id AS id, acquired_at AS acquiredAt, expires_at AS expiresAt, expiry_paused_ms AS pausedMs FROM downloads WHERE status = 'ready' AND origin <> 'media-folder'").all();
        const updateReadyExpiry = database.prepare("UPDATE downloads SET expires_at = ?, expiry_paused_ms = ? WHERE video_id = ? AND status = 'ready'");
        for (const media of readyMedia) {
          if (body.enabled) {
            let expiresAt = media.expiresAt;
            if (media.pausedMs !== null) expiresAt = new Date(nowMs + Math.max(0, media.pausedMs)).toISOString();
            else if (!expiresAt) expiresAt = expiryFromAcquisition(media.acquiredAt);
            updateReadyExpiry.run(expiresAt, null, media.id);
          } else {
            let pausedMs = media.pausedMs;
            if (media.expiresAt) {
              const expiryMs = Date.parse(media.expiresAt);
              const baseExpiryMs = Date.parse(expiryFromAcquisition(media.acquiredAt));
              const deadline = Number.isFinite(expiryMs) ? expiryMs : baseExpiryMs;
              pausedMs = Number.isFinite(deadline) ? Math.max(0, deadline - nowMs) : 0;
            }
            updateReadyExpiry.run('', pausedMs, media.id);
          }
        }
        database.prepare(`INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('auto_delete_enabled', ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`)
          .run(String(body.enabled), now);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      autoDeleteEnabled = body.enabled;
      sendJson(response, 200, { enabled: autoDeleteEnabled, updatedAt: now, lifetimeHours: 24 });
    } catch {
      sendJson(response, 400, { error: 'Auto-delete setting could not be updated.' });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/offline-preparation/comment-avatars') {
    try {
      const body = await readBody(request);
      if (typeof body.skip !== 'boolean') { sendJson(response, 400, { error: 'A skip preference is required.' }); return; }
      skipCommentAvatarPreparation = body.skip;
      persistAppSetting('skip_comment_avatar_preparation', skipCommentAvatarPreparation);
      if (skipCommentAvatarPreparation && offlinePreparation.phase === 'comment avatars' && ['queued', 'running'].includes(offlinePreparation.status)) {
        offlinePreparation.message = 'Skipping remaining comment-avatar downloads by your setting…';
      }
      sendJson(response, 200, { skipCommentAvatars: skipCommentAvatarPreparation, preparation: offlinePreparation });
    } catch { sendJson(response, 400, { error: 'Comment-avatar preference could not be updated.' }); }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/mode') {
    sendJson(response, 200, {
      mode: reportedNetworkMode(), preparation: offlinePreparation,
      skipCommentAvatars: skipCommentAvatarPreparation,
      internetAvailable: connectivityStatus.available, connectivityNotice,
      youtubeRateLimitedUntil: youtubeRateLimitUntil ? new Date(youtubeRateLimitUntil).toISOString() : ''
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/mode') {
    try {
      const body = await readBody(request);
      if (!['online', 'offline'].includes(body.mode)) { sendJson(response, 400, { error: 'Mode must be online or offline.' }); return; }
      const requestGeneration = ++networkModeRequestGeneration;
      if (body.mode === 'online') {
        if (youtubeRateLimitIsActive()) {
          setExplicitOfflinePreference(false);
          setAutoOnlineAfterConnectivityLoss(true);
          connectivityNotice = youtubeRateLimitMessage();
          sendJson(response, 429, { error: connectivityNotice, mode: 'offline', preparation: offlinePreparation, internetAvailable: connectivityStatus.available, connectivityNotice, youtubeRateLimitedUntil: new Date(youtubeRateLimitUntil).toISOString() });
          return;
        }
        // An explicit Online choice owns this transition; the connectivity
        // monitor must not race it with an automatic reconnect.
        setExplicitOfflinePreference(false);
        setAutoOnlineAfterConnectivityLoss(false);
        const probeAvailable = await checkInternetConnectivity();
        if (requestGeneration !== networkModeRequestGeneration) {
          sendJson(response, 409, { mode: reportedNetworkMode(), preparation: offlinePreparation, internetAvailable: connectivityStatus.available, connectivityNotice });
          return;
        }
        if (!probeAvailable) {
          switchOfflineForConnectionLoss();
          sendJson(response, 503, { error: connectivityNotice, mode: 'offline', preparation: offlinePreparation, internetAvailable: false, connectivityNotice });
          return;
        }
        switchOnlineAfterConnectivityRestore(false);
        youtubeRateLimitResumePending = false;
        sendJson(response, 200, { mode: networkMode, preparation: offlinePreparation, internetAvailable: true, connectivityNotice, youtubeRateLimitedUntil: '' });
        return;
      }
      setExplicitOfflinePreference(true);
      setAutoOnlineAfterConnectivityLoss(false);
      noInternetFallback = false;
      connectivityNotice = '';
      if (networkMode === 'offline') { sendJson(response, 200, { mode: networkMode, preparation: offlinePreparation }); return; }
      if (body.immediate === true) {
        const preparationActive = offlinePreparationRequested || ['queued', 'running'].includes(offlinePreparation.status);
        if (!preparationActive) { sendJson(response, 409, { error: 'There is no Offline preparation to pause.', mode: reportedNetworkMode(), preparation: offlinePreparation }); return; }
        offlinePreparationRun += 1;
        offlinePreparationRequested = false;
        offlinePreparationPaused = true;
        offlinePreparationBackground = false;
        networkMode = 'offline';
        const phaseName = String(offlinePreparation.phase || 'local preparation');
        offlinePreparation = {
          ...offlinePreparation, status: 'paused',
          message: `Preparation paused during ${phaseName}. It will resume in the background the next time you switch YourTube Online.`
        };
        const now = new Date().toISOString();
        database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('network_mode', 'offline', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = 'offline', updated_at = excluded.updated_at").run(now);
        setOfflinePreparationTarget('paused');
        saveOfflinePreparationCheckpoint(offlinePreparation);
        sendJson(response, 200, { mode: 'offline', preparation: offlinePreparation, internetAvailable: connectivityStatus.available, connectivityNotice: '' });
        return;
      }
      if (!offlinePreparationRequested) {
        if (offlinePreparationBackground) offlinePreparationRun += 1;
        offlinePreparationRequested = true;
        offlinePreparationPaused = false;
        offlinePreparationBackground = false;
        offlinePreparation = { status: 'queued', phase: 'downloads', completed: 0, total: jobs.size, message: 'Pausing queued download attempts…' };
        setOfflinePreparationTarget('offline');
        pauseRetryQueueForOffline();
        await pauseMetadataOnlyDownloads();
        if (requestGeneration !== networkModeRequestGeneration) {
          sendJson(response, 409, { mode: reportedNetworkMode(), preparation: offlinePreparation, internetAvailable: connectivityStatus.available, connectivityNotice });
          return;
        }
        await prepareOfflineCache();
      }
      sendJson(response, 202, { mode: reportedNetworkMode(), preparation: offlinePreparation, internetAvailable: connectivityStatus.available, connectivityNotice });
    } catch { sendJson(response, 400, { error: 'Request body must be valid JSON.' }); }
    return;
  }

  const cachedImageMatch = /^\/api\/images\/([a-f0-9]{64})$/.exec(url.pathname);
  if (request.method === 'GET' && cachedImageMatch) {
    const image = database.prepare('SELECT content_type AS contentType FROM cached_images WHERE image_key = ?').get(cachedImageMatch[1]);
    if (!image) { response.writeHead(404).end(); return; }
    try {
      const bytes = await readFile(path.join(imageCacheDirectory, cachedImageMatch[1]));
      response.writeHead(200, { 'content-type': image.contentType, 'cache-control': 'public, max-age=31536000, immutable', 'content-length': bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/remote-image') {
    const source = url.searchParams.get('src') || '';
    const requestedVideoId = url.searchParams.get('video_id') || '';
    const videoId = /^[A-Za-z0-9_-]{11}$/.test(requestedVideoId) && database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(requestedVideoId)
      ? requestedVideoId : '';
    let cached = videoId ? existingVideoThumbnail(videoId) : null;
    if (!cached && !isAllowedYoutubeImageSource(source)) { response.writeHead(400, { 'cache-control': 'no-store' }).end(); return; }
    if (!cached) cached = existingCachedImage(source);
    if (!cached && youtubeRateLimitIsActive()) { response.writeHead(503, { 'cache-control': 'no-store', 'retry-after': String(Math.max(1, Math.ceil((youtubeRateLimitUntil - Date.now()) / 1000))) }).end(); return; }
    if (!cached && !await cacheRemoteImage(source)) { response.writeHead(503, { 'cache-control': 'no-store' }).end(); return; }
    // Once a video has a canonical local thumbnail, a stale source URL must not
    // trigger another network lookup or replace the image we already saved.
    if (!cached) cached = existingVideoThumbnail(videoId) || existingCachedImage(source);
    if (!cached) { response.writeHead(404, { 'cache-control': 'no-store' }).end(); return; }
    if (videoId && !existingVideoThumbnail(videoId)) rememberVideoThumbnail(videoId, source);
    try {
      const bytes = await readFile(path.join(imageCacheDirectory, cached.key));
      const image = database.prepare('SELECT content_type AS contentType FROM cached_images WHERE image_key = ?').get(cached.key);
      response.writeHead(200, { 'content-type': image?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404, { 'cache-control': 'no-store' }).end(); }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(path.join(root, 'public', 'index.html')));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/downloads') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(path.join(root, 'public', 'index.html')));
    return;
  }

  const localChannelMatch = /^\/channel\/(.+)$/.exec(url.pathname);
  if (request.method === 'GET' && localChannelMatch) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(path.join(root, 'public', 'index.html')));
    return;
  }

  const watchMatch = /^\/watch\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
  if (request.method === 'GET' && watchMatch) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(path.join(root, 'public', 'index.html')));
    return;
  }

  const shortMatch = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
  if (request.method === 'GET' && shortMatch) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(path.join(root, 'public', 'index.html')));
    return;
  }

  const mediaMatch = /^\/media\/([A-Za-z0-9_-]{11})(?:\.(?:webm|mp4))?$/.exec(url.pathname);
  if (mediaMatch && ['GET', 'HEAD'].includes(request.method)) {
    await serveMedia(request, response, mediaMatch[1]);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/videos') {
    const rows = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind, v.section, v.topic, v.position, v.last_seen AS seenAt, v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge, d.acquired_at AS acquiredAt,
        (SELECT vp.category FROM video_provisions vp WHERE vp.video_id = v.video_id ORDER BY vp.last_seen DESC, vp.category LIMIT 1) AS sourceProvisionCategory,
        (SELECT vp.last_seen FROM video_provisions vp WHERE vp.video_id = v.video_id ORDER BY vp.last_seen DESC, vp.category LIMIT 1) AS sourceProvisionSeenAt,
        (SELECT vp.source_type FROM video_provenance vp WHERE vp.video_id = v.video_id ORDER BY vp.last_seen DESC, length(vp.source_key) DESC, vp.source_type LIMIT 1) AS sourceType,
        (SELECT vp.source_key FROM video_provenance vp WHERE vp.video_id = v.video_id ORDER BY vp.last_seen DESC, length(vp.source_key) DESC, vp.source_type LIMIT 1) AS sourceKey,
        (SELECT vp.source_label FROM video_provenance vp WHERE vp.video_id = v.video_id ORDER BY vp.last_seen DESC, length(vp.source_key) DESC, vp.source_type LIMIT 1) AS sourceDetailLabel,
        (SELECT vp.source_url FROM video_provenance vp WHERE vp.video_id = v.video_id ORDER BY vp.last_seen DESC, length(vp.source_key) DESC, vp.source_type LIMIT 1) AS sourceUrl,
        (SELECT vp.last_seen FROM video_provenance vp WHERE vp.video_id = v.video_id ORDER BY vp.last_seen DESC, length(vp.source_key) DESC, vp.source_type LIMIT 1) AS sourceDetailSeenAt,
        (SELECT ci.channel_key FROM channel_items ci WHERE ci.video_id = v.video_id ORDER BY ci.added_at DESC, ci.channel_key LIMIT 1) AS sourceChannelKey,
        (SELECT ci.tab_key FROM channel_items ci WHERE ci.video_id = v.video_id ORDER BY ci.added_at DESC, ci.channel_key LIMIT 1) AS sourceTab,
        (SELECT ci.added_at FROM channel_items ci WHERE ci.video_id = v.video_id ORDER BY ci.added_at DESC, ci.channel_key LIMIT 1) AS sourceSeenAt,
        CASE WHEN d.video_id IS NULL THEN 0 ELSE 1 END AS downloaded, COALESCE(w.view_count, 0) AS viewCount,
        COALESCE(pref.not_interested, 0) AS notInterested, COALESCE(pref.liked, 0) AS liked,
        CASE WHEN blocked.channel_key IS NULL THEN 0 ELSE 1 END AS channelBlocked
      FROM videos v LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_views w ON w.video_id = v.video_id
      LEFT JOIN video_preferences pref ON pref.video_id = v.video_id
      LEFT JOIN blocked_channels blocked ON blocked.channel_key = lower(trim(v.channel))
      WHERE (? = 0 OR d.video_id IS NOT NULL) AND (v.section <> 'channel' OR d.video_id IS NOT NULL)
      ORDER BY v.last_seen DESC, v.position ASC, v.first_seen DESC, v.video_id
    `).all(mediaDiscoveryPaused() ? 1 : 0);
    sendJson(response, 200, rows.map(video => {
      const detailedSourceAt = Date.parse(video.sourceDetailSeenAt || '');
      const channelSourceAt = Date.parse(video.sourceSeenAt || '');
      if (video.sourceDetailLabel && (!Number.isFinite(channelSourceAt) || !Number.isFinite(detailedSourceAt) || detailedSourceAt >= channelSourceAt)) {
        video.sourceLabel = `From ${video.sourceDetailLabel}`;
        video.sourceSeenAt = video.sourceDetailSeenAt;
      } else if (video.sourceChannelKey && video.sourceSeenAt &&
          (!video.sourceProvisionSeenAt || video.sourceSeenAt >= video.sourceProvisionSeenAt)) {
        const tabLabel = ({ home: 'Home', videos: 'Videos', shorts: 'Shorts', streams: 'Live', playlists: 'Playlists', community: 'Community' })[video.sourceTab] || 'Videos';
        video.sourceLabel = `From ${video.sourceChannelKey} · ${tabLabel}`;
      } else {
        video.sourceSeenAt = video.sourceProvisionSeenAt || video.seenAt;
        if (video.sourceProvisionCategory === 'other') video.sourceLabel = 'From YouTube page';
        else if (video.sourceProvisionCategory === 'direct') video.sourceLabel = 'From direct video ID';
        else if (video.sourceProvisionCategory === 'media-folder') video.sourceLabel = 'From media folder';
      }
      if (!getStoredMediaPath(video.id)) video.downloaded = 0;
      return video;
    }).filter(video => !mediaDiscoveryPaused() || Number(video.downloaded) === 1));
    return;
  }

  const provenanceMatch = /^\/api\/videos\/([A-Za-z0-9_-]{11})\/provenance$/.exec(url.pathname);
  if (request.method === 'GET' && provenanceMatch) {
    const id = provenanceMatch[1];
    if (!database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(id)) {
      sendJson(response, 404, { error: 'Video metadata is not in the local library.' });
      return;
    }
    const sources = database.prepare(`SELECT source_type AS type, source_key AS key, source_label AS label,
        source_url AS url, first_seen AS firstSeen, last_seen AS lastSeen, observations
      FROM video_provenance WHERE video_id = ?
      ORDER BY last_seen DESC, length(source_key) DESC, source_type, source_key`).all(id);
    sendJson(response, 200, { id, sources });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/shorts') {
    if (shortsApiCache && Date.now() < shortsApiCacheExpiresAt) {
      sendJson(response, 200, shortsApiCache);
      return;
    }
    const rows = database.prepare(`
      WITH channel_avatars AS (
        SELECT lower(trim(channel_key, '/')) AS normalized_key, MIN(NULLIF(trim(avatar), '')) AS avatar
        FROM (
          SELECT channel_key, avatar FROM videos WHERE trim(channel_key) <> '' AND trim(avatar) <> ''
          UNION ALL
          SELECT channel_key, avatar FROM channels WHERE trim(channel_key) <> '' AND trim(avatar) <> ''
          UNION ALL
          SELECT channel_key, avatar FROM subscriptions WHERE trim(channel_key) <> '' AND trim(avatar) <> ''
        )
        GROUP BY lower(trim(channel_key, '/'))
      )
      SELECT v.video_id AS id, v.title, v.channel, v.kind, v.channel_key AS channelKey, v.channel_url AS channelUrl,
        v.thumbnail, COALESCE(NULLIF(trim(v.avatar), ''), channel_avatars.avatar, '') AS avatar,
        v.duration, v.last_seen AS seenAt, d.acquired_at AS acquiredAt,
        COALESCE(d.status, '') AS downloadStatus, COALESCE(q.status, '') AS retryStatus,
        COALESCE(w.view_count, 0) AS viewCount, COALESCE(pref.liked, 0) AS liked
      FROM videos v
      LEFT JOIN downloads d ON d.video_id = v.video_id
      LEFT JOIN download_retry_queue q ON q.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      LEFT JOIN video_preferences pref ON pref.video_id = v.video_id
      LEFT JOIN blocked_channels blocked ON blocked.channel_key = lower(trim(v.channel))
      LEFT JOIN channel_avatars ON channel_avatars.normalized_key = lower(trim(v.channel_key, '/'))
      WHERE v.kind = 'short' AND COALESCE(pref.not_interested, 0) = 0 AND blocked.channel_key IS NULL
      ORDER BY v.last_seen DESC, v.position ASC, v.first_seen DESC, v.video_id
    `).all();
    shortsApiCache = rows.map(video => {
      video.downloaded = 0;
      if (video.downloadStatus === 'ready') {
        const mediaPath = getStoredMediaPath(video.id, 'short');
        if (mediaPath) {
          video.downloaded = 1;
          video.mediaExtension = path.extname(mediaPath).slice(1).toLowerCase();
        }
      }
      return video;
    });
    shortsApiCacheExpiresAt = Date.now() + 2500;
    sendJson(response, 200, shortsApiCache);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/shorts/download-batch') {
    if (networkMode !== 'online' || offlinePreparationRequested) {
      sendJson(response, 409, { error: 'Shorts downloads are available while YourTube is Online.', mode: reportedNetworkMode() });
      return;
    }
    const payload = await readBody(request);
    const requestedIds = Array.isArray(payload?.ids) ? payload.ids : [];
    if (!requestedIds.length || requestedIds.length > 5 || requestedIds.some(id => !/^[A-Za-z0-9_-]{11}$/.test(String(id || '')))) {
      sendJson(response, 400, { error: 'A Shorts download batch must contain between 1 and 5 valid video IDs.' });
      return;
    }
    const ids = [...new Set(requestedIds.map(String))];
    const queued = [];
    const already = [];
    const skipped = [];
    const now = new Date().toISOString();
    const getShort = database.prepare("SELECT 1 FROM videos WHERE video_id = ? AND kind = 'short'");
    const getRetry = database.prepare('SELECT status FROM download_retry_queue WHERE video_id = ?');
    const queueRetry = database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
      VALUES (?, 0, 'pending', ?, 'Queued from Shorts feed.', ?)
      ON CONFLICT(video_id) DO UPDATE SET status = 'pending', next_retry_at = excluded.next_retry_at,
        last_error = excluded.last_error, updated_at = excluded.updated_at
      WHERE download_retry_queue.status IN ('pending', 'waiting-live', 'running')`);
    for (const id of ids) {
      if (!getShort.get(id) || isAcquisitionExcluded(id)) { skipped.push({ id, reason: 'Short unavailable for acquisition.' }); continue; }
      if (getStoredMediaPath(id)) {
        try {
          // Shorts use the same integrity path as standard media. Re-hash an existing
          // local copy before declaring it ready; unchanged files reuse the saved
          // checksum without repeating the expensive full decode check.
          await verifyLocalMediaIntegrity(id);
          saveDownload(id, 'ready', '', 100, 'Ready to play');
          already.push(id);
        } catch (error) {
          await recordMediaIntegrityFailure(id, error);
          skipped.push({ id, reason: error.message || 'This Short failed its local integrity check.' });
        }
        continue;
      }
      if (jobs.has(id)) { already.push(id); continue; }
      const retry = getRetry.get(id);
      if (retry && ['paused', 'paused-offline', 'paused-limit', 'exhausted'].includes(retry.status)) {
        skipped.push({ id, reason: 'This Short is paused after a previous download attempt.' });
        continue;
      }
      queueRetry.run(id, now, now);
      saveDownload(id, 'queued', 'Queued from Shorts feed.', 0, 'Shorts batch queued');
      queued.push(id);
    }
    runDownloadRetries().catch(error => console.error('Shorts batch download queue:', error));
    sendJson(response, 202, { queued, already, skipped, batchSize: ids.length });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/homepage-layout') {
    const capture = database.prepare(`SELECT capture_id AS captureId, captured_at AS capturedAt
      FROM homepage_captures ORDER BY last_seen DESC, captured_at DESC, capture_id DESC LIMIT 1`).get();
    if (!capture) { sendJson(response, 200, { captureId: '', capturedAt: '', sections: [] }); return; }
    const sections = database.prepare(`SELECT section_key AS key, title, kind, topic, section_position AS position
      FROM homepage_sections WHERE capture_id = ? ORDER BY section_position, section_key`).all(capture.captureId);
    const placements = database.prepare(`SELECT section_key AS sectionKey, video_id AS id, position, mix_id AS mixId
      FROM homepage_placements WHERE capture_id = ? ORDER BY section_key, position, video_id`).all(capture.captureId);
    const placementsBySection = new Map();
    for (const placement of placements) {
      if (!placementsBySection.has(placement.sectionKey)) placementsBySection.set(placement.sectionKey, []);
      placementsBySection.get(placement.sectionKey).push({ id: placement.id, position: placement.position, mixId: placement.mixId });
    }
    sendJson(response, 200, {
      captureId: capture.captureId,
      capturedAt: capture.capturedAt,
      sections: sections.map(section => ({ ...section, placements: placementsBySection.get(section.key) || [] }))
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/liked') {
    const rows = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl,
        v.thumbnail, ${channelAvatarSelect('v')} AS avatar, v.duration, v.meta, v.kind, v.section, v.topic,
        v.last_seen AS seenAt, v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision,
        v.published_age AS publishedAge, d.acquired_at AS acquiredAt, d.expires_at AS expiresAt,
        COALESCE(w.view_count, 0) AS viewCount, COALESCE(p.current_time, 0) AS currentTime,
        COALESCE(p.completed, 0) AS completed, pref.updated_at AS likedAt,
        CASE WHEN d.video_id IS NULL THEN 0 ELSE 1 END AS downloaded, 1 AS liked
      FROM video_preferences pref JOIN videos v ON v.video_id = pref.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_views w ON w.video_id = v.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      WHERE pref.liked = 1
      ORDER BY pref.updated_at DESC, v.last_seen DESC, v.video_id
    `).all();
    const videos = rows.map(video => {
      if (!getStoredMediaPath(video.id, video.kind)) video.downloaded = 0;
      return localizeCachedImages(video);
    });
    sendJson(response, 200, videos);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/homepage-categories') {
    const rows = database.prepare(`SELECT c.category_key AS key, c.title, c.sort_position AS position,
        c.discovered_at AS discoveredAt, c.last_seen AS lastSeen, c.last_captured_at AS lastCapturedAt,
        (SELECT COUNT(*) FROM homepage_category_videos cv WHERE cv.category_key = c.category_key) AS videoCount
      FROM homepage_categories c WHERE c.last_seen = (SELECT MAX(last_seen) FROM homepage_categories)
      ORDER BY c.sort_position, c.title COLLATE NOCASE`).all();
    sendJson(response, 200, localizeCachedImages(rows));
    return;
  }

  const homepageCategoryVideosMatch = /^\/api\/homepage-categories\/([a-z0-9-]{1,70})\/videos$/i.exec(url.pathname);
  if (request.method === 'GET' && homepageCategoryVideosMatch) {
    const categoryKey = homepageCategoryVideosMatch[1].toLowerCase();
    const category = database.prepare('SELECT title FROM homepage_categories WHERE category_key = ?').get(categoryKey);
    if (!category) { sendJson(response, 200, { key: categoryKey, title: '', videos: [], offset: 0, limit: 24, hasMore: false, total: 0 }); return; }
    const requestedOffset = Number.parseInt(url.searchParams.get('offset'), 10);
    const requestedLimit = Number.parseInt(url.searchParams.get('limit'), 10);
    const offset = Number.isInteger(requestedOffset) ? Math.max(0, Math.min(requestedOffset, 10000)) : 0;
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 48)) : 24;
    const downloadedOnly = mediaDiscoveryPaused() ? 1 : 0;
    const total = database.prepare(`SELECT COUNT(*) AS count FROM homepage_category_videos cv
      LEFT JOIN downloads d ON d.video_id = cv.video_id AND d.status = 'ready'
      LEFT JOIN video_preferences pref ON pref.video_id = cv.video_id
      LEFT JOIN videos v ON v.video_id = cv.video_id
      LEFT JOIN blocked_channels blocked ON blocked.channel_key = lower(trim(v.channel))
      WHERE cv.category_key = ? AND (? = 0 OR d.video_id IS NOT NULL)
        AND COALESCE(pref.not_interested, 0) = 0 AND blocked.channel_key IS NULL`).get(categoryKey, downloadedOnly).count;
    const videos = database.prepare(`SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey,
        v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind,
        v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge,
        cv.position, cv.last_seen AS seenAt, cv.last_seen AS sourceSeenAt,
        CASE WHEN d.video_id IS NULL THEN 0 ELSE 1 END AS downloaded, COALESCE(w.view_count, 0) AS viewCount,
        COALESCE(pref.not_interested, 0) AS notInterested, CASE WHEN blocked.channel_key IS NULL THEN 0 ELSE 1 END AS channelBlocked
      FROM homepage_category_videos cv JOIN videos v ON v.video_id = cv.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_views w ON w.video_id = v.video_id
      LEFT JOIN video_preferences pref ON pref.video_id = v.video_id
      LEFT JOIN blocked_channels blocked ON blocked.channel_key = lower(trim(v.channel))
      WHERE cv.category_key = ? AND (? = 0 OR d.video_id IS NOT NULL)
        AND COALESCE(pref.not_interested, 0) = 0 AND blocked.channel_key IS NULL
      ORDER BY cv.last_seen DESC, cv.position, v.video_id LIMIT ? OFFSET ?`).all(categoryKey, downloadedOnly, limit, offset);
    sendJson(response, 200, { key: categoryKey, title: category.title, videos, offset, limit, total, hasMore: offset + videos.length < total });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/homepage-category-sync') {
    try {
      if (mediaDiscoveryPaused()) { sendJson(response, 409, { error: 'New media discovery is paused while YourTube is offline.', mode: reportedNetworkMode() }); return; }
      const parsed = await readBody(request);
      if (mediaDiscoveryPaused()) { sendJson(response, 409, { error: 'New media discovery is paused while YourTube is offline.', mode: reportedNetworkMode() }); return; }
      const captureId = String(parsed.captureId || '');
      const rawCategory = parsed.category || {};
      const categoryKey = String(rawCategory.key || '').toLowerCase();
      const title = String(rawCategory.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!/^[a-f0-9-]{36}$/i.test(captureId) || !/^[a-z0-9-]{1,70}$/.test(categoryKey) || !title) {
        sendJson(response, 400, { error: 'A valid capture ID and homepage category are required.' }); return;
      }
      const now = new Date().toISOString();
      const sortPosition = Math.max(0, Math.min(10000, Number.parseInt(rawCategory.position, 10) || 0));
      const incomingVideos = Array.isArray(parsed.videos) ? parsed.videos.slice(0, 24) : [];
      let acceptedVideos = 0;
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO homepage_categories (category_key, title, sort_position, discovered_at, last_seen, last_captured_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(category_key) DO UPDATE SET title = excluded.title,
          sort_position = excluded.sort_position, last_captured_at = excluded.last_captured_at`)
          .run(categoryKey, title, sortPosition, now, now, now);
        const insertCategoryVideo = database.prepare(`INSERT INTO homepage_category_videos
          (category_key, video_id, position, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(category_key, video_id) DO UPDATE SET position = excluded.position, last_seen = excluded.last_seen`);
        incomingVideos.forEach((raw, position) => {
          const video = cleanVideo(raw, position);
          if (!video) return;
          const extensionVersion = String(parsed.extensionVersion || '').trim().slice(0, 40) || 'unknown';
          recordExtensionDuration(extensionVersion, video, 'homepage-category', now);
          upsertVideo.run(video.id, video.url, video.title, video.channel, video.channelKey, video.channelUrl, video.thumbnail, video.avatar, video.duration, video.meta, video.kind, 'home', video.topic, position, now, now);
          saveVideoPublication(video.id, video);
          if (video.kind === 'short') isolateShortFromStandardFlows(video.id);
          database.prepare(`INSERT INTO video_provisions (video_id, category, first_seen, last_seen) VALUES (?, 'homepage', ?, ?)
            ON CONFLICT(video_id, category) DO UPDATE SET last_seen = excluded.last_seen`).run(video.id, now, now);
          recordVideoProvenance(video.id, raw.provenance, now, {
            sourceType: 'homepage-section', sourceKey: `category:${categoryKey}`,
            sourceLabel: `Homepage category · ${title}`, sourceUrl: 'https://www.youtube.com/'
          });
          insertCategoryVideo.run(categoryKey, video.id, position, now, now);
          acceptedVideos += 1;
        });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      scheduleBackgroundDurationLookup();
      sendJson(response, 200, { captureId, categoryKey, acceptedVideos, complete: parsed.complete === true, mode: reportedNetworkMode() });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : String(error?.message || 'Homepage category data could not be saved.') });
    }
    return;
  }

  const channelApiMatch = /^\/api\/channels\/(.+)$/.exec(url.pathname);
  if (request.method === 'GET' && channelApiMatch) {
    let channelKey = '';
    try { channelKey = cleanChannelKey(decodeURIComponent(channelApiMatch[1])); } catch {}
    if (!channelKey) { sendJson(response, 400, { error: 'Invalid YouTube channel address.' }); return; }
    const tab = ['home', 'videos', 'shorts', 'streams', 'playlists', 'community'].includes(url.searchParams.get('tab')) ? url.searchParams.get('tab') : 'videos';
    const channel = database.prepare(`SELECT channel_key AS channelKey, channel_url AS channelUrl, name, description,
      avatar, banner, subscriber_count AS subscriberCount, video_count AS videoCount, updated_at AS updatedAt
      FROM channels WHERE channel_key = ?`).get(channelKey) || null;
    const videos = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl,
        v.thumbnail, v.avatar, v.duration, v.meta, v.kind, ci.position, ci.added_at AS seenAt, ci.added_at AS sourceSeenAt,
        v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge,
        CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded,
        COALESCE(w.view_count, 0) AS viewCount
      FROM channel_items ci JOIN videos v ON v.video_id = ci.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE ci.channel_key = ? AND ci.tab_key = ?
      ORDER BY ci.position, ci.added_at DESC, v.video_id
      LIMIT 500
    `).all(channelKey, tab);
    const sourceTabLabel = ({ home: 'Home', videos: 'Videos', shorts: 'Shorts', streams: 'Live', playlists: 'Playlists', community: 'Community' })[tab];
    for (const video of videos) video.sourceLabel = `From ${channelKey} · ${sourceTabLabel}`;
    const captureRows = database.prepare(`SELECT capture_id AS captureId, tab_key AS tab, status, phase, message,
        video_count AS videoCount, created_at AS createdAt, updated_at AS updatedAt
      FROM channel_captures c WHERE channel_key = ? AND NOT EXISTS (
        SELECT 1 FROM channel_captures newer WHERE newer.channel_key = c.channel_key
          AND newer.tab_key = c.tab_key AND newer.created_at > c.created_at
      ) ORDER BY tab_key`).all(channelKey);
    const captureNow = Date.now();
    const hasFreshActiveCapture = captureRows.some(item => ['opening', 'collecting'].includes(item.status) &&
      Number.isFinite(Date.parse(item.updatedAt || '')) && captureNow - Date.parse(item.updatedAt) <= backgroundCaptureStaleMs);
    const presentCapture = item => {
      if (!item) return item;
      const updatedAt = Date.parse(item.updatedAt || '');
      const ageMs = Number.isFinite(updatedAt) ? captureNow - updatedAt : 0;
      const staleActive = ['opening', 'collecting'].includes(item.status) && ageMs > backgroundCaptureStaleMs;
      const orphanedQueue = item.status === 'queued' && reportedNetworkMode() === 'online' && !hasFreshActiveCapture && ageMs > backgroundCaptureStaleMs;
      if (!staleActive && !orphanedQueue) return item;
      return {
        ...item,
        status: 'stale',
        phase: 'stalled',
        message: orphanedQueue
          ? 'This section has waited more than five minutes without an active channel capture. Saved videos remain available; revisit this channel if prefetch has stopped.'
          : 'No extension progress for five minutes. Captured videos remain saved; revisit this channel if capture has stopped.'
      };
    };
    const captures = captureRows.map(presentCapture);
    const captureId = String(url.searchParams.get('captureId') || '');
    const capture = presentCapture(/^[a-f0-9-]{36}$/i.test(captureId)
      ? database.prepare(`SELECT capture_id AS captureId, tab_key AS tab, status, phase, message,
          video_count AS videoCount, created_at AS createdAt, updated_at AS updatedAt
          FROM channel_captures WHERE capture_id = ? AND channel_key = ?`).get(captureId, channelKey) || null
      : database.prepare(`SELECT capture_id AS captureId, tab_key AS tab, status, phase, message,
          video_count AS videoCount, created_at AS createdAt, updated_at AS updatedAt
          FROM channel_captures WHERE channel_key = ? AND tab_key = ? ORDER BY created_at DESC LIMIT 1`).get(channelKey, tab) || null);
    sendJson(response, 200, { channel, tab, videos, capture, captures });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/channel-captures') {
    try {
      const body = await readBody(request);
      const channelKey = cleanChannelKey(body.channelKey);
      const captureId = String(body.captureId || '');
      const tab = ['home', 'videos', 'shorts', 'streams', 'playlists', 'community'].includes(body.tab) ? body.tab : 'videos';
      if (!channelKey || !/^[a-f0-9-]{36}$/i.test(captureId)) { sendJson(response, 400, { error: 'A valid channel and capture id are required.' }); return; }
      if (mediaDiscoveryPaused()) { sendJson(response, 409, { error: 'Channel capture requires Online mode.', mode: reportedNetworkMode() }); return; }
      const now = new Date().toISOString();
      const channelUrl = `https://www.youtube.com/${channelKey}`;
      database.prepare(`INSERT INTO channels (channel_key, channel_url, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_key) DO UPDATE SET channel_url = excluded.channel_url, updated_at = excluded.updated_at`)
        .run(channelKey, channelUrl, now, now);
      database.prepare(`INSERT INTO channel_captures (capture_id, channel_key, tab_key, status, phase, video_count, created_at, updated_at)
        VALUES (?, ?, ?, 'opening', 'opening', 0, ?, ?)
        ON CONFLICT(capture_id) DO UPDATE SET channel_key = excluded.channel_key, tab_key = excluded.tab_key,
          status = 'opening', phase = 'opening', message = '', updated_at = excluded.updated_at`)
        .run(captureId, channelKey, tab, now, now);
      sendJson(response, 201, { captureId, channelKey, channelUrl, tab, status: 'opening', phase: 'opening', updatedAt: now });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Channel capture could not be started.' });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/channel-captures/batch') {
    try {
      const body = await readBody(request);
      const channelKey = cleanChannelKey(body.channelKey);
      const requested = Array.isArray(body.captures) ? body.captures.slice(0, 6) : [];
      const allowedTabs = ['home', 'videos', 'shorts', 'streams', 'playlists', 'community'];
      const seenTabs = new Set();
      const captures = requested.map(item => {
        const tab = String(item?.tab || '');
        const captureId = String(item?.captureId || '');
        if (!allowedTabs.includes(tab) || seenTabs.has(tab) || !/^[a-f0-9-]{36}$/i.test(captureId)) return null;
        seenTabs.add(tab);
        return { tab, captureId };
      });
      if (!channelKey || !captures.length || captures.some(item => !item) || seenTabs.size !== allowedTabs.length) {
        sendJson(response, 400, { error: 'A channel and all six channel sections are required.' }); return;
      }
      if (mediaDiscoveryPaused()) { sendJson(response, 409, { error: 'Channel capture requires Online mode.', mode: reportedNetworkMode() }); return; }
      const now = new Date().toISOString();
      const activeSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recentProgressSince = new Date(Date.now() - backgroundCaptureStaleMs).toISOString();
      const channelUrl = `https://www.youtube.com/${channelKey}`;
      database.prepare(`INSERT INTO channels (channel_key, channel_url, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_key) DO UPDATE SET channel_url = excluded.channel_url, updated_at = excluded.updated_at`)
        .run(channelKey, channelUrl, now, now);
      const findActive = database.prepare(`SELECT capture_id AS captureId, tab_key AS tab, status, phase, message
        FROM channel_captures WHERE channel_key = ? AND tab_key = ? AND created_at >= ?
          AND (status = 'paused' OR (status = 'queued' AND updated_at >= ?)
            OR (status IN ('opening', 'collecting') AND updated_at >= ?))
        ORDER BY created_at DESC LIMIT 1`);
      const insert = database.prepare(`INSERT INTO channel_captures
        (capture_id, channel_key, tab_key, status, phase, video_count, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`);
      const result = captures.map((job, index) => {
        const active = findActive.get(channelKey, job.tab, activeSince, recentProgressSince, recentProgressSince);
        if (active) return { ...active, reused: true };
        const status = index === 0 ? 'opening' : 'queued';
        const phase = index === 0 ? 'opening' : 'prefetch';
        const message = index === 0 ? '' : 'Waiting for the current channel section to finish.';
        insert.run(job.captureId, channelKey, job.tab, status, phase, message, now, now);
        return { captureId: job.captureId, tab: job.tab, status, phase, message, reused: false };
      });
      sendJson(response, 201, { channelKey, channelUrl, captures: result });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Channel prefetch could not be started.' });
    }
    return;
  }

  const channelCaptureStatusMatch = /^\/api\/channel-captures\/([a-f0-9-]{36})\/status$/i.exec(url.pathname);
  if (request.method === 'POST' && channelCaptureStatusMatch && extensionOrigin) {
    try {
      const body = await readBody(request);
      const status = ['opening', 'collecting', 'queued', 'error', 'paused'].includes(body.status) ? body.status : '';
      if (!status) { sendJson(response, 400, { error: 'Invalid channel capture status.' }); return; }
      const phase = String(body.phase || status).slice(0, 40);
      const message = String(body.message || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
      const result = database.prepare(`UPDATE channel_captures SET status = ?, phase = ?, message = ?, updated_at = ? WHERE capture_id = ?`)
        .run(status, phase, message, new Date().toISOString(), channelCaptureStatusMatch[1]);
      if (!result.changes) { sendJson(response, 404, { error: 'Channel capture was not found.' }); return; }
      sendJson(response, 200, { captureId: channelCaptureStatusMatch[1], status, phase, message });
    } catch (error) {
      sendJson(response, error instanceof RangeError ? 413 : 400, { error: 'Channel capture status could not be saved.' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/search') {
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 200);
    const offlineSearch = mediaDiscoveryPaused();
    const source = offlineSearch || url.searchParams.get('source') === 'local' ? 'local' : 'youtube';
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '5', 10);
    const requestedOffset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(20, requestedLimit)) : 5;
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.min(1000000, requestedOffset)) : 0;
    if (!query) { sendJson(response, 200, { videos: [], total: 0, localTotal: 0, localVideos: [], offset, limit, hasMore: false }); return; }
    const searchable = "lower(v.title || ' ' || v.channel || ' ' || v.meta)";
    const sourceFilter = source === 'local'
      ? offlineSearch ? '' : ' AND d.video_id IS NOT NULL'
      : ' AND d.video_id IS NULL';
    const matching = `instr(${searchable}, lower(?)) > 0${sourceFilter}`;
    const matchTotal = database.prepare(`SELECT COUNT(*) AS total FROM videos v LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready' WHERE ${matching}`).get(query).total;
    const localMatching = `instr(${searchable}, lower(?)) > 0 AND d.video_id IS NOT NULL`;
    const localTotal = database.prepare(`SELECT COUNT(*) AS total FROM videos v LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready' WHERE ${localMatching}`).get(query).total;
    const localVideos = database.prepare(`
      SELECT v.video_id AS id, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.duration,
        v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge
      FROM videos v JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      WHERE instr(${searchable}, lower(?)) > 0
      ORDER BY CASE WHEN instr(lower(v.title), lower(?)) > 0 THEN 0 ELSE 1 END,
        v.last_seen DESC, v.position ASC, v.video_id LIMIT 4
    `).all(query, query);
    const videos = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind, v.section, v.topic,
        v.last_seen AS seenAt, v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge, d.acquired_at AS acquiredAt,
        CASE WHEN d.video_id IS NULL THEN 0 ELSE 1 END AS downloaded, COALESCE(w.view_count, 0) AS viewCount
      FROM videos v LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE ${matching}
      ORDER BY CASE WHEN d.video_id IS NULL THEN 1 ELSE 0 END,
        CASE WHEN instr(lower(v.title), lower(?)) > 0 THEN 0 ELSE 1 END,
        v.last_seen DESC, v.position ASC, v.video_id
      LIMIT ? OFFSET ?
    `).all(query, query, limit, offset);
    sendJson(response, 200, {
      videos: localizeCachedImages(videos), total: matchTotal, localTotal,
      localVideos: localizeCachedImages(localVideos), offset, limit,
      hasMore: offset + videos.length < matchTotal
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/search-history') {
    const recentSearches = database.prepare(`SELECT h.search_id AS searchId, h.query, h.source, h.searched_at AS searchedAt
      FROM search_history h
      WHERE h.search_id = (
        SELECT latest.search_id FROM search_history latest
        WHERE latest.normalized_query = h.normalized_query AND latest.source = h.source
        ORDER BY latest.searched_at DESC, latest.search_id DESC LIMIT 1
      )
      ORDER BY h.searched_at DESC LIMIT 12`).all();
    sendJson(response, 200, recentSearches);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/search-history') {
    try {
      const payload = await readBody(request);
      const searchId = String(payload.searchId || '');
      const query = String(payload.query || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      const selectedVideoId = /^[A-Za-z0-9_-]{11}$/.test(String(payload.selectedVideoId || ''))
        ? String(payload.selectedVideoId)
        : '';
      const source = payload.source === 'local' ? 'local' : 'youtube';
      if (!/^[a-f0-9-]{36}$/i.test(searchId) || query.length < 2) {
        sendJson(response, 400, { error: 'A valid search is required.' });
        return;
      }
      const normalizedQuery = query.toLocaleLowerCase();
      const searchedAt = new Date().toISOString();
      database.prepare(`INSERT INTO search_history (search_id, query, normalized_query, searched_at, selected_video_id, source)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(search_id) DO UPDATE SET query = excluded.query,
        normalized_query = excluded.normalized_query,
        selected_video_id = CASE WHEN excluded.selected_video_id <> '' THEN excluded.selected_video_id ELSE search_history.selected_video_id END,
        source = excluded.source`)
        .run(searchId, query, normalizedQuery, searchedAt, selectedVideoId, source);
      const searchable = "lower(v.title || ' ' || v.channel || ' ' || v.meta)";
      const matches = database.prepare(`SELECT v.video_id AS id FROM videos v WHERE instr(${searchable}, lower(?)) > 0
        ORDER BY CASE WHEN instr(lower(v.title), lower(?)) > 0 THEN 0 ELSE 1 END,
          v.last_seen DESC, v.position ASC, v.video_id LIMIT 100`)
        .all(query, query);
      database.prepare('DELETE FROM search_history_results WHERE search_id = ?').run(searchId);
      const saveResult = database.prepare('INSERT INTO search_history_results (search_id, video_id, position) VALUES (?, ?, ?)');
      const sessionMatches = database.prepare('SELECT video_id AS id FROM search_results WHERE search_id = ? ORDER BY position ASC').all(searchId);
      const orderedMatches = [...new Set([...sessionMatches.map(video => video.id), ...matches.map(video => video.id)])];
      if (selectedVideoId && database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(selectedVideoId)) {
        orderedMatches.splice(Math.max(0, orderedMatches.indexOf(selectedVideoId)), orderedMatches.includes(selectedVideoId) ? 1 : 0);
        orderedMatches.unshift(selectedVideoId);
      }
      orderedMatches.forEach((videoId, position) => saveResult.run(searchId, videoId, position));
      if (selectedVideoId) {
        database.prepare(`INSERT INTO search_history_clicks (search_id, video_id, clicked_at) VALUES (?, ?, ?)
          ON CONFLICT(search_id, video_id) DO UPDATE SET clicked_at = excluded.clicked_at`)
          .run(searchId, selectedVideoId, searchedAt);
      }
      sendJson(response, 200, { saved: matches.length, searchedAt });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Search history could not be saved.' });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/search-history-click') {
    try {
      const payload = await readBody(request);
      const searchId = String(payload.searchId || '');
      const videoId = String(payload.videoId || '');
      if (!/^[a-f0-9-]{36}$/i.test(searchId) || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        sendJson(response, 400, { error: 'A valid search and video are required.' });
        return;
      }
      const resultBelongsToSearch = database.prepare('SELECT 1 FROM search_history_results WHERE search_id = ? AND video_id = ?').get(searchId, videoId);
      if (!resultBelongsToSearch) {
        sendJson(response, 404, { error: 'This video is not part of that search.' });
        return;
      }
      database.prepare(`INSERT INTO search_history_clicks (search_id, video_id, clicked_at) VALUES (?, ?, ?)
        ON CONFLICT(search_id, video_id) DO UPDATE SET clicked_at = excluded.clicked_at`)
        .run(searchId, videoId, new Date().toISOString());
      sendJson(response, 200, { saved: true });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Search selection could not be saved.' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/subscriptions') {
    database.prepare(`
      UPDATE subscriptions
      SET avatar = COALESCE(
        (SELECT c.avatar FROM channels c
          WHERE trim(c.channel_key, '/') = trim(subscriptions.channel_key, '/') AND trim(c.avatar) <> '' LIMIT 1),
        (SELECT v.avatar FROM videos v
          WHERE trim(v.channel_key, '/') = trim(subscriptions.channel_key, '/') AND trim(v.avatar) <> ''
          ORDER BY v.last_seen DESC LIMIT 1)
      )
      WHERE trim(avatar) = '' AND (
        EXISTS (SELECT 1 FROM channels c
          WHERE trim(c.channel_key, '/') = trim(subscriptions.channel_key, '/') AND trim(c.avatar) <> '')
        OR EXISTS (SELECT 1 FROM videos v
          WHERE trim(v.channel_key, '/') = trim(subscriptions.channel_key, '/') AND trim(v.avatar) <> '')
      )
    `).run();
    const rows = database.prepare('SELECT channel_key AS key, name, avatar, position FROM subscriptions ORDER BY position').all();
    sendJson(response, 200, localizeCachedImages(rows));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/queue') {
    const rows = database.prepare(`
      SELECT q.item_id AS itemId, q.position, q.added_at AS addedAt,
        q.source_playlist_id AS sourcePlaylistId, q.source_playlist_position AS sourcePlaylistPosition,
        v.video_id AS id, v.url, v.title, v.channel, v.thumbnail, v.avatar, v.duration, v.kind,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.duration, 0) AS progressDuration,
        COALESCE(p.completed, 0) AS completed,
        CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded
      FROM playback_queue q JOIN videos v ON v.video_id = q.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      WHERE v.kind <> 'short'
      ORDER BY q.position, q.item_id
    `).all();
    sendJson(response, 200, localizeCachedImages(rows));
    return;
  }

  if (request.method === 'PUT' && url.pathname === '/api/queue') {
    try {
      const body = await readBody(request);
      const playlistId = String(body.playlistId || '');
      const requestedItems = Array.isArray(body.items) ? body.items : [];
      if (!playlistId || requestedItems.length > 1000) {
        sendJson(response, 400, { error: 'A playlist and a valid set of local videos are required.' }); return;
      }
      const playlist = database.prepare('SELECT playlist_id AS id FROM playlists WHERE playlist_id = ?').get(playlistId);
      if (!playlist) { sendJson(response, 404, { error: 'Playlist not found.' }); return; }
      const seen = new Set();
      const items = [];
      for (const candidate of requestedItems) {
        const id = String(candidate?.videoId || '');
        const sourcePosition = Number.parseInt(candidate?.playlistPosition, 10);
        if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id) || !Number.isInteger(sourcePosition) || sourcePosition < 0) continue;
        seen.add(id);
        const video = database.prepare('SELECT kind FROM videos WHERE video_id = ?').get(id);
        if (!video || video.kind === 'short') continue;
        if (!database.prepare("SELECT 1 FROM downloads WHERE video_id = ? AND status = 'ready'").get(id) || !getStoredMediaPath(id)) continue;
        items.push({ id, sourcePosition });
      }
      if (!items.length) {
        sendJson(response, 409, { error: 'None of the selected playlist videos has a playable local copy. The current Up next queue was left unchanged.' }); return;
      }
      const addedAt = new Date().toISOString();
      const insert = database.prepare(`INSERT INTO playback_queue
        (video_id, position, added_at, source_playlist_id, source_playlist_position) VALUES (?, ?, ?, ?, ?)`);
      const queuedItems = [];
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec('DELETE FROM playback_queue');
        items.forEach((item, position) => {
          const result = insert.run(item.id, position, addedAt, playlistId, item.sourcePosition);
          queuedItems.push({ itemId: Number(result.lastInsertRowid), id: item.id, position, addedAt, sourcePlaylistId: playlistId, sourcePlaylistPosition: item.sourcePosition });
        });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      sendJson(response, 200, { replaced: true, playlistId, queued: queuedItems.length, skipped: requestedItems.length - queuedItems.length, items: queuedItems });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Up next could not be replaced with this playlist.' });
    }
    return;
  }

  if (request.method === 'DELETE' && url.pathname === '/api/queue') {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec('DELETE FROM playback_queue');
      database.exec('COMMIT');
      sendJson(response, 200, { cleared: true });
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/queue') {
    try {
      const body = await readBody(request);
      const videoId = String(body.videoId || '');
      const video = /^[A-Za-z0-9_-]{11}$/.test(videoId) ? database.prepare('SELECT kind FROM videos WHERE video_id = ?').get(videoId) : null;
      if (!video) {
        sendJson(response, 404, { error: 'Video not found in the local library.' }); return;
      }
      if (video.kind === 'short') { sendJson(response, 409, { error: 'Shorts stay in the Shorts feed and cannot be added to Up next.' }); return; }
      const existing = database.prepare('SELECT item_id AS itemId, position, added_at AS addedAt FROM playback_queue WHERE video_id = ? ORDER BY position, item_id LIMIT 1').get(videoId);
      if (existing) { sendJson(response, 200, { ...existing, alreadyQueued: true }); return; }
      const position = database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM playback_queue').get().position;
      const addedAt = new Date().toISOString();
      const result = database.prepare('INSERT INTO playback_queue (video_id, position, added_at) VALUES (?, ?, ?)').run(videoId, position, addedAt);
      sendJson(response, 201, { itemId: Number(result.lastInsertRowid), position, addedAt });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Video could not be added to the queue.' });
    }
    return;
  }

  const queueStartMatch = /^\/api\/queue\/([0-9]{1,12})\/start$/.exec(url.pathname);
  if (request.method === 'POST' && queueStartMatch) {
    try {
      const itemId = Number(queueStartMatch[1]);
      const body = await readBody(request);
      const repeat = body.repeat === true;
      database.exec('BEGIN IMMEDIATE');
      try {
        const queuedItem = database.prepare(`SELECT q.video_id AS videoId, q.source_playlist_id AS sourcePlaylistId,
          q.source_playlist_position AS sourcePlaylistPosition, v.kind FROM playback_queue q
          JOIN videos v ON v.video_id = q.video_id WHERE q.item_id = ?`).get(itemId);
        if (!queuedItem) {
          database.exec('COMMIT');
          sendJson(response, 200, { consumed: false, requeued: false });
          return;
        }
        database.prepare('DELETE FROM playback_queue WHERE item_id = ?').run(itemId);
        if (queuedItem.kind === 'short') {
          database.exec('COMMIT');
          sendJson(response, 200, { consumed: false, requeued: false });
          return;
        }
        const remaining = database.prepare('SELECT item_id AS itemId FROM playback_queue ORDER BY position, item_id').all();
        const setPosition = database.prepare('UPDATE playback_queue SET position = ? WHERE item_id = ?');
        remaining.forEach((item, position) => setPosition.run(position, item.itemId));
        let nextItemId = null;
        if (repeat) {
          const addedAt = new Date().toISOString();
          const result = database.prepare(`INSERT INTO playback_queue
            (video_id, position, added_at, source_playlist_id, source_playlist_position) VALUES (?, ?, ?, ?, ?)`)
            .run(queuedItem.videoId, remaining.length, addedAt, queuedItem.sourcePlaylistId, queuedItem.sourcePlaylistPosition);
          nextItemId = Number(result.lastInsertRowid);
        }
        database.exec('COMMIT');
        sendJson(response, 200, { consumed: true, requeued: repeat, itemId: nextItemId });
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Could not start the queued video.' });
    }
    return;
  }

  const queueItemMatch = /^\/api\/queue\/([0-9]{1,12})$/.exec(url.pathname);
  if (request.method === 'DELETE' && queueItemMatch) {
    const itemId = Number(queueItemMatch[1]);
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM playback_queue WHERE item_id = ?').run(itemId);
      const items = database.prepare('SELECT item_id AS id FROM playback_queue ORDER BY position, item_id').all();
      const setPosition = database.prepare('UPDATE playback_queue SET position = ? WHERE item_id = ?');
      items.forEach((item, position) => setPosition.run(position, item.id));
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    sendJson(response, 200, { removed: true });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/video-feedback') {
    try {
      const body = await readBody(request);
      const videoId = String(body.videoId || '');
      const action = String(body.action || '');
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(videoId)) {
        sendJson(response, 404, { error: 'Video not found in the local library.' }); return;
      }
      const now = new Date().toISOString();
      if (action === 'not-interested') {
        database.prepare(`INSERT INTO video_preferences (video_id, not_interested, updated_at) VALUES (?, 1, ?)
          ON CONFLICT(video_id) DO UPDATE SET not_interested = 1, updated_at = excluded.updated_at`).run(videoId, now);
        sendJson(response, 200, { saved: true, action });
        return;
      }
      if (action === 'like') {
        const liked = body.liked === true || body.liked === 1;
        database.prepare(`INSERT INTO video_preferences (video_id, liked, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(video_id) DO UPDATE SET liked = excluded.liked, updated_at = excluded.updated_at`).run(videoId, liked ? 1 : 0, now);
        shortsApiCache = null;
        shortsApiCacheExpiresAt = 0;
        sendJson(response, 200, { saved: true, action, liked });
        return;
      }
      if (action === 'dont-recommend-channel') {
        const author = database.prepare('SELECT channel FROM videos WHERE video_id = ?').get(videoId)?.channel || '';
        const channelName = cleanRepeatedLabel(author).slice(0, 200);
        const channelKey = channelName.toLowerCase();
        if (!channelKey || channelKey === 'channel unavailable') { sendJson(response, 409, { error: 'This video does not have a channel name to block.' }); return; }
        database.prepare(`INSERT INTO blocked_channels (channel_key, channel_name, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(channel_key) DO UPDATE SET channel_name = excluded.channel_name, updated_at = excluded.updated_at`).run(channelKey, channelName, now);
        sendJson(response, 200, { saved: true, action, channel: channelName });
        return;
      }
      sendJson(response, 400, { error: 'Unknown video feedback action.' });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Video feedback could not be saved.' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/daily-mix') {
    try {
      const dateParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date());
      const dateKey = `${dateParts.find(part => part.type === 'year')?.value}-${dateParts.find(part => part.type === 'month')?.value}-${dateParts.find(part => part.type === 'day')?.value}`;
      const playlistId = `daily-mix-${dateKey}`;
      let playlist = database.prepare(`SELECT playlist_id AS id, title, source, kind, thumbnail, created_at AS createdAt, updated_at AS updatedAt
        FROM playlists WHERE playlist_id = ? AND kind = 'daily-mix'`).get(playlistId);

      if (!playlist) {
        const now = new Date().toISOString();
        const recentCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const priorMixCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
        const allowNewStubs = reportedNetworkMode() === 'online';
        const musicPattern = /\b(?:music|song|official audio|official music video|lyrics?|vevo|concert|live performance|album|single|remix|cover|acoustic|karaoke|instrumental|soundtrack|dj set|mix)\b/i;
        const styleRules = [
          ['rock', /\b(?:rock|metal|punk|grunge|alternative rock|hard rock|classic rock|indie rock|post[- ]rock)\b/i],
          ['metal', /\b(?:metal|heavy metal|thrash|death metal|black metal|metalcore|doom metal)\b/i],
          ['hip-hop', /\b(?:hip[- ]hop|rap|trap)\b/i],
          ['r-and-b', /\b(?:r\s*&\s*b|rnb|rhythm and blues)\b/i],
          ['soul', /\b(?:soul|neo[- ]soul|motown)\b/i],
          ['pop', /\b(?:pop|synth[- ]pop|electropop|dance[- ]pop)\b/i],
          ['electronic', /\b(?:electronic|techno|house|trance|drum and bass|dnb|ambient|electronica)\b/i],
          ['jazz', /\b(?:jazz|bebop|swing|big band)\b/i],
          ['classical', /\b(?:classical|orchestra|symphony|opera|baroque)\b/i],
          ['country', /\b(?:country|bluegrass|americana)\b/i],
          ['folk', /\b(?:folk|singer[- ]songwriter|traditional music)\b/i],
          ['reggae', /\b(?:reggae|dancehall|ska)\b/i],
          ['latin', /\b(?:latin|salsa|bachata|reggaeton|cumbia|bossa nova)\b/i]
        ];
        const styleTagsFor = value => styleRules.filter(([, pattern]) => pattern.test(String(value || ''))).map(([tag]) => tag);
        const ignoredTokens = new Set(['official', 'video', 'audio', 'music', 'song', 'songs', 'lyrics', 'lyric', 'vevo', 'live', 'album', 'single', 'remix', 'cover', 'acoustic', 'karaoke', 'instrumental', 'soundtrack', 'mix', 'full', 'hd', '4k', 'feat', 'featuring', 'with', 'from', 'the', 'and', 'for', 'you', 'that', 'this', 'version', 'visualizer', 'records', 'record', 'channel']);
        const normalizeArtist = value => String(value || '').toLowerCase().replace(/\b(?:official|vevo|records|recordings|music|topic)\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
        const artistFor = row => {
          const channelArtist = normalizeArtist(row.channel || row.channelKey);
          if (channelArtist && !['channel unavailable', 'youtube', 'unknown'].includes(channelArtist) && !/^uc[a-z0-9_-]{20,32}$/i.test(channelArtist.replaceAll(' ', ''))) return channelArtist;
          const titleParts = String(row.title || '').split(/\s[-–—|:]\s/).map(part => part.trim()).filter(Boolean);
          if (/^(?:mix|live|official|music)$/i.test(titleParts[0] || '')) titleParts.shift();
          return normalizeArtist(titleParts[0] || '');
        };
        const tokensFor = value => [...new Set((String(value || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(token => !ignoredTokens.has(token)))];
        const watchedRows = database.prepare(`
          SELECT v.title, v.channel, v.channel_key AS channelKey, v.topic, v.section, COALESCE(ch.description, '') AS channelDescription,
            COALESCE(w.view_count, 0) AS viewCount, COALESCE(p.current_time, 0) AS currentTime,
            COALESCE(p.duration, 0) AS progressDuration, COALESCE(p.completed, 0) AS completed,
            EXISTS (SELECT 1 FROM playlist_items i JOIN playlists pl ON pl.playlist_id = i.playlist_id
              WHERE i.video_id = v.video_id AND (pl.kind = 'mix' OR lower(pl.title) LIKE '%music%' OR lower(pl.title) LIKE 'mix -%')) AS inMusicPlaylist,
            COALESCE((SELECT group_concat(pl.title, ' ') FROM playlist_items i JOIN playlists pl ON pl.playlist_id = i.playlist_id WHERE i.video_id = v.video_id), '') AS playlistContext
          FROM videos v LEFT JOIN video_views w ON w.video_id = v.video_id
          LEFT JOIN video_progress p ON p.video_id = v.video_id
          LEFT JOIN video_preferences f ON f.video_id = v.video_id
          LEFT JOIN channels ch ON ch.channel_key = v.channel_key
          WHERE v.kind <> 'short' AND COALESCE(f.not_interested, 0) = 0
            AND (COALESCE(w.view_count, 0) > 0 OR COALESCE(p.current_time, 0) > 0 OR COALESCE(p.completed, 0) = 1)
        `).all();
        const artistAffinity = new Map();
        const tokenAffinity = new Map();
        const styleAffinity = new Map();
        for (const row of watchedRows) {
          const text = `${row.title || ''} ${row.channel || ''} ${row.topic || ''} ${row.section || ''} ${row.channelDescription || ''} ${row.playlistContext || ''}`;
          const styleTags = styleTagsFor(text);
          if (!row.inMusicPlaylist && !musicPattern.test(text) && !styleTags.length) continue;
          const ratio = Number(row.progressDuration) > 0 ? Math.min(1, Number(row.currentTime) / Number(row.progressDuration)) : 0;
          const starts = Math.min(6, Number(row.viewCount) || 0);
          const completionSignal = Number(row.completed) ? 2.4 : ratio >= 0.8 ? 1.8 : ratio >= 0.5 ? 1.05 : ratio >= 0.15 ? 0.45 : 0;
          const signal = completionSignal + starts * 0.18 * (completionSignal > 0 ? 1 : 0.15);
          if (signal <= 0.25) continue;
          const artist = artistFor(row);
          if (artist && artist !== 'channel unavailable') artistAffinity.set(artist, (artistAffinity.get(artist) || 0) + signal);
          for (const token of tokensFor(`${row.title || ''} ${row.channel || ''}`)) tokenAffinity.set(token, (tokenAffinity.get(token) || 0) + signal);
          for (const tag of styleTags) styleAffinity.set(tag, (styleAffinity.get(tag) || 0) + signal);
        }

        const candidates = database.prepare(`
          SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.thumbnail, v.avatar, v.duration,
            v.kind, v.section, v.topic, COALESCE(ch.description, '') AS channelDescription,
            COALESCE((SELECT MIN(vp.first_seen) FROM video_provisions vp WHERE vp.video_id = v.video_id), v.first_seen) AS acquiredAt,
            CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded,
            EXISTS (SELECT 1 FROM playlist_items i JOIN playlists pl ON pl.playlist_id = i.playlist_id
              WHERE i.video_id = v.video_id AND (pl.kind = 'mix' OR lower(pl.title) LIKE '%music%' OR lower(pl.title) LIKE 'mix -%')) AS inMusicPlaylist,
            COALESCE((SELECT group_concat(pl.title, ' ') FROM playlist_items i JOIN playlists pl ON pl.playlist_id = i.playlist_id WHERE i.video_id = v.video_id), '') AS playlistContext,
            COALESCE(w.view_count, 0) AS viewCount
          FROM videos v LEFT JOIN downloads d ON d.video_id = v.video_id
          LEFT JOIN video_views w ON w.video_id = v.video_id
          LEFT JOIN channels ch ON ch.channel_key = v.channel_key
          WHERE v.kind != 'short' AND v.duration != '' AND NOT EXISTS (SELECT 1 FROM acquisition_exclusions x WHERE x.video_id = v.video_id)
            AND NOT EXISTS (SELECT 1 FROM video_preferences f WHERE f.video_id = v.video_id AND f.not_interested = 1)
            AND NOT EXISTS (SELECT 1 FROM blocked_channels b WHERE lower(b.channel_key) = lower(v.channel_key) OR lower(b.channel_key) = lower(v.channel))
            AND (d.status = 'ready' OR (? = 1 AND COALESCE((SELECT MIN(vp.first_seen) FROM video_provisions vp WHERE vp.video_id = v.video_id), v.first_seen) >= ?))
        `).all(allowNewStubs ? 1 : 0, recentCutoff);
        const maxArtistAffinity = Math.max(0, ...artistAffinity.values());
        const maxTokenAffinity = Math.max(0, ...tokenAffinity.values());
        const maxStyleAffinity = Math.max(0, ...styleAffinity.values());
        const candidatesById = new Map();
        for (const candidate of candidates) {
          const text = `${candidate.title || ''} ${candidate.channel || ''} ${candidate.topic || ''} ${candidate.section || ''} ${candidate.channelDescription || ''} ${candidate.playlistContext || ''}`;
          const styleTags = styleTagsFor(text);
          if (!hasFiniteVideoDuration(candidate.duration) || !candidate.inMusicPlaylist && !musicPattern.test(text) && !styleTags.length) continue;
          const artist = artistFor(candidate);
          const tokens = tokensFor(`${candidate.title || ''} ${candidate.channel || ''}`);
          const artistScore = maxArtistAffinity && artist ? (artistAffinity.get(artist) || 0) / maxArtistAffinity : 0;
          const tokenScore = maxTokenAffinity && tokens.length
            ? tokens.reduce((sum, token) => sum + (tokenAffinity.get(token) || 0) / maxTokenAffinity, 0) / Math.sqrt(tokens.length)
            : 0;
          const styleScore = maxStyleAffinity && styleTags.length
            ? styleTags.reduce((sum, tag) => sum + (styleAffinity.get(tag) || 0) / maxStyleAffinity, 0) / Math.sqrt(styleTags.length)
            : 0;
          const ageDays = Math.max(0, (Date.now() - (Date.parse(candidate.acquiredAt) || Date.now())) / 86_400_000);
          const freshnessScore = Math.max(0, 1 - ageDays / 30);
          const stableNoise = parseInt(createHash('sha256').update(`${dateKey}:${candidate.id}`).digest('hex').slice(0, 8), 16) / 0xffffffff;
          candidate.artistKey = artist || candidate.id;
          candidate.baseScore = artistScore * 3.2 + Math.min(1.5, tokenScore) * 1.25 + Math.min(1.8, styleScore) * 1.9 + freshnessScore * 0.55 + (candidate.downloaded ? 0.22 : 0.35) + stableNoise * 0.18;
          candidatesById.set(candidate.id, candidate);
        }
        const priorMixItems = database.prepare(`SELECT pi.video_id AS id, COUNT(*) AS uses
          FROM playlist_items pi JOIN playlists p ON p.playlist_id = pi.playlist_id
          WHERE p.kind = 'daily-mix' AND p.created_at >= ? AND p.playlist_id != ? GROUP BY pi.video_id`).all(priorMixCutoff, playlistId);
        const recentUses = new Map(priorMixItems.map(row => [row.id, Number(row.uses) || 0]));
        const selected = [];
        const selectedIds = new Set();
        const artistUses = new Map();
        const targetLocal = Math.ceil(12 * 0.65);
        let localCount = 0;
        let stubCount = 0;
        const selectBest = pool => {
          let best = null;
          let bestScore = -Infinity;
          for (const candidate of pool) {
            if (selectedIds.has(candidate.id)) continue;
            const score = candidate.baseScore
              - (recentUses.get(candidate.id) || 0) * 1.05
              - (artistUses.get(candidate.artistKey) || 0) * 1.1;
            if (score > bestScore || score === bestScore && candidate.id < (best?.id || '\uffff')) {
              best = candidate;
              bestScore = score;
            }
          }
          return best;
        };
        while (selected.length < 12 && selected.length < candidatesById.size) {
          const localPool = [...candidatesById.values()].filter(candidate => candidate.downloaded && !selectedIds.has(candidate.id));
          const stubPool = [...candidatesById.values()].filter(candidate => !candidate.downloaded && !selectedIds.has(candidate.id));
          let choice = null;
          if (localCount < targetLocal && localPool.length) choice = selectBest(localPool);
          else if (stubCount < 12 - targetLocal && stubPool.length) choice = selectBest(stubPool);
          else choice = selectBest([...localPool, ...stubPool]);
          if (!choice) break;
          selected.push(choice);
          selectedIds.add(choice.id);
          if (choice.downloaded) localCount += 1; else stubCount += 1;
          artistUses.set(choice.artistKey, (artistUses.get(choice.artistKey) || 0) + 1);
        }

        if (selected.length) {
          database.exec('BEGIN IMMEDIATE');
          try {
            playlist = database.prepare(`SELECT playlist_id AS id, title, source, kind, thumbnail, created_at AS createdAt, updated_at AS updatedAt
              FROM playlists WHERE playlist_id = ? AND kind = 'daily-mix'`).get(playlistId);
            if (!playlist) {
              const title = `Your Daily Mix · ${dateKey}`;
              database.prepare(`INSERT INTO playlists (playlist_id, title, source, kind, thumbnail, declared_item_count, is_complete, created_at, updated_at)
                VALUES (?, ?, 'local', 'daily-mix', ?, ?, 1, ?, ?)`).run(playlistId, title, selected[0].thumbnail || '', selected.length, now, now);
              const insertItem = database.prepare(`INSERT INTO playlist_items (playlist_id, video_id, position, source_key, added_at)
                VALUES (?, ?, ?, ?, ?)`);
              selected.forEach((video, position) => insertItem.run(playlistId, video.id, position, `daily-mix:${dateKey}:${video.id}`, now));
              playlist = { id: playlistId, title, source: 'local', kind: 'daily-mix', thumbnail: selected[0].thumbnail || '', createdAt: now, updatedAt: now };
            }
            database.prepare(`DELETE FROM playlist_items WHERE playlist_id IN (
              SELECT playlist_id FROM playlists WHERE kind = 'daily-mix' AND playlist_id != ? AND created_at < ?
            )`).run(playlistId, new Date(Date.now() - 30 * 86_400_000).toISOString());
            database.prepare(`DELETE FROM playlists WHERE kind = 'daily-mix' AND playlist_id != ? AND created_at < ?`).run(playlistId, new Date(Date.now() - 30 * 86_400_000).toISOString());
            database.exec('COMMIT');
          } catch (error) { database.exec('ROLLBACK'); throw error; }
        }
      }

      if (!playlist) {
        sendJson(response, 200, { id: '', title: 'Your Daily Mix', kind: 'daily-mix', items: [], message: 'No eligible music videos are available yet.' });
        return;
      }
      const items = database.prepare(`
        SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl,
          v.thumbnail, v.avatar, v.duration, v.meta, v.kind, v.published_at AS publishedAt,
          v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge,
          i.item_id AS itemId, i.position, i.added_at AS addedAt, d.acquired_at AS acquiredAt,
          CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded,
          COALESCE(w.view_count, 0) AS viewCount
        FROM playlist_items i JOIN videos v ON v.video_id = i.video_id
        LEFT JOIN downloads d ON d.video_id = v.video_id LEFT JOIN video_views w ON w.video_id = v.video_id
        WHERE i.playlist_id = ? ORDER BY i.position ASC
      `).all(playlist.id);
      sendJson(response, 200, { ...playlist, items, declaredItemCount: items.length, isComplete: true, localCount: items.filter(item => item.downloaded).length, generatedFor: playlist.id.slice('daily-mix-'.length) });
    } catch (error) {
      console.error('[daily-mix] Could not create or read daily mix:', error);
      sendJson(response, 500, { error: 'Your Daily Mix could not be prepared.' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/playlists') {
    const rows = database.prepare(`
      SELECT p.playlist_id AS id, p.title, p.source, p.kind, p.source_url AS sourceUrl, p.channel,
        p.thumbnail, p.declared_item_count AS declaredItemCount, p.is_complete AS isComplete,
        p.created_at AS createdAt, p.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM playlist_items i JOIN videos v ON v.video_id = i.video_id
          WHERE i.playlist_id = p.playlist_id AND v.kind <> 'short') AS capturedCount
      FROM playlists p WHERE p.kind <> 'download-group'
      ORDER BY CASE p.source WHEN 'local' THEN 0 ELSE 1 END, p.updated_at DESC, p.title COLLATE NOCASE
    `).all();
    sendJson(response, 200, rows);
    return;
  }

  const playlistActionMatch = /^\/api\/playlists\/([A-Za-z0-9_-]{1,160})\/(duplicate|redownload)$/.exec(url.pathname);
  if (request.method === 'POST' && playlistActionMatch) {
    const [, playlistId, action] = playlistActionMatch;
    const playlist = database.prepare(`SELECT playlist_id AS id, title, source, kind, thumbnail,
      declared_item_count AS declaredItemCount, is_complete AS isComplete FROM playlists WHERE playlist_id = ?`).get(playlistId);
    if (!playlist) { sendJson(response, 404, { error: 'Playlist not found.' }); return; }
    const items = database.prepare(`SELECT i.video_id AS id, v.thumbnail
      FROM playlist_items i LEFT JOIN videos v ON v.video_id = i.video_id
      WHERE i.playlist_id = ? AND COALESCE(v.kind, 'normal') <> 'short'
      ORDER BY i.position, i.added_at, i.item_id`).all(playlistId);

    if (action === 'duplicate') {
      const id = randomUUID().replaceAll('-', '');
      const now = new Date().toISOString();
      const cover = playlist.thumbnail || items.find(item => item.thumbnail)?.thumbnail || '';
      let title = '';
      database.exec('BEGIN IMMEDIATE');
      try {
        let suffix = 2;
        title = `${playlist.title} (${suffix})`;
        const titleExists = database.prepare("SELECT 1 FROM playlists WHERE source = 'local' AND title = ? COLLATE NOCASE LIMIT 1");
        while (titleExists.get(title)) title = `${playlist.title} (${++suffix})`;
        database.prepare(`INSERT INTO playlists (playlist_id, title, source, kind, thumbnail,
          declared_item_count, is_complete, created_at, updated_at)
          VALUES (?, ?, 'local', 'manual', ?, ?, 1, ?, ?)`).run(id, title, cover, items.length, now, now);
        const insertItem = database.prepare(`INSERT INTO playlist_items (playlist_id, video_id, position, source_key, added_at)
          VALUES (?, ?, ?, ?, ?)`);
        items.forEach((item, position) => insertItem.run(id, item.id, position, `duplicate:${randomUUID()}`, now));
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        console.error('[playlist] Could not duplicate playlist:', error);
        sendJson(response, 500, { error: 'This playlist could not be duplicated.' });
        return;
      }
      sendJson(response, 201, { id, title, source: 'local', kind: 'manual', thumbnail: cover,
        capturedCount: items.length, declaredItemCount: items.length, isComplete: true, createdAt: now, updatedAt: now });
      return;
    }

    if (networkMode !== 'online' || offlinePreparationRequested) {
      sendJson(response, 409, { error: 'Go Online before queuing playlist downloads.', mode: reportedNetworkMode() });
      return;
    }
    const now = new Date().toISOString();
    const enqueue = database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
      VALUES (?, 0, 'pending', ?, 'Queued from playlist', ?)
      ON CONFLICT(video_id) DO UPDATE SET attempts = 0, status = 'pending', next_retry_at = excluded.next_retry_at,
        last_error = excluded.last_error, updated_at = excluded.updated_at`);
    const enqueuePlaylistItem = database.prepare(`INSERT OR IGNORE INTO playlist_download_queue (video_id, playlist_id, queued_at)
      VALUES (?, ?, ?)`);
    let queued = 0;
    let alreadyLocal = 0;
    let alreadyQueued = 0;
    let paused = 0;
    let skipped = 0;
    const seen = new Set();
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        const id = String(item.id || '');
        if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) { skipped += 1; continue; }
        seen.add(id);
        if (getStoredMediaPath(id)) { alreadyLocal += 1; continue; }
        if (isAcquisitionExcluded(id)) { skipped += 1; continue; }
        if (jobs.has(id)) { alreadyQueued += 1; continue; }
        const retry = database.prepare('SELECT status FROM download_retry_queue WHERE video_id = ?').get(id);
        if (retry && ['pending', 'running', 'waiting-live'].includes(retry.status)) { alreadyQueued += 1; continue; }
        if (retry?.status === 'paused-limit' && areDownloadProtectionsActive()) { paused += 1; continue; }
        const video = database.prepare('SELECT kind FROM videos WHERE video_id = ?').get(id);
        if (!video || video.kind === 'short') { skipped += 1; continue; }
        enqueue.run(id, now, now);
        enqueuePlaylistItem.run(id, playlistId, now);
        saveDownload(id, 'error', 'Queued from playlist.', 0, 'Queued for download');
        queued += 1;
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      console.error('[playlist] Could not queue playlist downloads:', error);
      sendJson(response, 500, { error: 'Playlist downloads could not be queued.' });
      return;
    }
    sendJson(response, 202, { playlistId, queued, alreadyLocal, alreadyQueued, paused, skipped,
      captureIncomplete: playlist.source === 'youtube' && !Boolean(playlist.isComplete), total: items.length });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/playlists') {
    try {
      const body = await readBody(request);
      const title = cleanRepeatedLabel(body.title).slice(0, 120);
      if (!title) { sendJson(response, 400, { error: 'Enter a playlist name.' }); return; }
      if (body.fromQueue === true) {
        database.exec('BEGIN IMMEDIATE');
        try {
          const queueRows = database.prepare(`SELECT q.video_id AS id, v.thumbnail
            FROM playback_queue q JOIN videos v ON v.video_id = q.video_id
            WHERE v.kind <> 'short'
            ORDER BY q.position, q.item_id`).all();
          if (!queueRows.length) {
            database.exec('ROLLBACK');
            sendJson(response, 409, { error: 'The Up next queue is empty.' });
            return;
          }
          const id = randomUUID().replaceAll('-', '');
          const now = new Date().toISOString();
          database.prepare(`INSERT INTO playlists (playlist_id, title, source, kind, thumbnail,
            declared_item_count, is_complete, created_at, updated_at)
            VALUES (?, ?, 'local', 'manual', ?, ?, 1, ?, ?)`).run(id, title, queueRows[0].thumbnail || '', queueRows.length, now, now);
          const insertItem = database.prepare(`INSERT INTO playlist_items (playlist_id, video_id, position, source_key, added_at)
            VALUES (?, ?, ?, ?, ?)`);
          queueRows.forEach((item, position) => insertItem.run(id, item.id, position, `queue-save:${randomUUID()}`, now));
          database.exec('COMMIT');
          sendJson(response, 201, {
            id, title, source: 'local', kind: 'manual', thumbnail: queueRows[0].thumbnail || '',
            createdAt: now, updatedAt: now, capturedCount: queueRows.length,
            declaredItemCount: queueRows.length, isComplete: true
          });
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        return;
      }
      const id = randomUUID().replaceAll('-', '');
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO playlists (playlist_id, title, source, kind, created_at, updated_at)
        VALUES (?, ?, 'local', 'manual', ?, ?)`).run(id, title, now, now);
      sendJson(response, 201, { id, title, source: 'local', kind: 'manual', createdAt: now, updatedAt: now, capturedCount: 0, declaredItemCount: 0 });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Playlist could not be created.' });
    }
    return;
  }

  const playlistMatch = /^\/api\/playlists\/([A-Za-z0-9_-]{1,160})(?:\/(items|reorder)(?:\/([0-9]{1,12}))?)?$/.exec(url.pathname);
  if (playlistMatch) {
    const playlistId = playlistMatch[1];
    const action = playlistMatch[2] || '';
    const itemRoute = action === 'items';
    const itemVideoId = playlistMatch[3] || '';
    const playlist = database.prepare(`SELECT playlist_id AS id, title, source, kind, source_url AS sourceUrl,
      channel, thumbnail, declared_item_count AS declaredItemCount, is_complete AS isComplete,
      created_at AS createdAt, updated_at AS updatedAt FROM playlists WHERE playlist_id = ?`).get(playlistId);

    if (request.method === 'GET' && !action) {
      if (!playlist) { sendJson(response, 404, { error: 'Playlist not found.' }); return; }
      const items = database.prepare(`
        SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind,
          v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge,
          i.item_id AS itemId, i.position, i.added_at AS addedAt, d.acquired_at AS acquiredAt,
          CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded,
          COALESCE(w.view_count, 0) AS viewCount
        FROM playlist_items i JOIN videos v ON v.video_id = i.video_id
        LEFT JOIN downloads d ON d.video_id = v.video_id
        LEFT JOIN video_views w ON w.video_id = v.video_id
        WHERE i.playlist_id = ? AND v.kind <> 'short' ORDER BY i.position ASC, i.added_at ASC
      `).all(playlistId);
      sendJson(response, 200, { ...playlist, isComplete: Boolean(playlist.isComplete), items });
      return;
    }

    if (request.method === 'PATCH' && !action) {
      if (!playlist) { sendJson(response, 404, { error: 'Playlist not found.' }); return; }
      if (playlist.source !== 'local' || ['watch-later', 'daily-mix'].includes(playlist.kind)) { sendJson(response, 409, { error: 'This playlist cannot be renamed.' }); return; }
      try {
        const body = await readBody(request);
        const title = cleanRepeatedLabel(body.title).slice(0, 120);
        if (!title) { sendJson(response, 400, { error: 'Enter a playlist name.' }); return; }
        const updatedAt = new Date().toISOString();
        database.prepare('UPDATE playlists SET title = ?, updated_at = ? WHERE playlist_id = ? AND source = \'local\'').run(title, updatedAt, playlistId);
        sendJson(response, 200, { ...playlist, title, updatedAt });
      } catch (error) {
        const tooLarge = error instanceof RangeError;
        sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Playlist could not be renamed.' });
      }
      return;
    }

    if (request.method === 'DELETE' && !action) {
      if (!playlist) { sendJson(response, 404, { error: 'Playlist not found.' }); return; }
      if (playlist.source !== 'local' || ['watch-later', 'daily-mix'].includes(playlist.kind)) { sendJson(response, 409, { error: 'This playlist cannot be deleted.' }); return; }
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlistId);
        database.prepare('DELETE FROM playlists WHERE playlist_id = ? AND source = \'local\'').run(playlistId);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      sendJson(response, 200, { deleted: true });
      return;
    }

    if (request.method === 'POST' && itemRoute && !itemVideoId) {
      if (!playlist) { sendJson(response, 404, { error: 'Playlist not found.' }); return; }
      if (playlist.source !== 'local' || playlist.kind === 'daily-mix') { sendJson(response, 409, { error: 'This playlist is read-only in YourTube.' }); return; }
      try {
        const body = await readBody(request);
        const videoId = String(body.videoId || '');
        const video = /^[A-Za-z0-9_-]{11}$/.test(videoId) ? database.prepare('SELECT kind FROM videos WHERE video_id = ?').get(videoId) : null;
        if (!video) {
          sendJson(response, 404, { error: 'Video not found in the local library.' }); return;
        }
        if (video.kind === 'short') { sendJson(response, 409, { error: 'Shorts stay in the Shorts feed and cannot be added to playlists.' }); return; }
        const position = database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM playlist_items WHERE playlist_id = ?').get(playlistId).position;
        const now = new Date().toISOString();
        const result = database.prepare(`INSERT INTO playlist_items (playlist_id, video_id, position, source_key, added_at)
          VALUES (?, ?, ?, ?, ?)`).run(playlistId, videoId, position, `local:${randomUUID()}`, now);
        database.prepare('UPDATE playlists SET updated_at = ? WHERE playlist_id = ?').run(now, playlistId);
        sendJson(response, 201, { added: true, position });
      } catch (error) {
        const tooLarge = error instanceof RangeError;
        sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Video could not be added.' });
      }
      return;
    }

    if (request.method === 'DELETE' && itemRoute && itemVideoId) {
      if (!playlist) { sendJson(response, 404, { error: 'Playlist not found.' }); return; }
      if (playlist.source !== 'local' || playlist.kind === 'daily-mix') { sendJson(response, 409, { error: 'This playlist is read-only in YourTube.' }); return; }
      const now = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND item_id = ?').run(playlistId, Number(itemVideoId));
        const remaining = database.prepare('SELECT item_id AS id FROM playlist_items WHERE playlist_id = ? ORDER BY position, added_at, item_id').all(playlistId);
        const setPosition = database.prepare('UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND item_id = ?');
        remaining.forEach((item, position) => setPosition.run(position, playlistId, item.id));
        database.prepare('UPDATE playlists SET updated_at = ? WHERE playlist_id = ?').run(now, playlistId);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      sendJson(response, 200, { removed: true });
      return;
    }

    if (request.method === 'POST' && action === 'reorder') {
      if (!playlist) { sendJson(response, 404, { error: 'Playlist not found.' }); return; }
      if (playlist.source !== 'local' || playlist.kind === 'daily-mix') { sendJson(response, 409, { error: 'This playlist is read-only in YourTube.' }); return; }
      try {
        const body = await readBody(request);
        const ids = Array.isArray(body.itemIds) ? body.itemIds.slice(0, 10000).map(item => Number(item)) : [];
        const current = database.prepare('SELECT item_id AS id FROM playlist_items WHERE playlist_id = ? ORDER BY position, added_at, item_id').all(playlistId).map(item => item.id);
        const valid = new Set(current);
        if (ids.length !== current.length || ids.some(id => !valid.has(id)) || new Set(ids).size !== ids.length) {
          sendJson(response, 400, { error: 'The playlist order did not match its current videos.' }); return;
        }
        database.exec('BEGIN IMMEDIATE');
        try {
          const setPosition = database.prepare('UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND item_id = ?');
          ids.forEach((id, position) => setPosition.run(position, playlistId, id));
          database.prepare('UPDATE playlists SET updated_at = ? WHERE playlist_id = ?').run(new Date().toISOString(), playlistId);
          database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
        sendJson(response, 200, { reordered: true });
      } catch (error) {
        const tooLarge = error instanceof RangeError;
        sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Playlist order could not be saved.' });
      }
      return;
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/stats') {
    const mediaFiles = (await Promise.all([
      { directory: mediaDirectory, kind: 'video' },
      { directory: shortsMediaDirectory, kind: 'short' }
    ].map(async source => {
      const entries = await readdir(source.directory, { withFileTypes: true }).catch(() => []);
      return entries
        .filter(entry => entry.isFile() && /^[A-Za-z0-9_-]{11}\.(?:webm|mp4)$/i.test(entry.name))
        .map(entry => ({ filePath: path.join(source.directory, entry.name), kind: source.kind }));
    }))).flat();
    const mediaStats = await Promise.all(mediaFiles.map(async mediaFile => {
      try { return { ...mediaFile, stat: await stat(mediaFile.filePath) }; } catch { return null; }
    }));
    const availableMedia = mediaStats.filter(file => file?.stat.isFile());
    const localVideos = availableMedia.filter(file => file.kind === 'video').length;
    const localShorts = availableMedia.filter(file => file.kind === 'short').length;
    const localFiles = localVideos + localShorts;
    const activeMediaBytes = availableMedia.reduce((total, file) => total + file.stat.size, 0);
    const quarantineDirectory = path.join(dataDirectory, 'quarantine');
    const quarantineFiles = await readdir(quarantineDirectory).catch(() => []);
    const quarantineStats = await Promise.all(quarantineFiles.filter(name => /^[A-Za-z0-9_-]{11}-\d+\.(?:webm|mp4)$/i.test(name)).map(async name => {
      try { return await stat(path.join(quarantineDirectory, name)); } catch { return null; }
    }));
    const mediaBytes = activeMediaBytes + quarantineStats.reduce((total, file) => total + (file?.size || 0), 0);
    const mediaIntegrity = database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'ready' AND integrity_status = 'verified' THEN 1 ELSE 0 END), 0) AS verified,
      COALESCE(SUM(CASE WHEN status = 'ready' AND integrity_status = 'container-checked' THEN 1 ELSE 0 END), 0) AS containerChecked,
      COALESCE(SUM(CASE WHEN status = 'ready' AND integrity_status NOT IN ('verified', 'container-checked') THEN 1 ELSE 0 END), 0) AS unchecked,
      COALESCE(SUM(CASE WHEN integrity_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
      FROM downloads`).get();
    mediaIntegrity.failed = Math.max(mediaIntegrity.failed, quarantineFiles.filter(name => /^[A-Za-z0-9_-]{11}-\d+\.(?:webm|mp4)$/i.test(name)).length);
    const historicalViews = database.prepare('SELECT COALESCE(SUM(view_count), 0) AS total FROM video_views').get().total;
    const extensionVideos = database.prepare('SELECT COUNT(*) AS total FROM videos').get().total;
    const durationVersion = database.prepare(`SELECT extension_version AS version, MAX(last_seen_at) AS lastSeen
      FROM extension_duration_baseline GROUP BY extension_version ORDER BY lastSeen DESC LIMIT 1`).get();
    const durationBaseline = durationVersion ? database.prepare(`SELECT
      COUNT(*) AS sampled,
      COALESCE(SUM(first_has_duration), 0) AS firstWithDuration,
      COALESCE(SUM(last_has_duration), 0) AS latestWithDuration,
      COALESCE(SUM(CASE WHEN first_has_duration = 0 AND last_has_duration = 1 THEN 1 ELSE 0 END), 0) AS filledLater
      FROM extension_duration_baseline WHERE extension_version = ?`).get(durationVersion.version) : null;
    if (durationBaseline) {
      durationBaseline.version = durationVersion.version;
      durationBaseline.firstRatePercent = durationBaseline.sampled ? Math.round(durationBaseline.firstWithDuration * 100 / durationBaseline.sampled) : 0;
      durationBaseline.latestRatePercent = durationBaseline.sampled ? Math.round(durationBaseline.latestWithDuration * 100 / durationBaseline.sampled) : 0;
    }
    const activeDownloads = database.prepare(`SELECT COUNT(*) AS total FROM downloads d
      LEFT JOIN download_retry_queue q ON q.video_id = d.video_id
      WHERE d.status = 'downloading' OR q.status = 'waiting-live'`).get().total;
    const pausedDownloads = database.prepare(`SELECT COUNT(*) AS total FROM download_retry_queue q
      WHERE q.status IN ('paused', 'paused-offline') AND NOT EXISTS (
        SELECT 1 FROM downloads d WHERE d.video_id = q.video_id AND d.status = 'importing'
      )`).get().total;
    const queuedDownloads = database.prepare(`SELECT COUNT(*) AS total FROM download_retry_queue q
      WHERE q.status = 'pending' AND NOT EXISTS (
        SELECT 1 FROM downloads d WHERE d.video_id = q.video_id AND d.status = 'importing'
      )`).get().total;
    const activeChannelCaptures = database.prepare("SELECT COUNT(*) AS total FROM channel_captures WHERE status IN ('opening', 'queued', 'collecting')").get().total;
    const durationLookupActive = Boolean(database.prepare("SELECT 1 FROM video_duration_lookups WHERE status = 'running' LIMIT 1").get());
    const pendingDurations = database.prepare(`SELECT COUNT(*) AS total FROM videos v
      LEFT JOIN video_duration_lookups l ON l.video_id = v.video_id
      WHERE trim(v.duration) = '' AND (l.video_id IS NULL OR l.status IN ('pending', 'running', 'ready', 'extension', 'capturing', 'extension-retry')
        OR (l.status = 'unavailable' AND l.next_attempt_at <> 'never' AND l.updated_at <= ?))`).get(new Date(Date.now() - backgroundDurationUnavailableRetryMs).toISOString()).total;
    const downloadMetadataCounts = database.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN m.status = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
      COALESCE(SUM(CASE WHEN m.status = 'running' THEN 1 ELSE 0 END), 0) AS active
      FROM downloads d LEFT JOIN download_metadata m ON m.video_id = d.video_id WHERE d.status = 'ready'`).get();
    const currentMetadata = database.prepare("SELECT phase, message FROM download_metadata WHERE status = 'running' ORDER BY updated_at DESC LIMIT 1").get();
    const downloadMetadata = {
      total: downloadMetadataCounts.total,
      ready: downloadMetadataCounts.ready,
      pending: Math.max(0, downloadMetadataCounts.total - downloadMetadataCounts.ready),
      active: downloadMetadataCounts.active > 0,
      phase: currentMetadata?.phase || '',
      message: currentMetadata?.message || ''
    };
    sendJson(response, 200, { localFiles, localVideos, localShorts, mediaBytes, mediaIntegrity, mediaFolder: mediaFolderStatus(), historicalViews, extensionVideos, activeDownloads, pausedDownloads, queuedDownloads,
      youtubeCooldownUntil: getEnforcedYoutubeDownloadCooldownUntil(), activeChannelCaptures, durationLookupActive, pendingDurations, durationBaseline, downloadMetadata });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/extension/diagnostics' && localExtensionRequest) {
    const requestedCommentLimit = Number(url.searchParams.get('maxTabs'));
    if (Number.isInteger(requestedCommentLimit) && requestedCommentLimit >= 1 && requestedCommentLimit <= commentBackfillMaximumConcurrency) {
      const savedLimit = database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(commentBackfillConcurrencyKey)?.value;
      if (savedLimit !== String(requestedCommentLimit)) persistAppSetting(commentBackfillConcurrencyKey, requestedCommentLimit);
    }
    const durationCounts = database.prepare(`SELECT COUNT(*) AS missing,
      COALESCE(SUM(CASE WHEN l.video_id IS NULL OR l.status IN ('pending', 'running') THEN 1 ELSE 0 END), 0) AS queued,
      COALESCE(SUM(CASE WHEN l.status = 'extension' THEN 1 ELSE 0 END), 0) AS waitingExtension,
      COALESCE(SUM(CASE WHEN l.status = 'capturing' THEN 1 ELSE 0 END), 0) AS capturing,
      COALESCE(SUM(CASE WHEN l.status = 'extension-retry' THEN 1 ELSE 0 END), 0) AS retrying,
      COALESCE(SUM(CASE WHEN l.status = 'unavailable' THEN 1 ELSE 0 END), 0) AS unavailable
      FROM videos v LEFT JOIN video_duration_lookups l ON l.video_id = v.video_id WHERE trim(v.duration) = ''`).get();
    const durationSamples = database.prepare(`SELECT v.video_id AS videoId, v.title, v.channel,
      CASE WHEN l.video_id IS NULL THEN 'queued'
        WHEN l.status = 'extension' THEN 'waiting-extension'
        WHEN l.status = 'extension-retry' THEN 'retrying'
        ELSE l.status END AS status,
      COALESCE(NULLIF(l.message, ''), 'A local video length has not been saved yet.') AS message,
      COALESCE(l.extension_attempts, 0) AS attempts, l.next_attempt_at AS nextAttemptAt,
      COALESCE(l.updated_at, v.last_seen) AS updatedAt
      FROM videos v LEFT JOIN video_duration_lookups l ON l.video_id = v.video_id
      WHERE trim(v.duration) = '' AND (l.video_id IS NULL OR l.status IN ('pending', 'running', 'extension', 'capturing', 'extension-retry', 'unavailable'))
      ORDER BY CASE l.status WHEN 'capturing' THEN 0 WHEN 'extension' THEN 1 WHEN 'extension-retry' THEN 2
        WHEN 'pending' THEN 3 WHEN 'running' THEN 4 WHEN 'unavailable' THEN 5 ELSE 3 END,
        COALESCE(l.updated_at, v.last_seen) ASC LIMIT 6`).all();
    const mediaCounts = database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'downloading' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready
      FROM downloads`).get();
    const downloadRetryCounts = database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('pending', 'waiting-live') THEN 1 ELSE 0 END), 0) AS queued,
      COALESCE(SUM(CASE WHEN status IN ('paused', 'paused-offline', 'paused-limit', 'exhausted') THEN 1 ELSE 0 END), 0) AS paused
      FROM download_retry_queue q
      WHERE NOT EXISTS (SELECT 1 FROM downloads d WHERE d.video_id = q.video_id AND d.status = 'importing')`).get();
    const activeMediaSamples = database.prepare(`SELECT v.video_id AS videoId, v.title, v.channel, d.status,
      d.stage AS phase, d.message, d.progress, 0 AS attempts, '' AS nextAttemptAt, d.updated_at AS updatedAt
      FROM downloads d JOIN videos v ON v.video_id = d.video_id WHERE d.status = 'downloading'
      ORDER BY d.updated_at DESC LIMIT 4`).all();
    const retryMediaSamples = database.prepare(`SELECT v.video_id AS videoId, v.title, v.channel, q.status,
      COALESCE(d.stage, 'Queued for download') AS phase,
      COALESCE(NULLIF(q.last_error, ''), d.message, '') AS message,
      d.progress, q.attempts, q.next_retry_at AS nextAttemptAt, q.updated_at AS updatedAt
      FROM download_retry_queue q JOIN videos v ON v.video_id = q.video_id
      LEFT JOIN downloads d ON d.video_id = q.video_id
      WHERE q.status IN ('pending', 'waiting-live', 'paused', 'paused-offline', 'paused-limit', 'exhausted')
        AND COALESCE(d.status, '') <> 'importing'
      ORDER BY CASE q.status WHEN 'pending' THEN 0 WHEN 'waiting-live' THEN 1 ELSE 2 END, q.next_retry_at, q.updated_at DESC LIMIT 4`).all();
    const staleChannelBefore = new Date(Date.now() - backgroundCaptureStaleMs).toISOString();
    const channelCounts = database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('opening', 'collecting') AND updated_at > ? THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'stale' OR (status IN ('opening', 'collecting') AND updated_at <= ?) THEN 1 ELSE 0 END), 0) AS stale,
      COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
      COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors
      FROM channel_captures`).get(staleChannelBefore, staleChannelBefore);
    const recentChannelErrorsSince = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const channelSamples = database.prepare(`SELECT channel_key AS channel, tab_key AS tab, status, phase, message, updated_at AS updatedAt
      FROM channel_captures WHERE status IN ('opening', 'collecting', 'queued', 'error')
        AND (status <> 'error' OR updated_at >= ?)
      ORDER BY CASE WHEN status IN ('opening', 'collecting') AND updated_at > ? THEN 0
        WHEN status IN ('opening', 'collecting') THEN 1 WHEN status = 'queued' THEN 2 ELSE 3 END,
        updated_at DESC LIMIT 4`).all(recentChannelErrorsSince, staleChannelBefore);
    const localMetadataCounts = database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN m.status = 'running' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN m.status = 'waiting-extension' THEN 1 ELSE 0 END), 0) AS waitingExtension,
      COALESCE(SUM(CASE WHEN m.status IN ('pending', 'retry') OR m.status IS NULL THEN 1 ELSE 0 END), 0) AS queued
      FROM downloads d LEFT JOIN download_metadata m ON m.video_id = d.video_id WHERE d.status = 'ready'`).get();
    const commentBackfillCounts = database.prepare('SELECT status, COUNT(*) AS count FROM comment_backfill_queue GROUP BY status').all();
    const commentBackfillCountMap = Object.fromEntries(commentBackfillCounts.map(item => [item.status, Number(item.count) || 0]));
    sendJson(response, 200, {
      updatedAt: new Date().toISOString(), mode: reportedNetworkMode(),
      internetAvailable: connectivityStatus.available, connectivityNotice,
      preparation: offlinePreparation,
      videoLengths: durationCounts, videoLengthSamples: durationSamples,
      mediaDownloads: { ...mediaCounts, ...downloadRetryCounts, samples: [...activeMediaSamples, ...retryMediaSamples] },
      channelCaptures: { ...channelCounts, samples: channelSamples },
      downloadedMetadata: localMetadataCounts,
      commentBackfill: {
        maxConcurrency: commentBackfillConcurrency(), active: commentJobs.size,
        queued: (commentBackfillCountMap.queued || 0) + (commentBackfillCountMap.retry || 0),
        nextBatchAt: database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'comment_backfill_next_start_at'").get()?.value || ''
      }
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/extension/metadata-capture-jobs' && localExtensionRequest) {
    if (reportedNetworkMode() !== 'online' || connectivityStatus.available === false) {
      sendJson(response, 200, { job: null, mode: reportedNetworkMode() });
      return;
    }
    const now = new Date().toISOString();
    // Browser captures can pause for a user-solved CAPTCHA or age check.
    // Match the extension's ten-minute grace period before re-queuing the stub.
    const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    database.prepare("UPDATE video_duration_lookups SET status = 'extension-retry', message = 'The extension capture tab did not finish; it will retry automatically.', updated_at = ? WHERE status = 'capturing' AND updated_at <= ?")
      .run(now, staleBefore);
    const exhausted = database.prepare("SELECT video_id AS id FROM video_duration_lookups WHERE status IN ('extension', 'extension-retry') AND extension_attempts >= 3").all();
    for (const item of exhausted) {
      const message = 'The YouTube page did not provide a video length after three browser attempts. YourTube will retry its metadata lookup later.';
      setDurationLookup(item.id, 'unavailable', message);
      const downloaded = database.prepare("SELECT 1 FROM downloads WHERE video_id = ? AND status = 'ready'").get(item.id);
      if (downloaded) updateDownloadedMetadata(item.id, 'retry', 'extension capture', message, {
        nextAttemptAt: new Date(Date.now() + backgroundDurationUnavailableRetryMs).toISOString()
      });
    }
    const retryBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    const job = database.prepare(`SELECT v.video_id AS videoId, v.url, v.title, v.duration
      FROM video_duration_lookups l JOIN videos v ON v.video_id = l.video_id
      WHERE l.extension_attempts < 3 AND (l.status = 'extension' OR (l.status = 'extension-retry' AND l.updated_at <= ?))
      ORDER BY CASE l.status WHEN 'extension' THEN 0 ELSE 1 END, l.updated_at ASC LIMIT 1`).get(retryBefore);
    if (!job) {
      sendJson(response, 200, { job: null, mode: reportedNetworkMode() });
      return;
    }
    const isDownloaded = Boolean(database.prepare("SELECT 1 FROM downloads WHERE video_id = ? AND status = 'ready'").get(job.videoId));
    const missing = isDownloaded ? downloadedMetadataGaps(job.videoId) : [];
    const fields = [];
    if (!String(job.duration || '').trim() || /^(LIVE|UPCOMING)$/i.test(String(job.duration || '').trim())) fields.push('duration');
    if (missing.includes('channel name')) fields.push('channel');
    if (!fields.length) fields.push('duration');
    database.prepare("UPDATE video_duration_lookups SET status = 'capturing', extension_attempts = extension_attempts + 1, message = 'The extension is opening this video in the signed-in YouTube browser to read its rendered metadata.', updated_at = ? WHERE video_id = ? AND status IN ('extension', 'extension-retry')")
      .run(now, job.videoId);
    sendJson(response, 200, { job: { ...job, fields }, mode: reportedNetworkMode() });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/extension/video-metadata' && localExtensionRequest) {
    try {
      const parsed = await readBody(request, 16_000_000);
      const id = String(parsed.videoId || '');
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) { sendJson(response, 400, { error: 'A valid video ID is required.' }); return; }
      const video = database.prepare('SELECT url FROM videos WHERE video_id = ?').get(id);
      if (!video) { sendJson(response, 404, { error: 'The video stub no longer exists.' }); return; }
      const now = new Date().toISOString();
      const current = database.prepare('SELECT status FROM video_duration_lookups WHERE video_id = ?').get(id);
      if (!current || !['capturing', 'extension', 'extension-retry'].includes(current.status)) {
        sendJson(response, 409, { error: 'This extension metadata capture is no longer queued.' }); return;
      }
      const requestedFields = new Set((Array.isArray(parsed.requestedFields) ? parsed.requestedFields : []).map(field => String(field).toLowerCase()));
      const requestedChannelMissing = requestedFields.has('channel') && !cleanChannelName(parsed.channel);
      const requestedDurationMissing = requestedFields.has('duration') && !(Number(parsed.durationSeconds) > 0 || cleanDurationLabel(parsed.duration));
      const hasPageData = Boolean(parsed.title || parsed.channel || parsed.thumbnail || parsed.avatar || Number(parsed.durationSeconds) > 0 || parsed.commentsCaptured === true || parsed.publishedAt || parsed.publishedAge);
      if (parsed.failed === true && (!hasPageData || requestedChannelMissing || requestedDurationMissing)) {
        const missingField = requestedChannelMissing ? 'channel name' : requestedDurationMissing ? 'video length' : '';
        const defaultMessage = missingField
          ? `YouTube did not expose the requested ${missingField} in the browser page.`
          : 'YouTube did not expose the requested metadata in the browser page.';
        const message = String(parsed.message || defaultMessage).replace(/\s+/g, ' ').slice(0, 400);
        const attempts = Number(database.prepare('SELECT extension_attempts AS attempts FROM video_duration_lookups WHERE video_id = ?').get(id)?.attempts) || 0;
        const exhausted = attempts >= 3;
        const retryMessage = exhausted
          ? 'The YouTube page did not provide a video length after three browser attempts. YourTube will retry its metadata lookup later.'
          : `${message} The extension will retry in five minutes.`;
        setDurationLookup(id, exhausted ? 'unavailable' : 'extension-retry', retryMessage);
        const downloaded = database.prepare("SELECT 1 FROM downloads WHERE video_id = ? AND status = 'ready'").get(id);
        if (downloaded) updateDownloadedMetadata(id, exhausted ? 'retry' : 'waiting-extension', 'extension capture', retryMessage, {
          nextAttemptAt: exhausted ? new Date(Date.now() + backgroundDurationUnavailableRetryMs).toISOString() : ''
        });
        sendJson(response, 200, { accepted: true, duration: '', retry: true });
        return;
      }

      const title = String(parsed.title || '').trim().slice(0, 500);
      const channel = cleanRepeatedLabel(parsed.channel).slice(0, 200);
      const channelId = String(parsed.channelId || '').trim().slice(0, 100);
      const channelKey = cleanChannelKey(parsed.channelKey || parsed.channelUrl || (/^UC[A-Za-z0-9_-]{20,32}$/.test(channelId) ? `channel/${channelId}` : ''));
      const channelUrl = channelKey ? `https://www.youtube.com/${channelKey}` : '';
      const thumbnail = safeImage(parsed.thumbnail);
      const avatar = safeImage(parsed.avatar);
      const durationSeconds = Number(parsed.durationSeconds);
      const duration = formatDurationSeconds(durationSeconds) || cleanDurationLabel(parsed.duration);
      const description = String(parsed.description || '').slice(0, 20_000);
      const viewCount = Number.isFinite(Number(parsed.viewCount)) ? Number(parsed.viewCount) : null;
      const likeCount = Number.isFinite(Number(parsed.likeCount)) ? Number(parsed.likeCount) : null;
      const commentCount = Number.isFinite(Number(parsed.commentCount)) ? Number(parsed.commentCount) : null;
      const channelFollowerCount = Number.isFinite(Number(parsed.channelFollowerCount)) ? Number(parsed.channelFollowerCount) : null;
      const tags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 100).map(value => String(value).slice(0, 200)) : [];
      const publication = cleanPublishedAt(parsed.publishedAt, parsed.publishedAtPrecision);
      const info = {
        id, title, fulltitle: title, channel, uploader: channel, channel_id: channelId, channel_url: channelUrl,
        uploader_url: channelUrl, duration: durationSeconds, duration_string: duration,
        published_at: publication.publishedAt, published_at_precision: publication.precision, published_age: String(parsed.publishedAge || '').slice(0, 100),
        thumbnail, channel_thumbnail: avatar, description, view_count: viewCount, like_count: likeCount,
        comment_count: commentCount, channel_follower_count: channelFollowerCount, tags,
        webpage_url: video.url, extractor: 'youtube-page', extractor_key: 'YoutubePage',
        metadata_source: 'youtube-page', extractorMetadataCaptured: false
      };
      saveVideoMetadataFromInfo(id, info);
      if (duration) saveVideoDuration(id, { duration: durationSeconds || undefined, duration_string: duration });
      if (Array.isArray(parsed.comments) && parsed.commentsCaptured === true) {
        const existingComments = getComments(id)?.comments || [];
        const capturedComments = cleanComments(parsed.comments);
        const comments = cleanComments([...capturedComments, ...existingComments]);
        if (capturedComments.length || !existingComments.length) {
          const message = comments.length >= commentSnapshotLimit
            ? `${commentSnapshotVersion}; ${comments.length} saved from the rendered YouTube page.`
            : `Extension captured ${capturedComments.length} rendered comments; ${comments.length} saved locally.`;
          saveComments(id, 'ready', comments, message);
        }
      }
      const savedDuration = database.prepare('SELECT duration FROM videos WHERE video_id = ?').get(id)?.duration || '';
      if (/^UPCOMING$/i.test(String(savedDuration).trim())) {
        const retryAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
        setDurationLookup(id, 'upcoming', 'YouTube marks this video as Upcoming. Its length will be checked again after the scheduled start.', retryAt);
        sendJson(response, 200, { accepted: true, duration: 'UPCOMING', retry: true });
        return;
      }
      const hasDuration = Boolean(String(savedDuration).trim()) && !/^(LIVE|UPCOMING)$/i.test(String(savedDuration).trim());
      if (hasDuration) {
        const downloaded = database.prepare("SELECT 1 FROM downloads WHERE video_id = ? AND status = 'ready'").get(id);
        const savedChannel = database.prepare('SELECT channel FROM videos WHERE video_id = ?').get(id)?.channel || '';
        if (downloaded && (!String(savedChannel).trim() || /^(youtube|channel unavailable)$/i.test(String(savedChannel).trim()))) {
          const attempts = Number(database.prepare('SELECT extension_attempts AS attempts FROM video_duration_lookups WHERE video_id = ?').get(id)?.attempts) || 0;
          const exhausted = attempts >= 3;
          const retryAt = exhausted ? new Date(Date.now() + backgroundDurationUnavailableRetryMs).toISOString() : '';
          const message = exhausted
            ? 'The YouTube page did not provide a channel name after three browser captures. YourTube will retry metadata later.'
            : 'The video length is saved, but the channel name is still missing. The extension will retry this metadata capture in five minutes.';
          setDurationLookup(id, exhausted ? 'unavailable' : 'extension-retry', message, retryAt);
          updateDownloadedMetadata(id, exhausted ? 'retry' : 'waiting-extension', 'extension capture', message, { nextAttemptAt: retryAt });
          sendJson(response, 200, { accepted: true, duration: String(savedDuration).trim(), retry: true });
          return;
        }
        recordExtensionDuration(parsed.extensionVersion, { id, duration: String(savedDuration).trim() }, 'metadata-fallback', now);
        setDurationLookup(id, 'ready', 'Video length captured from the rendered YouTube page by the extension.');
        if (!downloaded || parsed.commentsCaptured === true) {
          database.prepare('UPDATE video_duration_lookups SET extension_attempts = 0 WHERE video_id = ?').run(id);
        }
        if (downloaded) updateDownloadedMetadata(id, 'pending', 'queued', 'Browser metadata captured; storing the video details and images locally.', { attempts: 0, nextAttemptAt: '' });
      } else {
        const detail = String(parsed.message || '').replace(/\s+/g, ' ').slice(0, 300);
        const attempts = Number(database.prepare('SELECT extension_attempts AS attempts FROM video_duration_lookups WHERE video_id = ?').get(id)?.attempts) || 0;
        const exhausted = attempts >= 3;
        const message = exhausted
          ? 'The YouTube page did not provide a video length after three browser attempts. YourTube will retry its metadata lookup later.'
          : detail
            ? `${detail} The extension will retry in five minutes.`
            : 'The extension captured the YouTube page, but it did not expose a video length. It will retry in five minutes.';
        setDurationLookup(id, exhausted ? 'unavailable' : 'extension-retry', message);
        const downloaded = database.prepare("SELECT 1 FROM downloads WHERE video_id = ? AND status = 'ready'").get(id);
        if (downloaded) updateDownloadedMetadata(id, exhausted ? 'retry' : 'waiting-extension', 'extension capture', message, {
          nextAttemptAt: exhausted ? new Date(Date.now() + backgroundDurationUnavailableRetryMs).toISOString() : ''
        });
      }
      sendJson(response, 200, { accepted: true, duration: hasDuration ? duration : '', retry: !hasDuration });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Browser metadata could not be saved.' });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/background-queue/retry') {
    try {
      const body = await readBody(request);
      const type = String(body.type || '');
      const id = String(body.id || '');
      if (!id || id.length > 200) { sendJson(response, 400, { error: 'A valid background job id is required.' }); return; }
      if (reportedNetworkMode() !== 'online' || connectivityStatus.available !== true || offlinePreparationRequested) {
        sendJson(response, 409, { error: 'Go Online with an active internet connection before retrying this job.', mode: reportedNetworkMode() }); return;
      }
      const now = new Date().toISOString();
      if (type === 'downloaded-metadata') {
        const row = database.prepare(`SELECT m.status, COALESCE(l.status, '') AS durationStatus
          FROM download_metadata m JOIN downloads d ON d.video_id = m.video_id
          LEFT JOIN video_duration_lookups l ON l.video_id = m.video_id
          WHERE m.video_id = ? AND d.status = 'ready'`).get(id);
        if (!row || !['retry', 'waiting-extension'].includes(row.status)) { sendJson(response, 409, { error: 'This local metadata job is no longer retryable.' }); return; }
        if (row.status === 'waiting-extension' && ['capturing', 'running'].includes(row.durationStatus)) { sendJson(response, 409, { error: 'The extension is already capturing this video metadata.' }); return; }
        if (row.status === 'waiting-extension') queueExtensionMetadataCapture(id, 'Manual retry requested.', { force: true });
        else updateDownloadedMetadata(id, 'pending', 'queued', 'Manual retry requested; waiting for the metadata worker.', { attempts: 0, nextAttemptAt: '' });
        sendJson(response, 202, { queued: true, message: 'Local metadata retry queued.' });
        return;
      }
      if (type === 'video-length') {
        const video = database.prepare('SELECT duration FROM videos WHERE video_id = ?').get(id);
        const lookup = database.prepare('SELECT status, next_attempt_at AS nextAttemptAt FROM video_duration_lookups WHERE video_id = ?').get(id);
        if (!video || String(video.duration || '').trim() && !/^UPCOMING$/i.test(String(video.duration).trim()) || ['running', 'capturing', 'ready'].includes(lookup?.status) || lookup?.status === 'unavailable' && lookup.nextAttemptAt === 'never') {
          sendJson(response, 409, { error: 'This video-length job is no longer retryable.' }); return;
        }
        queueExtensionMetadataCapture(id, 'Manual video-length retry requested.', { force: true });
        sendJson(response, 202, { queued: true, message: 'Video-length capture queued for the extension.' });
        return;
      }
      if (type === 'comments') {
        const comments = database.prepare("SELECT status FROM video_comments WHERE video_id = ?").get(id);
        if (comments?.status !== 'error') { sendJson(response, 409, { error: 'This comment job is no longer retryable.' }); return; }
        beginComments(id);
        sendJson(response, 202, { queued: true, message: 'Comment collection restarted.' });
        return;
      }
      if (type === 'comment-backfill') {
        const row = database.prepare("SELECT status FROM comment_backfill_queue WHERE video_id = ?").get(id);
        if (row?.status !== 'retry') { sendJson(response, 409, { error: 'This comment expansion is no longer retryable.' }); return; }
        database.prepare(`UPDATE comment_backfill_queue SET status = 'queued', attempts = 0, next_attempt_at = '',
          message = 'Manual retry requested; waiting for an available comment slot.', updated_at = ? WHERE video_id = ?`).run(now, id);
        runCommentBackfillQueue();
        sendJson(response, 202, { queued: true, message: 'Comment expansion retry queued.' });
        return;
      }
      if (type === 'channel-capture') {
        const row = database.prepare(`SELECT capture_id AS id, channel_key AS channelKey, tab_key AS tab, status, updated_at AS updatedAt
          FROM channel_captures WHERE capture_id = ?`).get(id);
        const terminalFailure = row && ['error', 'failed', 'stale'].includes(row.status);
        const staleActive = row && ['opening', 'queued', 'collecting'].includes(row.status) && Date.now() - Date.parse(row.updatedAt) > backgroundCaptureStaleMs;
        if (!row || (!terminalFailure && !staleActive)) {
          sendJson(response, 409, { error: 'This channel capture is no longer retryable.' }); return;
        }
        database.prepare("UPDATE channel_captures SET status = 'opening', phase = 'opening', message = 'Manual retry requested.', updated_at = ? WHERE capture_id = ?").run(now, id);
        sendJson(response, 202, { queued: true, message: 'Channel section capture restarted.', extensionMessage: { type: 'yourtube:collect-channel', captureId: row.id, channelKey: row.channelKey, tab: row.tab } });
        return;
      }
      if (type === 'search') {
        const row = database.prepare('SELECT search_id AS id, query, status, updated_at AS updatedAt FROM search_sessions WHERE search_id = ?').get(id);
        const terminalFailure = row && ['error', 'failed'].includes(row.status);
        const staleActive = ['collecting', 'stale'].includes(row?.status) && (row.status === 'stale' || Date.now() - Date.parse(row.updatedAt) > backgroundCaptureStaleMs);
        if (!row || (!terminalFailure && !staleActive)) {
          sendJson(response, 409, { error: 'This search capture is no longer retryable.' }); return;
        }
        database.prepare("UPDATE search_sessions SET status = 'collecting', updated_at = ? WHERE search_id = ?").run(now, id);
        sendJson(response, 202, { queued: true, message: 'Search capture restarted; existing results are kept.', extensionMessage: { type: 'yourtube:open-search', searchId: row.id, query: row.query } });
        return;
      }
      sendJson(response, 400, { error: 'This background job does not support manual retry.' });
    } catch (error) {
      sendJson(response, 400, { error: error.message || 'Background job could not be retried.' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/background-queue') {
    const staleChannelBefore = new Date(Date.now() - backgroundCaptureStaleMs).toISOString();
    const mediaFolderImportRows = database.prepare(`SELECT d.video_id AS videoId, COALESCE(v.title, d.video_id) AS title,
      COALESCE(v.channel, '') AS channel, d.status, d.stage AS phase, d.message, d.updated_at AS updatedAt
      FROM downloads d LEFT JOIN videos v ON v.video_id = d.video_id WHERE d.status = 'importing'
      ORDER BY d.updated_at`).all();
    const activeMedia = database.prepare(`SELECT d.video_id AS videoId, v.title, v.channel, d.status,
      d.stage AS phase, d.message, d.progress, d.updated_at AS updatedAt
      FROM downloads d LEFT JOIN videos v ON v.video_id = d.video_id
      WHERE d.status = 'downloading' ORDER BY d.updated_at DESC`).all();
    const queuedMedia = database.prepare(`SELECT q.video_id AS videoId, v.title, v.channel, q.status,
      COALESCE(d.stage, 'Queued for download') AS phase,
      COALESCE(NULLIF(q.last_error, ''), d.message, '') AS message,
      q.attempts, q.next_retry_at AS nextAttemptAt, q.updated_at AS updatedAt
      FROM download_retry_queue q LEFT JOIN videos v ON v.video_id = q.video_id
      LEFT JOIN downloads d ON d.video_id = q.video_id
      WHERE q.status IN ('pending', 'waiting-live') AND COALESCE(d.status, '') <> 'importing'
      ORDER BY q.next_retry_at, q.updated_at`).all()
      .map(item => ({ ...item, retryAction: item.status === 'pending' ? { type: 'media', id: item.videoId } : null }));
    const heldMedia = database.prepare(`SELECT q.video_id AS videoId, v.title, v.channel, q.status,
      COALESCE(d.stage, 'Paused') AS phase,
      COALESCE(NULLIF(q.last_error, ''), d.message, '') AS message,
      q.attempts, q.next_retry_at AS nextAttemptAt, q.updated_at AS updatedAt
      FROM download_retry_queue q LEFT JOIN videos v ON v.video_id = q.video_id
      LEFT JOIN downloads d ON d.video_id = q.video_id
      WHERE q.status IN ('paused', 'paused-offline', 'paused-limit', 'exhausted')
        AND COALESCE(d.status, '') <> 'importing' ORDER BY q.updated_at DESC`).all()
      .map(item => ({ ...item, retryAction: { type: 'media', id: item.videoId } }));
    const localMetadata = database.prepare(`SELECT d.video_id AS videoId, v.title, v.channel,
      COALESCE(m.status, 'pending') AS status, COALESCE(m.phase, 'queued') AS phase,
      COALESCE(m.message, 'Waiting for local metadata preparation.') AS message,
      COALESCE(l.status, '') AS durationStatus,
      COALESCE(m.attempts, 0) AS attempts, m.next_attempt_at AS nextAttemptAt,
      COALESCE(m.updated_at, d.updated_at) AS updatedAt
      FROM downloads d JOIN videos v ON v.video_id = d.video_id
      LEFT JOIN download_metadata m ON m.video_id = d.video_id
      LEFT JOIN video_duration_lookups l ON l.video_id = d.video_id
      WHERE d.status = 'ready' AND COALESCE(m.status, 'pending') <> 'ready'
      ORDER BY CASE m.status WHEN 'running' THEN 0 WHEN 'retry' THEN 2 ELSE 1 END,
      d.acquired_at DESC`).all()
      .map(item => ({ ...item, retryAction: item.status === 'retry' || item.status === 'waiting-extension' && ['extension', 'extension-retry', 'unavailable'].includes(item.durationStatus) ? { type: 'downloaded-metadata', id: item.videoId } : null }));
    const durationRows = database.prepare(`SELECT v.video_id AS videoId, v.title, v.channel,
      CASE l.status WHEN 'extension' THEN 'waiting-extension' WHEN 'capturing' THEN 'capturing' WHEN 'extension-retry' THEN 'retrying' ELSE COALESCE(l.status, 'queued') END AS status,
      l.status AS lookupStatus, l.next_attempt_at AS nextAttemptAt,
      CASE WHEN l.status IN ('extension', 'capturing', 'extension-retry') THEN 'Extension capture' ELSE 'Video length' END AS phase,
      COALESCE(NULLIF(l.message, ''), 'A local video length has not been saved yet.') AS message,
      l.updated_at AS updatedAt
      FROM videos v LEFT JOIN video_duration_lookups l ON l.video_id = v.video_id
      WHERE trim(v.duration) = '' AND (l.video_id IS NULL OR l.status IN ('pending', 'running', 'extension', 'capturing', 'extension-retry')
        OR (l.status = 'unavailable' AND l.next_attempt_at <> 'never' AND l.updated_at <= ?))
      ORDER BY CASE l.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'unavailable' THEN 2 ELSE 3 END,
        v.last_seen DESC`).all(new Date(Date.now() - backgroundDurationUnavailableRetryMs).toISOString())
      .map(item => ({ ...item, retryAction: !item.lookupStatus || ['pending', 'extension', 'extension-retry'].includes(item.lookupStatus) || item.lookupStatus === 'unavailable' && item.nextAttemptAt !== 'never' ? { type: 'video-length', id: item.videoId } : null }));
    const durationLimits = database.prepare(`SELECT v.video_id AS videoId, v.title, v.channel, 'unavailable' AS status,
      'Video length' AS phase, l.message, l.updated_at AS updatedAt
      FROM video_duration_lookups l JOIN videos v ON v.video_id = l.video_id
      WHERE trim(v.duration) = '' AND l.status = 'unavailable' AND l.next_attempt_at = 'never'
      ORDER BY l.updated_at DESC`).all();
    const comments = database.prepare(`SELECT c.video_id AS videoId, v.title, v.channel, c.status,
      'Comments' AS phase, c.message, c.updated_at AS updatedAt
      FROM video_comments c JOIN videos v ON v.video_id = c.video_id
      WHERE c.status IN ('loading', 'error') ORDER BY c.updated_at DESC`).all()
      .map(item => ({ ...item, retryAction: item.status === 'error' ? { type: 'comments', id: item.videoId } : null }));
    const commentBackfillCounts = database.prepare(`SELECT status, COUNT(*) AS count FROM comment_backfill_queue GROUP BY status`).all();
    const commentBackfillCountMap = Object.fromEntries(commentBackfillCounts.map(item => [item.status, Number(item.count) || 0]));
    const commentBackfillTotal = Object.values(commentBackfillCountMap).reduce((sum, count) => sum + count, 0);
    const commentBackfillRemaining = (commentBackfillCountMap.queued || 0) + (commentBackfillCountMap.retry || 0) + (commentBackfillCountMap.running || 0);
    const commentBackfillItems = database.prepare(`SELECT q.video_id AS videoId, COALESCE(v.title, q.video_id) AS title,
      COALESCE(v.channel, '') AS channel, q.status, 'Expand to 1,000 comments' AS phase,
      q.message, q.attempts, q.next_attempt_at AS nextAttemptAt, q.updated_at AS updatedAt
      FROM comment_backfill_queue q LEFT JOIN videos v ON v.video_id = q.video_id
      WHERE q.status IN ('running', 'queued', 'retry')
      ORDER BY CASE q.status WHEN 'running' THEN 0 WHEN 'retry' THEN 1 ELSE 2 END, q.created_at LIMIT 20`).all()
      .map(item => ({ ...item, retryAction: item.status === 'retry' ? { type: 'comment-backfill', id: item.videoId } : null }));
    const commentBackfillLimit = commentBackfillConcurrency();
    const channelCaptureRows = database.prepare(`SELECT capture_id AS id, channel_key AS channel,
      tab_key AS tab, status, phase, message, video_count AS videoCount, created_at AS createdAt,
      updated_at AS updatedAt
      FROM channel_captures WHERE status IN ('opening', 'queued', 'collecting', 'error', 'failed', 'stale')
      ORDER BY CASE WHEN status IN ('opening', 'collecting') AND updated_at > ? THEN 0
        WHEN status = 'queued' THEN 1 ELSE 2 END, updated_at DESC`).all(staleChannelBefore);
    const freshActiveChannelKeys = new Set(channelCaptureRows
      .filter(item => ['opening', 'collecting'].includes(item.status) && Date.now() - Date.parse(item.updatedAt) <= backgroundCaptureStaleMs)
      .map(item => item.channel));
    const canAdvanceChannelCaptures = reportedNetworkMode() === 'online' && connectivityStatus.available !== false;
    const channelCaptures = channelCaptureRows.map(item => {
        const ageMs = Date.now() - Date.parse(item.updatedAt);
        const stale = item.status === 'stale' || ['opening', 'collecting'].includes(item.status) && ageMs > backgroundCaptureStaleMs;
        const orphanedQueue = item.status === 'queued' && canAdvanceChannelCaptures && !freshActiveChannelKeys.has(item.channel) && ageMs > backgroundCaptureStaleMs;
        const terminalFailure = ['error', 'failed', 'stale'].includes(item.status);
        return {
          ...item,
          ...(stale || orphanedQueue ? {
            status: 'stale', phase: 'stalled',
            message: orphanedQueue
              ? 'This section has waited more than five minutes without an active channel capture. Saved videos remain available; revisit this channel if prefetch has stopped.'
              : 'No extension progress for five minutes. Captured videos remain saved; revisit this channel if capture has stopped.'
          } : {}),
          title: `${item.channel} · ${item.tab}`,
          retryAction: stale || orphanedQueue || terminalFailure ? { type: 'channel-capture', id: item.id } : null
        };
      });
    const channelMetadata = [...channelLookups.entries()]
      .filter(([, lookup]) => lookup.status === 'loading')
      .map(([videoId, lookup]) => {
        const video = database.prepare('SELECT title, channel FROM videos WHERE video_id = ?').get(videoId);
        return { videoId, title: video?.title || videoId, channel: video?.channel || '', status: 'running', phase: 'Channel details', message: lookup.message || 'Looking up channel details.' };
      });
    const searchSessions = database.prepare(`SELECT s.search_id AS id, s.query AS title, s.status,
      'YouTube search capture' AS phase,
      (SELECT COUNT(*) FROM search_results r WHERE r.search_id = s.search_id) AS resultCount,
      s.updated_at AS updatedAt
      FROM search_sessions s WHERE s.status IN ('collecting', 'error', 'failed', 'stale') ORDER BY s.updated_at DESC`).all()
      .map(item => {
        const stale = item.status === 'stale' || item.status === 'collecting' && Date.now() - Date.parse(item.updatedAt) > backgroundCaptureStaleMs;
        const terminalFailure = ['error', 'failed', 'stale'].includes(item.status);
        return {
          ...item,
          status: stale ? 'stale' : item.status,
          retryAction: stale || terminalFailure ? { type: 'search', id: item.id } : null,
          message: stale
            ? `No new results for five minutes. ${item.resultCount} captured results remain saved; run the search again if you need more.`
            : `${item.resultCount} results stored so far.`
        };
      });
    const preparation = ['queued', 'running', 'paused'].includes(offlinePreparation.status)
      ? [{ id: 'offline-preparation', title: 'Offline library preparation', status: offlinePreparation.status,
          phase: offlinePreparation.phase, message: offlinePreparation.message,
          progress: offlinePreparation.total ? Math.round(offlinePreparation.completed * 100 / offlinePreparation.total) : null,
          completed: offlinePreparation.completed, total: offlinePreparation.total }]
      : [];
    const groups = [
      { key: 'media-folder-imports', label: 'Media folder imports', description: 'Stable files copied into the media folder are integrity-checked before becoming playable.', items: mediaFolderImportRows },
      { key: 'active-media', label: 'Active media downloads', items: activeMedia },
      { key: 'queued-media', label: 'Queued download attempts', items: queuedMedia },
      { key: 'held-media', label: 'Paused or held downloads', items: heldMedia },
      { key: 'local-metadata', label: 'Downloaded video metadata', items: localMetadata },
      { key: 'video-lengths', label: 'Video lengths', description: 'Metadata only; no media is downloading. Server yt-dlp lookups are paced at about one item every five minutes; the extension is used when yt-dlp cannot provide a length. Server lookups pause Offline and during active download or comment work.', items: durationRows },
      { key: 'video-length-limits', label: 'Known video-length limits', items: durationLimits },
      { key: 'comments', label: 'Comment collection', items: comments },
      { key: 'comment-backfill', label: 'Historical comment expansion',
        description: `${commentBackfillTotal - commentBackfillRemaining}/${commentBackfillTotal} existing snapshots processed. Up to ${commentBackfillLimit} comment fetches run in parallel while you browse; a new batch starts about once per minute while Online. Showing up to 20 next items.`,
        items: commentBackfillItems, totalCount: commentBackfillRemaining },
      { key: 'channel-captures', label: 'Channel section captures', items: channelCaptures },
      { key: 'channel-metadata', label: 'Channel detail lookups', items: channelMetadata },
      { key: 'searches', label: 'YouTube search captures', items: searchSessions },
      { key: 'offline-preparation', label: 'Offline preparation', items: preparation }
    ].map(group => ({ ...group, count: group.totalCount ?? group.items.length }));
    sendJson(response, 200, {
      updatedAt: new Date().toISOString(), mode: reportedNetworkMode(),
      totalItems: groups.reduce((total, group) => total + group.count, 0), groups
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/search-sessions') {
    try {
      if (mediaDiscoveryPaused()) { const mode = reportedNetworkMode(); sendJson(response, 409, { error: mode === 'preparing' ? 'Search collection is paused while YourTube is switching to Offline.' : 'Search collection is unavailable in Offline mode.', mode }); return; }
      const parsed = await readBody(request);
      if (mediaDiscoveryPaused()) { const mode = reportedNetworkMode(); sendJson(response, 409, { error: mode === 'preparing' ? 'Search collection is paused while YourTube is switching to Offline.' : 'Search collection is unavailable in Offline mode.', mode }); return; }
      const searchId = String(parsed.searchId || '');
      const query = String(parsed.query || '').trim().slice(0, 200);
      if (!/^[a-f0-9-]{36}$/i.test(searchId) || !query) { sendJson(response, 400, { error: 'A search id and query are required.' }); return; }
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO search_sessions (search_id, query, status, updated_at) VALUES (?, ?, 'collecting', ?)
        ON CONFLICT(search_id) DO UPDATE SET query = excluded.query, status = 'collecting', updated_at = excluded.updated_at`).run(searchId, query, now);
      database.prepare('DELETE FROM search_results WHERE search_id = ?').run(searchId);
      sendJson(response, 201, { searchId, query, status: 'collecting' });
    } catch { sendJson(response, 400, { error: 'Request body must be valid JSON.' }); }
    return;
  }

  const searchSessionMatch = /^\/api\/search-sessions\/([a-f0-9-]{36})$/i.exec(url.pathname);
  if (request.method === 'GET' && searchSessionMatch) {
    const session = database.prepare('SELECT search_id AS searchId, query, status, updated_at AS updatedAt FROM search_sessions WHERE search_id = ?').get(searchSessionMatch[1]);
    if (!session) { sendJson(response, 404, { error: 'Search session not found.' }); return; }
    if (session.status === 'collecting' && Date.now() - Date.parse(session.updatedAt) > backgroundCaptureStaleMs) {
      session.status = 'stale';
      session.message = 'No new results arrived for five minutes. Existing captured results are still available.';
    } else if (session.status === 'stale') session.message = 'No new results arrived for five minutes. Existing captured results are still available.';
    const videos = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind, v.section, v.topic,
        v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge, sr.position, d.acquired_at AS acquiredAt,
        CASE WHEN d.video_id IS NULL THEN 0 ELSE 1 END AS downloaded, COALESCE(w.view_count, 0) AS viewCount
      FROM search_results sr JOIN videos v ON v.video_id = sr.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE sr.search_id = ? ORDER BY sr.position ASC
    `).all(searchSessionMatch[1]);
    sendJson(response, 200, { ...session, videos });
    return;
  }

  if (request.method === 'POST' && searchSessionMatch) {
    if (String(request.headers.origin || '') !== `http://${request.headers.host || ''}`) { sendJson(response, 403, { error: 'Search display acknowledgement must come from YourTube.' }); return; }
    const result = database.prepare("UPDATE search_sessions SET status = 'displayed', updated_at = ? WHERE search_id = ? AND status = 'ready'").run(new Date().toISOString(), searchSessionMatch[1]);
    sendJson(response, result.changes ? 200 : 409, { status: result.changes ? 'displayed' : 'not-ready' });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/search-sync' && extensionOrigin) {
    try {
      const parsed = await readBody(request);
      if (mediaDiscoveryPaused()) { const mode = reportedNetworkMode(); sendJson(response, 409, { error: mode === 'preparing' ? 'New media discovery is paused while YourTube is switching to Offline.' : 'YourTube is offline.', mode }); return; }
      const searchId = String(parsed.searchId || '');
      const query = String(parsed.query || '').trim().slice(0, 200);
      const session = /^[a-f0-9-]{36}$/i.test(searchId)
        ? database.prepare('SELECT query, status FROM search_sessions WHERE search_id = ?').get(searchId)
        : null;
      if (!session || query !== session.query || session.status === 'displayed') { sendJson(response, 404, { error: 'Search session is missing or no longer active.' }); return; }
      const incomingVideos = Array.isArray(parsed.videos) ? parsed.videos.slice(0, 500) : [];
      const now = new Date().toISOString();
      let acceptedVideos = 0;
      database.exec('BEGIN IMMEDIATE');
      try {
        incomingVideos.forEach((raw, position) => {
          const video = cleanVideo({ ...raw, section: 'search', topic: '', topicQuery: query }, position);
          if (!video) return;
          recordExtensionDuration(parsed.extensionVersion, video, 'search', now);
          database.prepare(`INSERT INTO videos (video_id, url, title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, kind, section, topic, position, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'search', ?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET url = excluded.url, title = excluded.title, channel = excluded.channel,
              channel_key = CASE WHEN excluded.channel_key <> '' THEN excluded.channel_key ELSE videos.channel_key END,
              channel_url = CASE WHEN excluded.channel_url <> '' THEN excluded.channel_url ELSE videos.channel_url END,
              thumbnail = CASE WHEN EXISTS (SELECT 1 FROM video_thumbnail_assets WHERE video_id = videos.video_id)
                THEN videos.thumbnail ELSE excluded.thumbnail END,
              avatar = excluded.avatar,
              duration = CASE WHEN trim(excluded.duration) <> '' THEN excluded.duration ELSE videos.duration END,
              meta = excluded.meta, topic = CASE WHEN trim(excluded.topic) <> '' THEN excluded.topic ELSE videos.topic END,
              last_seen = excluded.last_seen`)
            .run(video.id, video.url, video.title, video.channel, video.channelKey, video.channelUrl, video.thumbnail, video.avatar, video.duration, video.meta, video.kind, video.topic, video.position, now, now);
          if (video.kind === 'short') {
            database.prepare("UPDATE videos SET kind = 'short' WHERE video_id = ?").run(video.id);
            isolateShortFromStandardFlows(video.id);
          }
          saveVideoPublication(video.id, video);
          database.prepare(`INSERT INTO search_results (search_id, video_id, position) VALUES (?, ?, ?)
            ON CONFLICT(search_id, video_id) DO UPDATE SET position = excluded.position`).run(searchId, video.id, video.position);
          database.prepare(`INSERT INTO video_provisions (video_id, category, first_seen, last_seen) VALUES (?, 'search', ?, ?)
            ON CONFLICT(video_id, category) DO UPDATE SET last_seen = excluded.last_seen`).run(video.id, now, now);
          recordVideoProvenance(video.id, raw.provenance, now, {
            sourceType: 'search', sourceKey: searchId, sourceLabel: `YouTube search · ${query}`,
            sourceUrl: 'https://www.youtube.com/results'
          });
          acceptedVideos += 1;
        });
        // A user may open a result while the YouTube tab is still collecting.
        // Keep that search's recommendation candidates growing as new stubs arrive.
        const historyExists = database.prepare('SELECT 1 FROM search_history WHERE search_id = ?').get(searchId);
        if (historyExists) {
          const nextPosition = database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM search_history_results WHERE search_id = ?').get(searchId).position;
          const addHistoryResult = database.prepare(`INSERT OR IGNORE INTO search_history_results (search_id, video_id, position) VALUES (?, ?, ?)`);
          const historyCount = database.prepare('SELECT COUNT(*) AS count FROM search_history_results WHERE search_id = ?').get(searchId).count;
          const newSearchResults = database.prepare('SELECT video_id FROM search_results WHERE search_id = ? ORDER BY position').all(searchId);
          let position = Math.max(nextPosition, historyCount);
          for (const item of newSearchResults) {
            if (addHistoryResult.run(searchId, item.video_id, position).changes) position += 1;
          }
        }
        if (parsed.complete === true) database.prepare("UPDATE search_sessions SET status = 'ready', updated_at = ? WHERE search_id = ?").run(now, searchId);
        else database.prepare("UPDATE search_sessions SET status = 'collecting', updated_at = ? WHERE search_id = ? AND status IN ('collecting', 'stale')").run(now, searchId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      scheduleBackgroundDurationLookup();
      sendJson(response, 200, { acceptedVideos, status: parsed.complete === true ? 'ready' : 'collecting', mode: reportedNetworkMode() });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Search results could not be saved.' });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/channel-sync' && extensionOrigin) {
    try {
      const parsed = await readBody(request);
      if (mediaDiscoveryPaused()) { const mode = reportedNetworkMode(); sendJson(response, 409, { error: mode === 'preparing' ? 'New media discovery is paused while YourTube is switching to Offline.' : 'YourTube is offline.', mode }); return; }
      const captureId = String(parsed.captureId || '');
      const session = /^[a-f0-9-]{36}$/i.test(captureId)
        ? database.prepare('SELECT channel_key AS channelKey, tab_key AS tab, created_at AS createdAt FROM channel_captures WHERE capture_id = ?').get(captureId)
        : null;
      const channelKey = cleanChannelKey(parsed.channel?.key || parsed.channelKey);
      if (!session || channelKey !== session.channelKey || (parsed.tab && parsed.tab !== session.tab)) {
        sendJson(response, 404, { error: 'Channel capture is missing or no longer active.' }); return;
      }
      const now = new Date().toISOString();
      const channel = parsed.channel && typeof parsed.channel === 'object' ? parsed.channel : {};
      const name = cleanChannelName(channel.name);
      const description = String(channel.description || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      const avatar = safeImage(channel.avatar);
      const banner = safeImage(channel.banner);
      const subscriberCount = cleanRepeatedLabel(channel.subscriberCount).slice(0, 80);
      const videoCount = cleanRepeatedLabel(channel.videoCount).slice(0, 80);
      const channelUrl = `https://www.youtube.com/${channelKey}`;
      const channelOwnsVideoTab = ['videos', 'shorts', 'streams'].includes(session.tab);
      const incomingVideos = Array.isArray(parsed.videos) ? parsed.videos.slice(0, 500) : [];
      let acceptedVideos = 0;
      let phase = '';
      let captureStatus = '';
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO channels (channel_key, channel_url, name, description, avatar, banner, subscriber_count, video_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(channel_key) DO UPDATE SET channel_url = excluded.channel_url,
            name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE channels.name END,
            description = CASE WHEN excluded.description <> '' THEN excluded.description ELSE channels.description END,
            avatar = CASE WHEN excluded.avatar <> '' THEN excluded.avatar ELSE channels.avatar END,
            banner = CASE WHEN excluded.banner <> '' THEN excluded.banner ELSE channels.banner END,
            subscriber_count = CASE WHEN excluded.subscriber_count <> '' THEN excluded.subscriber_count ELSE channels.subscriber_count END,
            video_count = CASE WHEN excluded.video_count <> '' THEN excluded.video_count ELSE channels.video_count END,
            updated_at = excluded.updated_at`)
          .run(channelKey, channelUrl, name, description, avatar, banner, subscriberCount, videoCount, now, now);
        const upsertChannelVideo = database.prepare(`INSERT INTO videos
          (video_id, url, title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, kind, section, topic, position, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'channel', '', ?, ?, ?)
          ON CONFLICT(video_id) DO UPDATE SET title = excluded.title,
            channel = CASE WHEN trim(excluded.channel) <> '' THEN excluded.channel
              WHEN lower(trim(videos.channel)) IN ('youtube', 'channel unavailable') THEN '' ELSE videos.channel END,
            channel_key = CASE WHEN excluded.channel_key <> '' THEN excluded.channel_key ELSE videos.channel_key END,
            channel_url = CASE WHEN excluded.channel_url <> '' THEN excluded.channel_url ELSE videos.channel_url END,
            section = CASE WHEN videos.section = 'channel' THEN excluded.section ELSE videos.section END,
            thumbnail = CASE WHEN EXISTS (SELECT 1 FROM video_thumbnail_assets WHERE video_id = videos.video_id)
              THEN videos.thumbnail WHEN excluded.thumbnail <> '' THEN excluded.thumbnail ELSE videos.thumbnail END,
            avatar = CASE WHEN excluded.avatar <> '' THEN excluded.avatar ELSE videos.avatar END,
            duration = CASE WHEN trim(excluded.duration) <> '' AND
              (trim(videos.duration) = '' OR upper(trim(videos.duration)) IN ('LIVE', 'UPCOMING') OR upper(trim(excluded.duration)) NOT IN ('LIVE', 'UPCOMING'))
              THEN excluded.duration ELSE videos.duration END,
            meta = CASE WHEN excluded.meta <> '' THEN excluded.meta ELSE videos.meta END,
            last_seen = videos.last_seen`);
        const saveItem = database.prepare(`INSERT INTO channel_items (channel_key, video_id, tab_key, position, added_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_key, video_id, tab_key) DO UPDATE SET position = excluded.position, added_at = excluded.added_at`);
        incomingVideos.forEach((raw, position) => {
          const channelName = cleanChannelName(raw.channel) || (channelOwnsVideoTab ? name : '');
          const video = cleanVideo({
            ...raw,
            channel: channelName,
            channelKey: raw.channelKey || (channelOwnsVideoTab ? channelKey : ''),
            channelUrl: raw.channelUrl || (channelOwnsVideoTab ? channelUrl : '')
          }, position);
          if (!video) return;
          recordExtensionDuration(parsed.extensionVersion, video, 'channel', now);
          upsertChannelVideo.run(video.id, video.url, video.title, video.channel, video.channelKey, video.channelUrl,
            video.thumbnail, video.avatar || avatar, video.duration, video.meta, video.kind, video.position, now, now);
          if (video.kind === 'short') {
            database.prepare("UPDATE videos SET kind = 'short' WHERE video_id = ?").run(video.id);
            isolateShortFromStandardFlows(video.id);
          }
          saveVideoPublication(video.id, video);
          saveItem.run(channelKey, video.id, session.tab, video.position, now);
          const channelTabLabel = ({ home: 'Home', videos: 'Videos', shorts: 'Shorts', streams: 'Live', playlists: 'Playlists', community: 'Community' })[session.tab] || 'Videos';
          recordVideoProvenance(video.id, raw.provenance, now, {
            sourceType: 'channel', sourceKey: `${channelKey}:${session.tab}`,
            sourceLabel: `Channel · ${name || channelKey} · ${channelTabLabel}`, sourceUrl: channelUrl
          });
          const savedDuration = database.prepare('SELECT duration FROM videos WHERE video_id = ?').get(video.id)?.duration || '';
          if (/^UPCOMING$/i.test(String(savedDuration).trim())) {
            const retryAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
            setDurationLookup(video.id, 'upcoming', 'YouTube marks this video as Upcoming. Its length will be checked again after the scheduled start.', retryAt);
          } else if (savedDuration) {
            setDurationLookup(video.id, 'ready', 'Video length captured from the channel page.');
            database.prepare('UPDATE video_duration_lookups SET extension_attempts = 0 WHERE video_id = ?').run(video.id);
          } else {
            queueExtensionMetadataCapture(video.id, 'Channel capture did not include a video length.');
          }
          acceptedVideos += 1;
        });
        if (name && channelOwnsVideoTab) {
          database.prepare(`UPDATE videos SET channel = ?
            WHERE (channel_key = ? OR video_id IN (
              SELECT video_id FROM channel_items WHERE channel_key = ? AND tab_key IN ('videos', 'shorts', 'streams')
            )) AND (trim(channel) = '' OR lower(trim(channel)) IN ('youtube', 'channel unavailable'))`)
            .run(name, channelKey, channelKey);
        }
        const complete = parsed.complete === true;
        const finalFailure = parsed.final === true && !complete;
        const capturedVideoCount = database.prepare('SELECT COUNT(*) AS count FROM channel_items WHERE channel_key = ? AND tab_key = ?').get(channelKey, session.tab).count;
        phase = complete ? 'complete' : finalFailure ? 'incomplete' : parsed.phase === 'priority' ? 'priority' : 'background';
        const captureMessage = String(parsed.message || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
        captureStatus = finalFailure ? 'error' : complete ? 'complete' : 'collecting';
        database.prepare(`UPDATE channel_captures SET
          status = CASE WHEN status = 'complete' THEN 'complete' ELSE ? END,
          phase = CASE WHEN status = 'complete' THEN 'complete' ELSE ? END,
          video_count = ?, message = CASE WHEN status = 'complete' THEN message ELSE ? END,
          updated_at = ? WHERE capture_id = ?`)
          .run(captureStatus, phase, capturedVideoCount, finalFailure ? captureMessage : '', now, captureId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      scheduleBackgroundDurationLookup();
      sendJson(response, 200, { captureId, channelKey, acceptedVideos, phase, status: captureStatus, mode: reportedNetworkMode() });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      const invalidPayload = error instanceof SyntaxError;
      if (!tooLarge && !invalidPayload) console.error('[channel-sync] Could not persist captured channel data:', error);
      sendJson(response, tooLarge ? 413 : invalidPayload ? 400 : 500, { error: tooLarge ? 'Request too large' : invalidPayload ? 'Invalid channel data payload.' : 'Channel data could not be saved; retry the capture.' });
    }
    return;
  }

  const recommendationsMatch = /^\/api\/videos\/([A-Za-z0-9_-]{11})\/recommendations$/.exec(url.pathname);
  if (request.method === 'GET' && recommendationsMatch) {
    const current = database.prepare('SELECT topic FROM videos WHERE video_id = ?').get(recommendationsMatch[1]);
    if (!current) { sendJson(response, 404, { error: 'Video is not in the local feed.' }); return; }
    let downloadedUnwatched = database.prepare(`
      SELECT v.video_id AS id, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.duration, v.kind, v.topic,
        v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge,
        d.acquired_at AS acquiredAt, d.expires_at AS expiresAt, COALESCE(p.current_time, 0) AS currentTime,
        COALESCE(p.duration, 0) AS progressDuration, COALESCE(p.completed, 0) AS completed,
        1 AS downloaded, COALESCE(w.view_count, 0) AS viewCount
      FROM videos v JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE v.video_id <> ? AND v.kind <> 'short' AND COALESCE(p.completed, 0) = 0
        AND (COALESCE(p.duration, 0) <= 0 OR p.current_time < p.duration * 0.95)
      ORDER BY d.acquired_at DESC LIMIT 12
    `).all(recommendationsMatch[1]);
    const deletingSoon = autoDeleteEnabled ? database.prepare(`
      SELECT v.video_id AS id, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.duration, v.kind, v.topic,
        v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge,
        d.expires_at AS expiresAt, d.acquired_at AS acquiredAt,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.duration, 0) AS progressDuration,
        COALESCE(p.completed, 0) AS completed, 1 AS downloaded, COALESCE(w.view_count, 0) AS viewCount
      FROM videos v JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE v.video_id <> ? AND v.kind <> 'short' AND d.expires_at > ? AND d.expires_at <= ?
      ORDER BY d.expires_at ASC LIMIT 12
    `).all(recommendationsMatch[1], new Date().toISOString(), new Date(Date.now() + 60 * 60 * 1000).toISOString()) : [];
    const deletingSoonIds = new Set(deletingSoon.map(video => video.id));
    downloadedUnwatched = downloadedUnwatched.filter(video => !deletingSoonIds.has(video.id));
    const selectedIds = new Set([...downloadedUnwatched, ...deletingSoon].map(video => video.id));
    const recentSearches = database.prepare('SELECT search_id AS searchId, query, selected_video_id AS selectedVideoId FROM search_history ORDER BY searched_at DESC LIMIT 100').all();
    const searchCandidates = database.prepare(`
      SELECT v.video_id AS id, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.duration, v.kind, v.topic,
        v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge,
        COALESCE(d.status, '') = 'ready' AS downloaded,
        CASE WHEN d.status = 'ready' THEN d.acquired_at ELSE v.last_seen END AS acquiredAt,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.duration, 0) AS progressDuration,
        COALESCE(p.completed, 0) AS completed, COALESCE(w.view_count, 0) AS viewCount
      FROM search_history_results sr JOIN videos v ON v.video_id = sr.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE sr.search_id = ? AND v.video_id <> ? AND v.kind <> 'short'
        AND COALESCE(p.current_time, 0) <= 0 AND COALESCE(p.completed, 0) = 0
        AND COALESCE(w.view_count, 0) = 0
        AND NOT EXISTS (SELECT 1 FROM search_history clicked WHERE clicked.selected_video_id = v.video_id)
        AND NOT EXISTS (SELECT 1 FROM search_history_clicks clicked WHERE clicked.video_id = v.video_id)
      ORDER BY sr.position ASC LIMIT 100
    `);
    const searchRecommendations = [];
    for (const search of recentSearches) {
      const candidate = searchCandidates.all(search.searchId, search.selectedVideoId || '').find(video => !selectedIds.has(video.id));
      if (candidate) {
        candidate.searchQuery = search.query;
        candidate.searchId = search.searchId;
        searchRecommendations.push(candidate);
        selectedIds.add(candidate.id);
      }
      if (searchRecommendations.length >= 12) break;
    }
    const homepageStubs = database.prepare(`
      SELECT v.video_id AS id, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.duration, v.kind, v.topic,
        v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge,
        CASE WHEN d.status = 'ready' THEN d.acquired_at ELSE v.last_seen END AS acquiredAt,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.duration, 0) AS progressDuration,
        COALESCE(p.completed, 0) AS completed,
        CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded, COALESCE(w.view_count, 0) AS viewCount
      FROM videos v JOIN video_provisions vp ON vp.video_id = v.video_id AND vp.category = 'homepage'
      LEFT JOIN downloads d ON d.video_id = v.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE v.video_id <> ? AND v.kind <> 'short' AND COALESCE(d.status, '') <> 'ready'
      ORDER BY v.last_seen DESC, v.position ASC, v.first_seen DESC LIMIT 48
    `).all(recommendationsMatch[1]).filter(video => !selectedIds.has(video.id));
    sendJson(response, 200, { downloadedUnwatched, deletingSoon, autoDeleteEnabled, searchRecommendations: mediaDiscoveryPaused() ? [] : searchRecommendations, homepageStubs: mediaDiscoveryPaused() ? [] : homepageStubs });
    return;
  }

  const commentsMatch = /^\/api\/videos\/([A-Za-z0-9_-]{11})\/comments$/.exec(url.pathname);
  if (request.method === 'GET' && commentsMatch) {
    const id = commentsMatch[1];
    const video = database.prepare('SELECT video_id FROM videos WHERE video_id = ?').get(id);
    if (!video) { sendJson(response, 404, { error: 'Video is not in the local feed.' }); return; }
    const cached = getComments(id);
    if (networkMode === 'offline' && (!cached || cached.status === 'error')) {
      sendJson(response, 200, { status: 'unavailable', comments: [], message: cached?.message || 'Comments were not cached before Offline mode was enabled.' });
      return;
    }
    if (cached && cached.status !== 'error') {
      if (networkMode !== 'offline' && commentsNeedThreadRefresh(cached) && !commentJobs.has(id)) {
        beginComments(id, { preserveExisting: true, refreshThreadStructure: true });
      }
      if (!cached.channel && networkMode !== 'offline') beginChannelLookup(id);
      sendJson(response, 200, getComments(id) || cached);
      return;
    }
    beginComments(id);
    sendJson(response, 200, getComments(id) || { status: 'loading', comments: [], message: 'Loading comments…' });
    return;
  }

  const videoMatch = /^\/api\/videos\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
  if (request.method === 'POST' && url.pathname === '/api/videos/resolve') {
    try {
      const body = await readBody(request);
      const id = String(body.videoId || '').trim();
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
        sendJson(response, 400, { error: 'Enter a valid 11-character YouTube video ID.' });
        return;
      }
      const existing = database.prepare(`SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey,
          v.channel_url AS channelUrl, v.thumbnail, ${channelAvatarSelect('v')} AS avatar, v.duration,
          COALESCE(w.view_count, 0) AS viewCount, COALESCE(pref.liked, 0) AS liked
        FROM videos v LEFT JOIN video_views w ON w.video_id = v.video_id
        LEFT JOIN video_preferences pref ON pref.video_id = v.video_id WHERE v.video_id = ?`).get(id);
      if (existing) {
        sendJson(response, 200, existing);
        return;
      }
      if (isAcquisitionExcluded(id)) {
        sendJson(response, 409, { error: 'This video is excluded from YourTube acquisition.' });
        return;
      }
      if (mediaDiscoveryPaused()) {
        sendJson(response, 409, { error: 'Go Online to add a new video ID to YourTube.' , mode: reportedNetworkMode() });
        return;
      }

      const now = new Date().toISOString();
      database.prepare(`INSERT OR IGNORE INTO videos
        (video_id, url, title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, kind, section, topic, position, first_seen, last_seen)
        VALUES (?, ?, ?, '', '', '', ?, '', '', 'Added from a direct YouTube video ID.', 'normal', 'search', '', 0, ?, ?)`)
        .run(id, `https://www.youtube.com/watch?v=${id}`, id, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, now, now);
      database.prepare(`INSERT INTO video_provisions (video_id, category, first_seen, last_seen) VALUES (?, 'direct', ?, ?)
        ON CONFLICT(video_id, category) DO UPDATE SET last_seen = excluded.last_seen`).run(id, now, now);
      recordVideoProvenance(id, null, now, { sourceType: 'direct-id', sourceKey: id, sourceLabel: 'Direct video ID' });
      const video = database.prepare(`SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey,
          v.channel_url AS channelUrl, v.thumbnail, ${channelAvatarSelect('v')} AS avatar, v.duration,
          COALESCE(w.view_count, 0) AS viewCount, COALESCE(pref.liked, 0) AS liked
        FROM videos v LEFT JOIN video_views w ON w.video_id = v.video_id
        LEFT JOIN video_preferences pref ON pref.video_id = v.video_id WHERE v.video_id = ?`).get(id);
      sendJson(response, 201, video);
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'The YouTube video ID could not be added.' });
    }
    return;
  }

  if (request.method === 'GET' && videoMatch) {
    const video = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl,
        v.thumbnail, ${channelAvatarSelect('v')} AS avatar, v.duration, v.kind, COALESCE(w.view_count, 0) AS viewCount,
        COALESCE(pref.liked, 0) AS liked
      FROM videos v LEFT JOIN video_views w ON w.video_id = v.video_id
      LEFT JOIN video_preferences pref ON pref.video_id = v.video_id WHERE v.video_id = ?
    `).get(videoMatch[1]);
    sendJson(response, video ? 200 : 404, video ? localizeCachedImages(video) : { error: 'Video is not in the local feed.' });
    return;
  }

  const progressMatch = /^\/api\/progress\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
  if (progressMatch && request.method === 'GET') {
    const row = database.prepare(`
      SELECT progress.current_time AS currentTime, progress.duration AS duration, progress.completed AS completed,
        progress.updated_at AS updatedAt
      FROM video_progress AS progress WHERE progress.video_id = ?
    `).get(progressMatch[1]);
    sendJson(response, 200, row || { currentTime: 0, duration: 0, updatedAt: null });
    return;
  }
  if (progressMatch && request.method === 'POST') {
    const exists = database.prepare('SELECT 1 AS found FROM videos WHERE video_id = ?').get(progressMatch[1]);
    if (!exists) { sendJson(response, 404, { error: 'Video is not in the local feed.' }); return; }
    try {
      const payload = await readBody(request);
      const currentTime = Number(payload.currentTime);
      const duration = Number(payload.duration);
      const completed = payload.completed === true;
      if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || currentTime < 0 || duration < 0) {
        sendJson(response, 400, { error: 'Playback progress must be non-negative numbers.' });
        return;
      }
      const now = new Date().toISOString();
      const videoId = progressMatch[1];
      database.prepare(`
        INSERT INTO video_progress (video_id, current_time, duration, completed, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET current_time = excluded.current_time,
          duration = excluded.duration, completed = excluded.completed, updated_at = excluded.updated_at
      `).run(videoId, completed ? 0 : Math.min(currentTime, duration || currentTime), duration, completed ? 1 : 0, now);
      const storedDuration = database.prepare('SELECT duration FROM videos WHERE video_id = ?').get(videoId)?.duration;
      const playbackDuration = formatDurationSeconds(duration);
      if (!String(storedDuration || '').trim() && playbackDuration) {
        saveDurationLabel(videoId, playbackDuration);
        setDurationLookup(videoId, 'ready', 'Duration recorded from local playback metadata.');
      }
      if (payload.playing === true) scheduleBackgroundDurationLookup(videoId);
      sendJson(response, 200, { currentTime: completed ? 0 : currentTime, duration, completed, updatedAt: now });
    } catch {
      sendJson(response, 400, { error: 'Playback progress must be valid JSON.' });
    }
    return;
  }

  const viewMatch = /^\/api\/views\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
  if (request.method === 'POST' && viewMatch) {
    const id = viewMatch[1];
    const exists = database.prepare('SELECT kind FROM videos WHERE video_id = ?').get(id);
    if (!exists) { sendJson(response, 404, { error: 'Video is not in the local feed.' }); return; }
    database.prepare(`
      INSERT INTO video_views (video_id, view_count, updated_at) VALUES (?, 1, ?)
      ON CONFLICT(video_id) DO UPDATE SET view_count = video_views.view_count + 1, updated_at = excluded.updated_at
    `).run(id, new Date().toISOString());
    const result = database.prepare('SELECT view_count AS viewCount FROM video_views WHERE video_id = ?').get(id);
    if (exists.kind === 'short') {
      shortsApiCache = null;
      shortsApiCacheExpiresAt = 0;
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method === 'DELETE' && url.pathname === '/api/downloads/paused') {
    const paused = database.prepare("SELECT video_id AS id FROM download_retry_queue WHERE status IN ('paused', 'paused-offline', 'paused-limit')").all();
    let deleted = 0;
    let skipped = 0;
    for (const { id } of paused) {
      if (jobs.has(id)) { skipped += 1; continue; }
      const mediaExists = Boolean(getStoredMediaPath(id));
      if (mediaExists) {
        try { await verifyLocalMediaIntegrity(id); }
        catch (error) {
          await recordMediaIntegrityFailure(id, error);
          skipped += 1;
          continue;
        }
        saveDownload(id, 'ready', '', 100, 'Ready to play');
        database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
        database.prepare('DELETE FROM playlist_download_queue WHERE video_id = ?').run(id);
        deleted += 1;
        continue;
      }
      await discardDownloadFiles(id);
      database.prepare("DELETE FROM downloads WHERE video_id = ? AND status IN ('paused', 'paused-offline')").run(id);
      database.prepare("DELETE FROM download_retry_queue WHERE video_id = ? AND status IN ('paused', 'paused-offline', 'paused-limit')").run(id);
      database.prepare('DELETE FROM playlist_download_queue WHERE video_id = ?').run(id);
      deleted += 1;
    }
    sendJson(response, 200, { deleted, skipped });
    return;
  }

  const postponeMatch = /^\/api\/downloads\/([A-Za-z0-9_-]{11})\/postpone$/.exec(url.pathname);
  if (request.method === 'POST' && postponeMatch) {
    const id = postponeMatch[1];
    if (!autoDeleteEnabled) { sendJson(response, 409, { error: 'Auto-delete must be enabled to postpone deletion.' }); return; }
    const download = database.prepare("SELECT status, expires_at AS expiresAt FROM downloads WHERE video_id = ?").get(id);
    if (!download || download.status !== 'ready') { sendJson(response, 404, { error: 'This video is not in your downloaded library.' }); return; }
    const expiresAtMs = Date.parse(download.expiresAt);
    const remainingMs = expiresAtMs - Date.now();
    if (!Number.isFinite(expiresAtMs) || remainingMs <= 0 || remainingMs > autoDeletePostponeWindowMs) {
      sendJson(response, 409, { error: 'Postpone is available during the final five minutes before deletion.' });
      return;
    }
    const postponedUntil = new Date(Date.now() + mediaLifetimeMs).toISOString();
    const result = database.prepare("UPDATE downloads SET expires_at = ?, expiry_paused_ms = NULL WHERE video_id = ? AND status = 'ready' AND expires_at = ?")
      .run(postponedUntil, id, download.expiresAt);
    if (!result.changes) { sendJson(response, 409, { error: 'The deletion timer changed. Refresh and try again.' }); return; }
    sendJson(response, 200, { postponed: true, expiresAt: postponedUntil });
    return;
  }

  const pauseMatch = /^\/api\/downloads\/([A-Za-z0-9_-]{11})\/pause$/.exec(url.pathname);
  if (request.method === 'POST' && pauseMatch) {
    const id = pauseMatch[1];
    const integrityJob = mediaFolderImportJobs.get(id);
    if (integrityJob) {
      if (!integrityJob.pauseRequested) {
        integrityJob.stage = 'Pausing integrity check…';
        pauseIntegrityJob(integrityJob);
        saveDownload(id, 'importing', 'Pausing the local media integrity check.', 0, integrityJob.stage);
      }
      sendJson(response, 202, { status: 'importing', stage: integrityJob.stage, pauseRequested: true });
      return;
    }
    const job = jobs.get(id);
    if (!job) {
      const download = database.prepare('SELECT status, origin FROM downloads WHERE video_id = ?').get(id);
      if (download?.status === 'importing' && getStoredMediaPath(id)) {
        const message = markMediaIntegrityPaused(id);
        sendJson(response, 202, { status: 'paused', stage: 'Integrity check paused', message, pauseRequested: false });
        return;
      }
      if (download?.origin === 'media-folder' && download.status === 'paused') {
        const message = markMediaIntegrityPaused(id);
        sendJson(response, 202, { status: 'paused', stage: 'Integrity check paused', message, pauseRequested: false });
        return;
      }
      if (download?.status === 'importing' && download?.origin === 'media-folder') {
        const message = 'The imported media file is no longer present in the configured media folder. Refresh the Downloads view after the folder is available.';
        database.prepare(`UPDATE downloads SET status = 'error', message = ?, progress = 0,
          stage = 'Local file missing', updated_at = ? WHERE video_id = ? AND status = 'importing'`)
          .run(message, new Date().toISOString(), id);
        sendJson(response, 202, { status: 'error', message });
        return;
      }
      sendJson(response, 409, { error: 'This item is not an active download or local integrity check.' });
      return;
    }
    if (job.pauseRequested || job.offlinePauseRequested || job.endRequested || job.finishRequested || job.discardRequested) {
      sendJson(response, 202, { status: 'downloading', stage: job.stage, pauseRequested: job.pauseRequested });
      return;
    }
    job.pauseRequested = true;
    job.stage = 'Pausing download…';
    saveDownload(id, 'downloading', '', job.progress, job.stage);
    try { job.process.kill('SIGINT'); }
    catch {
      job.pauseRequested = false;
      sendJson(response, 500, { error: 'Could not pause the download.' });
      return;
    }
    sendJson(response, 202, { status: 'downloading', stage: job.stage, pauseRequested: true });
    return;
  }

  const finishMatch = /^\/api\/downloads\/([A-Za-z0-9_-]{11})\/finish$/.exec(url.pathname);
  if (request.method === 'POST' && finishMatch) {
    const id = finishMatch[1];
    const job = jobs.get(id);
    if (!job) { sendJson(response, 404, { error: 'This download is no longer active.' }); return; }
    if (!finishWindowElapsed(job.startedAt)) {
      sendJson(response, 409, { error: 'Finish and save becomes available after this download has run for 20 minutes.' });
      return;
    }
    if (job.finishRequested || job.endRequested || job.discardRequested || job.pauseRequested || job.offlinePauseRequested) {
      sendJson(response, 202, { status: 'downloading', stage: job.stage, finishRequested: job.finishRequested || job.endRequested });
      return;
    }
    const previousStage = job.stage;
    job.finishRequested = true;
    job.finishPhase = 'stopping';
    job.stage = job.isLive ? 'Ending live capture and finalizing audio/video…' : 'Stopping video transfer to save the current footage…';
    saveDownload(id, 'downloading', '', job.progress, job.stage);
    try { job.process.kill('SIGINT'); }
    catch {
      job.finishRequested = false;
      job.finishPhase = '';
      job.stage = previousStage;
      saveDownload(id, 'downloading', '', job.progress, previousStage);
      sendJson(response, 500, { error: `Could not stop the ${job.isLive ? 'live capture' : 'video transfer'} to finish and save it.` });
      return;
    }
    sendJson(response, 202, { status: 'downloading', stage: job.stage, finishRequested: true });
    return;
  }

  const liveActionMatch = /^\/api\/downloads\/([A-Za-z0-9_-]{11})\/(end|discard)$/.exec(url.pathname);
  if (request.method === 'POST' && liveActionMatch) {
    const [, id, action] = liveActionMatch;
    const job = jobs.get(id);
    if (!job || !job.isLive) { sendJson(response, 409, { error: 'This video is not an active live capture.' }); return; }
    if (action === 'end' && !finishWindowElapsed(job.startedAt)) {
      sendJson(response, 409, { error: 'Finish and save becomes available after this download has run for 20 minutes.' });
      return;
    }
    if (job.endRequested || job.finishRequested || job.discardRequested || job.pauseRequested || job.offlinePauseRequested) { sendJson(response, 202, { status: 'downloading', stage: job.stage }); return; }
    if (action === 'end') {
      job.endRequested = true;
      job.stage = 'Finalizing and saving the local copy…';
      saveDownload(id, 'downloading', '', job.progress, job.stage);
    } else {
      job.discardRequested = true;
      job.stage = 'Stopping and discarding the live capture…';
      saveDownload(id, 'downloading', '', job.progress, job.stage);
    }
    try { job.process.kill('SIGINT'); }
    catch { sendJson(response, 500, { error: 'Could not stop the live capture.' }); return; }
    sendJson(response, 202, { status: 'downloading', stage: job.stage, action });
    return;
  }

  if (request.method === 'POST' && /^\/api\/downloads\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) {
    const id = url.pathname.split('/').at(-1);
    if (jobs.has(id)) { sendJson(response, 202, getDownload(id) || { status: 'downloading', message: '' }); return; }
    if (getStoredMediaPath(id)) {
      const previousDownload = database.prepare('SELECT status, origin FROM downloads WHERE video_id = ?').get(id);
      const previousStatus = previousDownload?.status;
      if (previousStatus !== 'ready' || !hasSavedIntegrityChecksum(id)) {
        const isMediaFolderCheck = previousDownload?.origin === 'media-folder';
        if (isMediaFolderCheck && mediaFolderImportJobs.has(id)) {
          sendJson(response, 202, getDownload(id) || { status: 'importing', message: 'Local integrity check is already running.' });
          return;
        }
        const integrityJob = isMediaFolderCheck ? createMediaFolderIntegrityJob() : null;
        if (integrityJob) {
          mediaFolderImports.add(id);
          mediaFolderImportJobs.set(id, integrityJob);
          saveDownload(id, 'importing', 'Checking a local media file before saving it to the library.', 0, integrityJob.stage);
        }
        try {
          await verifyLocalMediaIntegrity(id, integrityJob ? { downloadJob: integrityJob } : {});
          throwIfIntegrityPaused(integrityJob);
        }
        catch (error) {
          if (error.code === 'INTEGRITY_PAUSED') {
            const message = markMediaIntegrityPaused(id);
            sendJson(response, 202, getDownload(id) || { status: 'paused', message });
            return;
          }
          await recordMediaIntegrityFailure(id, error);
          sendJson(response, 202, getDownload(id) || { status: 'error', message: error.message });
          return;
        } finally {
          if (integrityJob) {
            mediaFolderImportJobs.delete(id);
            mediaFolderImports.delete(id);
            scheduleMediaFolderScan(500);
          }
        }
      }
      saveDownload(id, 'ready', '', 100, 'Ready to play');
      sendJson(response, 200, getDownload(id));
      return;
    }
    if (networkMode === 'offline' || offlinePreparationRequested) { sendJson(response, 409, { error: 'New downloads are unavailable while Offline mode is active or preparing.', mode: reportedNetworkMode() }); return; }
    const blockedUntil = Date.parse(getYoutubeDownloadCooldownUntil());
    if (areDownloadProtectionsActive() && Number.isFinite(blockedUntil) && blockedUntil > Date.now()) {
      sendJson(response, 429, { error: 'YouTube sign-in cooldown is active. Manual retries and new downloads are unavailable until it ends.', retryAt: new Date(blockedUntil).toISOString() });
      return;
    }
    const retry = database.prepare('SELECT status, next_retry_at FROM download_retry_queue WHERE video_id = ?').get(id);
    const explicitlyRetried = url.searchParams.get('retry') === '1';
    const explicitlyRetryable = retry && ['pending', 'paused', 'paused-offline', 'paused-limit', 'exhausted'].includes(retry.status);
    if (retry && ['pending', 'waiting-live', 'running', 'exhausted'].includes(retry.status) && !explicitlyRetried && !jobs.has(id)) {
      // A watch page refresh is a status check in practice. Do not let its
      // initial POST bypass the queued backoff or start a second attempt.
      const current = getDownload(id);
      sendJson(response, current?.status === 'downloading' ? 200 : 202, current || { status: 'error', retryStatus: retry.status, retryAt: retry.next_retry_at });
      return;
    }
    if (retry && ['paused', 'paused-offline', 'paused-limit'].includes(retry.status) && !explicitlyRetried) {
      const current = getDownload(id);
      sendJson(response, 202, current || { status: 'paused', retryStatus: retry.status, retryAt: retry.next_retry_at });
      return;
    }
    if (explicitlyRetryable && explicitlyRetried) {
      const retryNow = new Date().toISOString();
      database.prepare("UPDATE download_retry_queue SET attempts = 0, status = 'running', next_retry_at = ?, last_error = 'Manual retry requested.', updated_at = ? WHERE video_id = ?")
        .run(retryNow, retryNow, id);
      saveDownload(id, 'error', 'Manual retry requested.', 0, 'Retrying now');
    }
    if (explicitlyRetried && database.prepare('SELECT 1 FROM playlist_download_queue WHERE video_id = ?').get(id)) {
      const retryNow = new Date().toISOString();
      const message = 'Manual retry requested; keeping this item in its playlist download order.';
      database.prepare("UPDATE download_retry_queue SET attempts = 0, status = 'pending', next_retry_at = ?, last_error = ?, updated_at = ? WHERE video_id = ?")
        .run(retryNow, message, retryNow, id);
      saveDownload(id, 'error', message, 0, 'Queued in playlist order');
      await runDownloadRetries();
      sendJson(response, 202, getDownload(id) || { status: 'error', message });
      return;
    }
    if (areDownloadProtectionsActive() && jobs.size && !jobs.has(id)) {
      const now = new Date().toISOString();
      const message = 'Queued behind the current download to avoid simultaneous requests to YouTube.';
      database.prepare(`INSERT INTO download_retry_queue (video_id, attempts, status, next_retry_at, last_error, updated_at)
        VALUES (?, 0, 'pending', ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET
        status = 'pending', next_retry_at = excluded.next_retry_at, last_error = excluded.last_error, updated_at = excluded.updated_at`)
        .run(id, now, message, now);
      saveDownload(id, 'error', message, 0, 'Waiting in download queue');
      sendJson(response, 202, getDownload(id));
      return;
    }
    const result = await beginDownload(id);
    if (!result) { sendJson(response, 404, { error: 'Video is not in the local feed.' }); return; }
    sendJson(response, result.status === 'ready' ? 200 : 202, result);
    return;
  }

  const downloadStatusMatch = /^\/api\/downloads\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
  if (request.method === 'GET' && downloadStatusMatch) {
    const result = getDownload(downloadStatusMatch[1]);
    sendJson(response, result ? 200 : 404, result || { error: 'No download job found.' });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/downloads/delete-group') {
    try {
      const body = await readBody(request);
      const videoIds = [...new Set((Array.isArray(body.videoIds) ? body.videoIds : [])
        .map(value => String(value || '')).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)))].slice(0, 2000);
      let deleted = 0;
      for (const id of videoIds) {
        if (jobs.has(id) || downloadStartingIds.has(id) || mediaFolderImports.has(id) || mediaFolderImportJobs.has(id) || integrityVerificationJobs.has(id)) continue;
        const current = database.prepare("SELECT status FROM downloads WHERE video_id = ?").get(id);
        if (current?.status !== 'ready') continue;
        downloadStartingIds.add(id);
        try {
          await discardDownloadFiles(id);
          const result = database.prepare(`UPDATE downloads SET status = 'deleted', message = 'The local media copy was deleted; saved video metadata was retained.',
            progress = 0, stage = 'Deleted locally', updated_at = ? WHERE video_id = ? AND status = 'ready'`).run(new Date().toISOString(), id);
          if (result.changes) {
            database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
            deleted += 1;
          }
        } catch (error) {
          console.error(`Could not delete grouped local media ${id}:`, error);
        } finally {
          downloadStartingIds.delete(id);
        }
      }
      sendJson(response, 200, { deleted, requested: videoIds.length });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Grouped media could not be deleted.' });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/downloads/play-group') {
    try {
      const body = await readBody(request);
      const groupKey = String(body.groupKey || '').trim().slice(0, 240);
      const title = cleanRepeatedLabel(body.title).slice(0, 120);
      const requestedItems = Array.isArray(body.items) ? body.items.slice(0, 1000) : [];
      if (!groupKey || !title || !requestedItems.length) {
        sendJson(response, 400, { error: 'A downloaded group with playable videos is required.' }); return;
      }
      const seen = new Set();
      const items = [];
      for (const candidate of requestedItems) {
        const id = String(candidate?.videoId || '');
        if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        const video = database.prepare(`SELECT v.video_id AS id, v.kind, v.thumbnail
          FROM videos v JOIN downloads d ON d.video_id = v.video_id
          WHERE v.video_id = ? AND d.status = 'ready'`).get(id);
        if (!video || video.kind === 'short' || !getStoredMediaPath(id)) continue;
        items.push(video);
      }
      if (!items.length) { sendJson(response, 409, { error: 'This group has no locally playable videos.' }); return; }

      const playlistId = `download-group-${createHash('sha256').update(groupKey).digest('hex').slice(0, 40)}`;
      const now = new Date().toISOString();
      const insertPlaylistItem = database.prepare(`INSERT INTO playlist_items (playlist_id, video_id, position, source_key, added_at)
        VALUES (?, ?, ?, ?, ?)`);
      const insertQueueItem = database.prepare(`INSERT INTO playback_queue
        (video_id, position, added_at, source_playlist_id, source_playlist_position) VALUES (?, ?, ?, ?, ?)`);
      const resultItems = [];
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO playlists (playlist_id, title, source, kind, thumbnail, declared_item_count, is_complete, created_at, updated_at)
          VALUES (?, ?, 'local', 'download-group', ?, ?, 1, ?, ?)
          ON CONFLICT(playlist_id) DO UPDATE SET title = excluded.title, thumbnail = excluded.thumbnail,
            declared_item_count = excluded.declared_item_count, is_complete = 1, updated_at = excluded.updated_at`)
          .run(playlistId, title, items[0].thumbnail || '', items.length, now, now);
        database.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlistId);
        database.exec('DELETE FROM playback_queue');
        items.forEach((item, position) => {
          insertPlaylistItem.run(playlistId, item.id, position, `download-group:${item.id}`, now);
          const queued = insertQueueItem.run(item.id, position, now, playlistId, position);
          resultItems.push({ id: item.id, queueItemId: Number(queued.lastInsertRowid), position });
        });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      sendJson(response, 200, { playlistId, title, queued: resultItems.length, items: resultItems });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'This downloaded group could not be opened for playback.' });
    }
    return;
  }

  const downloadDeleteMatch = /^\/api\/downloads\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
  if (request.method === 'DELETE' && downloadDeleteMatch) {
    const id = downloadDeleteMatch[1];
    if (jobs.has(id)) { sendJson(response, 409, { error: 'This video is still downloading.' }); return; }
    const download = database.prepare("SELECT status FROM downloads WHERE video_id = ?").get(id);
    if (!download || download.status !== 'ready') { sendJson(response, 404, { error: 'This video is not in your downloaded library.' }); return; }
    try {
      await discardDownloadFiles(id);
      database.prepare(`UPDATE downloads SET status = 'deleted', message = 'The local media copy was deleted; saved video metadata was retained.',
        progress = 0, stage = 'Deleted locally', updated_at = ? WHERE video_id = ? AND status = 'ready'`).run(new Date().toISOString(), id);
      database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
      sendJson(response, 200, { deleted: true, id, metadataRetained: true });
    } catch (error) {
      console.error(`Could not delete local media ${id}:`, error);
      sendJson(response, 500, { error: 'The local media file could not be deleted.' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/downloads/available') {
    const rows = database.prepare("SELECT video_id AS id FROM downloads WHERE status = 'ready'").all();
    const ids = rows.filter(row => Boolean(getStoredMediaPath(row.id))).map(row => row.id);
    sendJson(response, 200, { ids });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/downloads/recent') {
    const recentCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const recentKind = url.searchParams.get('kind');
    await reconcileRecentlyReacquiredMedia(recentCutoff);
    const recentRowsForKind = kind => {
      const kindClause = kind === 'shorts' ? "AND v.kind = 'short'" : kind === 'videos' ? "AND COALESCE(v.kind, '') <> 'short'" : '';
      return database.prepare(`
        SELECT v.video_id AS id, v.title, v.channel, v.thumbnail, v.avatar, v.duration, v.kind,
          d.acquired_at AS acquiredAt, COALESCE(w.view_count, 0) AS viewCount
        FROM downloads d JOIN videos v ON v.video_id = d.video_id
        LEFT JOIN video_views w ON w.video_id = v.video_id
        WHERE d.status = 'ready' AND d.acquired_at >= ? ${kindClause}
        ORDER BY d.acquired_at DESC, v.video_id
        LIMIT 12
      `).all(recentCutoff).filter(row => Boolean(getStoredMediaPath(row.id)));
    };
    if (recentKind === 'split') {
      sendJson(response, 200, {
        videos: localizeCachedImages(recentRowsForKind('videos')),
        shorts: localizeCachedImages(recentRowsForKind('shorts'))
      });
    } else {
      sendJson(response, 200, localizeCachedImages(recentRowsForKind(recentKind)));
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/downloads') {
    const includeFileStats = url.searchParams.get('includeFileStats') === '1';
    const sourceRows = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind, v.section, v.topic, v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge, d.acquired_at AS acquiredAt, d.expires_at AS expiresAt, 1 AS downloaded, COALESCE(w.view_count, 0) AS viewCount, COALESCE(pref.liked, 0) AS liked,
        COALESCE(CAST(json_extract(CASE WHEN json_valid(vm.metadata_json) THEN vm.metadata_json ELSE '{}' END, '$.like_count') AS INTEGER), CAST(json_extract(CASE WHEN json_valid(vm.metadata_json) THEN vm.metadata_json ELSE '{}' END, '$.publicMetrics.like_count') AS INTEGER), 0) AS likeCount,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.completed, 0) AS completed, d.integrity_status AS integrityStatus, d.integrity_checksum AS integrityChecksum, d.integrity_file_size AS fileSizeBytes,
        ta.status AS transcriptionStatus, ta.audio_relative_path AS transcriptionAudioPath,
        ta.audio_format AS transcriptionAudioFormat, ta.audio_sample_rate AS transcriptionAudioSampleRate,
        ta.audio_channels AS transcriptionAudioChannels, ta.audio_size AS transcriptionAudioSize,
        ta.audio_checksum AS transcriptionAudioChecksum, ta.source_checksum AS transcriptionSourceChecksum,
        ta.error AS transcriptionAudioError, m.status AS metadataStatus, m.phase AS metadataPhase, m.message AS metadataMessage
      FROM downloads d JOIN videos v ON v.video_id = d.video_id LEFT JOIN video_views w ON w.video_id = v.video_id
      LEFT JOIN video_preferences pref ON pref.video_id = v.video_id
      LEFT JOIN video_metadata vm ON vm.video_id = v.video_id
      LEFT JOIN download_metadata m ON m.video_id = d.video_id
      LEFT JOIN transcription_assets ta ON ta.video_id = d.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      WHERE d.status = 'ready' ORDER BY d.acquired_at DESC
    `).all();
    const rows = [];
    for (let offset = 0; offset < sourceRows.length; offset += 64) {
      const batch = await Promise.all(sourceRows.slice(offset, offset + 64).map(async row => {
        const mediaPath = getStoredMediaPath(row.id, row.kind);
        if (!mediaPath) {
          downloadedMediaFileSizeCache.delete(row.id);
          return null;
        }
        let fileSizeBytes = Math.max(0, Number(row.fileSizeBytes) || 0);
        if (includeFileStats && fileSizeBytes === 0) {
          const cached = downloadedMediaFileSizeCache.get(row.id);
          if (cached?.path === mediaPath && Date.now() - cached.checkedAt < downloadedMediaFileSizeCacheTtlMs) fileSizeBytes = cached.size;
          else {
            try {
              const mediaStat = await stat(mediaPath);
              fileSizeBytes = mediaStat.size;
              downloadedMediaFileSizeCache.set(row.id, { path: mediaPath, size: fileSizeBytes, checkedAt: Date.now() });
            } catch {}
          }
        }
        return { ...row, fileSizeBytes, mediaExtension: path.extname(mediaPath).slice(1).toLowerCase() };
      }));
      rows.push(...batch.filter(Boolean));
    }
    const topicsByVideo = new Map(rows.map(row => {
      const topic = normalizeTopicLabel(row.topic);
      return [row.id, new Set(topic ? [topic] : [])];
    }));
    const provisionsByVideo = new Map(rows.map(row => [row.id, new Set()]));
    for (let offset = 0; offset < rows.length; offset += 500) {
      const ids = rows.slice(offset, offset + 500).map(row => row.id);
      const placeholders = ids.map(() => '?').join(',');
      const capturedTopics = database.prepare(`
        SELECT id, topic FROM (
          SELECT hp.video_id AS id,
            CASE WHEN trim(hs.topic) <> '' THEN trim(hs.topic)
              WHEN hs.kind IN ('topic', 'feed') THEN trim(hs.title) ELSE '' END AS topic
          FROM homepage_placements hp
          JOIN homepage_sections hs ON hs.capture_id = hp.capture_id AND hs.section_key = hp.section_key
          WHERE hp.video_id IN (${placeholders})
            AND lower(trim(hs.title)) NOT IN ('for you', 'top news', 'shorts', 'explore more topics', 'watch again', 'continue watching', 'recommended for you', 'because you watched', 'recently uploaded', 'new to you', 'subscriptions', 'your videos', 'history')
          UNION ALL
          SELECT video_id AS id, trim(hc.title) AS topic
          FROM homepage_category_videos hcv
          JOIN homepage_categories hc ON hc.category_key = hcv.category_key
          WHERE hcv.video_id IN (${placeholders})
            AND lower(trim(hc.title)) NOT IN ('all', 'watched', 'recently uploaded')
        ) WHERE trim(topic) <> ''
      `).all(...ids, ...ids);
      for (const item of capturedTopics) {
        const topic = normalizeTopicLabel(item.topic);
        if (topic) topicsByVideo.get(item.id)?.add(topic);
      }
      const provenance = database.prepare(`SELECT video_id AS id, category FROM video_provisions WHERE video_id IN (${placeholders})`).all(...ids);
      for (const item of provenance) provisionsByVideo.get(item.id)?.add(item.category);
    }
    for (const row of rows) {
      row.topics = [...(topicsByVideo.get(row.id) || [])];
      row.sourceCategories = [...(provisionsByVideo.get(row.id) || [])];
    }
    sendJson(response, 200, localizeCachedImages(rows));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/media-folder/status') {
    sendJson(response, 200, mediaFolderStatus());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/history') {
    const rows = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind,
        v.published_at AS publishedAt, v.published_at_precision AS publishedAtPrecision, v.published_age AS publishedAge,
        w.view_count AS viewCount, w.updated_at AS lastViewedAt,
        CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded,
        d.acquired_at AS acquiredAt, d.expires_at AS expiresAt,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.duration, 0) AS progressDuration,
        COALESCE(p.completed, 0) AS completed
      FROM video_views w
      JOIN videos v ON v.video_id = w.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      WHERE w.view_count > 0
      ORDER BY w.updated_at DESC
      LIMIT 500
    `).all();
    sendJson(response, 200, rows);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/downloads/active') {
    const rows = database.prepare(`
      SELECT v.video_id AS id, v.title, v.channel, v.thumbnail, v.duration, d.status AS status,
        d.progress, d.updated_at AS updatedAt, d.started_at AS startedAt,
        CASE WHEN d.status = 'importing' THEN 'integrity'
          WHEN q.status IN ('paused-offline', 'paused-limit') THEN 'paused' ELSE q.status END AS retryStatus,
        CASE WHEN q.status = 'paused-offline' THEN 'Paused for Offline mode'
          WHEN q.status = 'paused-limit' THEN 'Paused during YouTube cooldown'
          ELSE d.stage END AS stage,
        d.message AS message, q.last_error AS retryError, q.attempts AS retryAttempts,
        q.next_retry_at AS retryAt
      FROM downloads d JOIN videos v ON v.video_id = d.video_id
      LEFT JOIN download_retry_queue q ON q.video_id = d.video_id
      WHERE d.status IN ('downloading', 'importing') OR q.status IN ('pending', 'waiting-live', 'paused', 'paused-offline', 'paused-limit')
      ORDER BY d.updated_at DESC
    `).all();
    const withLiveStats = await Promise.all(rows.map(async row => {
      const job = jobs.get(row.id) || mediaFolderImportJobs.get(row.id);
      return {
        ...row,
        youtubeCooldownUntil: getEnforcedYoutubeDownloadCooldownUntil(),
        isIntegrityImport: row.status === 'importing' || Boolean(job?.integrityQueued || job?.integrityChecking),
        isLive: Boolean(job?.isLive),
        integrityQueued: Boolean(job?.integrityQueued || row.status === 'importing' && !job),
        integrityChecking: Boolean(job?.integrityChecking),
        integrityProgress: Number.isFinite(job?.integrityProgress) ? job.integrityProgress : null,
        integrityPhase: job?.integrityPhase || '',
        finishAvailable: finishWindowElapsed(row.startedAt || job?.startedAt),
        pauseRequested: Boolean(job?.pauseRequested),
        finishRequested: Boolean(job?.finishRequested),
        endRequested: Boolean(job?.endRequested),
        discardRequested: Boolean(job?.discardRequested),
        fileBytes: await currentDownloadBytes(row.id)
      };
    }));
    sendJson(response, 200, withLiveStats);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/sync') {
    try {
      if (mediaDiscoveryPaused()) { const mode = reportedNetworkMode(); sendJson(response, 409, { error: mode === 'preparing' ? 'New media discovery is paused while YourTube is switching to Offline.' : 'YourTube is offline.', mode }); return; }
      const parsed = await readBody(request);
      if (mediaDiscoveryPaused()) { const mode = reportedNetworkMode(); sendJson(response, 409, { error: mode === 'preparing' ? 'New media discovery is paused while YourTube is switching to Offline.' : 'YourTube is offline.', mode }); return; }
      const incomingVideos = Array.isArray(parsed.videos) ? parsed.videos.slice(0, 500) : [];
      const incomingSubscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions.slice(0, 500) : [];
      const incomingPlaylists = Array.isArray(parsed.playlists) ? parsed.playlists.slice(0, 30) : [];
      const provisionCategory = parsed.provisionCategory === 'other' ? 'other' : 'homepage';
      const incomingHomepageCategories = provisionCategory === 'homepage' && Array.isArray(parsed.homepageCategories)
        ? parsed.homepageCategories.slice(0, 60) : [];
      const homepageLayout = provisionCategory === 'homepage' && /^[a-f0-9-]{36}$/i.test(String(parsed.homepageLayout?.captureId || ''))
        ? parsed.homepageLayout : null;
      const extensionVersion = String(parsed.extensionVersion || '').trim().slice(0, 40) || 'unknown';
      const now = new Date().toISOString();
      let acceptedVideos = 0;
      let acceptedSubscriptions = 0;
      let acceptedPlaylists = 0;
      let acceptedPlaylistItems = 0;
      database.exec('BEGIN IMMEDIATE');
      try {
        incomingVideos.forEach((raw, position) => {
          const video = cleanVideo(raw, position);
          if (!video) return;
          recordExtensionDuration(extensionVersion, video, provisionCategory, now);
          upsertVideo.run(video.id, video.url, video.title, video.channel, video.channelKey, video.channelUrl, video.thumbnail, video.avatar, video.duration, video.meta, video.kind, video.section, video.topic, video.position, now, now);
          saveVideoPublication(video.id, video);
          if (video.kind === 'short') {
            isolateShortFromStandardFlows(video.id);
          }
          database.prepare(`INSERT INTO video_provisions (video_id, category, first_seen, last_seen) VALUES (?, ?, ?, ?)
            ON CONFLICT(video_id, category) DO UPDATE SET last_seen = excluded.last_seen`).run(video.id, provisionCategory, now, now);
          const fallbackSource = provisionCategory === 'homepage'
            ? { sourceType: 'homepage', sourceKey: 'homepage', sourceLabel: 'YouTube homepage', sourceUrl: 'https://www.youtube.com/' }
            : { sourceType: 'youtube-page', sourceLabel: 'YouTube page' };
          recordVideoProvenance(video.id, raw.provenance || parsed.sourceContext, now, fallbackSource);
          const sourceChannelKey = cleanChannelKey(raw.sourceChannelKey);
          const sourceTab = ['home', 'videos', 'shorts', 'streams', 'playlists', 'community'].includes(raw.sourceTab) ? raw.sourceTab : '';
          if (sourceChannelKey && sourceTab) {
            const sourceChannelUrl = channelUrlForKey(sourceChannelKey, sourceTab);
            database.prepare(`INSERT INTO channels (channel_key, channel_url, name, description, avatar, banner, subscriber_count, video_count, created_at, updated_at)
              VALUES (?, ?, ?, '', '', '', '', '', ?, ?)
              ON CONFLICT(channel_key) DO UPDATE SET channel_url = excluded.channel_url,
                name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE channels.name END, updated_at = excluded.updated_at`)
              .run(sourceChannelKey, sourceChannelUrl, video.channel, now, now);
            database.prepare(`INSERT INTO channel_items (channel_key, video_id, tab_key, position, added_at)
              VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_key, video_id, tab_key)
              DO UPDATE SET position = excluded.position, added_at = excluded.added_at`)
              .run(sourceChannelKey, video.id, sourceTab, video.position, now);
          }
          acceptedVideos += 1;
        });
        incomingSubscriptions.forEach((raw, position) => {
          const subscription = cleanSubscription(raw, position);
          if (!subscription) return;
          upsertSubscription.run(subscription.key, subscription.name, subscription.avatar, position, now);
          acceptedSubscriptions += 1;
        });
        const saveHomepageCategory = database.prepare(`INSERT INTO homepage_categories
          (category_key, title, sort_position, discovered_at, last_seen, last_captured_at)
          VALUES (?, ?, ?, ?, ?, '') ON CONFLICT(category_key) DO UPDATE SET title = excluded.title,
          sort_position = excluded.sort_position, last_seen = excluded.last_seen`);
        const seenHomepageCategoryKeys = new Set();
        incomingHomepageCategories.forEach((raw, position) => {
          const title = String(raw?.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          const key = String(raw?.key || '').toLowerCase();
          if (!title || !/^[a-z0-9-]{1,70}$/.test(key) || seenHomepageCategoryKeys.has(key)) return;
          seenHomepageCategoryKeys.add(key);
          const requestedPosition = Number.parseInt(raw?.position, 10);
          const categoryPosition = Number.isInteger(requestedPosition) && requestedPosition >= 0 ? Math.min(requestedPosition, 10000) : position;
          saveHomepageCategory.run(key, title, categoryPosition, now, now);
        });
        incomingPlaylists.forEach(raw => {
          const playlist = cleanPlaylist(raw);
          if (!playlist) return;
          const existing = database.prepare('SELECT source, title FROM playlists WHERE playlist_id = ?').get(playlist.id);
          if (existing?.source === 'local') return;
          const playlistTitle = playlist.title || existing?.title || (playlist.kind === 'mix' ? 'YouTube Mix' : 'YouTube playlist');
          const nonShortDeclaredCount = Math.max(0, playlist.itemCount - playlist.items.filter(video => video.kind === 'short').length);
          database.prepare(`INSERT INTO playlists
            (playlist_id, title, source, kind, source_url, channel, thumbnail, declared_item_count, is_complete, created_at, updated_at)
            VALUES (?, ?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(playlist_id) DO UPDATE SET
              title = CASE WHEN lower(excluded.title) IN ('youtube playlist', 'youtube mix')
                AND playlists.title <> '' AND lower(playlists.title) NOT IN ('youtube playlist', 'youtube mix')
                THEN playlists.title ELSE excluded.title END,
              kind = excluded.kind, source_url = excluded.source_url,
              channel = CASE WHEN excluded.channel <> '' THEN excluded.channel ELSE playlists.channel END,
              thumbnail = CASE WHEN excluded.thumbnail <> '' THEN excluded.thumbnail ELSE playlists.thumbnail END,
              declared_item_count = MAX(playlists.declared_item_count, excluded.declared_item_count),
              is_complete = MAX(playlists.is_complete, excluded.is_complete), updated_at = excluded.updated_at
            WHERE playlists.source = 'youtube'`)
            .run(playlist.id, playlistTitle, playlist.kind, playlist.sourceUrl, playlist.channel, playlist.thumbnail,
              nonShortDeclaredCount, playlist.complete ? 1 : 0, now, now);
          acceptedPlaylists += 1;
          const addItem = database.prepare(`INSERT INTO playlist_items (playlist_id, video_id, position, source_key, added_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(playlist_id, source_key) DO UPDATE SET
              video_id = excluded.video_id, position = excluded.position`);
          playlist.items.forEach((video, position) => {
            const itemPosition = Number.isInteger(video.position) ? video.position : position;
            recordExtensionDuration(extensionVersion, video, 'playlist', now);
            recordVideoProvenance(video.id, null, now, {
              sourceType: 'playlist', sourceKey: playlist.id,
              sourceLabel: `YouTube playlist · ${playlist.title || 'YouTube playlist'}`, sourceUrl: playlist.sourceUrl
            });
            upsertPlaylistVideo.run(video.id, video.url, video.title, video.channel, video.channelKey, video.channelUrl, video.thumbnail, video.avatar,
              video.duration, video.meta, video.kind, position, now, now);
            if (video.kind === 'short') database.prepare("UPDATE videos SET kind = 'short' WHERE video_id = ?").run(video.id);
            const storedKind = database.prepare('SELECT kind FROM videos WHERE video_id = ?').get(video.id)?.kind;
            saveVideoPublication(video.id, video);
            if (storedKind === 'short') {
              isolateShortFromStandardFlows(video.id);
            } else {
              database.prepare(`INSERT INTO video_provisions (video_id, category, first_seen, last_seen)
                VALUES (?, 'playlist', ?, ?) ON CONFLICT(video_id, category) DO UPDATE SET last_seen = excluded.last_seen`)
                .run(video.id, now, now);
              addItem.run(playlist.id, video.id, itemPosition, `youtube:${itemPosition}`, now);
              acceptedPlaylistItems += 1;
            }
          });
          if (playlist.complete) {
            const capturedKeys = new Set(playlist.items.flatMap((video, position) =>
              video.kind === 'short' ? [] : [`youtube:${Number.isInteger(video.position) ? video.position : position}`]));
            const previousItems = database.prepare("SELECT source_key AS sourceKey FROM playlist_items WHERE playlist_id = ? AND source_key LIKE 'youtube:%'").all(playlist.id);
            const removeItem = database.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND source_key = ?');
            for (const item of previousItems) if (!capturedKeys.has(item.sourceKey)) removeItem.run(playlist.id, item.sourceKey);
            database.prepare(`UPDATE playlists SET declared_item_count = (
              SELECT COUNT(*) FROM playlist_items i JOIN videos v ON v.video_id = i.video_id
              WHERE i.playlist_id = playlists.playlist_id AND v.kind <> 'short'
            ) WHERE playlist_id = ?`).run(playlist.id);
          }
        });
        if (homepageLayout) {
          const captureId = String(homepageLayout.captureId);
          database.prepare(`INSERT INTO homepage_captures (capture_id, captured_at, first_seen, last_seen)
            VALUES (?, ?, ?, ?) ON CONFLICT(capture_id) DO UPDATE SET captured_at = excluded.captured_at, last_seen = excluded.last_seen`)
            .run(captureId, now, now, now);
          database.prepare('DELETE FROM homepage_placements WHERE capture_id = ?').run(captureId);
          database.prepare('DELETE FROM homepage_sections WHERE capture_id = ?').run(captureId);
          const sectionRows = Array.isArray(homepageLayout.sections) ? homepageLayout.sections.slice(0, 80) : [];
          const insertSection = database.prepare(`INSERT INTO homepage_sections
            (capture_id, section_key, title, kind, topic, section_position) VALUES (?, ?, ?, ?, ?, ?)`);
          const insertPlacement = database.prepare(`INSERT OR IGNORE INTO homepage_placements
            (capture_id, section_key, video_id, position, mix_id) VALUES (?, ?, ?, ?, ?)`);
          const hasVideo = database.prepare('SELECT 1 FROM videos WHERE video_id = ?');
          const seenSectionKeys = new Set();
          let placementCount = 0;
          sectionRows.forEach((rawSection, sectionIndex) => {
            const sectionKey = String(rawSection?.key || '').trim().slice(0, 120);
            if (!/^[a-z0-9:_-]{1,120}$/i.test(sectionKey) || seenSectionKeys.has(sectionKey)) return;
            seenSectionKeys.add(sectionKey);
            const title = String(rawSection?.title || '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'YouTube';
            const kind = ['for-you', 'feed', 'topic', 'shorts'].includes(rawSection?.kind) ? rawSection.kind : 'feed';
            const topic = String(rawSection?.topic || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            const requestedPosition = Number.parseInt(rawSection?.position, 10);
            const sectionPosition = Number.isInteger(requestedPosition) && requestedPosition >= 0 ? Math.min(requestedPosition, 10000) : sectionIndex;
            insertSection.run(captureId, sectionKey, title, kind, topic, sectionPosition);
            const entries = Array.isArray(rawSection?.placements) ? rawSection.placements.slice(0, 500) : [];
            entries.forEach((entry, entryIndex) => {
              if (placementCount >= 2000) return;
              const id = String(entry?.id || '');
              if (!/^[A-Za-z0-9_-]{11}$/.test(id) || !hasVideo.get(id)) return;
              const requestedItemPosition = Number.parseInt(entry?.position, 10);
              const itemPosition = Number.isInteger(requestedItemPosition) && requestedItemPosition >= 0 ? Math.min(requestedItemPosition, 100000) : entryIndex;
              const rawMixId = String(entry?.mixId || '');
              const mixId = /^RD[A-Za-z0-9_-]{1,158}$/.test(rawMixId) ? rawMixId : '';
              insertPlacement.run(captureId, sectionKey, id, itemPosition, mixId);
              placementCount += 1;
            });
          });
          database.prepare(`DELETE FROM homepage_placements WHERE capture_id NOT IN
            (SELECT capture_id FROM homepage_captures ORDER BY last_seen DESC LIMIT 24)`).run();
          database.prepare(`DELETE FROM homepage_sections WHERE capture_id NOT IN
            (SELECT capture_id FROM homepage_captures ORDER BY last_seen DESC LIMIT 24)`).run();
          database.prepare(`DELETE FROM homepage_captures WHERE capture_id NOT IN
            (SELECT capture_id FROM homepage_captures ORDER BY last_seen DESC LIMIT 24)`).run();
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      scheduleBackgroundDurationLookup();
      const total = database.prepare('SELECT COUNT(*) AS count FROM videos').get().count;
      const withChannels = database.prepare("SELECT COUNT(*) AS count FROM videos WHERE trim(channel) <> ''").get().count;
      const currentCategoryKeys = [...new Set(incomingHomepageCategories
        .filter(item => /^[a-z0-9-]{1,70}$/.test(String(item?.key || '').toLowerCase()) && String(item?.title || '').trim())
        .map(item => String(item.key).toLowerCase()))];
      const homepageCategoriesToCapture = currentCategoryKeys.length
        ? database.prepare(`SELECT category_key AS key, title, sort_position AS position FROM homepage_categories
            WHERE (last_captured_at = '' OR last_captured_at < ?) AND category_key IN (${currentCategoryKeys.map(() => '?').join(',')})
            ORDER BY sort_position, title COLLATE NOCASE LIMIT 60`)
          .all(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), ...currentCategoryKeys)
        : [];
      console.log(`Extension sync: ${acceptedVideos} cards, ${acceptedSubscriptions} subscriptions, ${acceptedPlaylists} playlists, ${acceptedPlaylistItems} playlist entries; ${withChannels} video authors stored.`);
      sendJson(response, 200, { acceptedVideos, acceptedSubscriptions, acceptedPlaylists, acceptedPlaylistItems, total, homepageCategoriesToCapture, mode: reportedNetworkMode() });
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'Request too large' : 'Request body must be valid JSON.' });
    }
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

const startupNow = new Date();
if (downloadProtectionMode === 'off') {
  // Keep previously paused items visible for explicit retry, but drop the
  // shared cooldown so it cannot block new attempts while protections are off.
  database.prepare('DELETE FROM app_settings WHERE setting_key = ?').run(youtubeCooldownKey);
}
for (const retry of database.prepare("SELECT video_id AS id, attempts, status FROM download_retry_queue WHERE status IN ('running', 'pending')").all()) {
  if (interruptedFinishIds.has(retry.id)) continue;
  if (retry.attempts >= maxDownloadAttempts) {
    const message = 'Paused after 10 failed attempts. Choose Retry to try again.';
    database.prepare("UPDATE download_retry_queue SET status = 'paused', last_error = ?, updated_at = ? WHERE video_id = ?")
      .run(message, startupNow.toISOString(), retry.id);
    database.prepare("UPDATE downloads SET status = 'paused', message = ?, stage = 'Paused after 10 failed attempts', updated_at = ? WHERE video_id = ?")
      .run(message, startupNow.toISOString(), retry.id);
  } else if (retry.status === 'running') {
    // Recover an interrupted process without restarting its retry backoff clock.
    database.prepare("UPDATE download_retry_queue SET status = 'pending', updated_at = ? WHERE video_id = ?")
      .run(startupNow.toISOString(), retry.id);
  }
}
for (const failed of database.prepare(`SELECT video_id AS id, message FROM downloads
  WHERE status = 'error' AND video_id NOT IN (SELECT video_id FROM download_retry_queue)
    AND NOT (COALESCE(origin, '') = 'media-folder' AND COALESCE(stage, '') = 'Waiting for media-folder scan')`).all()) {
  if (failed.message === 'Download was interrupted. Try again.') {
    const now = new Date();
    const updatedAt = now.toISOString();
    markRestartInterrupted.run(restartRecoveryMessage, updatedAt, failed.id);
    queueRestartInterrupted.run(failed.id, new Date(now.getTime() + downloadRetryDelay).toISOString(), restartRecoveryMessage, updatedAt);
  } else {
    recordDownloadFailure(failed.id, failed.message);
  }
}
if (networkMode === 'offline' || offlinePreparationRequested) pauseRetryQueueForOffline();
if (youtubeRateLimitIsActive()) {
  if (!explicitOfflinePreference) {
    if (networkMode !== 'offline') switchOfflineForConnectionLoss();
    setAutoOnlineAfterConnectivityLoss(true);
    if (offlinePreparationPaused) {
      offlinePreparation = { ...offlinePreparation, status: 'paused', message: 'Background preparation is paused because YouTube is rate limiting requests. It will resume when the Online pause ends.' };
      setOfflinePreparationTarget('paused');
      saveOfflinePreparationCheckpoint(offlinePreparation);
    }
  }
  connectivityNotice = youtubeRateLimitMessage();
}
const finalizedStartupCaptures = finalizeStalledCaptures();
if (finalizedStartupCaptures.channel || finalizedStartupCaptures.searches) {
  console.log(`Finalized stale captures: ${finalizedStartupCaptures.channel} channel sections, ${finalizedStartupCaptures.searches} searches.`);
}
const downloadRetryTimer = setInterval(() => { runDownloadRetries().catch(error => console.error('Download retry queue:', error)); }, 1_000);
downloadRetryTimer.unref();
const finishRecoveryTimer = setInterval(() => { resumePendingFinishRecoveries(); }, 1_000);
finishRecoveryTimer.unref();
const mediaCleanupTimer = setInterval(() => { cleanupExpiredMedia().catch(error => console.error('Expired media cleanup:', error)); }, 60_000);
mediaCleanupTimer.unref();
const mediaFolderPeriodicScanTimer = setInterval(handleMediaFolderChange, mediaFolderScanMs);
mediaFolderPeriodicScanTimer.unref();
cleanupExpiredMedia().catch(error => console.error('Expired media cleanup:', error));
const connectivityMonitorTimer = setInterval(() => { monitorInternetConnectivity().catch(error => console.error('Internet connectivity check:', error)); }, 10_000);
connectivityMonitorTimer.unref();
const backgroundDurationLookupTimer = setInterval(() => scheduleBackgroundDurationLookup(), 30_000);
backgroundDurationLookupTimer.unref();
const staleCaptureTimer = setInterval(() => {
  try { finalizeStalledCaptures(); }
  catch (error) { console.error('Stale capture finalization:', error); }
}, 60_000);
staleCaptureTimer.unref();
const downloadedMetadataTimer = setInterval(() => runDownloadedMetadataQueue().catch(error => console.error('Downloaded metadata preparation:', error)), 5_000);
downloadedMetadataTimer.unref();
const commentBackfillTimer = setInterval(() => {
  try { runCommentBackfillQueue(); }
  catch (error) { console.error('Historical comment expansion:', error); }
}, 15_000);
commentBackfillTimer.unref();

server.listen(port, host, () => {
  console.log(`YourTube local feed: http://${host}:${port}`);
  console.log(`Download protections: ${downloadProtectionMode}`);
  console.log(`Media folder: ${mediaDirectory}${mediaDirectoryIsExternal ? ' (configured separately)' : ''}`);
  handleMediaFolderChange();
  monitorInternetConnectivity().catch(error => console.error('Internet connectivity check:', error));
  resumePendingFinishRecoveries();
  setTimeout(() => scheduleBackgroundDurationLookup(), 1500).unref();
  setTimeout(() => runDownloadedMetadataQueue().catch(error => console.error('Downloaded metadata preparation:', error)), 5000).unref();
  if (offlinePreparationRequested && networkMode !== 'offline') {
    setTimeout(() => {
      if (offlinePreparationRequested) prepareOfflineCache().catch(error => console.error('Offline cache preparation:', error));
    }, 0);
  } else if (offlinePreparationBackground && networkMode === 'online') {
    setTimeout(() => {
      if (offlinePreparationBackground && networkMode === 'online') prepareOfflineCache({ backgroundOnly: true }).catch(error => console.error('Background preparation:', error));
    }, 0);
  }
});
