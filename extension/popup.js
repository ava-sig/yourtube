const $ = selector => document.querySelector(selector);
let currentMode = 'preparing';
let refreshing = false;
let currentCaptureSettings = { paused: false, maxTabs: 2 };

function sendMessage(message, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The extension background worker did not answer in time.')), timeoutMs);
    chrome.runtime.sendMessage(message, result => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result || {});
    });
  });
}

async function readServerDiagnosticsDirectly() {
  let lastError = null;
  for (const baseUrl of ['http://127.0.0.1:4173', 'http://localhost:4173']) {
    try {
      const response = await fetch(`${baseUrl}/api/extension/diagnostics`, {
        cache: 'no-store', signal: AbortSignal.timeout(5000)
      });
      if (response.ok) return await response.json();
      lastError = new Error(`Diagnostics returned HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    try {
      const response = await fetch(`${baseUrl}/api/mode`, {
        cache: 'no-store', signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error(`YourTube returned HTTP ${response.status}`);
      return { ...(await response.json()), diagnosticsUnavailable: true };
    } catch (error) { lastError = error; }
  }
  throw new Error(lastError?.message || 'Could not read local server diagnostics.');
}

function number(value) {
  return (Number(value) || 0).toLocaleString();
}

function timeAgo(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime()) || !value) return 'time unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function timeUntil(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime()) || !value) return 'not scheduled';
  const seconds = Math.floor((date.getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'due now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)}m`;
  return `in ${Math.ceil(seconds / 3600)}h`;
}

function setNotice(selector, message) {
  const element = $(selector);
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('hidden', !message);
}

function setWorkerNotice(message, isError = false) {
  const element = $('#worker-note');
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('hidden', !message);
  element.classList.toggle('notice-error', isError && Boolean(message));
}

function appendItem(container, { title, status = '', message = '', meta = '' }) {
  const row = document.createElement('article');
  row.className = 'item-row';
  const top = document.createElement('div');
  top.className = 'item-top';
  const heading = document.createElement('div');
  heading.className = 'item-title';
  heading.textContent = title || 'Untitled queue item';
  top.append(heading);
  if (status) {
    const badge = document.createElement('span');
    badge.className = 'item-badge';
    badge.textContent = status.replaceAll('-', ' ');
    badge.dataset.state = status;
    top.append(badge);
  }
  row.append(top);
  if (message) {
    const detail = document.createElement('div');
    detail.className = 'item-message';
    detail.textContent = message;
    row.append(detail);
  }
  if (meta) {
    const foot = document.createElement('div');
    foot.className = 'item-meta';
    foot.textContent = meta;
    row.append(foot);
  }
  container.append(row);
}

function renderList(selector, rows, emptyMessage, renderRow) {
  const container = $(selector);
  if (!container) return;
  container.replaceChildren();
  if (!rows?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }
  rows.forEach(item => renderRow(container, item));
}

function render(data) {
  currentMode = data.server?.mode || data.extensionMode || 'preparing';
  currentCaptureSettings = data.captureSettings || currentCaptureSettings;
  $('#version').textContent = `v${data.extensionVersion || chrome.runtime.getManifest().version}`;
  $('#page-badge').textContent = data.currentPage || '—';
  const captureLimit = Math.max(1, Math.min(4, Number(currentCaptureSettings.maxTabs) || 2));
  $('#capture-toggle').textContent = currentCaptureSettings.paused ? 'Resume' : 'Pause';
  $('#capture-toggle').title = currentCaptureSettings.paused ? 'Resume opening video-length capture tabs' : 'Pause opening new video-length capture tabs';
  $('#capture-limit').value = String(captureLimit);
  $('#capture-toggle').disabled = Boolean(data.workerUnavailable);
  $('#capture-limit').disabled = Boolean(data.workerUnavailable);
  $('#capture-control-note').textContent = currentCaptureSettings.paused
    ? `New video-length tabs paused · ${data.captures?.length || 0} existing tab${data.captures?.length === 1 ? '' : 's'} continue.`
    : `Video-length captures · up to ${captureLimit} tabs · current tabs stay open if YouTube asks for verification.`;
  const connection = $('#connection');
  const server = data.server;
  if (!data.serverReachable) {
    connection.dataset.state = 'error';
    $('#connection-title').textContent = 'YourTube server unreachable';
    $('#connection-detail').textContent = 'The extension cannot read or advance local queues.';
    $('#mode-label').textContent = 'No local connection';
    $('#mode-detail').textContent = 'Start the YourTube server at 127.0.0.1:4173.';
    $('#mode').textContent = 'Unavailable';
    $('#mode').disabled = true;
    setNotice('#server-error', data.serverError || 'Could not connect to the local server.');
    setNotice('#offline-note', '');
    setWorkerNotice('');
    $('#length-total').textContent = '—';
    $('#length-breakdown').textContent = 'Queue counts unavailable';
    $('#capture-count').textContent = data.workerUnavailable ? `—/${captureLimit}` : `${data.captures?.length || 0}/${captureLimit}`;
    $('#capture-detail').textContent = data.workerUnavailable ? 'Extension worker unavailable' : currentCaptureSettings.paused ? 'New captures paused' : 'Video-length capture tabs';
    $('#media-active').textContent = '—';
    $('#media-detail').textContent = 'Local server unavailable';
    $('#sync-count').textContent = data.workerUnavailable ? '—' : number(data.syncRetries?.length);
    $('#sync-detail').textContent = data.workerUnavailable ? 'Extension storage unavailable' : 'Waiting to reach the server';
    $('#local-metadata-count').textContent = '—';
    $('#local-metadata-detail').textContent = 'Local server unavailable';
    $('#nudge').disabled = true;
    $('#media-queue-summary').textContent = 'Unavailable';
    renderList('#media-items', [], data.workerUnavailable ? 'Extension worker did not respond; media queue details are unavailable.' : 'Download queue details need a local connection.', () => {});
    $('#channel-summary').textContent = 'Unavailable';
  } else {
    const mode = server.mode || data.extensionMode;
    connection.dataset.state = mode === 'offline' || mode === 'preparing' ? mode : 'online';
    $('#connection-title').textContent = mode === 'online' ? 'Connected · YourTube Online' : mode === 'preparing' ? 'Connected · switching mode' : 'Connected · YourTube Offline';
    $('#connection-detail').textContent = data.workerUnavailable
      ? 'Local server responds; extension background worker did not'
      : server.internetAvailable === false ? 'No internet connection detected' : 'Local server and browser extension are communicating';
    $('#mode-label').textContent = mode === 'online' ? 'Online' : mode === 'preparing' ? 'Preparing offline' : 'Offline';
    $('#mode-detail').textContent = mode === 'offline'
      ? 'Browser captures and new discovery are paused.'
      : mode === 'preparing'
        ? `${server.preparation?.message || 'Finishing the Offline transition.'}`
        : 'The extension can open YouTube pages to collect missing details.';
    $('#mode').dataset.mode = mode;
    $('#mode').textContent = mode === 'preparing' ? 'Preparing…' : mode === 'offline' ? 'Go Online' : 'Go Offline';
    $('#mode').disabled = mode === 'preparing' || Boolean(data.workerUnavailable);
    $('#mode').title = data.workerUnavailable ? 'Reload the extension to restore its background worker.' : '';
    setNotice('#server-error', '');

    const lengths = server.videoLengths || {};
    $('#length-total').textContent = data.diagnosticsPartial ? '—' : number(lengths.missing);
    $('#length-breakdown').textContent = data.diagnosticsPartial
      ? 'Detailed queue endpoint unavailable'
      : `${number(lengths.waitingExtension)} waiting for extension · ${number(lengths.capturing)} in browser · ${number(lengths.queued)} queued · ${number(lengths.retrying)} retrying · ${number(lengths.unavailable)} unavailable`;
    $('#capture-count').textContent = data.workerUnavailable ? `—/${captureLimit}` : `${data.captures?.length || 0}/${captureLimit}`;
    $('#capture-detail').textContent = data.workerUnavailable
      ? 'Extension worker unavailable'
      : data.captures?.length
      ? data.captures.map(capture => capture.challenge ? 'Waiting for YouTube verification' : capture.redirected ? 'YouTube redirected · waiting' : capture.tabStatus).join(' · ')
      : data.metadataQueueBusy
        ? `Queue worker checking for ${data.metadataQueueBusyForSeconds || 0}s · ${data.metadataQueueState?.message || 'reading queue'}`
        : currentCaptureSettings.paused
        ? 'Paused · no new tabs will open'
        : mode === 'online'
        ? `${data.metadataQueueState?.message || 'No capture tab is currently open'} · checked ${timeAgo(data.metadataQueueState?.checkedAt)}`
        : 'Capture slots paused';
    const media = server.mediaDownloads || {};
    $('#media-active').textContent = data.diagnosticsPartial ? '—' : number(media.active);
    $('#media-detail').textContent = data.diagnosticsPartial
      ? 'Detailed queue endpoint unavailable'
      : `${number(media.queued)} queued · ${number(media.paused)} paused · ${number(media.ready)} ready`;
    $('#sync-count').textContent = data.workerUnavailable ? '—' : number(data.syncRetries?.length);
    const latestSyncRetry = data.syncRetries?.[0];
    $('#sync-detail').textContent = data.workerUnavailable
      ? 'Extension storage unavailable'
      : latestSyncRetry
      ? `${latestSyncRetry.path} · next retry ${timeUntil(latestSyncRetry.nextAttemptAt)}`
      : 'No captured data waiting to sync';
    const localMetadata = server.downloadedMetadata || {};
    const localMetadataPending = Number(localMetadata.active || 0) + Number(localMetadata.waitingExtension || 0) + Number(localMetadata.queued || 0);
    $('#local-metadata-count').textContent = data.diagnosticsPartial ? '—' : number(localMetadataPending);
    $('#local-metadata-detail').textContent = data.diagnosticsPartial
      ? 'Detailed queue endpoint unavailable'
      : `${number(localMetadata.active)} active · ${number(localMetadata.waitingExtension)} waiting extension · ${number(localMetadata.queued)} queued`;

    const noProgress = data.workerUnavailable
      ? `The extension background worker did not answer. Reload YourTube Local Feed in Chrome’s Extensions page to restore capture and local queue diagnostics.${data.diagnosticsPartial ? ' The server is reachable, but its detailed diagnostics endpoint is unavailable; restart the YourTube server.' : ''}`
      : data.diagnosticsPartial
        ? 'The server is reachable, but detailed queue diagnostics are unavailable. Restart the YourTube server to load its diagnostics endpoint.'
      : mode === 'offline'
      ? `${number(lengths.waitingExtension)} items are marked “waiting for extension”. That work is paused in Offline mode; switch Online to let the extension open YouTube capture pages.`
      : mode === 'preparing'
        ? 'New browser captures wait until the Offline transition finishes.'
        : lengths.waitingExtension > 0 && !(data.captures?.length)
          ? 'The server has work for the extension, but no capture tabs are open. Use “Try next capture” to ask the extension to claim the next item.'
          : '';
    setNotice('#offline-note', noProgress);
    const workerState = data.metadataQueueState;
    const workerNote = data.workerUnavailable
      ? 'The popup could read localhost directly, but the extension worker did not respond. Reload the extension; its queue controls are disabled until then.'
      : mode === 'online' && !noProgress && lengths.waitingExtension > 0 && !(data.captures?.length)
      ? data.metadataQueueBusy
        ? `The extension queue worker is still checking (${data.metadataQueueBusyForSeconds || 0}s). If it stays here, this view will show its last error.`
        : `Last queue check ${timeAgo(workerState?.checkedAt)}: ${workerState?.message || 'No capture tab is active.'}`
      : '';
    setWorkerNotice(workerNote, workerState?.status === 'error' || Boolean(data.metadataQueueBusy && (data.metadataQueueBusyForSeconds || 0) > 45));
    $('#nudge').disabled = mode !== 'online' || data.metadataQueueBusy || !lengths.waitingExtension || Boolean(data.workerUnavailable) || currentCaptureSettings.paused;
    $('#channel-summary').textContent = data.diagnosticsPartial
      ? 'Details unavailable'
      : `${number(server.channelCaptures?.active)} active · ${number(server.channelCaptures?.queued)} queued${Number(server.channelCaptures?.stale) ? ` · ${number(server.channelCaptures.stale)} historical stalls` : ''}`;
  }

  renderList('#capture-list', data.captures, data.workerUnavailable ? 'Extension worker did not respond; active tabs cannot be read.' : 'No browser captures are active.', (container, item) => {
    appendItem(container, {
      title: item.title,
      status: item.tabStatus,
      message: item.challengeMessage || (item.redirected
        ? `YouTube changed this capture URL; keeping the tab open · ${item.videoId} · ${item.ageSeconds}s`
        : `Video ${item.videoId} · running for ${item.ageSeconds}s`),
      meta: 'Background YouTube tab'
    });
  });

  renderList('#queue-items', server?.videoLengthSamples, data.diagnosticsPartial ? 'The server does not expose detailed queue diagnostics yet.' : data.serverReachable ? 'No video-length work is queued.' : 'Queue details need a local connection.', (container, item) => {
    const attemptText = item.attempts ? ` · attempt ${item.attempts}/3` : '';
    appendItem(container, {
      title: item.title || item.videoId,
      status: item.status,
      message: item.message,
      meta: `${item.channel || item.videoId} · updated ${timeAgo(item.updatedAt)}${attemptText}${item.nextAttemptAt && item.nextAttemptAt !== 'never' ? ` · next retry ${timeUntil(item.nextAttemptAt)}` : ''}`
    });
  });

  const channelRows = server?.channelCaptures?.samples || [];
  if (channelRows.length) {
    const container = $('#capture-list');
    if (container.querySelector('.empty-state')) container.replaceChildren();
    channelRows.slice(0, 2).forEach(item => appendItem(container, {
      title: `${item.channel} · ${item.tab}`,
      status: ['opening', 'collecting'].includes(item.status) && Date.now() - new Date(item.updatedAt).getTime() > 5 * 60_000 ? 'stale' : item.status,
      message: item.message || (Date.now() - new Date(item.updatedAt).getTime() > 5 * 60_000 ? 'No progress update for five minutes; this channel capture may have stopped.' : 'Channel section is being captured.'),
      meta: `${item.phase || 'Channel capture'} · updated ${timeAgo(item.updatedAt)}`
    }));
  }

  const mediaQueue = server?.mediaDownloads;
  if (mediaQueue) {
    $('#media-queue-summary').textContent = `${number(mediaQueue.active)} active · ${number(mediaQueue.queued)} queued · ${number(mediaQueue.paused)} paused`;
    renderList('#media-items', mediaQueue.samples, 'No media download attempts are active or queued. The waiting items below are metadata work.', (container, item) => {
      const progressText = Number.isFinite(Number(item.progress)) ? ` · ${Math.round(Number(item.progress))}%` : '';
      const retryText = item.nextAttemptAt ? ` · next attempt ${timeUntil(item.nextAttemptAt)}` : '';
      appendItem(container, {
        title: item.title || item.videoId,
        status: item.status,
        message: item.message || item.phase || 'No error detail recorded.',
        meta: `${item.channel || item.videoId} · ${item.phase || 'Download'}${progressText}${item.attempts ? ` · attempt ${item.attempts}` : ''}${retryText}`
      });
    });
  } else {
    $('#media-queue-summary').textContent = data.diagnosticsPartial ? 'Details unavailable' : data.serverReachable ? 'No data' : 'Unavailable';
    renderList('#media-items', [], data.diagnosticsPartial ? 'Detailed media queue diagnostics are unavailable.' : 'Media queue details need a local connection.', () => {});
  }

  renderList('#last-events', data.events, data.workerUnavailable ? 'Extension worker did not respond; local activity history cannot be read.' : 'No extension capture errors or events have been recorded yet.', (container, event) => {
    appendItem(container, {
      title: event.kind === 'error' ? 'Capture issue'
        : event.kind === 'capture-challenge' ? 'YouTube verification needed'
          : event.kind === 'capture-redirect' ? 'Capture page redirected'
        : event.kind === 'sync-error' ? 'Sync retry queued'
          : event.kind === 'capture-started' ? 'Capture started' : 'Capture completed',
      status: event.kind,
      message: event.message,
      meta: `${event.videoId ? `${event.videoId} · ` : ''}${timeAgo(event.at)}`
    });
  });
  $('#updated').textContent = `Last checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

async function refreshDiagnostics() {
  if (refreshing) return;
  refreshing = true;
  $('#refresh').disabled = true;
  try {
    let data = null;
    let workerError = null;
    try { data = await sendMessage({ type: 'yourtube:get-diagnostics' }); }
    catch (error) { workerError = error; }
    if (!workerError && data?.serverReachable) {
      render(data);
      return;
    }
    let server;
    try {
      server = await readServerDiagnosticsDirectly();
    } catch (serverError) {
      render({
        ...data,
        extensionVersion: data?.extensionVersion || chrome.runtime.getManifest().version,
        extensionMode: data?.extensionMode || currentMode,
        serverReachable: false,
        serverError: `${serverError.message}${workerError ? ` Extension worker: ${workerError.message}` : ''}`,
        workerUnavailable: Boolean(workerError),
        captures: data?.captures || [], syncRetries: data?.syncRetries || [], events: data?.events || []
      });
      return;
    }
    render({
      ...data,
      extensionVersion: data?.extensionVersion || chrome.runtime.getManifest().version,
      extensionMode: server.mode || data?.extensionMode || currentMode,
      currentPage: data?.currentPage || (workerError ? 'Extension worker offline' : 'YourTube'),
      serverReachable: true,
      server,
      diagnosticsPartial: Boolean(server.diagnosticsUnavailable),
      workerUnavailable: Boolean(workerError || data?.workerUnavailable),
      workerError: workerError?.message || data?.workerError,
      captures: data?.captures || [], syncRetries: data?.syncRetries || [], events: data?.events || [],
      metadataQueueState: data?.metadataQueueState || (workerError
        ? { status: 'error', message: workerError.message, checkedAt: new Date().toISOString() }
        : { status: 'idle', message: '', checkedAt: '' })
    });
  } finally {
    refreshing = false;
    $('#refresh').disabled = false;
  }
}

$('#version').textContent = `v${chrome.runtime.getManifest().version}`;
$('#refresh').addEventListener('click', refreshDiagnostics);
async function saveCaptureSettings(settings) {
  $('#capture-toggle').disabled = true;
  $('#capture-limit').disabled = true;
  try {
    const result = await sendMessage({ type: 'yourtube:set-metadata-capture-settings', ...settings });
    if (!result.ok) throw new Error(result.error || 'Capture settings could not be saved.');
    currentCaptureSettings = result.settings || currentCaptureSettings;
    setNotice('#action-feedback', currentCaptureSettings.paused
      ? 'New video-length capture tabs paused. Any open tabs will continue.'
      : `Video-length captures resumed, with up to ${currentCaptureSettings.maxTabs} tabs.`);
  } catch (error) {
    setNotice('#action-feedback', error.message);
  }
  await refreshDiagnostics();
}

$('#capture-toggle').addEventListener('click', () => {
  void saveCaptureSettings({ paused: !currentCaptureSettings.paused });
});
$('#capture-limit').addEventListener('change', event => {
  void saveCaptureSettings({ maxTabs: Number(event.currentTarget.value) });
});
$('#mode').addEventListener('click', async () => {
  if (currentMode === 'preparing') return;
  const next = currentMode === 'online' ? 'offline' : 'online';
  $('#mode').disabled = true;
  setNotice('#action-feedback', next === 'offline' ? 'Switching Offline and preparing local metadata…' : 'Checking connectivity and returning Online…');
  try {
    const result = await sendMessage({ type: 'yourtube:set-mode', mode: next });
    if (!result.ok) throw new Error(result.error || 'The mode could not be changed.');
    setNotice('#action-feedback', '');
  } catch (error) {
    setNotice('#action-feedback', error.message);
  }
  await refreshDiagnostics();
});

$('#nudge').addEventListener('click', async () => {
  $('#nudge').disabled = true;
  setNotice('#action-feedback', 'Asking the extension to start available video-length captures…');
  try {
    const result = await sendMessage({ type: 'yourtube:nudge-capture-queue' });
    if (!result.ok) throw new Error(result.error || 'The queue could not be started.');
    setNotice('#action-feedback', 'Queue checked. Up to two available items can open in background YouTube tabs.');
  } catch (error) {
    setNotice('#action-feedback', error.message);
  }
  await refreshDiagnostics();
});

refreshDiagnostics();
setInterval(refreshDiagnostics, 5000);
