import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferVideoTopic, normalizeTopicLabel } from '../lib/topic-classifier.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.resolve(process.env.YOURTUBE_DATA_DIR || path.join(root, 'data'));
const isRepositoryData = dataDirectory === path.join(root, 'data');
const databasePath = path.join(dataDirectory, isRepositoryData ? 'yourtube.runtime.sqlite' : 'yourtube.sqlite');
const apply = process.argv.includes('--apply');
const database = new DatabaseSync(databasePath);
database.exec('PRAGMA busy_timeout = 10000;');

const rows = database.prepare(`SELECT video_id AS id, title, channel, channel_key AS channelKey, topic
  FROM videos ORDER BY video_id`).all();
const metadataById = new Map();
for (const row of database.prepare('SELECT video_id AS id, metadata_json AS value FROM video_metadata').all()) {
  try { metadataById.set(row.id, JSON.parse(row.value || '{}')); } catch { metadataById.set(row.id, {}); }
}
const labelsById = new Map();
const addLabel = (id, value) => {
  const label = String(value || '').replace(/\s+/g, ' ').trim();
  if (!label) return;
  const labels = labelsById.get(id) || [];
  labels.push(label);
  labelsById.set(id, labels);
};
for (const row of database.prepare(`SELECT hcv.video_id AS id, hc.title AS label
  FROM homepage_category_videos hcv JOIN homepage_categories hc ON hc.category_key = hcv.category_key`).all()) addLabel(row.id, row.label);
for (const row of database.prepare(`SELECT hp.video_id AS id,
  CASE WHEN trim(hs.topic) <> '' THEN hs.topic WHEN hs.kind IN ('topic','feed') THEN hs.title ELSE '' END AS label
  FROM homepage_placements hp JOIN homepage_sections hs
  ON hs.capture_id = hp.capture_id AND hs.section_key = hp.section_key`).all()) addLabel(row.id, row.label);

const queriesById = new Map();
for (const row of database.prepare(`SELECT r.video_id AS id, h.query
  FROM search_history_results r JOIN search_history h ON h.search_id = r.search_id`).all()) {
  const queries = queriesById.get(row.id) || [];
  queries.push(row.query);
  queriesById.set(row.id, queries);
}
const descriptionsByChannel = new Map(database.prepare('SELECT channel_key AS key, description FROM channels WHERE trim(description) <> ?').all('')
  .map(row => [row.key, row.description]));
const plan = [];
const normalizedPlan = [];
const byTopic = new Map();
const bySource = new Map();
for (const row of rows) {
  const metadata = metadataById.get(row.id) || {};
  const currentTopic = String(row.topic || '').trim();
  if (currentTopic) {
    const normalizedTopic = normalizeTopicLabel(currentTopic);
    if (normalizedTopic && normalizedTopic !== currentTopic) {
      normalizedPlan.push({
        id: row.id,
        topic: normalizedTopic,
        originalTopic: currentTopic,
        inference: { topic: normalizedTopic, source: 'normalized-existing-label', confidence: 1 },
        metadata
      });
    }
    continue;
  }
  const inference = inferVideoTopic({
    title: row.title,
    channel: row.channel || metadata.channel,
    channelDescription: descriptionsByChannel.get(row.channelKey) || '',
    queries: queriesById.get(row.id) || [],
    capturedTopics: labelsById.get(row.id) || [],
    categories: Array.isArray(metadata.categories) ? metadata.categories : [],
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    description: metadata.description || descriptionsByChannel.get(row.channelKey) || '',
    artist: metadata.artist,
    album: metadata.album,
    track: metadata.track
  });
  if (!inference) continue;
  plan.push({ id: row.id, topic: inference.topic, inference, metadata });
  byTopic.set(inference.topic, (byTopic.get(inference.topic) || 0) + 1);
  bySource.set(inference.source, (bySource.get(inference.source) || 0) + 1);
}

if (apply) {
  const updateVideo = database.prepare(`UPDATE videos SET topic = ? WHERE video_id = ? AND trim(topic) = ?`);
  const updateMetadata = database.prepare(`INSERT INTO video_metadata (video_id, metadata_json, local_assets_json, updated_at)
    VALUES (?, ?, '[]', ?) ON CONFLICT(video_id) DO UPDATE SET
    metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`);
  const updates = [...normalizedPlan, ...plan];
  for (let offset = 0; offset < updates.length; offset += 100) {
    const batch = updates.slice(offset, offset + 100);
    database.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      for (const item of batch) {
        updateVideo.run(item.topic, item.id, item.originalTopic || '');
        updateMetadata.run(item.id, JSON.stringify({
          ...item.metadata,
          topicClassification: {
            topic: item.topic,
            source: item.inference.source,
            confidence: item.inference.confidence,
            version: 1,
            classifiedAt: now,
            ...(item.originalTopic ? { normalizedFrom: item.originalTopic } : {})
          }
        }), now);
      }
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
}

const remaining = database.prepare('SELECT COUNT(*) AS count FROM videos WHERE trim(topic) = ?').get('').count;
const ready = database.prepare(`SELECT COUNT(*) AS total,
  SUM(CASE WHEN trim(v.topic) <> ? THEN 1 ELSE 0 END) AS classified
  FROM downloads d JOIN videos v ON v.video_id = d.video_id WHERE d.status = ?`).get('', 'ready');
const readyIds = new Set(database.prepare(`SELECT v.video_id AS id FROM downloads d JOIN videos v ON v.video_id = d.video_id WHERE d.status = ?`).all('ready').map(row => row.id));
const plannedIds = new Set(plan.map(item => item.id));
const projectedReady = database.prepare(`SELECT v.video_id AS id, v.topic FROM downloads d JOIN videos v ON v.video_id = d.video_id WHERE d.status = ?`).all('ready')
  .filter(row => String(row.topic || '').trim() || plannedIds.has(row.id)).length;
console.log(JSON.stringify({
  mode: apply ? 'applied' : 'dry-run',
  database: databasePath,
  videosScanned: rows.length,
  topicsAssigned: plan.length,
  topicsNormalized: normalizedPlan.length,
  remainingWithoutTopic: remaining,
  readyDownloads: ready.total,
  readyDownloadsWithTopic: ready.classified || 0,
  readyDownloadsWithTopicAfterApply: projectedReady,
  readyDownloadsUnclassifiedAfterApply: Math.max(0, readyIds.size - projectedReady),
  byTopic: Object.fromEntries([...byTopic].sort((a, b) => b[1] - a[1])),
  bySource: Object.fromEntries(bySource)
}, null, 2));
database.close();
