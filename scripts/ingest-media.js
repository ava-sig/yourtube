#!/usr/bin/env node

const usage = 'Usage: npm run ingest -- <YouTube or X video URL>\nExample: npm run ingest -- https://x.com/creator/status/1234567890';
const input = process.argv[2];

if (!input || input === '--help' || input === '-h') {
  console.log(usage);
  process.exit(input ? 0 : 2);
}

function parseMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a complete HTTPS video URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only public HTTPS video URLs are accepted.');

  const host = url.hostname.toLowerCase();
  const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);
  if (youtubeHosts.has(host)) {
    let id = '';
    if (host.endsWith('youtu.be')) id = url.pathname.split('/').filter(Boolean)[0] || '';
    else if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else id = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('This YouTube URL does not contain a supported video ID.');
    return { provider: 'youtube', id };
  }

  const xHosts = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
  if (xHosts.has(host)) {
    const match = url.pathname.match(/^\/@?[\p{L}\p{N}._-]{1,100}\/status\/(\d+)(?:\/video\/\d+)?\/?$/u)
      || url.pathname.match(/^\/i\/(?:web\/)?status\/(\d+)(?:\/video\/\d+)?\/?$/);
    if (!match || match[1].length > 40) throw new Error('This X URL must point to a status containing a video.');
    return { provider: 'x', url: url.href };
  }

  throw new Error(`Unsupported video source: ${host}. This command currently accepts YouTube and X/Twitter URLs.`);
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
    cache: 'no-store'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 202) {
    throw new Error(result.error || `YourTube returned HTTP ${response.status}.`);
  }
  return result;
}

try {
  const serverBase = new URL(process.env.YOURTUBE_URL || 'http://127.0.0.1:4173');
  if (!['http:', 'https:'].includes(serverBase.protocol)
    || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(serverBase.hostname)) {
    throw new Error('YOURTUBE_URL must point to a local YourTube server (127.0.0.1, localhost, or ::1).');
  }
  serverBase.pathname = serverBase.pathname.replace(/\/?$/, '/');
  serverBase.search = '';
  serverBase.hash = '';

  const media = parseMediaUrl(input);
  let id;
  let download;
  if (media.provider === 'x') {
    const result = await requestJson(serverBase, 'api/external-media', {
      method: 'POST', body: JSON.stringify({ sourceUrl: media.url })
    });
    id = result.id;
    download = result.download || {};
  } else {
    const resolved = await requestJson(serverBase, 'api/videos/resolve', {
      method: 'POST', body: JSON.stringify({ videoId: media.id })
    });
    id = resolved.id || media.id;
    download = await requestJson(serverBase, `api/downloads/${encodeURIComponent(id)}`, {
      method: 'POST', body: '{}'
    });
  }

  const isShort = media.provider === 'x';
  const localUrl = new URL(`${isShort ? 'shorts' : 'watch'}/${encodeURIComponent(id)}`, serverBase);
  console.log(`Added ${media.provider === 'x' ? 'X Short' : 'YouTube video'} to YourTube.`);
  console.log(`YourTube ID: ${id}`);
  console.log(`Status: ${download.stage || download.status || 'queued'}${Number.isFinite(Number(download.progress)) && download.status === 'downloading' ? ` · ${Math.floor(Number(download.progress))}%` : ''}`);
  if (download.message) console.log(download.message);
  console.log(`Local page: ${localUrl.href}`);
} catch (error) {
  console.error(`Ingest failed: ${error.message || error}`);
  if (/ECONNREFUSED|fetch failed/i.test(String(error?.cause?.code || error?.message || error))) {
    console.error('Start YourTube first with `npm start` or `npm run dev`.');
  }
  process.exitCode = 1;
}
