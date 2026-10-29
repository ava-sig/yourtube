import { createServer } from 'node:http';
import { createReadStream, existsSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.YOURTUBE_DATA_DIR || path.join(root, 'data');
const mediaDirectory = path.join(dataDirectory, 'media');
const imageCacheDirectory = path.join(dataDirectory, 'images');
const mediaContentTypes = Object.freeze({ webm: 'video/webm', mp4: 'video/mp4' });
await mkdir(dataDirectory, { recursive: true });
await mkdir(mediaDirectory, { recursive: true });
await mkdir(imageCacheDirectory, { recursive: true });
const page = await readFile(path.join(root, 'public', 'index.html'));
const playerPage = await readFile(path.join(root, 'public', 'player.html'));
const favicon = await readFile(path.join(root, 'public', 'favicon.ico'));
const vueRuntime = await readFile(path.join(root, 'public', 'vendor', 'vue.global.prod.js'));
const imagePlaceholder = await readFile(path.join(root, 'public', 'image-placeholder.svg'));
const database = new DatabaseSync(path.join(dataDirectory, 'yourtube.sqlite'));
const port = Number(process.env.PORT || 4173);
const hostArgument = process.argv.slice(2).find(argument => argument.startsWith('--host='))?.slice('--host='.length);
const hostIndex = process.argv.indexOf('--host');
const host = hostArgument || (hostIndex >= 0 ? process.argv[hostIndex + 1] : '') || process.env.HOST || '127.0.0.1';
const jobs = new Map();
const commentJobs = new Map();
const channelLookups = new Map();
let downloadedMetadataWorkerRunning = false;
const ffmpegAvailable = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function getStoredMediaPath(id) {
  for (const extension of Object.keys(mediaContentTypes)) {
    const candidate = path.join(mediaDirectory, `${id}.${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function getStoredMediaExtension(id) {
  const storedPath = getStoredMediaPath(id);
  return storedPath ? path.extname(storedPath).slice(1).toLowerCase() : '';
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
    last_seen TEXT NOT NULL
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
    added_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_preferences (
    video_id TEXT PRIMARY KEY,
    not_interested INTEGER NOT NULL DEFAULT 0,
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
    expiry_paused_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS download_retry_queue (
    video_id TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    next_retry_at TEXT NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_comments (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    comments_json TEXT NOT NULL DEFAULT '[]',
    message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
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
    searched_at TEXT NOT NULL
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
database.prepare(`INSERT OR IGNORE INTO download_metadata (video_id, status, phase, attempts, next_attempt_at, message, updated_at)
  SELECT video_id, 'pending', 'queued', 0, '', 'Preparing local metadata for this media.', updated_at
  FROM downloads WHERE status = 'ready'`).run();
database.prepare("UPDATE download_metadata SET status = 'retry', phase = 'queued', message = 'Metadata preparation was interrupted by a server restart.', next_attempt_at = '', updated_at = ? WHERE status = 'running'")
  .run(new Date().toISOString());
database.prepare(`UPDATE download_metadata SET status = 'pending', phase = 'queued', attempts = 0, next_attempt_at = '',
  message = 'Rechecking local metadata completeness.', updated_at = ?
  WHERE status = 'retry' AND message LIKE 'Local metadata is incomplete:%source metadata%'`).run(new Date().toISOString());
for (const [column, definition] of [['channel_key', "TEXT NOT NULL DEFAULT ''"], ['channel_url', "TEXT NOT NULL DEFAULT ''"]]) {
  try { database.exec(`ALTER TABLE videos ADD COLUMN ${column} ${definition}`); }
  catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
}
database.exec(`CREATE TRIGGER IF NOT EXISTS enqueue_download_metadata_after_video_update
  AFTER UPDATE OF title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta ON videos
  WHEN EXISTS (SELECT 1 FROM downloads WHERE video_id = NEW.video_id AND status = 'ready')
    AND (OLD.title <> NEW.title OR OLD.channel <> NEW.channel OR OLD.channel_key <> NEW.channel_key
      OR OLD.channel_url <> NEW.channel_url OR OLD.thumbnail <> NEW.thumbnail OR OLD.avatar <> NEW.avatar
      OR OLD.duration <> NEW.duration OR OLD.meta <> NEW.meta)
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
for (const [column, definition] of [['progress', "REAL NOT NULL DEFAULT 0"], ['stage', "TEXT NOT NULL DEFAULT ''"], ['acquired_at', "TEXT NOT NULL DEFAULT ''"], ['started_at', "TEXT NOT NULL DEFAULT ''"], ['expires_at', "TEXT NOT NULL DEFAULT ''"], ['expiry_paused_ms', 'INTEGER']]) {
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
    const names = (await readdir(mediaDirectory)).filter(name => name.startsWith(`${row.id}.`) && !name.includes('.finalizing.'));
    const mediaStats = await Promise.all(names.map(name => stat(path.join(mediaDirectory, name)).catch(() => null)));
    for (const file of mediaStats) if (file?.birthtimeMs > 0) times.push(file.birthtimeMs);
  } catch {}
  const startedAtMs = Math.min(...times.filter(Number.isFinite));
  if (Number.isFinite(startedAtMs)) setDownloadStartedAt.run(new Date(startedAtMs).toISOString(), row.id);
}));
try { database.exec("ALTER TABLE search_history ADD COLUMN selected_video_id TEXT NOT NULL DEFAULT ''"); } catch (error) {
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
const watchLaterCreatedAt = new Date().toISOString();
database.prepare(`INSERT OR IGNORE INTO playlists (playlist_id, title, source, kind, created_at, updated_at)
  VALUES ('watch-later', 'Watch later', 'local', 'watch-later', ?, ?)`).run(watchLaterCreatedAt, watchLaterCreatedAt);
database.prepare(`INSERT OR IGNORE INTO video_provisions (video_id, category, first_seen, last_seen)
  SELECT video_id, CASE WHEN section = 'search' THEN 'search' ELSE 'homepage' END, first_seen, last_seen FROM videos`).run();
database.prepare(`UPDATE video_progress SET completed = 1 WHERE current_time = 0 AND duration > 0 AND completed = 0
  AND video_id IN (SELECT video_id FROM video_views WHERE view_count > 0)`).run();
database.prepare("DELETE FROM videos WHERE lower(trim(title)) = 'watch'").run();
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
if (interruptedFinishIds.size) {
  const placeholders = [...interruptedFinishIds].map(() => '?').join(', ');
  database.prepare(`UPDATE downloads SET status = 'error', message = 'Download was interrupted. Try again.', stage = 'Interrupted', updated_at = ? WHERE status = 'downloading' AND video_id NOT IN (${placeholders})`)
    .run(new Date().toISOString(), ...interruptedFinishIds);
} else {
  database.prepare("UPDATE downloads SET status = 'error', message = 'Download was interrupted. Try again.', stage = 'Interrupted', updated_at = ? WHERE status = 'downloading'").run(new Date().toISOString());
}
database.prepare("UPDATE video_comments SET status = 'error', message = 'Comment lookup was interrupted. Reload to try again.', updated_at = ? WHERE status = 'loading'").run(new Date().toISOString());
database.prepare("UPDATE video_duration_lookups SET status = 'pending', message = 'Lookup interrupted by restart.', updated_at = ? WHERE status = 'running' AND updated_at < ?")
  .run(new Date().toISOString(), new Date(Date.now() - 60_000).toISOString());

const upsertVideo = database.prepare(`
  INSERT INTO videos (video_id, url, title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, kind, section, topic, position, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(video_id) DO UPDATE SET
    url = excluded.url, title = excluded.title, channel = excluded.channel,
    channel_key = CASE WHEN excluded.channel_key <> '' THEN excluded.channel_key ELSE videos.channel_key END,
    channel_url = CASE WHEN excluded.channel_url <> '' THEN excluded.channel_url ELSE videos.channel_url END,
    thumbnail = excluded.thumbnail, avatar = excluded.avatar,
    duration = CASE WHEN trim(excluded.duration) <> '' THEN excluded.duration ELSE videos.duration END,
    meta = excluded.meta, kind = excluded.kind, section = excluded.section,
    topic = excluded.topic, position = excluded.position, last_seen = excluded.last_seen
`);
const upsertSubscription = database.prepare(`
  INSERT INTO subscriptions (channel_key, name, avatar, position, last_seen)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(channel_key) DO UPDATE SET
    name = excluded.name, avatar = excluded.avatar, position = excluded.position, last_seen = excluded.last_seen
`);
const upsertPlaylistVideo = database.prepare(`
  INSERT INTO videos (video_id, url, title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, kind, section, topic, position, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'playlist', '', ?, ?, ?)
  ON CONFLICT(video_id) DO UPDATE SET
    url = excluded.url, title = excluded.title, channel = excluded.channel,
    channel_key = CASE WHEN excluded.channel_key <> '' THEN excluded.channel_key ELSE videos.channel_key END,
    channel_url = CASE WHEN excluded.channel_url <> '' THEN excluded.channel_url ELSE videos.channel_url END,
    thumbnail = CASE WHEN excluded.thumbnail <> '' THEN excluded.thumbnail ELSE videos.thumbnail END,
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

function cleanVideo(value, position) {
  if (!value || typeof value !== 'object') return null;
  try {
    const url = new URL(value.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.protocol !== 'https:' || !['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return null;
    const id = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    const title = String(value.title || '').trim().slice(0, 500);
    if (!title || /^watch$/i.test(title)) return null;
    const channelKey = cleanChannelKey(value.channelKey || value.channelUrl);
    return {
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title,
      channel: cleanRepeatedLabel(value.channel).slice(0, 200),
      channelKey,
      channelUrl: channelKey ? `https://www.youtube.com/${channelKey}` : '',
      thumbnail: safeImage(value.thumbnail),
      avatar: safeImage(value.avatar),
      duration: cleanDurationLabel(value.duration),
      meta: String(value.meta || '').slice(0, 200),
      kind: value.kind === 'short' ? 'short' : 'normal',
      section: value.section === 'news' ? 'news' : value.section === 'search' ? 'search' : value.section === 'playlist' ? 'playlist' : value.section === 'channel' ? 'channel' : 'home',
      topic: String(value.topic || '').slice(0, 80),
      position: Number.isInteger(value.position) ? Math.max(0, Math.min(value.position, 10000)) : position
    };
  } catch { return null; }
}

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
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !title) return null;
  const sourceUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`;
  const items = (Array.isArray(value.items) ? value.items : []).slice(0, 500)
    .map((item, position) => cleanVideo({ ...item, section: 'playlist' }, position))
    .filter(Boolean);
  const declaredItemCount = Number.isInteger(value.itemCount)
    ? Math.max(items.length, Math.min(100000, value.itemCount))
    : items.length;
  return {
    id,
    title,
    source: 'youtube',
    kind: value.kind === 'mix' || /^RD/i.test(id) ? 'mix' : 'playlist',
    sourceUrl,
    channel: cleanRepeatedLabel(value.channel).slice(0, 200),
    thumbnail: safeImage(value.thumbnail),
    itemCount: declaredItemCount,
    complete: value.complete === true,
    items
  };
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) throw new RangeError('Request too large');
  }
  return JSON.parse(body);
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(localizeCachedImages(value)));
}

const modeSetting = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'network_mode'").get();
let networkMode = modeSetting?.value === 'offline' ? 'offline' : 'online';
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
  const readyMedia = database.prepare("SELECT video_id AS id, acquired_at AS acquiredAt, expires_at AS expiresAt, expiry_paused_ms AS pausedMs FROM downloads WHERE status = 'ready'").all();
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
  const readyMedia = database.prepare("SELECT video_id AS id, expires_at AS expiresAt FROM downloads WHERE status = 'ready' AND expires_at <> '' AND expiry_paused_ms IS NULL").all();
  const pauseReadyExpiry = database.prepare("UPDATE downloads SET expires_at = '', expiry_paused_ms = ? WHERE video_id = ? AND status = 'ready' AND expires_at = ?");
  const now = Date.now();
  for (const media of readyMedia) {
    const deadline = Date.parse(media.expiresAt);
    pauseReadyExpiry.run(Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0, media.id, media.expiresAt);
  }
}
const offlinePreparationTarget = database.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = 'offline_preparation_target'").get()?.value || 'online';
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
const reportedNetworkMode = () => networkMode !== 'offline' && (offlinePreparationRequested || !offlinePreparationBackground && ['queued', 'running'].includes(offlinePreparation.status)) ? 'preparing' : networkMode;
const mediaDiscoveryPaused = () => reportedNetworkMode() !== 'online';
function setOfflinePreparationTarget(target) {
  database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('offline_preparation_target', ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at")
    .run(target, new Date().toISOString());
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
    connectivityStatus = { available: true, checkedAt: new Date().toISOString() };
  }).catch(() => {
    connectivityStatus = { available: false, checkedAt: new Date().toISOString() };
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
  offlinePreparation = pausedPreparation
    ? { ...pausedPreparation, status: 'paused', message: 'Preparation remains paused. Reconnect, then switch Online to resume it in the background.' }
    : { status: 'idle', phase: 'comments', completed: 0, total: 0, message: '' };
  noInternetFallback = true;
  connectivityNotice = 'No internet connection detected. YourTube switched to Offline. Reconnect, then turn Online on.';
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
async function monitorInternetConnectivity() {
  await checkInternetConnectivity();
  if (!connectivityStatus.available && networkMode === 'online') switchOfflineForConnectionLoss();
  else if (connectivityStatus.available && noInternetFallback && networkMode === 'offline') {
    connectivityNotice = 'Internet connection restored. YourTube is still Offline; turn Online on when you are ready.';
  }
}
const imageKey = source => createHash('sha256').update(source).digest('hex');
const cachedImageLookup = database.prepare('SELECT image_key AS key FROM cached_images WHERE source_url = ?');
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
function localizeCachedImages(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(localizeCachedImages);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const id = String(value.id || value.video_id || '');
    const source = key === 'thumbnail' && !item && /^[A-Za-z0-9_-]{11}$/.test(id)
      ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
      : item;
    if (['thumbnail', 'avatar', 'authorThumbnail'].includes(key) && typeof source === 'string' && source.startsWith('https://')) {
      const cached = existingCachedImage(source);
      result[key] = cached ? `/api/images/${cached.key}` : networkMode === 'offline' ? '' : source;
    } else result[key] = localizeCachedImages(item);
  }
  const videoId = String(value.id || value.video_id || '');
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
async function cacheRemoteImage(source) {
  if (!source || !/^https:\/\//i.test(source)) return false;
  if (existingCachedImage(source)) return true;
  let current;
  try { current = new URL(source); } catch { return false; }
  const allowed = host => /(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com|youtube\.com)$/i.test(host);
  if (!allowed(current.hostname)) return false;
  try {
    const response = await fetch(current, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('image/')) return false;
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || !allowed(finalUrl.hostname)) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8_000_000) return false;
    const key = imageKey(source);
    await writeFile(path.join(imageCacheDirectory, key), bytes);
    database.prepare('INSERT OR REPLACE INTO cached_images (image_key, source_url, content_type, cached_at) VALUES (?, ?, ?, ?)')
      .run(key, source, response.headers.get('content-type').split(';')[0], new Date().toISOString());
    return true;
  } catch { return false; }
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
    const videoThumbnails = videoRows.map(row => row.thumbnail || `https://i.ytimg.com/vi/${row.id}/hqdefault.jpg`);
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
      const images = [...new Set(sourceImages.filter(Boolean))].filter(source => {
        if (seenImages.has(source)) return false;
        seenImages.add(source);
        return !existingCachedImage(source);
      });
      offlinePreparation = { status: 'running', phase, completed: 0, total: images.length, message: `Preparing ${phase}…` };
      let nextImage = 0;
      const imageWorkers = Array.from({ length: Math.min(6, images.length) }, async () => {
        while (runId === offlinePreparationRun) {
          const index = nextImage++;
          if (index >= images.length) return;
          await cacheRemoteImage(images[index]);
          if (runId !== offlinePreparationRun) return;
          offlinePreparation.completed += 1;
        }
      });
      await Promise.all(imageWorkers);
    }
    await cacheImagePhase('thumbnails', videoThumbnails);
    if (runId !== offlinePreparationRun) return;
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
  const previous = database.prepare('SELECT acquired_at AS acquiredAt, started_at AS startedAt, expires_at AS expiresAt, expiry_paused_ms AS pausedMs FROM downloads WHERE video_id = ?').get(id) || null;
  const acquiredAt = status === 'ready' ? previous?.acquiredAt || now : '';
  const startedAt = previous?.startedAt || (status === 'downloading' ? now : '');
  let expiresAt = '';
  let pausedMs = previous?.pausedMs ?? null;
  if (status === 'ready' && autoDeleteEnabled) {
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
    INSERT INTO downloads (video_id, status, message, progress, stage, updated_at, acquired_at, expires_at, expiry_paused_ms, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET status = excluded.status, message = excluded.message,
      progress = excluded.progress, stage = excluded.stage, updated_at = excluded.updated_at,
      acquired_at = CASE WHEN downloads.acquired_at = '' AND excluded.status = 'ready' THEN excluded.acquired_at ELSE downloads.acquired_at END,
      expires_at = CASE WHEN excluded.status = 'ready' THEN excluded.expires_at ELSE downloads.expires_at END,
      expiry_paused_ms = CASE WHEN excluded.status = 'ready' THEN excluded.expiry_paused_ms ELSE downloads.expiry_paused_ms END,
      started_at = CASE WHEN downloads.started_at = '' AND excluded.started_at <> '' THEN excluded.started_at ELSE downloads.started_at END
  `).run(id, status, message, progress, stage, now, acquiredAt, expiresAt, pausedMs, startedAt);
  if (status === 'ready') {
    database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
    queueDownloadedMetadata(id);
  }
}

function getDownload(id) {
  const result = database.prepare(`SELECT d.status, d.message, d.progress, d.stage, d.updated_at AS updatedAt,
    r.attempts AS retryAttempts, r.next_retry_at AS retryAt, r.last_error AS retryError, r.status AS retryStatus,
    m.status AS metadataStatus, m.phase AS metadataPhase, m.message AS metadataMessage
    FROM downloads d LEFT JOIN download_retry_queue r ON r.video_id = d.video_id
    LEFT JOIN download_metadata m ON m.video_id = d.video_id WHERE d.video_id = ?`).get(id) || null;
  return result ? { ...result, mediaExtension: getStoredMediaExtension(id) } : null;
}

const downloadRetryDelay = 10_000;
const maxDownloadRetryDelay = 30 * 60_000;
const maxDownloadAttempts = 10;
const youtubeCooldownKey = 'youtube_download_cooldown_until';
const youtubeCooldownDuration = 30 * 60_000;
const downloadProtectionMode = ['off', 'auto', 'always'].includes(process.env.YOURTUBE_DOWNLOAD_PROTECTIONS)
  ? process.env.YOURTUBE_DOWNLOAD_PROTECTIONS
  : 'off';
function areDownloadProtectionsActive() {
  if (downloadProtectionMode === 'always') return true;
  if (downloadProtectionMode !== 'auto') return false;
  const until = Date.parse(database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(youtubeCooldownKey)?.value || '');
  return Number.isFinite(until) && until > Date.now();
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
  const detail = normalized.replace(/\s+/g, ' ').slice(0, 220);
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
  if (requiresSignIn && downloadProtectionMode !== 'off') startYoutubeDownloadCooldown();
}

async function runDownloadRetries() {
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
  // Keep automatic retries serial so a connection-level block does not fan out
  // into a burst of simultaneous YouTube requests.
  if (protectionsActive && jobs.size) return;
  const now = new Date().toISOString();
  const due = database.prepare(`SELECT video_id AS id FROM download_retry_queue
    WHERE status IN ('pending', 'waiting-live') AND next_retry_at <= ? ORDER BY next_retry_at LIMIT ${protectionsActive ? 1 : 3}`).all(now);
  for (const { id } of due) {
    if (jobs.has(id)) continue;
    database.prepare("UPDATE download_retry_queue SET status = 'running', updated_at = ? WHERE video_id = ? AND status IN ('pending', 'waiting-live')").run(now, id);
    try {
      const result = await beginDownload(id);
      if (!result) database.prepare("UPDATE download_retry_queue SET status = 'exhausted', last_error = 'Video stub is no longer available.', updated_at = ? WHERE video_id = ?").run(new Date().toISOString(), id);
    } catch (error) {
      recordDownloadFailure(id, error.message);
    }
  }
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

function saveComments(id, status, comments = [], message = '') {
  database.prepare(`
    INSERT INTO video_comments (video_id, status, comments_json, message, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET status = excluded.status, comments_json = excluded.comments_json,
      message = excluded.message, updated_at = excluded.updated_at
  `).run(id, status, JSON.stringify(comments), message, new Date().toISOString());
  if (status !== 'loading') markDownloadedMetadataDirty(id);
}

function cleanComments(rawComments) {
  return (Array.isArray(rawComments) ? rawComments : []).slice(0, 50).map(comment => ({
    id: String(comment.id || '').slice(0, 300),
    parent: String(comment.parent || '').slice(0, 300),
    author: String(comment.author || 'YouTube user').slice(0, 200),
    authorId: String(comment.author_id || '').slice(0, 300),
    authorUrl: String(comment.author_url || '').slice(0, 2000),
    authorIsVerified: Boolean(comment.author_is_verified),
    authorIsUploader: Boolean(comment.author_is_uploader),
    text: String(comment.text || '').slice(0, 4000),
    likes: Number.isFinite(Number(comment.like_count)) ? Math.max(0, Number(comment.like_count)) : 0,
    published: String(comment.time_text || '').slice(0, 100),
    timestamp: Number.isFinite(Number(comment.timestamp)) ? Number(comment.timestamp) : null,
    replyCount: Number.isFinite(Number(comment.reply_count)) ? Math.max(0, Number(comment.reply_count)) : 0,
    isPinned: Boolean(comment.is_pinned),
    authorThumbnail: safeImage(comment.author_thumbnail || '')
  })).filter(comment => comment.text.trim());
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
    title = CASE WHEN trim(title) = '' AND ? <> '' THEN ? ELSE title END,
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
  const metadata = {
    extractorMetadataCaptured: info.extractorMetadataCaptured !== false,
    metadataSource: text(info.metadata_source, 80) || 'yt-dlp',
    id: text(info.id || id, 40), title, fulltitle: text(info.fulltitle, 1000), alt_title: text(info.alt_title, 1000),
    description: text(info.description, 20_000), extractor: text(info.extractor, 100), extractor_key: text(info.extractor_key, 100),
    webpage_url: text(info.webpage_url, 2_000), original_url: text(info.original_url, 2_000),
    uploader: text(info.uploader, 500), uploader_id: text(info.uploader_id, 300), uploader_url: text(info.uploader_url, 2_000),
    channel: text(info.channel, 500), channel_id: text(info.channel_id, 300), channel_url: text(info.channel_url, 2_000), channel_follower_count: Number(info.channel_follower_count) || null,
    duration_string: text(info.duration_string, 80), upload_date: text(info.upload_date, 40), release_date: text(info.release_date, 40), modified_date: text(info.modified_date, 40),
    live_status: text(info.live_status, 80), availability: text(info.availability, 80), language: text(info.language, 80), license: text(info.license, 200),
    release_year: Number(info.release_year) || null, artist: text(info.artist, 500), album: text(info.album, 500), track: text(info.track, 500),
    series: text(info.series, 500), season_number: Number(info.season_number) || null, episode_number: Number(info.episode_number) || null, episode: text(info.episode, 500),
    thumbnail, thumbnails: thumbnailVariants.slice(0, 12).map(item => ({ url: safeImage(item?.url), width: Number(item?.width) || 0, height: Number(item?.height) || 0 })).filter(item => item.url),
    categories: Array.isArray(info.categories) ? info.categories.slice(0, 50).map(item => text(String(item), 200)) : [],
    tags: Array.isArray(info.tags) ? info.tags.slice(0, 250).map(item => text(String(item), 200)) : [],
    chapters: Array.isArray(info.chapters) ? info.chapters.slice(0, 200).map(chapter => ({ start_time: Number(chapter?.start_time) || 0, end_time: Number(chapter?.end_time) || 0, title: text(chapter?.title, 500) })) : [],
    commentsCaptureLimit: 50,
    commentsReturnedByExtractor: Array.isArray(info.comments) ? info.comments.length : null,
    extractorFields: stableExtractorMetadata(info)
  };
  for (const key of numbers) metadata[key] = Number.isFinite(Number(info[key])) ? Number(info[key]) : null;
  const prior = database.prepare('SELECT metadata_json AS value FROM video_metadata WHERE video_id = ?').get(id)?.value;
  let previous = {};
  try { previous = JSON.parse(prior || '{}'); } catch {}
  database.prepare(`INSERT INTO video_metadata (video_id, metadata_json, local_assets_json, updated_at) VALUES (?, ?, '[]', ?)
    ON CONFLICT(video_id) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
    .run(id, JSON.stringify({ ...previous, ...metadata }), new Date().toISOString());
}

function saveLocalVideoMetadataSnapshot(id, localAssets = []) {
  const video = database.prepare(`SELECT video_id AS id, url, title, channel, channel_key AS channelKey, channel_url AS channelUrl,
    thumbnail, avatar, duration, meta, kind, section, topic FROM videos WHERE video_id = ?`).get(id);
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
  if (/this video requires payment to watch|requires a payment|paid content|purchase this video/i.test(raw)) {
    return {
      status: 'unavailable', nextAttemptAt: 'never',
      message: `${human || 'This video requires payment to watch.'} No duration lookup will be retried automatically.`
    };
  }
  if (/this live stream recording is not available|live stream recording.*(?:unavailable|not available)/i.test(raw)) {
    return {
      status: 'unavailable', nextAttemptAt: 'never',
      message: `${human || 'This live stream recording is not available.'} No duration lookup will be retried automatically.`
    };
  }
  return null;
}

function saveClassifiedDurationFailure(id, classification) {
  if (classification.status === 'upcoming') {
    database.prepare("UPDATE videos SET duration = 'UPCOMING' WHERE video_id = ? AND (trim(duration) = '' OR upper(trim(duration)) = 'UPCOMING')").run(id);
    setDurationLookup(id, 'upcoming', classification.message, classification.nextAttemptAt);
  } else {
    setDurationLookup(id, 'unavailable', classification.message, 'never');
  }
}

function queueExtensionMetadataCapture(id, reason = '') {
  const savedDuration = database.prepare('SELECT duration FROM videos WHERE video_id = ?').get(id)?.duration || '';
  if (String(savedDuration).trim() && !/^UPCOMING$/i.test(String(savedDuration).trim())) {
    setDurationLookup(id, 'ready', 'Video length is already present in the local library.');
    return;
  }
  const detail = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const reasonText = ageConfirmationPattern.test(detail)
    ? 'YouTube requires age confirmation.'
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
  if (previous?.status === 'unavailable' && previous.nextAttemptAt === 'never') return;
  if (!['extension', 'capturing', 'extension-retry', 'ready'].includes(previous?.status)) {
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
      const blocked = /HTTP Error 429|too many requests|rate.?limit|sign in to confirm|confirm you(?:'|’)re not a bot|temporarily blocked/i.test(stderr);
      if (duration === 'UPCOMING') {
        const releaseTimestamp = Number(info?.release_timestamp || info?.release_time || info?.timestamp);
        const retryAt = Number.isFinite(releaseTimestamp) && releaseTimestamp > Date.now() / 1000
          ? new Date(releaseTimestamp * 1000 + 15 * 60_000).toISOString()
          : new Date(Date.now() + 6 * 60 * 60_000).toISOString();
        setDurationLookup(id, 'upcoming', 'Upcoming live event or premiere. Video length will be checked again after it begins.', retryAt);
      } else if (duration) setDurationLookup(id, 'ready');
      else {
        const classified = classifyDurationFailure(stderr);
        if (classified) saveClassifiedDurationFailure(id, classified);
        else queueExtensionMetadataCapture(id, ageRestricted ? stderr : stderr.trim() || 'No duration metadata was returned.');
      }
      complete({ duration, blocked, ageRestricted, terminal: !duration && classifyDurationFailure(stderr)?.status === 'unavailable', extensionQueued: !duration && !classifyDurationFailure(stderr) });
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
    try {
      if (output.length > 2_000_000) throw new Error('Metadata exceeded the size limit.');
      const info = JSON.parse(output.trim());
      lookup.status = saveVideoChannel(id, info) ? 'ready' : 'unavailable';
    } catch {
      lookup.status = 'unavailable';
    }
  });
}

function beginComments(id) {
  if (commentJobs.has(id)) return;
  const video = database.prepare('SELECT url FROM videos WHERE video_id = ?').get(id);
  if (!video) return;
  saveComments(id, 'loading', [], 'Loading comments…');
  const args = [
    '--ignore-config', '--no-cookies', '--no-color', '--no-warnings', '--no-progress',
    '--skip-download', '--write-comments', '--dump-single-json',
    '--extractor-args', 'youtube:comment_sort=top;max_comments=50,50,50,50,2', video.url
  ];
  const child = spawn(process.env.YT_DLP_PATH || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  commentJobs.set(id, child);
  let output = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > 12_000_000) child.kill();
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-3000); });
  const timeout = setTimeout(() => {
    if (!commentJobs.has(id)) return;
    saveComments(id, 'error', [], 'Comment lookup timed out. Trying the rendered YouTube page through the extension.');
    queueExtensionMetadataCapture(id, 'Comment lookup timed out.');
    commentJobs.delete(id);
    child.kill();
  }, 90_000);
  timeout.unref();
  child.on('error', error => {
    clearTimeout(timeout);
    const message = error.code === 'ENOENT' ? 'yt-dlp is unavailable; comments could not be loaded.' : 'Could not start comment lookup.';
    saveComments(id, 'error', [], message);
    queueExtensionMetadataCapture(id, message);
    commentJobs.delete(id);
  });
  child.on('close', code => {
    clearTimeout(timeout);
    if (!commentJobs.has(id)) return;
    try {
      if (output.length > 12_000_000) throw new Error('Comment data exceeded the size limit.');
      const info = JSON.parse(output.trim());
      const comments = cleanComments(info.comments);
      saveVideoChannel(id, info);
      saveComments(id, 'ready', comments, comments.length ? '' : 'No comments were returned for this video.');
    } catch {
      const blocked = /comments? (?:are )?disabled|comments? (?:are )?turned off/i.test(stderr);
      const ageRestricted = ageConfirmationPattern.test(stderr);
      const message = blocked
        ? 'Comments are disabled for this video.'
        : ageRestricted
          ? 'YouTube requires age confirmation. Waiting for the extension to capture metadata from the signed-in browser page.'
          : code === 0 ? 'yt-dlp returned unusable comment metadata.' : 'Comments could not be loaded. Trying the rendered YouTube page through the extension.';
      const isReady = blocked;
      saveComments(id, isReady ? 'ready' : 'error', [], message);
      if (!isReady) queueExtensionMetadataCapture(id, ageRestricted ? stderr : message);
    }
    commentJobs.delete(id);
  });
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
  const thumbnail = metadataThumbnailCandidates(video).find(source => existingCachedImage(source));
  if (!thumbnail) gaps.push('thumbnail');
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
  for (const source of [thumbnail, video.avatar, ...commentImages].filter(Boolean)) {
    if (existingCachedImage(source) && !indexedAssets.has(source)) gaps.push('local asset index');
  }
  return [...new Set(gaps)];
}

function reconcileDownloadedMetadata(ids) {
  let pending = 0;
  for (const id of ids) {
    const video = database.prepare('SELECT thumbnail, avatar FROM videos WHERE video_id = ?').get(id);
    const comments = commentsForMetadata(id);
    const cachedThumbnail = metadataThumbnailCandidates({ id, thumbnail: video?.thumbnail }).find(source => existingCachedImage(source));
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
    const knownAvatar = database.prepare(`SELECT avatar FROM channels WHERE channel_key = ? AND trim(avatar) <> ''
      UNION ALL SELECT avatar FROM subscriptions WHERE channel_key = ? AND trim(avatar) <> '' LIMIT 1`).get(video.channelKey, video.channelKey)?.avatar;
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
  let localThumbnail = thumbnailCandidates.find(source => existingCachedImage(source)) || '';
  for (const source of thumbnailCandidates) {
    if (localThumbnail) break;
    if (await cacheRemoteImage(source)) localThumbnail = source;
  }
  if (!localThumbnail) throw new Error('The video thumbnail could not be stored locally; it will retry later.');
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
  if (!item) return;

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
  if (getStoredMediaPath(id)) {
    saveDownload(id, 'ready', '', 100, 'Ready to play');
    return { status: 'ready', message: '', progress: 100, stage: 'Ready to play', mediaExtension: getStoredMediaExtension(id) };
  }

  if (jobs.has(id)) return getDownload(id) || { status: 'downloading', message: '' };
  const video = database.prepare('SELECT url, duration FROM videos WHERE video_id = ?').get(id);
  if (!video) return null;

  const allowMp4Fallback = hasFiniteVideoDuration(video.duration);
  const format = ffmpegAvailable
    ? `bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]${allowMp4Fallback ? '/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]' : ''}`
    : `best[ext=webm]${allowMp4Fallback ? '/best[ext=mp4]' : ''}`;
  const args = [
    '--ignore-config', '--no-cookies', '--no-playlist', '--no-color', '--newline', '--progress', '--progress-delta', '0.5',
    '--progress-template', 'download:YT_PROGRESS:%(progress._percent_str)s', '--format', format,
    '--print', 'before_dl:YT_LIVE:%(live_status)s', '--merge-output-format', 'webm/mp4', '--output', path.join(mediaDirectory, '%(id)s.%(ext)s'), video.url
  ];
  saveDownload(id, 'downloading', '', 0, 'Checking video formats…');
  const startedAt = database.prepare('SELECT started_at AS value FROM downloads WHERE video_id = ?').get(id)?.value || new Date().toISOString();
  const job = { status: 'downloading', progress: 0, stage: 'Checking video formats…', startedAt, transferStarted: false, offlinePauseRequested: false, pauseRequested: false, finishRequested: false, finishPhase: '', isLive: false, endRequested: false, discardRequested: false };
  jobs.set(id, job);
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
    jobs.delete(id);
  });
  downloadProcess.on('close', async code => {
    if (!jobs.has(id)) return;
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
        saveDownload(id, 'ready', '', 100, 'Ready to play');
      } catch (error) {
        if (error.code === 'WAITING_FOR_ONLINE') markFinishWaitingForOnline(id, job.progress);
        else {
          const message = `Finish and save could not complete yet: ${error.message} The captured files are preserved; retry when ready.`;
          markDownloadPausedByUser(id, job.progress, message);
        }
      }
      jobs.delete(id);
      return;
    }
    if (job.endRequested) {
      try {
        await finalizePartialWebm(id, { allowLongerAudio: true });
        saveDownload(id, 'ready', '', 100, 'Ready to play');
      } catch (error) {
        const message = `Could not finish and save this live capture: ${error.message} The captured files are paused; retry to continue downloading.`;
        markDownloadPausedByUser(id, job.progress, message);
      }
      jobs.delete(id);
      return;
    }
    if (job.pauseRequested) {
      if (getStoredMediaPath(id)) {
        saveDownload(id, 'ready', '', 100, 'Ready to play');
      } else {
        markDownloadPausedByUser(id, job.progress);
      }
      jobs.delete(id);
      return;
    }
    if (job.offlinePauseRequested) {
      if (getStoredMediaPath(id)) {
        saveDownload(id, 'ready', '', 100, 'Ready to play');
      } else {
        if (offlinePreparationRequested || networkMode === 'offline') markDownloadPausedOffline(id);
        else queueCancelledDownloadForOnline(id);
      }
      jobs.delete(id);
      return;
    }
    if (job.discardRequested) {
      try { await discardDownloadFiles(id); } catch (error) { console.error(`Could not discard live capture ${id}:`, error); }
      database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
      saveDownload(id, 'discarded', 'Live capture discarded.', 0, 'Discarded');
      jobs.delete(id);
      return;
    }
    try {
      if (!getStoredMediaPath(id)) throw new Error('No complete local media file was created.');
      saveDownload(id, 'ready', '', 100, 'Ready to play');
    } catch {
      const unsupported = /requested format is not available|no video formats found|requested format not available/i.test(ytOutput);
      const signInRequired = /sign in to confirm (?:you(?:'|’)re|you are) not a bot/i.test(ytOutput);
      const lastErrorLine = ytOutput.split(/\r?\n/).map(line => line.trim()).filter(line => /^ERROR:/i.test(line)).at(-1)?.replace(/https?:\/\/\S+/g, '[URL]');
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
    jobs.delete(id);
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
  const entries = await readdir(mediaDirectory);
  const candidates = entries.filter(name => name.startsWith(`${id}.`) && !name.endsWith('.ytdl') && !name.includes('.finalizing.'));
  const sizes = await Promise.all(candidates.map(async name => {
    try { return (await stat(path.join(mediaDirectory, name))).size; } catch { return 0; }
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

async function discardDownloadFiles(id) {
  const entries = await readdir(mediaDirectory);
  await Promise.all(entries.filter(name => name.startsWith(`${id}.`)).map(name => unlink(path.join(mediaDirectory, name)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  })));
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
      const deleted = database.prepare("DELETE FROM downloads WHERE video_id = ? AND status = 'ready' AND expires_at = ?").run(item.id, item.expiresAt);
      database.exec('COMMIT');
      if (deleted.changes) console.log(`Auto-deleted expired local video ${item.id}`);
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      console.error(`Could not auto-delete expired local video ${item.id}:`, error);
    }
  }
}

async function finalizePartialWebm(id, { allowLongerAudio = false, requireAudioThroughVideo = false } = {}) {
  const outputPath = path.join(mediaDirectory, `${id}.webm`);
  const finalizeError = (code, message) => Object.assign(new Error(message), { code });
  const names = await readdir(mediaDirectory);
  const candidates = names
    .filter(name => name.startsWith(`${id}.`) && /\.webm(?:\.part)?$/i.test(name) && !name.includes('.finalizing.'))
    .map(name => path.join(mediaDirectory, name));
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
  const temporaryPath = path.join(mediaDirectory, `${id}.finalizing.webm`);
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
  const outputPath = path.join(mediaDirectory, `${id}.finish-audio.webm`);
  const files = await readdir(mediaDirectory);
  await Promise.all(files
    .filter(name => name.startsWith(`${id}.finish-audio.`))
    .map(name => unlink(path.join(mediaDirectory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; })));

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
    .then(() => saveDownload(item.id, 'ready', '', 100, 'Ready to play'))
    .catch(error => {
      if (error.code === 'WAITING_FOR_ONLINE') {
        markFinishWaitingForOnline(item.id, job.progress);
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
  const extensionMetadataRoute = url.pathname === '/api/extension/metadata-capture-jobs' || url.pathname === '/api/extension/video-metadata';
  if (extensionOrigin && (extensionMetadataRoute || url.pathname === '/api/sync' || url.pathname === '/api/search-sync' || url.pathname === '/api/channel-sync' || url.pathname === '/api/mode' || /^\/api\/(?:search-sessions\/[a-f0-9-]{36}|channel-captures\/(?:[a-f0-9-]{36}(?:\/status)?|batch))$/i.test(url.pathname))) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (request.method === 'OPTIONS' && (extensionMetadataRoute || url.pathname === '/api/sync' || url.pathname === '/api/search-sync' || url.pathname === '/api/channel-sync' || url.pathname === '/api/mode' || /^\/api\/(?:search-sessions\/[a-f0-9-]{36}|channel-captures\/(?:[a-f0-9-]{36}(?:\/status)?|batch))$/i.test(url.pathname)) && extensionOrigin) {
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
        const readyMedia = database.prepare("SELECT video_id AS id, acquired_at AS acquiredAt, expires_at AS expiresAt, expiry_paused_ms AS pausedMs FROM downloads WHERE status = 'ready'").all();
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

  if (request.method === 'GET' && url.pathname === '/api/mode') {
    sendJson(response, 200, {
      mode: reportedNetworkMode(), preparation: offlinePreparation,
      internetAvailable: connectivityStatus.available, connectivityNotice
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/mode') {
    try {
      const body = await readBody(request);
      if (!['online', 'offline'].includes(body.mode)) { sendJson(response, 400, { error: 'Mode must be online or offline.' }); return; }
      const requestGeneration = ++networkModeRequestGeneration;
      if (body.mode === 'online') {
        await checkInternetConnectivity();
        if (requestGeneration !== networkModeRequestGeneration) {
          sendJson(response, 409, { mode: reportedNetworkMode(), preparation: offlinePreparation, internetAvailable: connectivityStatus.available, connectivityNotice });
          return;
        }
        if (!connectivityStatus.available) {
          switchOfflineForConnectionLoss();
          sendJson(response, 503, { error: connectivityNotice, mode: 'offline', preparation: offlinePreparation, internetAvailable: false, connectivityNotice });
          return;
        }
        const resumePreparation = offlinePreparationPaused;
        const resumePhase = offlinePreparation.phase || 'video lengths';
        const resumeCompleted = Number(offlinePreparation.completed) || 0;
        const resumeTotal = Number(offlinePreparation.total) || 0;
        offlinePreparationRun += 1;
        offlinePreparationRequested = false;
        offlinePreparationPaused = false;
        offlinePreparationBackground = resumePreparation;
        networkMode = 'online';
        noInternetFallback = false;
        connectivityNotice = '';
        const now = new Date().toISOString();
        // Resume the original schedule. Resetting next_retry_at here made every
        // Online toggle extend the wait, even when the retry was already due.
        database.prepare("UPDATE download_retry_queue SET status = 'pending', updated_at = ? WHERE status = 'paused-offline'").run(now);
        database.prepare("UPDATE downloads SET status = 'error', message = 'Retry queued after returning Online.', stage = 'Waiting to retry', updated_at = ? WHERE status = 'paused-offline'").run(now);
        setOfflinePreparationTarget(resumePreparation ? 'background' : 'online');
        offlinePreparation = resumePreparation
          ? { status: 'queued', phase: resumePhase, completed: resumeCompleted, total: resumeTotal, message: 'Resuming preparation in the background while YourTube stays Online.' }
          : { status: 'idle', phase: 'comments', completed: 0, total: 0, message: '' };
        database.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ('network_mode', 'online', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = 'online', updated_at = excluded.updated_at").run(new Date().toISOString());
        if (resumePreparation) saveOfflinePreparationCheckpoint(offlinePreparation);
        sendJson(response, 200, { mode: networkMode, preparation: offlinePreparation, internetAvailable: true, connectivityNotice });
        if (resumePreparation) setTimeout(() => { if (networkMode === 'online' && offlinePreparationBackground) prepareOfflineCache({ backgroundOnly: true }).catch(error => console.error('Background preparation:', error)); }, 0);
        return;
      }
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

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/downloads') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(playerPage);
    return;
  }

  const localChannelMatch = /^\/channel\/(.+)$/.exec(url.pathname);
  if (request.method === 'GET' && localChannelMatch) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }

  const watchMatch = /^\/watch\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
  if (request.method === 'GET' && watchMatch) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(playerPage);
    return;
  }

  const mediaMatch = /^\/media\/([A-Za-z0-9_-]{11})\.webm$/.exec(url.pathname);
  if (mediaMatch && ['GET', 'HEAD'].includes(request.method)) {
    await serveMedia(request, response, mediaMatch[1]);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/videos') {
    const rows = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind, v.section, v.topic, v.position, v.last_seen AS seenAt, d.acquired_at AS acquiredAt,
        (SELECT vp.category FROM video_provisions vp WHERE vp.video_id = v.video_id ORDER BY vp.last_seen DESC, vp.category LIMIT 1) AS sourceProvisionCategory,
        (SELECT vp.last_seen FROM video_provisions vp WHERE vp.video_id = v.video_id ORDER BY vp.last_seen DESC, vp.category LIMIT 1) AS sourceProvisionSeenAt,
        (SELECT ci.channel_key FROM channel_items ci WHERE ci.video_id = v.video_id ORDER BY ci.added_at DESC, ci.channel_key LIMIT 1) AS sourceChannelKey,
        (SELECT ci.tab_key FROM channel_items ci WHERE ci.video_id = v.video_id ORDER BY ci.added_at DESC, ci.channel_key LIMIT 1) AS sourceTab,
        (SELECT ci.added_at FROM channel_items ci WHERE ci.video_id = v.video_id ORDER BY ci.added_at DESC, ci.channel_key LIMIT 1) AS sourceSeenAt,
        CASE WHEN d.video_id IS NULL THEN 0 ELSE 1 END AS downloaded, COALESCE(w.view_count, 0) AS viewCount,
        COALESCE(pref.not_interested, 0) AS notInterested, CASE WHEN blocked.channel_key IS NULL THEN 0 ELSE 1 END AS channelBlocked
      FROM videos v LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_views w ON w.video_id = v.video_id
      LEFT JOIN video_preferences pref ON pref.video_id = v.video_id
      LEFT JOIN blocked_channels blocked ON blocked.channel_key = lower(trim(v.channel))
      WHERE (? = 0 OR d.video_id IS NOT NULL) AND (v.section <> 'channel' OR d.video_id IS NOT NULL)
      ORDER BY v.last_seen DESC, v.position ASC, v.first_seen DESC, v.video_id
    `).all(mediaDiscoveryPaused() ? 1 : 0);
    sendJson(response, 200, rows.map(video => {
      if (video.sourceChannelKey && video.sourceSeenAt &&
          (!video.sourceProvisionSeenAt || video.sourceSeenAt >= video.sourceProvisionSeenAt)) {
        const tabLabel = ({ home: 'Home', videos: 'Videos', shorts: 'Shorts', streams: 'Live', playlists: 'Playlists', community: 'Community' })[video.sourceTab] || 'Videos';
        video.sourceLabel = `From ${video.sourceChannelKey} · ${tabLabel}`;
      } else {
        video.sourceSeenAt = video.sourceProvisionSeenAt || video.seenAt;
        if (video.sourceProvisionCategory === 'other') video.sourceLabel = 'From YouTube page';
      }
      return video;
    }));
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
    const captures = database.prepare(`SELECT capture_id AS captureId, tab_key AS tab, status, phase, message,
        video_count AS videoCount, created_at AS createdAt, updated_at AS updatedAt
      FROM channel_captures c WHERE channel_key = ? AND NOT EXISTS (
        SELECT 1 FROM channel_captures newer WHERE newer.channel_key = c.channel_key
          AND newer.tab_key = c.tab_key AND newer.created_at > c.created_at
      ) ORDER BY tab_key`).all(channelKey);
    const captureId = String(url.searchParams.get('captureId') || '');
    const capture = /^[a-f0-9-]{36}$/i.test(captureId)
      ? database.prepare(`SELECT capture_id AS captureId, tab_key AS tab, status, phase, message,
          video_count AS videoCount, created_at AS createdAt, updated_at AS updatedAt
          FROM channel_captures WHERE capture_id = ? AND channel_key = ?`).get(captureId, channelKey) || null
      : database.prepare(`SELECT capture_id AS captureId, tab_key AS tab, status, phase, message,
          video_count AS videoCount, created_at AS createdAt, updated_at AS updatedAt
          FROM channel_captures WHERE channel_key = ? AND tab_key = ? ORDER BY created_at DESC LIMIT 1`).get(channelKey, tab) || null;
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
      const channelUrl = `https://www.youtube.com/${channelKey}`;
      database.prepare(`INSERT INTO channels (channel_key, channel_url, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_key) DO UPDATE SET channel_url = excluded.channel_url, updated_at = excluded.updated_at`)
        .run(channelKey, channelUrl, now, now);
      const findActive = database.prepare(`SELECT capture_id AS captureId, tab_key AS tab, status, phase, message
        FROM channel_captures WHERE channel_key = ? AND tab_key = ? AND created_at >= ?
          AND status IN ('opening', 'collecting', 'queued', 'paused')
        ORDER BY created_at DESC LIMIT 1`);
      const insert = database.prepare(`INSERT INTO channel_captures
        (capture_id, channel_key, tab_key, status, phase, video_count, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`);
      const result = captures.map((job, index) => {
        const active = findActive.get(channelKey, job.tab, activeSince);
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
    const source = mediaDiscoveryPaused() || url.searchParams.get('source') === 'local' ? 'local' : 'youtube';
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '5', 10);
    const requestedOffset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(20, requestedLimit)) : 5;
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.min(1000000, requestedOffset)) : 0;
    if (!query) { sendJson(response, 200, { videos: [], total: 0, localTotal: 0, localVideos: [], offset, limit, hasMore: false }); return; }
    const searchable = "lower(v.title || ' ' || v.channel || ' ' || v.meta)";
    const sourceFilter = source === 'local' ? ' AND d.video_id IS NOT NULL' : ' AND d.video_id IS NULL';
    const matching = `instr(${searchable}, lower(?)) > 0${sourceFilter}`;
    const matchTotal = database.prepare(`SELECT COUNT(*) AS total FROM videos v LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready' WHERE ${matching}`).get(query).total;
    const localMatching = `instr(${searchable}, lower(?)) > 0 AND d.video_id IS NOT NULL`;
    const localTotal = database.prepare(`SELECT COUNT(*) AS total FROM videos v LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready' WHERE ${localMatching}`).get(query).total;
    const localVideos = database.prepare(`
      SELECT v.video_id AS id, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.duration
      FROM videos v JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      WHERE instr(${searchable}, lower(?)) > 0
      ORDER BY CASE WHEN instr(lower(v.title), lower(?)) > 0 THEN 0 ELSE 1 END,
        v.last_seen DESC, v.position ASC, v.video_id LIMIT 4
    `).all(query, query);
    const videos = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind, v.section, v.topic,
        v.last_seen AS seenAt, d.acquired_at AS acquiredAt,
        CASE WHEN d.video_id IS NULL THEN 0 ELSE 1 END AS downloaded, COALESCE(w.view_count, 0) AS viewCount
      FROM videos v LEFT JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE ${matching}
      ORDER BY CASE WHEN instr(lower(v.title), lower(?)) > 0 THEN 0 ELSE 1 END,
        v.last_seen DESC, v.position ASC, v.video_id
      LIMIT ? OFFSET ?
    `).all(query, query, limit, offset);
    sendJson(response, 200, { videos, total: matchTotal, localTotal, localVideos, offset, limit, hasMore: offset + videos.length < matchTotal });
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
      if (!/^[a-f0-9-]{36}$/i.test(searchId) || query.length < 2 || payload.source === 'local') {
        sendJson(response, 400, { error: 'A YouTube stub search is required.' });
        return;
      }
      const normalizedQuery = query.toLocaleLowerCase();
      const searchedAt = new Date().toISOString();
      database.prepare(`INSERT INTO search_history (search_id, query, normalized_query, searched_at, selected_video_id)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(search_id) DO UPDATE SET query = excluded.query,
        normalized_query = excluded.normalized_query, searched_at = excluded.searched_at,
        selected_video_id = excluded.selected_video_id`)
        .run(searchId, query, normalizedQuery, searchedAt, selectedVideoId);
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
    const rows = database.prepare('SELECT channel_key AS key, name, avatar, position FROM subscriptions ORDER BY position').all();
    sendJson(response, 200, rows);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/queue') {
    const rows = database.prepare(`
      SELECT q.item_id AS itemId, q.position, q.added_at AS addedAt,
        v.video_id AS id, v.url, v.title, v.channel, v.thumbnail, v.avatar, v.duration,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.duration, 0) AS progressDuration,
        COALESCE(p.completed, 0) AS completed,
        CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded
      FROM playback_queue q JOIN videos v ON v.video_id = q.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      ORDER BY q.position, q.item_id
    `).all();
    sendJson(response, 200, rows);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/queue') {
    try {
      const body = await readBody(request);
      const videoId = String(body.videoId || '');
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(videoId)) {
        sendJson(response, 404, { error: 'Video not found in the local library.' }); return;
      }
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

  if (request.method === 'GET' && url.pathname === '/api/playlists') {
    const rows = database.prepare(`
      SELECT p.playlist_id AS id, p.title, p.source, p.kind, p.source_url AS sourceUrl, p.channel,
        p.thumbnail, p.declared_item_count AS declaredItemCount, p.is_complete AS isComplete,
        p.created_at AS createdAt, p.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.playlist_id) AS capturedCount
      FROM playlists p
      ORDER BY CASE p.source WHEN 'local' THEN 0 ELSE 1 END, p.updated_at DESC, p.title COLLATE NOCASE
    `).all();
    sendJson(response, 200, rows);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/playlists') {
    try {
      const body = await readBody(request);
      const title = cleanRepeatedLabel(body.title).slice(0, 120);
      if (!title) { sendJson(response, 400, { error: 'Enter a playlist name.' }); return; }
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
          i.item_id AS itemId, i.position, i.added_at AS addedAt, d.acquired_at AS acquiredAt,
          CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded,
          COALESCE(w.view_count, 0) AS viewCount
        FROM playlist_items i JOIN videos v ON v.video_id = i.video_id
        LEFT JOIN downloads d ON d.video_id = v.video_id
        LEFT JOIN video_views w ON w.video_id = v.video_id
        WHERE i.playlist_id = ? ORDER BY i.position ASC, i.added_at ASC
      `).all(playlistId);
      sendJson(response, 200, { ...playlist, isComplete: Boolean(playlist.isComplete), items });
      return;
    }

    if (request.method === 'PATCH' && !action) {
      if (!playlist) { sendJson(response, 404, { error: 'Playlist not found.' }); return; }
      if (playlist.source !== 'local' || playlist.kind === 'watch-later') { sendJson(response, 409, { error: 'This playlist cannot be renamed.' }); return; }
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
      if (playlist.source !== 'local' || playlist.kind === 'watch-later') { sendJson(response, 409, { error: 'This playlist cannot be deleted.' }); return; }
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
      if (playlist.source !== 'local') { sendJson(response, 409, { error: 'YouTube playlists are read-only in YourTube.' }); return; }
      try {
        const body = await readBody(request);
        const videoId = String(body.videoId || '');
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !database.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(videoId)) {
          sendJson(response, 404, { error: 'Video not found in the local library.' }); return;
        }
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
      if (playlist.source !== 'local') { sendJson(response, 409, { error: 'YouTube playlists are read-only in YourTube.' }); return; }
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
      if (playlist.source !== 'local') { sendJson(response, 409, { error: 'YouTube playlists are read-only in YourTube.' }); return; }
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
    const mediaFiles = await readdir(mediaDirectory);
    const validMediaFiles = mediaFiles.filter(name => /^[A-Za-z0-9_-]{11}\.(?:webm|mp4)$/i.test(name));
    const mediaStats = await Promise.all(validMediaFiles.map(async name => {
      try { return await stat(path.join(mediaDirectory, name)); } catch { return null; }
    }));
    const localFiles = mediaStats.filter(Boolean).length;
    const mediaBytes = mediaStats.reduce((total, file) => total + (file?.size || 0), 0);
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
    const pausedDownloads = database.prepare("SELECT COUNT(*) AS total FROM download_retry_queue WHERE status IN ('paused', 'paused-offline')").get().total;
    const queuedDownloads = database.prepare("SELECT COUNT(*) AS total FROM download_retry_queue WHERE status = 'pending'").get().total;
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
    sendJson(response, 200, { localFiles, mediaBytes, historicalViews, extensionVideos, activeDownloads, pausedDownloads, queuedDownloads,
      activeChannelCaptures, durationLookupActive, pendingDurations, durationBaseline, downloadMetadata });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/extension/metadata-capture-jobs' && extensionOrigin) {
    if (reportedNetworkMode() !== 'online' || connectivityStatus.available === false) {
      sendJson(response, 200, { job: null, mode: reportedNetworkMode() });
      return;
    }
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
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
    const job = database.prepare(`SELECT v.video_id AS videoId, v.url, v.title
      FROM video_duration_lookups l JOIN videos v ON v.video_id = l.video_id
      WHERE l.extension_attempts < 3 AND (l.status = 'extension' OR (l.status = 'extension-retry' AND l.updated_at <= ?))
      ORDER BY CASE l.status WHEN 'extension' THEN 0 ELSE 1 END, l.updated_at ASC LIMIT 1`).get(retryBefore);
    if (!job) {
      sendJson(response, 200, { job: null, mode: reportedNetworkMode() });
      return;
    }
    database.prepare("UPDATE video_duration_lookups SET status = 'capturing', extension_attempts = extension_attempts + 1, message = 'The extension is opening this video in the signed-in YouTube browser to read its rendered metadata.', updated_at = ? WHERE video_id = ? AND status IN ('extension', 'extension-retry')")
      .run(now, job.videoId);
    sendJson(response, 200, { job, mode: reportedNetworkMode() });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/extension/video-metadata' && extensionOrigin) {
    try {
      const parsed = await readBody(request);
      const id = String(parsed.videoId || '');
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) { sendJson(response, 400, { error: 'A valid video ID is required.' }); return; }
      const video = database.prepare('SELECT url FROM videos WHERE video_id = ?').get(id);
      if (!video) { sendJson(response, 404, { error: 'The video stub no longer exists.' }); return; }
      const now = new Date().toISOString();
      const current = database.prepare('SELECT status FROM video_duration_lookups WHERE video_id = ?').get(id);
      if (!current || !['capturing', 'extension', 'extension-retry'].includes(current.status)) {
        sendJson(response, 409, { error: 'This extension metadata capture is no longer queued.' }); return;
      }
      const hasPageData = Boolean(parsed.title || parsed.channel || parsed.thumbnail || parsed.avatar || Number(parsed.durationSeconds) > 0 || parsed.commentsCaptured === true);
      if (parsed.failed === true && !hasPageData) {
        const message = String(parsed.message || 'YouTube did not expose the requested metadata in the browser page.').replace(/\s+/g, ' ').slice(0, 400);
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
      const tags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 100).map(value => String(value).slice(0, 200)) : [];
      const info = {
        id, title, fulltitle: title, channel, uploader: channel, channel_id: channelId, channel_url: channelUrl,
        uploader_url: channelUrl, duration: durationSeconds, duration_string: duration,
        thumbnail, channel_thumbnail: avatar, description, view_count: viewCount, tags,
        webpage_url: video.url, extractor: 'youtube-page', extractor_key: 'YoutubePage',
        metadata_source: 'youtube-page', extractorMetadataCaptured: false
      };
      saveVideoMetadataFromInfo(id, info);
      if (duration) saveVideoDuration(id, { duration: durationSeconds || undefined, duration_string: duration });
      if (Array.isArray(parsed.comments) && parsed.commentsCaptured === true) {
        const comments = cleanComments(parsed.comments);
        saveComments(id, 'ready', comments, comments.length ? 'Comments captured from the rendered YouTube page.' : 'No comments were rendered on the YouTube page.');
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
        recordExtensionDuration(parsed.extensionVersion, { id, duration: String(savedDuration).trim() }, 'metadata-fallback', now);
        setDurationLookup(id, 'ready', 'Video length captured from the rendered YouTube page by the extension.');
        const downloaded = database.prepare("SELECT 1 FROM downloads WHERE video_id = ? AND status = 'ready'").get(id);
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

  if (request.method === 'GET' && url.pathname === '/api/background-queue') {
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
      WHERE q.status IN ('pending', 'waiting-live') ORDER BY q.next_retry_at, q.updated_at`).all();
    const heldMedia = database.prepare(`SELECT q.video_id AS videoId, v.title, v.channel, q.status,
      COALESCE(d.stage, 'Paused') AS phase,
      COALESCE(NULLIF(q.last_error, ''), d.message, '') AS message,
      q.attempts, q.next_retry_at AS nextAttemptAt, q.updated_at AS updatedAt
      FROM download_retry_queue q LEFT JOIN videos v ON v.video_id = q.video_id
      LEFT JOIN downloads d ON d.video_id = q.video_id
      WHERE q.status IN ('paused', 'paused-offline', 'paused-limit', 'exhausted') ORDER BY q.updated_at DESC`).all();
    const localMetadata = database.prepare(`SELECT d.video_id AS videoId, v.title, v.channel,
      COALESCE(m.status, 'pending') AS status, COALESCE(m.phase, 'queued') AS phase,
      COALESCE(m.message, 'Waiting for local metadata preparation.') AS message,
      COALESCE(m.attempts, 0) AS attempts, m.next_attempt_at AS nextAttemptAt,
      COALESCE(m.updated_at, d.updated_at) AS updatedAt
      FROM downloads d JOIN videos v ON v.video_id = d.video_id
      LEFT JOIN download_metadata m ON m.video_id = d.video_id
      WHERE d.status = 'ready' AND COALESCE(m.status, 'pending') <> 'ready'
      ORDER BY CASE m.status WHEN 'running' THEN 0 WHEN 'retry' THEN 2 ELSE 1 END,
        d.acquired_at DESC`).all();
    const durationRows = database.prepare(`SELECT v.video_id AS videoId, v.title, v.channel,
      CASE l.status WHEN 'extension' THEN 'waiting-extension' WHEN 'capturing' THEN 'capturing' WHEN 'extension-retry' THEN 'retrying' ELSE COALESCE(l.status, 'queued') END AS status,
      CASE WHEN l.status IN ('extension', 'capturing', 'extension-retry') THEN 'Extension capture' ELSE 'Video length' END AS phase,
      COALESCE(NULLIF(l.message, ''), 'A local video length has not been saved yet.') AS message,
      l.updated_at AS updatedAt
      FROM videos v LEFT JOIN video_duration_lookups l ON l.video_id = v.video_id
      WHERE trim(v.duration) = '' AND (l.video_id IS NULL OR l.status IN ('pending', 'running', 'extension', 'capturing', 'extension-retry')
        OR (l.status = 'unavailable' AND l.next_attempt_at <> 'never' AND l.updated_at <= ?))
      ORDER BY CASE l.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'unavailable' THEN 2 ELSE 3 END,
        v.last_seen DESC`).all(new Date(Date.now() - backgroundDurationUnavailableRetryMs).toISOString());
    const durationLimits = database.prepare(`SELECT v.video_id AS videoId, v.title, v.channel, 'unavailable' AS status,
      'Video length' AS phase, l.message, l.updated_at AS updatedAt
      FROM video_duration_lookups l JOIN videos v ON v.video_id = l.video_id
      WHERE trim(v.duration) = '' AND l.status = 'unavailable' AND l.next_attempt_at = 'never'
      ORDER BY l.updated_at DESC`).all();
    const comments = database.prepare(`SELECT c.video_id AS videoId, v.title, v.channel, c.status,
      'Comments' AS phase, c.message, c.updated_at AS updatedAt
      FROM video_comments c JOIN videos v ON v.video_id = c.video_id
      WHERE c.status = 'loading' ORDER BY c.updated_at DESC`).all();
    const channelCaptures = database.prepare(`SELECT capture_id AS id, channel_key AS channel,
      tab_key AS tab, status, phase, message, video_count AS videoCount, created_at AS createdAt,
      updated_at AS updatedAt
      FROM channel_captures WHERE status IN ('opening', 'queued', 'collecting')
      ORDER BY CASE status WHEN 'collecting' THEN 0 WHEN 'opening' THEN 1 ELSE 2 END, updated_at DESC`).all()
      .map(item => ({ ...item, title: `${item.channel} · ${item.tab}` }));
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
      FROM search_sessions s WHERE s.status = 'collecting' ORDER BY s.updated_at DESC`).all()
      .map(item => ({ ...item, message: `${item.resultCount} results stored so far.` }));
    const preparation = ['queued', 'running', 'paused'].includes(offlinePreparation.status)
      ? [{ id: 'offline-preparation', title: 'Offline library preparation', status: offlinePreparation.status,
          phase: offlinePreparation.phase, message: offlinePreparation.message,
          progress: offlinePreparation.total ? Math.round(offlinePreparation.completed * 100 / offlinePreparation.total) : null,
          completed: offlinePreparation.completed, total: offlinePreparation.total }]
      : [];
    const groups = [
      { key: 'active-media', label: 'Active media downloads', items: activeMedia },
      { key: 'queued-media', label: 'Queued download attempts', items: queuedMedia },
      { key: 'held-media', label: 'Paused or held downloads', items: heldMedia },
      { key: 'local-metadata', label: 'Downloaded video metadata', items: localMetadata },
      { key: 'video-lengths', label: 'Video lengths', items: durationRows },
      { key: 'video-length-limits', label: 'Known video-length limits', items: durationLimits },
      { key: 'comments', label: 'Comment collection', items: comments },
      { key: 'channel-captures', label: 'Channel section captures', items: channelCaptures },
      { key: 'channel-metadata', label: 'Channel detail lookups', items: channelMetadata },
      { key: 'searches', label: 'YouTube search captures', items: searchSessions },
      { key: 'offline-preparation', label: 'Offline preparation', items: preparation }
    ].map(group => ({ ...group, count: group.items.length }));
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
    const videos = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind, v.section, v.topic,
        sr.position, d.acquired_at AS acquiredAt,
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
          const video = cleanVideo({ ...raw, section: 'search', topic: '' }, position);
          if (!video) return;
          recordExtensionDuration(parsed.extensionVersion, video, 'search', now);
          database.prepare(`INSERT INTO videos (video_id, url, title, channel, channel_key, channel_url, thumbnail, avatar, duration, meta, kind, section, topic, position, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'search', '', ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET url = excluded.url, title = excluded.title, channel = excluded.channel,
              channel_key = CASE WHEN excluded.channel_key <> '' THEN excluded.channel_key ELSE videos.channel_key END,
              channel_url = CASE WHEN excluded.channel_url <> '' THEN excluded.channel_url ELSE videos.channel_url END,
              thumbnail = excluded.thumbnail, avatar = excluded.avatar,
              duration = CASE WHEN trim(excluded.duration) <> '' THEN excluded.duration ELSE videos.duration END,
              meta = excluded.meta, last_seen = excluded.last_seen`)
            .run(video.id, video.url, video.title, video.channel, video.channelKey, video.channelUrl, video.thumbnail, video.avatar, video.duration, video.meta, video.kind, video.position, now, now);
          database.prepare(`INSERT INTO search_results (search_id, video_id, position) VALUES (?, ?, ?)
            ON CONFLICT(search_id, video_id) DO UPDATE SET position = excluded.position`).run(searchId, video.id, video.position);
          database.prepare(`INSERT INTO video_provisions (video_id, category, first_seen, last_seen) VALUES (?, 'search', ?, ?)
            ON CONFLICT(video_id, category) DO UPDATE SET last_seen = excluded.last_seen`).run(video.id, now, now);
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
        else database.prepare("UPDATE search_sessions SET updated_at = ? WHERE search_id = ? AND status = 'collecting'").run(now, searchId);
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
      const name = cleanRepeatedLabel(channel.name).slice(0, 200);
      const description = String(channel.description || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      const avatar = safeImage(channel.avatar);
      const banner = safeImage(channel.banner);
      const subscriberCount = cleanRepeatedLabel(channel.subscriberCount).slice(0, 80);
      const videoCount = cleanRepeatedLabel(channel.videoCount).slice(0, 80);
      const channelUrl = `https://www.youtube.com/${channelKey}`;
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
            channel = CASE WHEN excluded.channel <> '' THEN excluded.channel ELSE videos.channel END,
            channel_key = excluded.channel_key, channel_url = excluded.channel_url,
            section = CASE WHEN videos.section = 'channel' THEN excluded.section ELSE videos.section END,
            thumbnail = CASE WHEN excluded.thumbnail <> '' THEN excluded.thumbnail ELSE videos.thumbnail END,
            avatar = CASE WHEN excluded.avatar <> '' THEN excluded.avatar ELSE videos.avatar END,
            duration = CASE WHEN trim(excluded.duration) <> '' AND
              (trim(videos.duration) = '' OR upper(trim(videos.duration)) IN ('LIVE', 'UPCOMING') OR upper(trim(excluded.duration)) NOT IN ('LIVE', 'UPCOMING'))
              THEN excluded.duration ELSE videos.duration END,
            meta = CASE WHEN excluded.meta <> '' THEN excluded.meta ELSE videos.meta END,
            last_seen = videos.last_seen`);
        const saveItem = database.prepare(`INSERT INTO channel_items (channel_key, video_id, tab_key, position, added_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_key, video_id, tab_key) DO UPDATE SET position = excluded.position, added_at = excluded.added_at`);
        incomingVideos.forEach((raw, position) => {
          const video = cleanVideo({ ...raw, channel: raw.channel || name, channelKey, channelUrl }, position);
          if (!video) return;
          recordExtensionDuration(parsed.extensionVersion, video, 'channel', now);
          upsertChannelVideo.run(video.id, video.url, video.title, video.channel, channelKey, channelUrl,
            video.thumbnail, video.avatar || avatar, video.duration, video.meta, video.kind, video.position, now, now);
          saveItem.run(channelKey, video.id, session.tab, video.position, now);
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
        d.acquired_at AS acquiredAt, d.expires_at AS expiresAt, COALESCE(p.current_time, 0) AS currentTime,
        COALESCE(p.duration, 0) AS progressDuration, COALESCE(p.completed, 0) AS completed,
        1 AS downloaded, COALESCE(w.view_count, 0) AS viewCount
      FROM videos v JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE v.video_id <> ? AND COALESCE(p.completed, 0) = 0
        AND (COALESCE(p.duration, 0) <= 0 OR p.current_time < p.duration * 0.95)
      ORDER BY d.acquired_at DESC LIMIT 12
    `).all(recommendationsMatch[1]);
    const deletingSoon = autoDeleteEnabled ? database.prepare(`
      SELECT v.video_id AS id, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.duration, v.kind, v.topic,
        d.expires_at AS expiresAt, d.acquired_at AS acquiredAt,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.duration, 0) AS progressDuration,
        COALESCE(p.completed, 0) AS completed, 1 AS downloaded, COALESCE(w.view_count, 0) AS viewCount
      FROM videos v JOIN downloads d ON d.video_id = v.video_id AND d.status = 'ready'
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE v.video_id <> ? AND d.expires_at > ? AND d.expires_at <= ?
      ORDER BY d.expires_at ASC LIMIT 12
    `).all(recommendationsMatch[1], new Date().toISOString(), new Date(Date.now() + 60 * 60 * 1000).toISOString()) : [];
    const deletingSoonIds = new Set(deletingSoon.map(video => video.id));
    downloadedUnwatched = downloadedUnwatched.filter(video => !deletingSoonIds.has(video.id));
    const selectedIds = new Set([...downloadedUnwatched, ...deletingSoon].map(video => video.id));
    const recentSearches = database.prepare('SELECT search_id AS searchId, query, selected_video_id AS selectedVideoId FROM search_history ORDER BY searched_at DESC LIMIT 100').all();
    const searchCandidates = database.prepare(`
      SELECT v.video_id AS id, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.duration, v.kind, v.topic,
        COALESCE(d.status, '') = 'ready' AS downloaded,
        CASE WHEN d.status = 'ready' THEN d.acquired_at ELSE v.last_seen END AS acquiredAt,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.duration, 0) AS progressDuration,
        COALESCE(p.completed, 0) AS completed, COALESCE(w.view_count, 0) AS viewCount
      FROM search_history_results sr JOIN videos v ON v.video_id = sr.video_id
      LEFT JOIN downloads d ON d.video_id = v.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE sr.search_id = ? AND v.video_id <> ?
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
        CASE WHEN d.status = 'ready' THEN d.acquired_at ELSE v.last_seen END AS acquiredAt,
        COALESCE(p.current_time, 0) AS currentTime, COALESCE(p.duration, 0) AS progressDuration,
        COALESCE(p.completed, 0) AS completed,
        CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END AS downloaded, COALESCE(w.view_count, 0) AS viewCount
      FROM videos v JOIN video_provisions vp ON vp.video_id = v.video_id AND vp.category = 'homepage'
      LEFT JOIN downloads d ON d.video_id = v.video_id
      LEFT JOIN video_progress p ON p.video_id = v.video_id
      LEFT JOIN video_views w ON w.video_id = v.video_id
      WHERE v.video_id <> ? AND COALESCE(d.status, '') <> 'ready'
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
      if (!cached.channel && networkMode !== 'offline') beginChannelLookup(id);
      sendJson(response, 200, getComments(id) || cached);
      return;
    }
    beginComments(id);
    sendJson(response, 200, getComments(id) || { status: 'loading', comments: [], message: 'Loading comments…' });
    return;
  }

  const videoMatch = /^\/api\/videos\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
  if (request.method === 'GET' && videoMatch) {
    const video = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, COALESCE(w.view_count, 0) AS viewCount
      FROM videos v LEFT JOIN video_views w ON w.video_id = v.video_id WHERE v.video_id = ?
    `).get(videoMatch[1]);
    sendJson(response, video ? 200 : 404, video || { error: 'Video is not in the local feed.' });
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
    const exists = database.prepare('SELECT 1 AS found FROM videos WHERE video_id = ?').get(id);
    if (!exists) { sendJson(response, 404, { error: 'Video is not in the local feed.' }); return; }
    database.prepare(`
      INSERT INTO video_views (video_id, view_count, updated_at) VALUES (?, 1, ?)
      ON CONFLICT(video_id) DO UPDATE SET view_count = video_views.view_count + 1, updated_at = excluded.updated_at
    `).run(id, new Date().toISOString());
    const result = database.prepare('SELECT view_count AS viewCount FROM video_views WHERE video_id = ?').get(id);
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
        saveDownload(id, 'ready', '', 100, 'Ready to play');
        deleted += 1;
        continue;
      }
      await discardDownloadFiles(id);
      database.prepare("DELETE FROM downloads WHERE video_id = ? AND status IN ('paused', 'paused-offline')").run(id);
      database.prepare("DELETE FROM download_retry_queue WHERE video_id = ? AND status IN ('paused', 'paused-offline', 'paused-limit')").run(id);
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
    const job = jobs.get(id);
    if (!job) { sendJson(response, 404, { error: 'This download is no longer active.' }); return; }
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
    try {
      if (!getStoredMediaPath(id)) throw new Error('Downloaded file not found.');
      saveDownload(id, 'ready', '', 100, 'Ready to play');
      sendJson(response, 200, getDownload(id));
      return;
    } catch {}
    if (networkMode === 'offline' || offlinePreparationRequested) { sendJson(response, 409, { error: 'New downloads are unavailable while Offline mode is active or preparing.', mode: reportedNetworkMode() }); return; }
    const blockedUntil = Date.parse(database.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(youtubeCooldownKey)?.value || '');
    if (areDownloadProtectionsActive() && Number.isFinite(blockedUntil) && blockedUntil > Date.now()) {
      sendJson(response, 429, { error: 'YouTube is asking this connection to sign in. Automatic downloads are paused to avoid repeated requests.', retryAt: new Date(blockedUntil).toISOString() });
      return;
    }
    const retry = database.prepare('SELECT status, next_retry_at FROM download_retry_queue WHERE video_id = ?').get(id);
    const explicitlyRetried = url.searchParams.get('retry') === '1';
    if (retry && ['pending', 'waiting-live', 'running', 'exhausted'].includes(retry.status) && !jobs.has(id)) {
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
    if (retry && ['paused', 'paused-offline', 'paused-limit'].includes(retry.status) && explicitlyRetried) {
      database.prepare("UPDATE download_retry_queue SET attempts = 0, status = 'running', next_retry_at = ?, updated_at = ? WHERE video_id = ?")
        .run(new Date().toISOString(), new Date().toISOString(), id);
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

  const downloadDeleteMatch = /^\/api\/downloads\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
  if (request.method === 'DELETE' && downloadDeleteMatch) {
    const id = downloadDeleteMatch[1];
    if (jobs.has(id)) { sendJson(response, 409, { error: 'This video is still downloading.' }); return; }
    const download = database.prepare("SELECT status FROM downloads WHERE video_id = ?").get(id);
    if (!download || download.status !== 'ready') { sendJson(response, 404, { error: 'This video is not in your downloaded library.' }); return; }
    try {
      await discardDownloadFiles(id);
      database.prepare("DELETE FROM downloads WHERE video_id = ? AND status = 'ready'").run(id);
      database.prepare('DELETE FROM download_retry_queue WHERE video_id = ?').run(id);
      sendJson(response, 200, { deleted: true, id });
    } catch (error) {
      console.error(`Could not delete local media ${id}:`, error);
      sendJson(response, 500, { error: 'The local media file could not be deleted.' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/downloads') {
    const rows = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind, v.section, v.topic, d.acquired_at AS acquiredAt, d.expires_at AS expiresAt, 1 AS downloaded, COALESCE(w.view_count, 0) AS viewCount,
        m.status AS metadataStatus, m.phase AS metadataPhase, m.message AS metadataMessage
      FROM downloads d JOIN videos v ON v.video_id = d.video_id LEFT JOIN video_views w ON w.video_id = v.video_id
      LEFT JOIN download_metadata m ON m.video_id = d.video_id
      WHERE d.status = 'ready' ORDER BY d.acquired_at DESC
    `).all();
    sendJson(response, 200, rows);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/history') {
    const rows = database.prepare(`
      SELECT v.video_id AS id, v.url, v.title, v.channel, v.channel_key AS channelKey, v.channel_url AS channelUrl, v.thumbnail, v.avatar, v.duration, v.meta, v.kind,
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
      SELECT v.video_id AS id, v.title, v.channel, v.thumbnail, v.duration,
        d.progress, d.updated_at AS updatedAt, d.started_at AS startedAt,
        CASE WHEN q.status IN ('paused-offline', 'paused-limit') THEN 'paused' ELSE q.status END AS retryStatus,
        CASE WHEN q.status = 'paused-offline' THEN 'Paused for Offline mode'
          WHEN q.status = 'paused-limit' THEN 'Paused during YouTube cooldown'
          ELSE d.stage END AS stage,
        d.message AS message, q.last_error AS retryError, q.attempts AS retryAttempts,
        q.next_retry_at AS retryAt
      FROM downloads d JOIN videos v ON v.video_id = d.video_id
      LEFT JOIN download_retry_queue q ON q.video_id = d.video_id
      WHERE d.status = 'downloading' OR q.status IN ('pending', 'waiting-live', 'paused', 'paused-offline', 'paused-limit')
      ORDER BY d.updated_at DESC
    `).all();
    const withLiveStats = await Promise.all(rows.map(async row => {
      const job = jobs.get(row.id);
      return {
        ...row,
        isLive: Boolean(job?.isLive),
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
          database.prepare(`INSERT INTO video_provisions (video_id, category, first_seen, last_seen) VALUES (?, ?, ?, ?)
            ON CONFLICT(video_id, category) DO UPDATE SET last_seen = excluded.last_seen`).run(video.id, provisionCategory, now, now);
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
        incomingPlaylists.forEach(raw => {
          const playlist = cleanPlaylist(raw);
          if (!playlist) return;
          const existing = database.prepare('SELECT source FROM playlists WHERE playlist_id = ?').get(playlist.id);
          if (existing?.source === 'local') return;
          database.prepare(`INSERT INTO playlists
            (playlist_id, title, source, kind, source_url, channel, thumbnail, declared_item_count, is_complete, created_at, updated_at)
            VALUES (?, ?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(playlist_id) DO UPDATE SET
              title = excluded.title, kind = excluded.kind, source_url = excluded.source_url, channel = excluded.channel,
              thumbnail = CASE WHEN excluded.thumbnail <> '' THEN excluded.thumbnail ELSE playlists.thumbnail END,
              declared_item_count = MAX(playlists.declared_item_count, excluded.declared_item_count),
              is_complete = MAX(playlists.is_complete, excluded.is_complete), updated_at = excluded.updated_at
            WHERE playlists.source = 'youtube'`)
            .run(playlist.id, playlist.title, playlist.kind, playlist.sourceUrl, playlist.channel, playlist.thumbnail,
              playlist.itemCount, playlist.complete ? 1 : 0, now, now);
          acceptedPlaylists += 1;
          const addItem = database.prepare(`INSERT INTO playlist_items (playlist_id, video_id, position, source_key, added_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(playlist_id, source_key) DO UPDATE SET
              video_id = excluded.video_id, position = excluded.position`);
          playlist.items.forEach((video, position) => {
            const itemPosition = Number.isInteger(video.position) ? video.position : position;
            recordExtensionDuration(extensionVersion, video, 'playlist', now);
            upsertPlaylistVideo.run(video.id, video.url, video.title, video.channel, video.channelKey, video.channelUrl, video.thumbnail, video.avatar,
              video.duration, video.meta, video.kind, position, now, now);
            database.prepare(`INSERT INTO video_provisions (video_id, category, first_seen, last_seen)
              VALUES (?, 'playlist', ?, ?) ON CONFLICT(video_id, category) DO UPDATE SET last_seen = excluded.last_seen`)
              .run(video.id, now, now);
            addItem.run(playlist.id, video.id, itemPosition, `youtube:${itemPosition}`, now);
            acceptedPlaylistItems += 1;
          });
          if (playlist.complete) {
            const capturedKeys = new Set(playlist.items.map((video, position) => `youtube:${Number.isInteger(video.position) ? video.position : position}`));
            const previousItems = database.prepare("SELECT source_key AS sourceKey FROM playlist_items WHERE playlist_id = ? AND source_key LIKE 'youtube:%'").all(playlist.id);
            const removeItem = database.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND source_key = ?');
            for (const item of previousItems) if (!capturedKeys.has(item.sourceKey)) removeItem.run(playlist.id, item.sourceKey);
          }
        });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      scheduleBackgroundDurationLookup();
      const total = database.prepare('SELECT COUNT(*) AS count FROM videos').get().count;
      const withChannels = database.prepare("SELECT COUNT(*) AS count FROM videos WHERE trim(channel) <> ''").get().count;
      console.log(`Extension sync: ${acceptedVideos} cards, ${acceptedSubscriptions} subscriptions, ${acceptedPlaylists} playlists, ${acceptedPlaylistItems} playlist entries; ${withChannels} video authors stored.`);
      sendJson(response, 200, { acceptedVideos, acceptedSubscriptions, acceptedPlaylists, acceptedPlaylistItems, total, mode: reportedNetworkMode() });
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
for (const failed of database.prepare("SELECT video_id AS id, message FROM downloads WHERE status = 'error' AND video_id NOT IN (SELECT video_id FROM download_retry_queue)").all()) {
  recordDownloadFailure(failed.id, failed.message);
}
if (networkMode === 'offline' || offlinePreparationRequested) pauseRetryQueueForOffline();
const downloadRetryTimer = setInterval(() => { runDownloadRetries().catch(error => console.error('Download retry queue:', error)); }, 1_000);
downloadRetryTimer.unref();
const finishRecoveryTimer = setInterval(() => { resumePendingFinishRecoveries(); }, 1_000);
finishRecoveryTimer.unref();
const mediaCleanupTimer = setInterval(() => { cleanupExpiredMedia().catch(error => console.error('Expired media cleanup:', error)); }, 60_000);
mediaCleanupTimer.unref();
cleanupExpiredMedia().catch(error => console.error('Expired media cleanup:', error));
const connectivityMonitorTimer = setInterval(() => { monitorInternetConnectivity().catch(error => console.error('Internet connectivity check:', error)); }, 10_000);
connectivityMonitorTimer.unref();
const backgroundDurationLookupTimer = setInterval(() => scheduleBackgroundDurationLookup(), 30_000);
backgroundDurationLookupTimer.unref();
const downloadedMetadataTimer = setInterval(() => runDownloadedMetadataQueue().catch(error => console.error('Downloaded metadata preparation:', error)), 5_000);
downloadedMetadataTimer.unref();

server.listen(port, host, () => {
  console.log(`YourTube local feed: http://${host}:${port}`);
  console.log(`Download protections: ${downloadProtectionMode}`);
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
