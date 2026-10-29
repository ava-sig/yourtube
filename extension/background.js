const RETRY_KEY = 'yourtubeSyncRetryQueue';
const RETRY_ALARM = 'yourtube-sync-retry';
const RETRY_DELAYS_MINUTES = [1, 5, 15, 60, 240, 720, 1440];
const MODE_KEY = 'yourtubeNetworkMode';
const MODE_ALARM = 'yourtube-mode-sync';
const CHANNEL_QUEUE_KEY = 'yourtubeChannelCaptureQueue';
const CHANNEL_ACTIVE_KEY = 'yourtubeActiveChannelCapture';
const CHANNEL_PAUSED_KEY = 'yourtubeChannelCapturePaused';
const CHANNEL_ALARM = 'yourtube-channel-prefetch';
const METADATA_CAPTURE_KEY = 'yourtubeActiveMetadataCapture';
const METADATA_CAPTURE_ALARM = 'yourtube-metadata-capture';
const DIAGNOSTICS_KEY = 'yourtubeExtensionDiagnostics';
const METADATA_QUEUE_STATE_KEY = 'yourtubeMetadataQueueState';
const MAX_METADATA_CAPTURE_TABS = 2;
// Fail closed until the localhost server reports its persisted mode.
let extensionMode = 'preparing';
let queueMutation = Promise.resolve();
let channelBatchMutation = Promise.resolve();
let diagnosticMutation = Promise.resolve();
let prioritizingChannelBatch = false;
let metadataCaptureStarting = false;
let metadataCaptureStartedAt = 0;
let metadataQueueState = { status: 'idle', message: 'Waiting for the next queue check.', checkedAt: '' };

function metadataCaptureEntries(value) {
  if (Array.isArray(value)) return value.filter(item => item?.videoId);
  return value?.videoId ? [value] : [];
}

function recordExtensionEvent(kind, message, videoId = '') {
  const task = diagnosticMutation.then(async () => {
    const stored = await chrome.storage.local.get(DIAGNOSTICS_KEY);
    const events = Array.isArray(stored[DIAGNOSTICS_KEY]) ? stored[DIAGNOSTICS_KEY] : [];
    events.unshift({ kind, message: String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 400), videoId, at: new Date().toISOString() });
    await chrome.storage.local.set({ [DIAGNOSTICS_KEY]: events.slice(0, 12) });
  });
  diagnosticMutation = task.catch(() => {});
  return task.catch(() => {});
}

async function saveMetadataCaptureEntries(entries) {
  await chrome.storage.local.set({ [METADATA_CAPTURE_KEY]: entries.length ? entries : null });
}

async function updateMetadataQueueState(status, message) {
  metadataQueueState = { status, message: String(message || '').slice(0, 400), checkedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [METADATA_QUEUE_STATE_KEY]: metadataQueueState }).catch(() => {});
}

async function removeMetadataCapture(videoId, tabId) {
  const stored = await chrome.storage.local.get(METADATA_CAPTURE_KEY);
  const entries = metadataCaptureEntries(stored[METADATA_CAPTURE_KEY])
    .filter(item => item.videoId !== videoId || (tabId !== undefined && item.tabId !== tabId));
  await saveMetadataCaptureEntries(entries);
}

async function saveMode(mode) {
  if (!['online', 'offline', 'preparing'].includes(mode)) return;
  const previousMode = extensionMode;
  extensionMode = mode;
  await chrome.storage.local.set({ [MODE_KEY]: mode });
  if (mode === 'preparing' || mode === 'offline' && previousMode !== mode) await pauseActiveChannelCaptureForOffline(mode);
  if (mode === 'online' && previousMode !== 'online') {
    try {
      const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://m.youtube.com/*'] });
      await Promise.all(tabs.filter(tab => tab.id !== undefined).map(tab =>
        chrome.tabs.sendMessage(tab.id, { type: 'yourtube:mode-changed', mode }).catch(() => {})
      ));
    } catch {}
    drainRetryQueue();
    launchNextChannelCapture();
    pollMetadataCaptureQueue();
  }
}

async function refreshMode() {
  try {
    const response = await fetch('http://127.0.0.1:4173/api/mode', { cache: 'no-store' });
    if (response.ok) await saveMode((await response.json()).mode);
  } catch {}
  return extensionMode;
}

async function reportMetadataCaptureFailure(videoId, message) {
  await recordExtensionEvent('error', message, videoId);
  try {
    await fetch('http://127.0.0.1:4173/api/extension/video-metadata', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId, failed: true, message: String(message || '').slice(0, 400) })
    });
  } catch {}
}

async function pollMetadataCaptureQueue() {
  if (metadataCaptureStarting) return;
  if (extensionMode !== 'online') {
    await updateMetadataQueueState('paused', `Queue polling paused because the extension is ${extensionMode}.`);
    return;
  }
  metadataCaptureStarting = true;
  metadataCaptureStartedAt = Date.now();
  await updateMetadataQueueState('checking', 'Checking the local video-length queue.');
  let active = [];
  try {
    const stored = await chrome.storage.local.get(METADATA_CAPTURE_KEY);
    active = metadataCaptureEntries(stored[METADATA_CAPTURE_KEY]);
    for (const capture of [...active]) {
      if (capture.tabId === undefined || capture.tabId === null) {
        if (Date.now() - (capture.startedAt || Date.now()) < 30_000) continue;
        active = active.filter(item => item.videoId !== capture.videoId);
        await reportMetadataCaptureFailure(capture.videoId, 'Chrome did not finish opening the metadata capture tab.');
        continue;
      }
      try {
        const tab = await chrome.tabs.get(capture.tabId);
        let current;
        try { current = new URL(tab.pendingUrl || tab.url || ''); } catch {}
        const isExpectedWatchPage = current && ['www.youtube.com', 'm.youtube.com'].includes(current.hostname) &&
          current.pathname === '/watch' && current.searchParams.get('v') === capture.videoId &&
          current.searchParams.get('yourtube_metadata_capture') === capture.videoId;
        if (isExpectedWatchPage && Date.now() - (capture.startedAt || Date.now()) < 120_000) continue;
        try { await chrome.tabs.remove(capture.tabId); } catch {}
        active = active.filter(item => item.videoId !== capture.videoId);
        await reportMetadataCaptureFailure(capture.videoId, isExpectedWatchPage
          ? 'The YouTube page did not finish rendering metadata in time.'
          : 'YouTube redirected away from the requested watch page before metadata could be captured.');
      }
      catch {
        active = active.filter(item => item.videoId !== capture.videoId);
        await reportMetadataCaptureFailure(capture.videoId, 'The extension capture tab closed before metadata arrived.');
      }
    }
    await saveMetadataCaptureEntries(active);
    while (active.length < MAX_METADATA_CAPTURE_TABS && extensionMode === 'online') {
      const response = await fetch('http://127.0.0.1:4173/api/extension/metadata-capture-jobs', { cache: 'no-store' });
      if (!response.ok) {
        await updateMetadataQueueState('error', `The server returned HTTP ${response.status} for the capture queue.`);
        break;
      }
      const result = await response.json().catch(() => ({}));
      if (result.mode) await saveMode(result.mode);
      if (extensionMode !== 'online') {
        await updateMetadataQueueState('paused', `Queue polling paused because YourTube is ${extensionMode}.`);
        break;
      }
      if (!result.job?.videoId) {
        await updateMetadataQueueState('empty', 'The server returned no eligible video-length job.');
        break;
      }
      const videoId = String(result.job.videoId);
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        await updateMetadataQueueState('error', 'The server returned a malformed video ID for capture.');
        break;
      }
      if (active.some(item => item.videoId === videoId)) {
        await updateMetadataQueueState('error', `The server offered ${videoId}, which is already active in this browser.`);
        break;
      }
      const capture = { videoId, tabId: null, startedAt: Date.now() };
      active = [...active, capture];
      await saveMetadataCaptureEntries(active);
      try {
        const captureUrl = new URL(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
        captureUrl.searchParams.set('yourtube_metadata_capture', videoId);
        const tab = await chrome.tabs.create({ url: captureUrl.href, active: false });
        active = active.map(item => item.videoId === videoId ? { ...item, tabId: tab.id, startedAt: Date.now() } : item);
        await saveMetadataCaptureEntries(active);
        await recordExtensionEvent('capture-started', 'Opened a background YouTube tab for video-length capture.', videoId);
        await updateMetadataQueueState('active', `Opened a capture tab for ${videoId}.`);
      } catch (error) {
        active = active.filter(item => item.videoId !== videoId);
        await saveMetadataCaptureEntries(active);
        await reportMetadataCaptureFailure(videoId, 'Chrome could not open the extension metadata capture tab.');
        console.warn('[YourTube] Browser metadata capture could not start:', error?.message || error);
      }
    }
  } catch (error) {
    console.warn('[YourTube] Browser metadata capture could not start:', error?.message || error);
    await updateMetadataQueueState('error', error?.message || 'The browser capture queue could not be checked.');
    await recordExtensionEvent('error', `The browser capture queue could not reach or read YourTube: ${error?.message || error}`);
  } finally {
    metadataCaptureStarting = false;
    metadataCaptureStartedAt = 0;
    if (active.length && metadataQueueState.status === 'checking') {
      await updateMetadataQueueState('active', `${active.length} browser metadata capture${active.length === 1 ? '' : 's'} active.`);
    }
  }
}

function serializeQueueMutation(operation) {
  const result = queueMutation.then(operation, operation);
  queueMutation = result.catch(() => {});
  return result;
}

function serializeChannelBatchMutation(operation) {
  const result = channelBatchMutation.then(operation, operation);
  channelBatchMutation = result.catch(() => {});
  return result;
}

function syncEndpoint(message) {
  const isSearch = message?.type === 'yourtube:search-sync';
  const isChannel = message?.type === 'yourtube:channel-sync';
  if (!isSearch && !isChannel && message?.type !== 'yourtube:sync') return null;
  const extensionVersion = chrome.runtime.getManifest().version;
  return {
    path: isSearch ? '/api/search-sync' : isChannel ? '/api/channel-sync' : '/api/sync',
    body: isSearch
      ? { searchId: message.searchId, query: message.query, videos: message.videos || [], complete: message.complete === true, extensionVersion }
      : isChannel
        ? { captureId: message.captureId, channel: message.channel || {}, channelKey: message.channelKey, tab: message.tab, videos: message.videos || [], phase: message.phase, message: message.message || '', final: message.final === true, complete: message.complete === true, extensionVersion }
      : { videos: message.videos || [], subscriptions: message.subscriptions || [], playlists: message.playlists || [], provisionCategory: message.provisionCategory === 'homepage' ? 'homepage' : 'other', extensionVersion },
    isSearch,
    isChannel,
    complete: message.complete === true
  };
}

async function readQueue() {
  const stored = await chrome.storage.local.get(RETRY_KEY);
  return Array.isArray(stored[RETRY_KEY]) ? stored[RETRY_KEY] : [];
}

async function writeQueue(queue) {
  await chrome.storage.local.set({ [RETRY_KEY]: queue });
}

async function scheduleQueueRetry(queue) {
  if (!queue.length || extensionMode !== 'online') {
    await chrome.alarms.clear(RETRY_ALARM);
    return;
  }
  const next = Math.min(...queue.map(item => item.nextAttemptAt || Date.now() + 60_000));
  await chrome.alarms.create(RETRY_ALARM, { when: Math.max(Date.now() + 1000, next) });
}

async function enqueueFailedSync(request, failureReason = 'The local server did not acknowledge the captured data.') {
  return serializeQueueMutation(async () => {
    const queue = await readQueue();
    queue.push({
      id: crypto.randomUUID(),
      path: request.path,
      body: request.body,
      attempts: 0,
      nextAttemptAt: Date.now() + 60_000,
      createdAt: Date.now()
    });
    await writeQueue(queue);
    await scheduleQueueRetry(queue);
    await recordExtensionEvent('sync-error', `${request.path}: ${failureReason}. Captured data was saved for automatic retry.`);
  });
}

async function postSync(request) {
  const response = await fetch(`http://127.0.0.1:4173${request.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.body)
  });
  const result = await response.json().catch(() => ({}));
  if (result.mode) await saveMode(result.mode);
  if (!response.ok) {
    const error = new Error(result.error || `Local server returned ${response.status}`);
    error.mode = result.mode;
    error.status = response.status;
    throw error;
  }
  return result;
}

async function extensionDiagnosticsSnapshot() {
  let server = null;
  let serverError = '';
  try {
    await refreshMode();
    const response = await fetch('http://127.0.0.1:4173/api/extension/diagnostics', { cache: 'no-store' });
    if (!response.ok) throw new Error(`YourTube returned HTTP ${response.status}`);
    server = await response.json();
    if (server.mode) await saveMode(server.mode);
  } catch (error) {
    serverError = error?.message || 'YourTube could not be reached.';
  }

  const stored = await chrome.storage.local.get([
    RETRY_KEY, METADATA_CAPTURE_KEY, CHANNEL_QUEUE_KEY, CHANNEL_ACTIVE_KEY,
    CHANNEL_PAUSED_KEY, DIAGNOSTICS_KEY, METADATA_QUEUE_STATE_KEY
  ]);
  const active = metadataCaptureEntries(stored[METADATA_CAPTURE_KEY]);
  const captures = await Promise.all(active.map(async capture => {
    const sample = server?.videoLengthSamples?.find(item => item.videoId === capture.videoId);
    const item = {
      videoId: capture.videoId, title: sample?.title || capture.videoId,
      startedAt: capture.startedAt || 0,
      ageSeconds: Math.max(0, Math.floor((Date.now() - (capture.startedAt || Date.now())) / 1000)),
      tabStatus: capture.tabId === null ? 'Opening tab' : 'Checking tab…'
    };
    if (capture.tabId !== undefined && capture.tabId !== null) {
      try {
        const tab = await chrome.tabs.get(capture.tabId);
        item.title = sample?.title || tab.title || item.title;
        item.tabStatus = tab.status === 'complete' ? 'YouTube page loaded' : 'YouTube page loading';
        try {
          const parsed = new URL(tab.pendingUrl || tab.url || '');
          if (!['www.youtube.com', 'm.youtube.com'].includes(parsed.hostname) || parsed.searchParams.get('v') !== capture.videoId) {
            item.tabStatus = 'Unexpected YouTube redirect';
          }
        } catch { item.tabStatus = 'Tab URL unavailable'; }
      } catch { item.tabStatus = 'Capture tab is missing'; }
    }
    return item;
  }));
  let currentPage = 'Unknown page';
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const host = new URL(tab?.url || '').hostname;
    currentPage = host === 'www.youtube.com' || host === 'm.youtube.com' ? 'YouTube' : host.includes('localhost') || host === '127.0.0.1' ? 'YourTube' : host || 'Unknown page';
  } catch {}
  const syncRetries = Array.isArray(stored[RETRY_KEY]) ? stored[RETRY_KEY] : [];
  const channelQueue = Array.isArray(stored[CHANNEL_QUEUE_KEY]) ? stored[CHANNEL_QUEUE_KEY] : [];
  const events = Array.isArray(stored[DIAGNOSTICS_KEY]) ? stored[DIAGNOSTICS_KEY].slice(0, 5) : [];
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    extensionMode, currentPage, serverReachable: Boolean(server), serverError,
    server, captures, syncRetries: syncRetries.map(item => ({ path: item.path, attempts: item.attempts || 0, nextAttemptAt: item.nextAttemptAt || 0 })),
    metadataQueueState: stored[METADATA_QUEUE_STATE_KEY] || metadataQueueState,
    metadataQueueBusy: metadataCaptureStarting,
    metadataQueueBusyForSeconds: metadataCaptureStarting ? Math.floor((Date.now() - metadataCaptureStartedAt) / 1000) : 0,
    channel: { active: stored[CHANNEL_ACTIVE_KEY] || null, queued: channelQueue.length, paused: stored[CHANNEL_PAUSED_KEY] === true },
    events
  };
}

const CHANNEL_TABS = ['home', 'videos', 'shorts', 'streams', 'playlists', 'community'];
let openingChannelCapture = false;

function validChannelKey(value) {
  return /^(?:@[\p{L}\p{N}._-]{3,100}|channel\/UC[A-Za-z0-9_-]{20,32}|(?:user|c)\/[\p{L}\p{N}._-]{1,100})$/u.test(String(value || ''));
}

async function channelCaptureState(captureId, status, phase, message = '') {
  if (!/^[a-f0-9-]{36}$/i.test(String(captureId || ''))) return;
  try {
    await fetch(`http://127.0.0.1:4173/api/channel-captures/${encodeURIComponent(captureId)}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, phase, message: String(message).slice(0, 500) })
    });
  } catch {}
}

function channelCaptureUrl(job) {
  const channelKey = String(job.channelKey || '');
  const channelPath = channelKey.startsWith('@') ? `@${encodeURIComponent(channelKey.slice(1))}` : channelKey.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`https://www.youtube.com/${channelPath}/${job.tab}`);
  url.searchParams.set('yourtube_channel_id', job.captureId);
  url.searchParams.set('yourtube_channel_tab', job.tab);
  return url.href;
}

function isAssignedChannelCaptureUrl(value, job) {
  try {
    const url = new URL(value || '');
    if (!['www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return false;
    if (url.searchParams.get('yourtube_channel_id') !== String(job.captureId || '') ||
        url.searchParams.get('yourtube_channel_tab') !== String(job.tab || '')) return false;
    const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
    const keyParts = String(job.channelKey || '').split('/');
    const channelMatches = keyParts.length === 1
      ? parts[0]?.toLowerCase() === keyParts[0].toLowerCase()
      : parts[0]?.toLowerCase() === keyParts[0].toLowerCase() && parts[1]?.toLowerCase() === keyParts[1].toLowerCase();
    if (!channelMatches) return false;
    const section = parts[keyParts.length];
    if (job.tab === 'home') return !section || section === 'home';
    if (job.tab === 'streams') return section === 'streams' || section === 'live';
    return section === job.tab;
  } catch { return false; }
}

function isAssignedChannelCaptureTab(tab, job) {
  return isAssignedChannelCaptureUrl(tab?.pendingUrl || tab?.url, job);
}

async function pauseStoredChannelBatch(active, queue, phase, message) {
  const jobs = new Map();
  for (const job of [...(Array.isArray(queue) ? queue : []), active].filter(Boolean)) {
    if (job.captureId) jobs.set(job.captureId, job);
  }
  await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: null, [CHANNEL_QUEUE_KEY]: [], [CHANNEL_PAUSED_KEY]: true });
  await Promise.all([...jobs.values()].map(job => channelCaptureState(job.captureId, 'paused', phase, message)));
}

async function startChannelCaptureInTab(job, tabId) {
  const message = {
    type: 'yourtube:start-channel-capture',
    captureId: job.captureId,
    channelKey: job.channelKey,
    tab: job.tab
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, message);
      if (result?.ok) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await channelCaptureState(job.captureId, 'error', 'content-script-timeout', 'The YouTube page opened, but its capture script did not start. Revisit the channel to retry.');
  return false;
}

async function finishChannelCapture(captureId, senderTabId) {
  if (prioritizingChannelBatch) {
    await new Promise(resolve => setTimeout(resolve, 50));
    return finishChannelCapture(captureId, senderTabId);
  }
  const stored = await chrome.storage.local.get([CHANNEL_QUEUE_KEY, CHANNEL_ACTIVE_KEY]);
  const active = stored[CHANNEL_ACTIVE_KEY];
  const queue = Array.isArray(stored[CHANNEL_QUEUE_KEY]) ? stored[CHANNEL_QUEUE_KEY] : [];
  const ownsActiveTab = active?.captureId === captureId && (senderTabId === undefined || active.tabId === senderTabId);
  if (!ownsActiveTab) return;
  if (senderTabId !== undefined && senderTabId !== null) {
    try {
      const currentTab = await chrome.tabs.get(senderTabId);
      if (!isAssignedChannelCaptureTab(currentTab, active)) {
        await pauseStoredChannelBatch(active, queue, 'tab-navigated-away', 'Channel prefetch paused because its assigned tab navigated elsewhere. Revisit the channel to start a fresh capture.');
        return;
      }
    } catch {
      await pauseStoredChannelBatch(active, queue, 'tab-closed', 'Channel prefetch paused because its assigned tab closed. Revisit the channel to start a fresh capture.');
      return;
    }
  }
  if (ownsActiveTab && queue.length && senderTabId !== undefined && senderTabId !== null && extensionMode === 'online') {
    const next = queue.shift();
    await chrome.storage.local.set({
      [CHANNEL_ACTIVE_KEY]: { ...next, tabId: senderTabId, startedAt: Date.now(), navigating: true },
      [CHANNEL_QUEUE_KEY]: queue
    });
    await channelCaptureState(next.captureId, 'opening', 'opening', 'Loading the next channel section in the same background tab.');
    try {
      if (prioritizingChannelBatch) return;
      const latest = await chrome.storage.local.get(CHANNEL_ACTIVE_KEY);
      if (latest[CHANNEL_ACTIVE_KEY]?.captureId !== next.captureId) return;
      const currentTab = await chrome.tabs.get(senderTabId);
      if (!isAssignedChannelCaptureTab(currentTab, active)) {
        await pauseStoredChannelBatch(latest[CHANNEL_ACTIVE_KEY], queue, 'tab-navigated-away', 'Channel prefetch paused because its assigned tab navigated elsewhere. Revisit the channel to start a fresh capture.');
        return;
      }
      await chrome.tabs.update(senderTabId, { url: channelCaptureUrl(next) });
      const afterNavigation = await chrome.storage.local.get(CHANNEL_ACTIVE_KEY);
      if (afterNavigation[CHANNEL_ACTIVE_KEY]?.captureId !== next.captureId) return;
      await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: { ...afterNavigation[CHANNEL_ACTIVE_KEY], navigating: false } });
      if (!await startChannelCaptureInTab(next, senderTabId)) await finishChannelCapture(next.captureId, senderTabId);
      return;
    } catch (error) {
      await channelCaptureState(next.captureId, 'queued', 'tab-navigation-retry', String(error?.message || 'The next channel section could not be opened.'));
      const latest = await chrome.storage.local.get(CHANNEL_QUEUE_KEY);
      const remaining = Array.isArray(latest[CHANNEL_QUEUE_KEY]) ? latest[CHANNEL_QUEUE_KEY] : [];
      if (!remaining.some(item => item.captureId === next.captureId)) remaining.unshift(next);
      await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: null, [CHANNEL_QUEUE_KEY]: remaining });
      if (extensionMode === 'online') await launchNextChannelCapture();
      return;
    }
  }
  if (ownsActiveTab) await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: null, [CHANNEL_QUEUE_KEY]: queue });
  if (senderTabId !== undefined && senderTabId !== null) {
    try {
      const currentTab = await chrome.tabs.get(senderTabId);
      if (isAssignedChannelCaptureTab(currentTab, active)) await chrome.tabs.remove(senderTabId);
    } catch {}
  }
  if (extensionMode === 'online') await launchNextChannelCapture();
}

async function pauseChannelCapture(captureId, senderTabId, message, phase = 'offline') {
  const stored = await chrome.storage.local.get([CHANNEL_QUEUE_KEY, CHANNEL_ACTIVE_KEY]);
  const active = stored[CHANNEL_ACTIVE_KEY];
  const queue = Array.isArray(stored[CHANNEL_QUEUE_KEY]) ? stored[CHANNEL_QUEUE_KEY] : [];
  if (active?.captureId !== captureId || (senderTabId !== undefined && active.tabId !== senderTabId)) return;
  let assignedTab = false;
  if (senderTabId !== undefined && senderTabId !== null) {
    try { assignedTab = isAssignedChannelCaptureTab(await chrome.tabs.get(senderTabId), active); } catch {}
  }
  if (active?.captureId === captureId && (senderTabId === undefined || active.tabId === senderTabId)) {
    if (!queue.some(item => item.captureId === active.captureId)) queue.unshift(active);
    await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: null, [CHANNEL_QUEUE_KEY]: queue });
  }
  await channelCaptureState(captureId, 'paused', phase, message);
  if (assignedTab) {
    try { await chrome.tabs.remove(senderTabId); } catch {}
  }
}

async function pauseActiveChannelCaptureForOffline(mode = 'offline') {
  const stored = await chrome.storage.local.get([CHANNEL_QUEUE_KEY, CHANNEL_ACTIVE_KEY]);
  const active = stored[CHANNEL_ACTIVE_KEY];
  if (!active?.captureId) return;
  const queue = Array.isArray(stored[CHANNEL_QUEUE_KEY]) ? stored[CHANNEL_QUEUE_KEY] : [];
  if (!queue.some(item => item.captureId === active.captureId)) {
    queue.unshift({ captureId: active.captureId, channelKey: active.channelKey, tab: active.tab, queuedAt: active.queuedAt || Date.now() });
  }
  await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: null, [CHANNEL_QUEUE_KEY]: queue });
  const preparing = mode === 'preparing';
  await channelCaptureState(active.captureId, 'paused', preparing ? 'mode-preparing' : 'offline', preparing
    ? 'Channel capture paused while YourTube is switching to Offline. It will resume when Online mode is available.'
    : 'Paused while YourTube is offline. It will resume when Online mode returns.');
  if (active.tabId !== undefined && active.tabId !== null) {
    try {
      const tab = await chrome.tabs.get(active.tabId);
      if (isAssignedChannelCaptureTab(tab, active)) await chrome.tabs.remove(active.tabId);
    } catch {}
  }
}

async function launchNextChannelCapture() {
  if (openingChannelCapture || prioritizingChannelBatch || extensionMode !== 'online') return;
  openingChannelCapture = true;
  try {
    for (;;) {
      const stored = await chrome.storage.local.get([CHANNEL_QUEUE_KEY, CHANNEL_ACTIVE_KEY, CHANNEL_PAUSED_KEY, METADATA_CAPTURE_KEY]);
      if (metadataCaptureEntries(stored[METADATA_CAPTURE_KEY]).length >= MAX_METADATA_CAPTURE_TABS) return;
      if (stored[CHANNEL_PAUSED_KEY]) return;
      const queue = Array.isArray(stored[CHANNEL_QUEUE_KEY]) ? stored[CHANNEL_QUEUE_KEY] : [];
      let active = stored[CHANNEL_ACTIVE_KEY];
      if (active?.navigating) return;
      if (active?.tabId !== undefined && active?.tabId !== null) {
        try {
          const currentTab = await chrome.tabs.get(active.tabId);
          if (isAssignedChannelCaptureTab(currentTab, active)) return;
          await pauseStoredChannelBatch(active, queue, 'tab-navigated-away', 'Channel prefetch paused because its assigned tab navigated elsewhere. Revisit the channel to start a fresh capture.');
          return;
        }
        catch {
          await pauseStoredChannelBatch(active, queue, 'tab-closed', 'Channel prefetch paused because its assigned tab closed. Revisit the channel to start a fresh capture.');
          return;
        }
      }
      if (active?.captureId) {
        if (Date.now() - (active.startedAt || 0) < 30000) return;
        if (queue.length) {
          await channelCaptureState(active.captureId, 'paused', 'superseded', 'Capture paused while newer channel sections take priority.');
        } else {
          await channelCaptureState(active.captureId, 'queued', 'recovering', 'Recovering the queued channel section after the extension restarted.');
          if (!queue.some(item => item.captureId === active.captureId)) queue.unshift({ captureId: active.captureId, channelKey: active.channelKey, tab: active.tab, queuedAt: active.queuedAt || Date.now() });
        }
        await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: null, [CHANNEL_QUEUE_KEY]: queue });
      }
      const job = queue.shift();
      await chrome.storage.local.set({ [CHANNEL_QUEUE_KEY]: queue });
      if (!job) return;
      await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: { ...job, tabId: null, startedAt: Date.now() } });
      try {
        const created = await chrome.tabs.create({ url: channelCaptureUrl(job), active: false });
        let latest = await chrome.storage.local.get(CHANNEL_ACTIVE_KEY);
        if (latest[CHANNEL_ACTIVE_KEY]?.captureId !== job.captureId) {
          try { await chrome.tabs.remove(created.id); } catch {}
          continue;
        }
        await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: { ...job, tabId: created.id, startedAt: Date.now() } });
        latest = await chrome.storage.local.get(CHANNEL_ACTIVE_KEY);
        if (latest[CHANNEL_ACTIVE_KEY]?.captureId !== job.captureId) {
          try { await chrome.tabs.remove(created.id); } catch {}
          continue;
        }
        await channelCaptureState(job.captureId, 'opening', 'opening', 'Opening this section in a background YouTube tab.');
        if (!await startChannelCaptureInTab(job, created.id)) await finishChannelCapture(job.captureId, created.id);
        return;
      } catch (error) {
        await channelCaptureState(job.captureId, 'error', 'tab-open-failed', String(error?.message || error));
        await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: null });
      }
    }
  } finally {
    openingChannelCapture = false;
    chrome.storage.local.get([CHANNEL_QUEUE_KEY, CHANNEL_ACTIVE_KEY, CHANNEL_PAUSED_KEY]).then(stored => {
      if (!stored[CHANNEL_PAUSED_KEY] && !stored[CHANNEL_ACTIVE_KEY]?.captureId && Array.isArray(stored[CHANNEL_QUEUE_KEY]) && stored[CHANNEL_QUEUE_KEY].length) {
        launchNextChannelCapture();
      }
    }).catch(() => {});
  }
}

async function queueChannelCaptures(channelKey, captures) {
  return serializeChannelBatchMutation(async () => {
    prioritizingChannelBatch = true;
    try {
      const requested = [];
      const requestedIds = new Set();
      for (const capture of captures) {
        if (!capture || !CHANNEL_TABS.includes(capture.tab) || !/^[a-f0-9-]{36}$/i.test(String(capture.captureId || ''))) continue;
        if (requestedIds.has(capture.captureId)) continue;
        requestedIds.add(capture.captureId);
        requested.push({ captureId: capture.captureId, channelKey, tab: capture.tab, queuedAt: Date.now() });
      }
      if (!requested.length) return { added: 0, waiting: 0 };

      const stored = await chrome.storage.local.get([CHANNEL_QUEUE_KEY, CHANNEL_ACTIVE_KEY]);
      const oldQueue = Array.isArray(stored[CHANNEL_QUEUE_KEY]) ? stored[CHANNEL_QUEUE_KEY] : [];
      const oldActive = stored[CHANNEL_ACTIVE_KEY];
      const requestedById = new Map(requested.map(job => [job.captureId, job]));
      let oldTabIsOwned = false;
      if (oldActive?.tabId !== undefined && oldActive?.tabId !== null) {
        try {
          const oldTab = await chrome.tabs.get(oldActive.tabId);
          oldTabIsOwned = isAssignedChannelCaptureTab(oldTab, oldActive);
        } catch {}
      }

      const activeWasRequested = oldActive?.captureId && requestedById.has(oldActive.captureId) &&
        requestedById.get(oldActive.captureId).tab === oldActive.tab &&
        requestedById.get(oldActive.captureId).channelKey === oldActive.channelKey;
      const preserveActive = activeWasRequested && (oldActive.tabId == null || oldTabIsOwned);
      let nextActive = preserveActive ? { ...oldActive } : null;
      let nextQueue = requested.filter(job => !preserveActive || job.captureId !== oldActive.captureId);
      let reuseTabFor;

      if (!preserveActive && oldTabIsOwned && nextQueue.length) {
        reuseTabFor = nextQueue.shift();
        nextActive = { ...reuseTabFor, tabId: oldActive.tabId, startedAt: Date.now(), navigating: true };
      }

      const superseded = new Map();
      for (const job of [...oldQueue, oldActive].filter(Boolean)) {
        if (preserveActive && job.captureId === oldActive.captureId) continue;
        if (!requestedIds.has(job.captureId)) superseded.set(job.captureId, job);
      }

      await chrome.storage.local.set({
        [CHANNEL_ACTIVE_KEY]: nextActive,
        [CHANNEL_QUEUE_KEY]: nextQueue,
        [CHANNEL_PAUSED_KEY]: false
      });

      for (const job of superseded.values()) {
        void channelCaptureState(job.captureId, 'paused', 'superseded', 'Paused because a newer channel was opened. Revisit that channel to resume its capture.');
      }
      for (const job of nextQueue) {
        void channelCaptureState(job.captureId, 'queued', 'prefetch', 'Waiting for the current channel section to finish.');
      }

      if (reuseTabFor) {
        void (async () => {
          const tabId = nextActive.tabId;
          try {
            await channelCaptureState(reuseTabFor.captureId, 'opening', 'opening', 'Opening the newly requested channel in the background capture tab.');
            const latest = await chrome.storage.local.get(CHANNEL_ACTIVE_KEY);
            if (latest[CHANNEL_ACTIVE_KEY]?.captureId !== reuseTabFor.captureId) return;
            const currentTab = await chrome.tabs.get(tabId);
            if (!isAssignedChannelCaptureTab(currentTab, oldActive)) {
              await pauseStoredChannelBatch(latest[CHANNEL_ACTIVE_KEY], nextQueue, 'tab-navigated-away', 'Channel prefetch paused because its assigned tab navigated elsewhere. Revisit the channel to start a fresh capture.');
              return;
            }
            await chrome.tabs.update(tabId, { url: channelCaptureUrl(reuseTabFor) });
            const afterNavigation = await chrome.storage.local.get(CHANNEL_ACTIVE_KEY);
            if (afterNavigation[CHANNEL_ACTIVE_KEY]?.captureId !== reuseTabFor.captureId) return;
            await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: { ...afterNavigation[CHANNEL_ACTIVE_KEY], navigating: false } });
            if (!await startChannelCaptureInTab(reuseTabFor, tabId)) await finishChannelCapture(reuseTabFor.captureId, tabId);
          } catch (error) {
            await channelCaptureState(reuseTabFor.captureId, 'queued', 'tab-navigation-retry', String(error?.message || 'Could not open the requested channel section.'));
            const latest = await chrome.storage.local.get([CHANNEL_ACTIVE_KEY, CHANNEL_QUEUE_KEY]);
            if (latest[CHANNEL_ACTIVE_KEY]?.captureId === reuseTabFor.captureId) {
              const remaining = Array.isArray(latest[CHANNEL_QUEUE_KEY]) ? latest[CHANNEL_QUEUE_KEY] : [];
              if (!remaining.some(item => item.captureId === reuseTabFor.captureId)) remaining.unshift(reuseTabFor);
              await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: null, [CHANNEL_QUEUE_KEY]: remaining });
              if (extensionMode === 'online') void launchNextChannelCapture();
            }
          }
        })();
      } else if (!preserveActive) {
        void launchNextChannelCapture();
      }

      return { added: requested.length, waiting: nextQueue.length + (nextActive?.captureId ? 1 : 0) };
    } finally {
      prioritizingChannelBatch = false;
      if (extensionMode === 'online') void launchNextChannelCapture();
    }
  });
}

chrome.alarms.create(CHANNEL_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CHANNEL_ALARM) return launchNextChannelCapture();
});
chrome.tabs.onRemoved.addListener(tabId => {
  return (async () => {
    const stored = await chrome.storage.local.get([CHANNEL_QUEUE_KEY, CHANNEL_ACTIVE_KEY, METADATA_CAPTURE_KEY]);
    const metadataCapture = metadataCaptureEntries(stored[METADATA_CAPTURE_KEY]).find(item => item.tabId === tabId);
    if (metadataCapture) {
      await removeMetadataCapture(metadataCapture.videoId, tabId);
      await reportMetadataCaptureFailure(metadataCapture.videoId, 'The extension capture tab closed before metadata arrived.');
      if (extensionMode === 'online') setTimeout(() => pollMetadataCaptureQueue(), 1500);
    }
    const active = stored[CHANNEL_ACTIVE_KEY];
    if (!active?.captureId || active.tabId !== tabId) return;
    const queue = Array.isArray(stored[CHANNEL_QUEUE_KEY]) ? stored[CHANNEL_QUEUE_KEY] : [];
    if (!queue.some(item => item.captureId === active.captureId)) {
      queue.unshift({ captureId: active.captureId, channelKey: active.channelKey, tab: active.tab, queuedAt: active.queuedAt || Date.now() });
    }
    await chrome.storage.local.set({ [CHANNEL_ACTIVE_KEY]: null, [CHANNEL_QUEUE_KEY]: queue, [CHANNEL_PAUSED_KEY]: true });
    await channelCaptureState(active.captureId, 'paused', 'tab-closed', 'Prefetch paused because its background tab was closed. Revisit the channel to resume.');
  })();
});

let drainingQueue = false;
async function drainRetryQueue() {
  if (drainingQueue) return;
  if (extensionMode !== 'online') { await chrome.alarms.clear(RETRY_ALARM); return; }
  drainingQueue = true;
  try {
    await serializeQueueMutation(async () => {
      const now = Date.now();
      const queue = await readQueue();
      const remaining = [];
      for (const item of queue) {
        if ((item.nextAttemptAt || 0) > now) {
          remaining.push(item);
          continue;
        }
        try {
          if (item.path === '/api/channel-sync' && item.body?.captureId) {
            const attempt = (item.attempts || 0) + 1;
            await channelCaptureState(item.body.captureId, 'queued', 'retrying', `Retrying channel data delivery (attempt ${attempt}).`);
          }
          await postSync(item);
        } catch (error) {
          if (error.mode === 'offline' || error.mode === 'preparing') {
            if (item.path === '/api/channel-sync' && item.body?.captureId) {
              const preparing = error.mode === 'preparing';
              await channelCaptureState(item.body.captureId, 'paused', preparing ? 'mode-preparing' : 'offline', preparing
                ? 'Channel data delivery is paused while YourTube is switching to Offline.'
                : 'Channel data retry paused while YourTube is offline.');
            }
            remaining.push(item, ...queue.slice(queue.indexOf(item) + 1));
            break;
          }
          const attempts = (item.attempts || 0) + 1;
          const delay = RETRY_DELAYS_MINUTES[Math.min(attempts - 1, RETRY_DELAYS_MINUTES.length - 1)];
          if (item.path === '/api/channel-sync' && item.body?.captureId) {
            await channelCaptureState(item.body.captureId, 'queued', 'retrying', `Retry ${attempts} failed. Next automatic attempt in ${delay} minute${delay === 1 ? '' : 's'}.`);
          }
          remaining.push({ ...item, attempts, lastError: String(error.message || error).slice(0, 300), nextAttemptAt: Date.now() + delay * 60_000 });
        }
      }
      await writeQueue(remaining);
      await scheduleQueueRetry(remaining);
    });
  } finally {
    drainingQueue = false;
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RETRY_ALARM) drainRetryQueue();
});

chrome.runtime.onInstalled.addListener(details => {
  drainRetryQueue();
  if (details.reason === 'update') {
    (async () => {
      const stored = await chrome.storage.local.get([CHANNEL_ACTIVE_KEY, CHANNEL_QUEUE_KEY]);
      const active = stored[CHANNEL_ACTIVE_KEY];
      const queue = Array.isArray(stored[CHANNEL_QUEUE_KEY]) ? stored[CHANNEL_QUEUE_KEY] : [];
      if (active?.tabId !== undefined && active?.tabId !== null) {
        try {
          const tab = await chrome.tabs.get(active.tabId);
          if (isAssignedChannelCaptureTab(tab, active)) {
            await chrome.storage.local.set({ [CHANNEL_QUEUE_KEY]: [], [CHANNEL_PAUSED_KEY]: true });
            for (const job of queue) {
              void channelCaptureState(job.captureId, 'paused', 'extension-updated', 'Queued channel sections were paused during the extension update. Revisit the channel to restart them.');
            }
            return;
          }
        } catch {}
      }
      await pauseStoredChannelBatch(active, queue, 'extension-updated', 'Channel prefetch paused during the extension update. Revisit the channel to start a fresh capture.');
    })();
  }
});
chrome.runtime.onStartup.addListener(() => {
  drainRetryQueue();
  launchNextChannelCapture();
});
chrome.alarms.create(MODE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === MODE_ALARM) refreshMode(); });
chrome.alarms.create(METADATA_CAPTURE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === METADATA_CAPTURE_ALARM) pollMetadataCaptureQueue(); });
refreshMode().then(() => pollMetadataCaptureQueue());
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  chrome.storage.local.get(METADATA_CAPTURE_KEY).then(async stored => {
    const active = metadataCaptureEntries(stored[METADATA_CAPTURE_KEY]).find(item => item.tabId === tabId);
    if (!active?.videoId || !tab.url?.startsWith('https://')) return;
    let current;
    try { current = new URL(tab.url); } catch { return; }
    const matches = ['www.youtube.com', 'm.youtube.com'].includes(current.hostname) && current.pathname === '/watch' &&
      current.searchParams.get('v') === active.videoId && current.searchParams.get('yourtube_metadata_capture') === active.videoId;
    if (matches) return;
    await removeMetadataCapture(active.videoId, tabId);
    await reportMetadataCaptureFailure(active.videoId, 'YouTube redirected away from the requested watch page before metadata could be captured.');
    try { await chrome.tabs.remove(tabId); } catch {}
    if (extensionMode === 'online') setTimeout(() => pollMetadataCaptureQueue(), 1500);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'yourtube:get-diagnostics') {
    extensionDiagnosticsSnapshot().then(sendResponse).catch(error => sendResponse({
      extensionVersion: chrome.runtime.getManifest().version,
      extensionMode, serverReachable: false, serverError: error?.message || 'Diagnostics could not be collected.'
    }));
    return true;
  }
  if (message?.type === 'yourtube:nudge-capture-queue') {
    (async () => {
      await refreshMode();
      if (extensionMode !== 'online') return { ok: false, error: 'Set YourTube Online before starting browser captures.' };
      if (metadataCaptureStarting) return { ok: false, error: `The capture worker is already busy checking the queue for ${Math.floor((Date.now() - metadataCaptureStartedAt) / 1000)} seconds.` };
      await pollMetadataCaptureQueue();
      return { ok: true };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || 'The video-length queue could not be started.' }));
    return true;
  }
  if (message?.type === 'yourtube:metadata-page-capture') {
    const videoId = String(message.videoId || '');
    let senderPage;
    try { senderPage = new URL(sender.url || ''); } catch {}
    const youtubePage = senderPage && ['www.youtube.com', 'm.youtube.com'].includes(senderPage.hostname) && senderPage.pathname === '/watch';
    if (!youtubePage || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || senderPage.searchParams.get('v') !== videoId || senderPage.searchParams.get('yourtube_metadata_capture') !== videoId || sender.tab?.id === undefined) {
      sendResponse({ ok: false, error: 'Metadata capture did not come from its assigned YouTube watch page.' });
      return;
    }
    (async () => {
      const stored = await chrome.storage.local.get(METADATA_CAPTURE_KEY);
      const active = metadataCaptureEntries(stored[METADATA_CAPTURE_KEY]).find(item => item.videoId === videoId);
      if (!active || (active.tabId !== null && active.tabId !== sender.tab.id)) {
        sendResponse({ ok: false, error: 'This browser metadata capture is no longer active.' });
        return;
      }
      try {
        const response = await fetch('http://127.0.0.1:4173/api/extension/video-metadata', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ videoId, ...(message.capture || {}), failed: message.failed === true, message: message.error || '', extensionVersion: chrome.runtime.getManifest().version })
        });
        const result = await response.json().catch(() => ({}));
        if (result.mode) await saveMode(result.mode);
        if (!response.ok) throw new Error(result.error || `Local server returned ${response.status}`);
        await recordExtensionEvent('capture-completed', result.duration
          ? 'YouTube page metadata arrived and a video length was saved.'
          : 'YouTube page metadata arrived, but it did not include a video length.', videoId);
        sendResponse({ ok: true, ...result });
      } catch (error) {
        await reportMetadataCaptureFailure(videoId, error.message || 'Could not deliver the captured browser metadata.');
        sendResponse({ ok: false, error: error.message || 'Could not deliver the captured browser metadata.' });
      } finally {
        await removeMetadataCapture(videoId, sender.tab.id);
        try { await chrome.tabs.remove(sender.tab.id); } catch {}
        setTimeout(() => pollMetadataCaptureQueue(), 1500);
        setTimeout(() => launchNextChannelCapture(), 1800);
      }
    })();
    return true;
  }
  if (message?.type === 'yourtube:channel-retry-status') {
    const captureId = String(message.captureId || '');
    const attempt = Math.max(1, Math.min(999, Number(message.attempt) || 1));
    const detail = String(message.detail || '').replace(/[\r\n]+/g, ' ').slice(0, 250);
    if (!/^[a-f0-9-]{36}$/i.test(captureId) || !/^https:\/\/(?:www\.)?youtube\.com\//.test(sender.url || '')) {
      sendResponse({ ok: false });
      return;
    }
    (async () => {
      const stored = await chrome.storage.local.get(CHANNEL_ACTIVE_KEY);
      const active = stored[CHANNEL_ACTIVE_KEY];
      if (active?.captureId !== captureId || active?.tabId !== sender.tab?.id) {
        sendResponse({ ok: false });
        return;
      }
      await channelCaptureState(captureId, 'queued', 'retrying', `Retrying channel data delivery (attempt ${attempt}; next attempt in about 2 seconds).${detail ? ` ${detail}` : ''}`);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === 'yourtube:get-mode') {
    refreshMode().then(mode => sendResponse({ mode }));
    return true;
  }
  if (message?.type === 'yourtube:set-mode') {
    if (!['online', 'offline'].includes(message.mode)) { sendResponse({ ok: false, error: 'Invalid mode.' }); return; }
    (async () => {
      try {
        const response = await fetch('http://127.0.0.1:4173/api/mode', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: message.mode })
        });
        const result = await response.json();
        if (!response.ok && response.status !== 202) throw new Error(result.error || 'Could not update mode.');
        await saveMode(result.mode);
        if (result.mode === 'online') drainRetryQueue();
        sendResponse({ ok: true, mode: result.mode, preparation: result.preparation });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
    })();
    return true;
  }
  if (message?.type === 'yourtube:set-mode-state') {
    if (message.mode !== 'preparing') { sendResponse({ ok: false, error: 'Only the preparing mode can be synchronized without a server request.' }); return; }
    saveMode('preparing').then(() => sendResponse({ ok: true, mode: extensionMode }));
    return true;
  }
  if (message?.type === 'yourtube:open-search') {
    if (extensionMode !== 'online') { sendResponse({ ok: false, error: 'YourTube is offline.' }); return; }
    const senderUrl = sender.url || '';
    if (!/^http:\/\/(?:localhost|127\.0\.0\.1):4173\//.test(senderUrl) || !/^[a-f0-9-]{36}$/i.test(String(message.searchId || ''))) {
      sendResponse({ ok: false, error: 'Search requests must come from the local YourTube app.' });
      return;
    }
    const query = String(message.query || '').trim().slice(0, 200);
    if (!query) { sendResponse({ ok: false, error: 'A search term is required.' }); return; }
    const url = new URL('https://www.youtube.com/results');
    url.searchParams.set('search_query', query);
    url.searchParams.set('yourtube_search_id', message.searchId);
    chrome.tabs.create({ url: url.href, active: false }, tab => {
      sendResponse({ ok: true, tabId: tab?.id });
    });
    return true;
  }
  if (message?.type === 'yourtube:open-channel-batch' || message?.type === 'yourtube:open-channel') {
    if (extensionMode !== 'online') { sendResponse({ ok: false, error: 'YourTube is offline.' }); return; }
    const senderUrl = sender.url || '';
    const channelKey = String(message.channelKey || '');
    const captures = message.type === 'yourtube:open-channel-batch'
      ? message.captures
      : [{ captureId: message.captureId, tab: message.tab }];
    const valid = Array.isArray(captures) && captures.length > 0 && captures.every(capture =>
      CHANNEL_TABS.includes(capture?.tab) && /^[a-f0-9-]{36}$/i.test(String(capture?.captureId || ''))
    ) && new Set(captures.map(capture => capture.tab)).size === captures.length;
    if (!/^http:\/\/(?:localhost|127\.0\.0\.1):4173\//.test(senderUrl) || !validChannelKey(channelKey) || !valid) {
      sendResponse({ ok: false, error: 'Channel requests must come from the local YourTube app and include valid section capture IDs.' });
      return;
    }
    queueChannelCaptures(channelKey, captures).then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message || 'Could not queue channel sections.' }));
    return true;
  }
  const request = syncEndpoint(message);
  if (!request) return;
  if (extensionMode !== 'online') {
    const preparing = extensionMode === 'preparing';
    const unavailableMessage = preparing
      ? 'Media discovery is paused while YourTube is switching to Offline.'
      : 'Media discovery is paused while YourTube is Offline.';
    if (request.isChannel) {
      (async () => {
        await pauseChannelCapture(String(message.captureId || ''), sender.tab?.id,
          preparing ? 'Channel capture paused while YourTube is switching to Offline. It will resume when Online mode is available.' : 'Paused while YourTube is offline. It will resume when Online mode returns.',
          preparing ? 'mode-preparing' : 'offline');
        sendResponse({ ok: false, queued: false, paused: true, mode: extensionMode, error: unavailableMessage });
      })();
      return true;
    }
    sendResponse({ ok: false, queued: false, paused: true, mode: extensionMode, error: unavailableMessage });
    return;
  }
  (async () => {
    try {
      const result = await postSync(request);
      let tabClosed = false;
      const senderUrl = sender.url || '';
      if (request.isChannel && (request.complete || request.body.final) && /^https:\/\/(www\.)?youtube\.com\//.test(senderUrl)) {
        sendResponse({ ok: true, ...result });
        await finishChannelCapture(message.captureId, sender.tab?.id);
        return;
      }
      if (request.isSearch && request.complete && /^https:\/\/(www\.)?youtube\.com\/results/.test(senderUrl) && sender.tab?.id !== undefined) {
        let displayed = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            const stateResponse = await fetch(`http://127.0.0.1:4173/api/search-sessions/${encodeURIComponent(message.searchId)}`);
            const state = stateResponse.ok ? await stateResponse.json() : null;
            if (state?.status === 'displayed') {
              await chrome.tabs.remove(sender.tab.id);
              tabClosed = true;
              displayed = true;
              break;
            }
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        if (!displayed) {
          try { await chrome.tabs.remove(sender.tab.id); tabClosed = true; } catch {}
        }
      }
      sendResponse({ ok: true, ...result, tabClosed });
    } catch (error) {
      if (request.isChannel) {
        const captureId = String(message.captureId || '');
        const senderTabId = sender.tab?.id;
        if (error.mode === 'offline' || error.mode === 'preparing' || extensionMode !== 'online') {
          const mode = error.mode || extensionMode;
          const preparing = mode === 'preparing';
          const pauseMessage = preparing
            ? 'Channel capture paused while YourTube is switching to Offline. It will resume when Online mode is available.'
            : 'Paused while YourTube is offline. It will resume when Online mode returns.';
          await pauseChannelCapture(captureId, senderTabId, pauseMessage, preparing ? 'mode-preparing' : 'offline');
          sendResponse({ ok: false, paused: true, mode, error: pauseMessage });
          return;
        }
        if ([400, 404, 413].includes(error.status)) {
          await channelCaptureState(captureId, 'error', 'server-rejected', error.message);
          sendResponse({ ok: false, fatal: true, error: error.message });
          await finishChannelCapture(captureId, senderTabId);
          return;
        }
        try {
          await enqueueFailedSync(request, error.message);
          const completed = request.complete === true;
          if (completed || request.body.final) await channelCaptureState(captureId, 'queued', 'retrying', 'Captured channel data is saved in the extension retry queue. Automatic delivery will retry shortly.');
          sendResponse({ ok: true, queued: true, error: `${error.message}. Saved for automatic retry.` });
          if (completed || request.body.final) await finishChannelCapture(captureId, senderTabId);
        } catch (queueError) {
          sendResponse({ ok: false, error: `${error.message}; could not save retry: ${queueError.message}` });
        }
        return;
      }
      if (error.mode === 'offline' || error.mode === 'preparing') {
        sendResponse({ ok: false, queued: false, paused: true, mode: error.mode, error: error.message });
        return;
      }
      try {
        await enqueueFailedSync(request, error.message);
        let tabClosed = false;
        if (request.isChannel && request.complete && /^https:\/\/(www\.)?youtube\.com\//.test(sender.url || '') && sender.tab?.id !== undefined) {
          try { await chrome.tabs.remove(sender.tab.id); tabClosed = true; } catch {}
        }
        sendResponse({ ok: false, queued: true, tabClosed, error: `${error.message}. Saved for automatic retry.` });
      } catch (queueError) {
        sendResponse({ ok: false, queued: false, error: `${error.message}; could not save retry: ${queueError.message}` });
      }
    }
  })();
  return true;
});

drainRetryQueue();
