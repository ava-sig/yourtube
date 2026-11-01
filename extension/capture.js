(() => {
  const cardSelector = 'ytd-rich-item-renderer, ytd-rich-grid-slim-media, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-movie-renderer, ytd-grid-movie-renderer, ytd-compact-movie-renderer, ytd-reel-item-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model';
  const youtubePlaylistAdapters = [
    { selector: 'ytd-radio-renderer, ytd-compact-radio-renderer', kind: 'mix', allowWatchList: true },
    { selector: 'ytd-grid-playlist-renderer, ytd-compact-playlist-renderer, ytd-playlist-renderer', kind: 'playlist', allowWatchList: true },
    { selector: 'yt-lockup-view-model, ytd-rich-item-renderer', kind: 'playlist', allowWatchList: true, requirePlaylistCue: true }
  ];
  let pending = 0;
  let lastSent = '';
  let lastPlaylistSignature = '';
  const playlistSyncInFlight = new Set();
  let expandedCount = 0;
  const expandedControls = new WeakSet();
  const observedAvatarImages = new WeakSet();
  const initialSearchUrl = new URL(location.href);
  const playlistCaptureId = /^[a-f0-9-]{36}$/i.test(initialSearchUrl.searchParams.get('yourtube_playlist_capture') || '')
    ? initialSearchUrl.searchParams.get('yourtube_playlist_capture') : '';
  const playlistCapturePlaylistId = initialSearchUrl.searchParams.get('list') || '';
  let playlistScanStarted = false;
  let playlistScanPaused = false;
  let playlistScanTimer = 0;
  let playlistScanRounds = 0;
  let stablePlaylistRounds = 0;
  let previousPlaylistItemCount = 0;
  let playlistScanAdvance = null;
  let pendingPlaylistFinalize = null;
  let metadataCaptureId = /^[A-Za-z0-9_-]{11}$/.test(initialSearchUrl.searchParams.get('yourtube_metadata_capture') || '')
    ? initialSearchUrl.searchParams.get('yourtube_metadata_capture') : '';
  let metadataCaptureSent = false;
  let metadataCaptureAttempts = 0;
  let metadataCaptureTimer = 0;
  let metadataCommentsScrollStarted = false;
  let metadataCaptureStartedAt = metadataCaptureId ? Date.now() : 0;
  let metadataChallengeReported = false;
  let activeSearchId = initialSearchUrl.pathname === '/results' ? (initialSearchUrl.searchParams.get('yourtube_search_id') || '') : '';
  let activeSearchQuery = initialSearchUrl.pathname === '/results' ? (initialSearchUrl.searchParams.get('search_query') || '') : '';
  let searchScanStarted = false;
  let searchRounds = 0;
  let stableSearchRounds = 0;
  let previousSearchVideoCount = 0;
  const sentSearchCards = new Map();
  const observedSearchVideoIds = new Set();
  const initialChannelUrl = new URL(location.href);
  let activeChannelId = initialChannelUrl.searchParams.get('yourtube_channel_id') || '';
  let activeChannelTab = initialChannelUrl.searchParams.get('yourtube_channel_tab') || 'videos';
  let channelScanStarted = false;
  let channelComplete = false;
  let channelRounds = 0;
  let stableChannelRounds = 0;
  let channelDurationWaitRounds = 0;
  let previousChannelVideoCount = 0;
  let lastChannelSignature = '';
  let channelSyncInFlight = false;
  let channelDeliveryAttempts = 0;
  let channelPendingComplete = false;
  let channelPendingFinal = false;
  let channelPendingFinalMessage = '';
  let channelRetryTimer = 0;
  const channelCards = new Map();
  const sentChannelCards = new Map();
  const thumbnailControlsById = new Map();
  const activeThumbnailControls = new Set();
  const thumbnailDownloadPolls = new Set();
  const locallyAvailableVideoIds = new Set();
  const thumbnailPositionTargets = new WeakMap();
  let localAvailabilityFetchedAt = 0;
  let localAvailabilityRequestInFlight = false;
  const thumbnailPositionObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => {
        for (const entry of entries) {
          const position = thumbnailPositionTargets.get(entry.target);
          if (position?.host.isConnected) positionThumbnailControl(position.anchor, position.root, position.host);
        }
      })
    : null;

  const downloadIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18h14"/></svg>';
  const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const errorIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Zm0 5v5m0 3v.2"/></svg>';

  function setThumbnailControlState(videoId, state, progress = 0, detail = '') {
    const controls = thumbnailControlsById.get(videoId);
    if (!controls) return;
    for (const control of [...controls]) {
      if (!control.button.isConnected) {
        controls.delete(control);
        continue;
      }
      const { button, icon } = control;
      button.dataset.state = state;
      button.style.setProperty('--progress', String(Math.max(0, Math.min(100, Number(progress) || 0))));
      button.setAttribute('aria-label', state === 'play' ? 'Play local video' : state === 'error' ? `Download failed; retry. ${detail || 'Unknown error.'}` : state === 'queued' || state === 'downloading' ? `Download ${Math.round(progress || 0)}%` : 'Download video for local playback');
      button.setAttribute('aria-busy', state === 'queued' || state === 'downloading' ? 'true' : 'false');
      button.tabIndex = state === 'queued' || state === 'downloading' || control.host.hasAttribute('data-hovered') ? 0 : -1;
      button.dataset.detail = String(detail || '').slice(0, 120);
      icon.innerHTML = state === 'play' ? playIcon : state === 'error' ? errorIcon : downloadIcon;
      if (thumbnailControlNeedsTracking(control)) activeThumbnailControls.add(control);
      else activeThumbnailControls.delete(control);
    }
    if (!controls.size) thumbnailControlsById.delete(videoId);
  }

  function applyLocalAvailability(ids) {
    locallyAvailableVideoIds.clear();
    ids.forEach(id => locallyAvailableVideoIds.add(id));
    localAvailabilityFetchedAt = Date.now();
    for (const [id, controls] of thumbnailControlsById) {
      const busy = [...controls].some(control => ['queued', 'downloading'].includes(control.button.dataset.state));
      if (!busy) setThumbnailControlState(id, locallyAvailableVideoIds.has(id) ? 'play' : 'download');
    }
  }

  function refreshLocalAvailability(force = false) {
    if (localAvailabilityRequestInFlight || (!force && Date.now() - localAvailabilityFetchedAt < 15_000)) return;
    localAvailabilityRequestInFlight = true;
    try {
      chrome.runtime.sendMessage({ type: 'yourtube:get-local-availability' }, result => {
        localAvailabilityRequestInFlight = false;
        if (chrome.runtime.lastError || !result?.ok || !Array.isArray(result.ids)) return;
        applyLocalAvailability(result.ids.filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)));
        scheduleCapture();
      });
    } catch { localAvailabilityRequestInFlight = false; }
  }

  function requestDownloadProgress(videoId) {
    try {
      chrome.runtime.sendMessage({ type: 'yourtube:get-thumbnail-download-progress', videoId }, result => {
        if (chrome.runtime.lastError || !result?.ok || !result.download) {
          setThumbnailControlState(videoId, 'error', 0, result?.error || chrome.runtime.lastError?.message || 'Could not read download progress.');
          thumbnailDownloadPolls.delete(videoId);
          return;
        }
        const download = result.download;
        const progress = Number(download.progress) || 0;
        if (download.status === 'ready') {
          locallyAvailableVideoIds.add(videoId);
          localAvailabilityFetchedAt = Date.now();
          setThumbnailControlState(videoId, 'play', 100);
          thumbnailDownloadPolls.delete(videoId);
          return;
        }
        const retrying = ['pending', 'running', 'waiting-live'].includes(download.retryStatus);
        if (download.status === 'error' && !retrying) {
          setThumbnailControlState(videoId, 'error', progress, download.message || download.stage);
          thumbnailDownloadPolls.delete(videoId);
          return;
        }
        const state = download.status === 'downloading' ? 'downloading' : 'queued';
        setThumbnailControlState(videoId, state, progress, download.stage || download.message);
        setTimeout(() => requestDownloadProgress(videoId), state === 'downloading' ? 1200 : 3000);
      });
    } catch {
      thumbnailDownloadPolls.delete(videoId);
      setThumbnailControlState(videoId, 'error', 0, 'The YourTube extension is unavailable.');
    }
  }

  function startThumbnailDownload(video) {
    const videoId = video.id;
    if (thumbnailDownloadPolls.has(videoId)) return;
    thumbnailDownloadPolls.add(videoId);
    setThumbnailControlState(videoId, 'queued', 0);
    try {
      chrome.runtime.sendMessage({
        type: 'yourtube:queue-thumbnail-download', video,
        provisionCategory: location.pathname === '/' ? 'homepage' : 'other'
      }, result => {
        if (chrome.runtime.lastError || !result?.ok) {
          thumbnailDownloadPolls.delete(videoId);
          setThumbnailControlState(videoId, 'error', 0, result?.error || chrome.runtime.lastError?.message || 'Could not queue this download.');
          return;
        }
        const download = result.download || {};
        if (download.status === 'ready') {
          locallyAvailableVideoIds.add(videoId);
          setThumbnailControlState(videoId, 'play', 100);
          thumbnailDownloadPolls.delete(videoId);
          return;
        }
        setThumbnailControlState(videoId, download.status === 'downloading' ? 'downloading' : 'queued', Number(download.progress) || 0, download.stage || download.message);
        requestDownloadProgress(videoId);
      });
    } catch (error) {
      thumbnailDownloadPolls.delete(videoId);
      setThumbnailControlState(videoId, 'error', 0, error?.message || 'The YourTube extension is unavailable.');
    }
  }

  function openLocalThumbnailVideo(videoId) {
    try {
      chrome.runtime.sendMessage({ type: 'yourtube:open-local-thumbnail-video', videoId }, result => {
        if (chrome.runtime.lastError || !result?.ok) {
          setThumbnailControlState(videoId, 'error', 0, result?.error || chrome.runtime.lastError?.message || 'Could not open local playback.');
        }
      });
    } catch (error) {
      setThumbnailControlState(videoId, 'error', 0, error?.message || 'The YourTube extension is unavailable.');
    }
  }

  function visibleThumbnailElement(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 && rect.width > 0 && rect.height > 0;
  }

  function thumbnailOverlap(anchor, element) {
    if (!anchor?.isConnected) return 0;
    if (!visibleThumbnailElement(element)) return 0;
    const anchorRect = anchor.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const anchorArea = anchorRect.width * anchorRect.height;
    const elementArea = rect.width * rect.height;
    if (!anchorArea || !elementArea) return 0;
    const width = Math.max(0, Math.min(anchorRect.right, rect.right) - Math.max(anchorRect.left, rect.left));
    const height = Math.max(0, Math.min(anchorRect.bottom, rect.bottom) - Math.max(anchorRect.top, rect.top));
    const overlapArea = width * height;
    if (overlapArea / anchorArea < 0.2 || overlapArea / elementArea < 0.35) return 0;
    return overlapArea / anchorArea;
  }

  function thumbnailPreviewVideo(anchor, root, includePortaled = true) {
    if (!anchor?.isConnected || !root?.isConnected) return null;
    const candidates = [...root.querySelectorAll('video')];
    if (includePortaled) {
      for (const video of document.querySelectorAll('video')) {
        if (!root.contains(video)) candidates.push(video);
      }
    }
    return candidates
      .filter(video => !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
      .map(video => ({ video, overlap: thumbnailOverlap(anchor, video) }))
      .filter(item => item.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)[0]?.video || null;
  }

  function thumbnailVisualTarget(anchor, root, includePortaled = true) {
    const playingPreview = thumbnailPreviewVideo(anchor, root, includePortaled);
    if (playingPreview) return playingPreview;
    const movingPreview = [...root.querySelectorAll('ytd-moving-thumbnail-renderer')]
      .map(element => ({ element, overlap: thumbnailOverlap(anchor, element) }))
      .filter(item => item.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)[0]?.element;
    return movingPreview || anchor;
  }

  function thumbnailControlNeedsTracking(control) {
    return ['queued', 'downloading'].includes(control.button.dataset.state) ||
      control.host.hasAttribute('data-hovered') || control.host.hasAttribute('data-previewing') ||
      Date.now() < (control.previewWatchUntil || 0);
  }

  function refreshThumbnailPreview(control) {
    if (!control?.host?.isConnected) return;
    const { host } = control;
    const anchor = host._yourtubeAnchor;
    const root = host._yourtubeCard;
    const target = thumbnailVisualTarget(anchor, root, true);
    const preview = target instanceof HTMLVideoElement && !target.paused && target.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    host.toggleAttribute('data-previewing', preview);
    positionThumbnailControl(anchor, root, host, target);
    if (thumbnailControlNeedsTracking(control)) {
      activeThumbnailControls.add(control);
      const watchPreview = host.hasAttribute('data-hovered') || host.hasAttribute('data-previewing') || Date.now() < (control.previewWatchUntil || 0);
      if (watchPreview) {
        if (control.previewTimer) clearTimeout(control.previewTimer);
        control.previewTimer = setTimeout(() => {
          control.previewTimer = 0;
          refreshThumbnailPreview(control);
        }, 240);
      } else if (control.previewTimer) {
        clearTimeout(control.previewTimer);
        control.previewTimer = 0;
      }
    } else {
      activeThumbnailControls.delete(control);
      if (control.previewTimer) clearTimeout(control.previewTimer);
      control.previewTimer = 0;
    }
  }

  function positionThumbnailControl(anchor, root, host, targetOverride = null) {
    if (!anchor?.isConnected || !root?.isConnected || !host?.isConnected) return;
    const target = targetOverride || thumbnailVisualTarget(anchor, root, host.hasAttribute('data-hovered') || host.hasAttribute('data-previewing'));
    const rect = target.getBoundingClientRect();
    host.style.position = 'fixed';
    host.style.inset = 'auto';
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.width = `${rect.width}px`;
    host.style.height = `${rect.height}px`;
    const previousTarget = host._yourtubeCurrentTarget;
    if (previousTarget && previousTarget !== target && previousTarget !== anchor && previousTarget !== root && thumbnailPositionObserver) {
      thumbnailPositionObserver.unobserve(previousTarget);
      host._yourtubeObservedTargets?.delete(previousTarget);
    }
    host._yourtubeCurrentTarget = target;
    if (thumbnailPositionObserver && target !== anchor) {
      const position = { anchor, root, host };
      thumbnailPositionTargets.set(target, position);
      host._yourtubeObservedTargets ||= new Set();
      if (!host._yourtubeObservedTargets.has(target)) {
        host._yourtubeObservedTargets.add(target);
        thumbnailPositionObserver.observe(target);
      }
    }
  }

  function discardThumbnailControl(host, root) {
    if (!host) return;
    const anchor = host._yourtubeAnchor;
    for (const controls of thumbnailControlsById.values()) {
      for (const control of controls) {
        if (control.host !== host) continue;
        activeThumbnailControls.delete(control);
        if (control.previewTimer) clearTimeout(control.previewTimer);
        controls.delete(control);
      }
    }
    for (const [videoId, controls] of thumbnailControlsById) if (!controls.size) thumbnailControlsById.delete(videoId);
    if (root?._yourtubeThumbnailControl === host) root._yourtubeThumbnailControl = null;
    if (thumbnailPositionObserver) {
      for (const target of host._yourtubeObservedTargets || []) thumbnailPositionObserver.unobserve(target);
      thumbnailPositionObserver.unobserve(root);
      if (anchor && anchor !== root) thumbnailPositionObserver.unobserve(anchor);
    }
    host.remove();
  }

  function setThumbnailControlHovered(control, hovered) {
    if (!control?.host?.isConnected) return;
    const wasHovered = control.host.hasAttribute('data-hovered');
    control.host.toggleAttribute('data-hovered', hovered);
    const busy = ['queued', 'downloading'].includes(control.button.dataset.state);
    if (hovered) control.previewWatchUntil = Date.now() + 4500;
    control.button.tabIndex = hovered || busy ? 0 : -1;
    if (hovered === wasHovered) return;
    if (hovered || busy || control.host.hasAttribute('data-previewing') || Date.now() < (control.previewWatchUntil || 0)) {
      activeThumbnailControls.add(control);
      refreshThumbnailPreview(control);
    } else {
      activeThumbnailControls.delete(control);
    }
  }

  function updateActiveThumbnailControls(event) {
    for (const control of [...activeThumbnailControls]) {
      const { host, button } = control;
      if (!host.isConnected || !host._yourtubeAnchor?.isConnected || !host._yourtubeCard?.isConnected) {
        activeThumbnailControls.delete(control);
        continue;
      }
      const busy = ['queued', 'downloading'].includes(button.dataset.state);
      if (event && busy && !host.hasAttribute('data-hovered')) continue;
      if (event && !busy && host.hasAttribute('data-hovered')) {
        const target = host._yourtubeCurrentTarget?.isConnected ? host._yourtubeCurrentTarget : host._yourtubeAnchor;
        const rect = target.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        setThumbnailControlHovered(control, inside);
      }
      if (event) continue;
      if (busy && !host.hasAttribute('data-hovered') && !host.hasAttribute('data-previewing')) positionThumbnailControl(host._yourtubeAnchor, host._yourtubeCard, host);
      else refreshThumbnailPreview(control);
    }
  }

  function cleanupDetachedThumbnailControls() {
    for (const [videoId, controls] of [...thumbnailControlsById]) {
      for (const control of [...controls]) {
        if (control.host.isConnected && control.host._yourtubeAnchor?.isConnected && control.host._yourtubeCard?.isConnected) continue;
        discardThumbnailControl(control.host, control.host._yourtubeCard);
      }
      if (!controls.size) thumbnailControlsById.delete(videoId);
    }
  }

  function installThumbnailControl(card, video) {
    if (!video) return;
    const anchor = [...card.querySelectorAll('a[href*="/watch"], a[href*="/shorts/"]')]
      .find(item => videoIdFrom(item.href) === video.id);
    if (!anchor) return;
    // A page-level overlay stays above YouTube's inline preview renderer and
    // does not replace the pointer target that triggers preview playback.
    const overlayRoot = card;

    if (video.acquisitionExclusionReason) {
      const excludedHost = overlayRoot._yourtubeThumbnailControl;
      discardThumbnailControl(excludedHost, overlayRoot);
      return;
    }

    let host = overlayRoot._yourtubeThumbnailControl;
    if (host && !host.isConnected) {
      discardThumbnailControl(host, overlayRoot);
      host = null;
    }
    if (host?.dataset.videoId === video.id) {
      host._yourtubeVideo = video;
      host._yourtubeAnchor = anchor;
      if (host._yourtubeControl) host._yourtubeControl.video = video;
      positionThumbnailControl(anchor, overlayRoot, host);
      if (locallyAvailableVideoIds.has(video.id) && !['queued', 'downloading'].includes(host.shadowRoot?.querySelector('button')?.dataset.state)) {
        setThumbnailControlState(video.id, 'play', 100);
      }
      return;
    }
    if (host) {
      discardThumbnailControl(host, overlayRoot);
    }

    host = document.createElement('yourtube-thumbnail-control');
    host.dataset.videoId = video.id;
    host.style.zIndex = '2147483647';
    host._yourtubeAnchor = anchor;
    host._yourtubeVideo = video;
    host._yourtubeCard = overlayRoot;
    overlayRoot._yourtubeThumbnailControl = host;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { position:fixed; inset:auto; z-index:2147483647; display:block; pointer-events:none; }
        .control { position:absolute; top:50%; left:50%; width:40%; aspect-ratio:1; padding:0; border:0; border-radius:50%; transform:translate(-50%,-50%) scale(.88); opacity:0; pointer-events:none; display:grid; place-items:center; color:#fff; background:rgba(18,18,18,.84); box-shadow:0 2px 12px rgba(0,0,0,.35); cursor:pointer; transition:opacity .14s ease, transform .14s ease, background .14s ease; }
        .control[data-state="queued"], .control[data-state="downloading"] { opacity:1; transform:translate(-50%,-50%) scale(1); }
        :host([data-hovered]) .control, .control:focus-visible { opacity:1; transform:translate(-50%,-50%) scale(1); outline:2px solid rgba(255,255,255,.9); outline-offset:2px; }
        .control[data-state="download"], .control[data-state="error"], .control[data-state="play"] { opacity:0; }
        :host([data-hovered]) .control[data-state="download"], :host([data-hovered]) .control[data-state="error"], :host([data-hovered]) .control[data-state="play"], :host([data-previewing]) .control { opacity:1; transform:translate(-50%,-50%) scale(1); }
        :host(:focus-within) .control { opacity:1; transform:translate(-50%,-50%) scale(1); outline:2px solid rgba(255,255,255,.9); outline-offset:2px; }
        .icon { width:38%; height:38%; display:grid; place-items:center; }
        .icon svg { width:100%; height:100%; fill:none; stroke:currentColor; stroke-width:2.1; stroke-linecap:round; stroke-linejoin:round; }
        [data-state="play"] .icon svg { fill:currentColor; stroke:none; }
        [data-state="error"] .icon { color:#ff6473; }
        .ring { position:absolute; inset:-5px; width:calc(100% + 10px); height:calc(100% + 10px); transform:rotate(-90deg); transform-origin:50% 50%; overflow:visible; }
        .ring circle { fill:none; stroke-width:5; }
        .track { stroke:rgba(255,255,255,.3); }
        .progress { stroke:#ff3048; stroke-linecap:round; stroke-dasharray:100; stroke-dashoffset:calc(100 - var(--progress, 0)); transition:stroke-dashoffset .28s linear; }
        [data-state="queued"] .ring { animation:spin 1s linear infinite; }
        [data-state="queued"] .progress { stroke-dasharray:22 78; }
        [data-state="downloading"] .progress { stroke-dasharray:100; }
        @keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .control, .progress { transition:none; animation-duration:3s !important; } }
      </style>
      <button class="control" type="button" tabindex="-1" data-state="${locallyAvailableVideoIds.has(video.id) ? 'play' : 'download'}" aria-label="${locallyAvailableVideoIds.has(video.id) ? 'Play local video' : 'Download video for local playback'}" aria-busy="false">
        <svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="46"/><circle class="progress" cx="50" cy="50" r="46" pathLength="100"/></svg>
        <span class="icon">${locallyAvailableVideoIds.has(video.id) ? playIcon : downloadIcon}</span>
      </button>`;
    const button = shadow.querySelector('button');
    const icon = shadow.querySelector('.icon');
    const control = { host, button, icon, video };
    host._yourtubeControl = control;
    if (!thumbnailControlsById.has(video.id)) thumbnailControlsById.set(video.id, new Set());
    thumbnailControlsById.get(video.id).add(control);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const state = button.dataset.state;
      if (state === 'play') openLocalThumbnailVideo(video.id);
      else if (state !== 'queued' && state !== 'downloading') startThumbnailDownload(video);
    });
    button.addEventListener('focus', () => setThumbnailControlHovered(control, true));
    button.addEventListener('blur', () => {
      if (!overlayRoot.matches(':hover')) setThumbnailControlHovered(control, false);
    });
    if (!overlayRoot.dataset.yourtubeHoverHooks) {
      overlayRoot.dataset.yourtubeHoverHooks = 'true';
      const updateHoveredControl = event => {
        const currentHost = overlayRoot._yourtubeThumbnailControl;
        const currentAnchor = currentHost?._yourtubeAnchor;
        const currentControl = currentHost?._yourtubeControl;
        if (!currentHost || !currentAnchor || !currentControl) return;
        if (event?.type?.startsWith('pointer')) {
          const target = currentHost._yourtubeCurrentTarget?.isConnected ? currentHost._yourtubeCurrentTarget : currentAnchor;
          const rect = target.getBoundingClientRect();
          const insideThumbnail = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
          setThumbnailControlHovered(currentControl, insideThumbnail);
        } else if (currentAnchor.matches(':focus-visible') || currentHost.shadowRoot?.querySelector('button')?.matches(':focus-visible')) {
          setThumbnailControlHovered(currentControl, true);
          positionThumbnailControl(currentAnchor, overlayRoot, currentHost);
        }
      };
      for (const eventName of ['pointerenter', 'pointermove', 'focusin']) overlayRoot.addEventListener(eventName, updateHoveredControl);
      overlayRoot.addEventListener('focusout', () => {
        const currentHost = overlayRoot._yourtubeThumbnailControl;
        const currentControl = currentHost?._yourtubeControl;
        const keyboardFocused = currentHost?._yourtubeAnchor?.matches(':focus-visible') || currentHost?.shadowRoot?.querySelector('button')?.matches(':focus-visible');
        if (currentControl && !keyboardFocused && !overlayRoot.matches(':hover')) setThumbnailControlHovered(currentControl, false);
      });
    }
    if (thumbnailPositionObserver) {
      const position = { anchor, root: overlayRoot, host };
      thumbnailPositionTargets.set(anchor, position);
      thumbnailPositionTargets.set(overlayRoot, position);
      host._yourtubeObservedTargets = new Set([anchor, overlayRoot]);
      thumbnailPositionObserver.observe(anchor);
      thumbnailPositionObserver.observe(overlayRoot);
    }
    document.body.append(host);
    positionThumbnailControl(anchor, overlayRoot, host);
    if (anchor.matches(':hover') || anchor.matches(':focus-visible') || button.matches(':focus-visible')) setThumbnailControlHovered(control, true);
  }

  function validChannelKey(value) {
    const key = String(value || '').trim();
    return /^(?:@[\p{L}\p{N}._-]{3,100}|channel\/UC[A-Za-z0-9_-]{20,32}|(?:user|c)\/[\p{L}\p{N}._-]{1,100})$/u.test(key) ? key : '';
  }

  function channelKeyFromLink(link) {
    try {
      const url = new URL(link, location.origin);
      if (!['www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return '';
      const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
      const candidate = parts[0]?.startsWith('@') ? parts[0] : parts.length > 1 && ['channel', 'user', 'c'].includes(parts[0]) ? `${parts[0]}/${parts[1]}` : '';
      return validChannelKey(candidate);
    } catch { return ''; }
  }

  function trackedChannel() {
    const params = new URLSearchParams(location.search);
    if (!activeChannelId) activeChannelId = params.get('yourtube_channel_id') || '';
    if (!['home', 'videos', 'shorts', 'streams', 'playlists', 'community'].includes(activeChannelTab)) activeChannelTab = params.get('yourtube_channel_tab') || 'videos';
    return /^[a-f0-9-]{36}$/i.test(activeChannelId) && validChannelKey(channelKeyFromLink(location.href)) &&
      ['home', 'videos', 'shorts', 'streams', 'playlists', 'community'].includes(activeChannelTab);
  }

  function videoIdFrom(link) {
    try {
      const url = new URL(link, location.origin);
      if (url.pathname === '/watch') return url.searchParams.get('v');
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2];
    } catch {}
    return '';
  }

  function playlistIdFrom(link) {
    try {
      const url = new URL(link, location.origin);
      if (!(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))) return '';
      if (!['/playlist', '/watch'].includes(url.pathname)) return '';
      const id = url.searchParams.get('list') || '';
      return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : '';
    } catch { return ''; }
  }

  function text(element) {
    return (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function imageUrl(image) {
    if (!image) return '';
    const imageHost = image.closest('yt-img-shadow, yt-image');
    const imageElements = [image, imageHost].filter(Boolean);
    const sources = imageElements.flatMap(element => [
      element.currentSrc,
      ...['src', 'data-src', 'data-thumb', 'data-lazy-src', 'data-original', 'data-original-src', 'data-thumb-url']
        .map(attribute => element.getAttribute(attribute)),
      ...(element.getAttribute('srcset') || element.getAttribute('data-srcset') || '')
        .split(',').map(candidate => candidate.trim().split(/\s+/)[0])
    ]);
    for (const source of sources) {
      const value = String(source || '').trim();
      if (/^https?:\/\//i.test(value)) return value;
      if (value.startsWith('//')) return `https:${value}`;
    }
    return '';
  }

  function durationSecondsFromLabel(value) {
    const parts = String(value || '').match(/\d+/g)?.map(Number) || [];
    if (parts.length < 2 || parts.length > 3) return 0;
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  }

  function durationSecondsFromIso(value) {
    const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    return match ? (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0) : 0;
  }

  function publicationDetails(root, fallbackText = '') {
    const relativeAge = String(fallbackText || '').match(/\b(?:\d+\s+)?(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/i)?.[0] ||
      String(fallbackText || '').match(/\b\d+\s+(?:秒|分钟|小時|小时|天|週|周|个月|個月|年)前\b/)?.[0] || '';
    const candidates = [];
    if (root?.matches?.('time[datetime], [itemprop="datePublished"], [itemprop="uploadDate"]')) candidates.push(root);
    for (const selector of ['time[datetime]', '[itemprop="datePublished"]', '[itemprop="uploadDate"]', 'meta[property="article:published_time"]', 'meta[name="date"]']) {
      candidates.push(...(root?.querySelectorAll?.(selector) || []));
    }
    for (const node of candidates) {
      const raw = String(node.getAttribute('datetime') || node.getAttribute('content') || node.getAttribute('content-date') || '').trim();
      if (!raw) continue;
      if (/^\d{8}$/.test(raw)) {
        const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
        return { publishedAt: date, publishedAtPrecision: 'date', publishedAge: relativeAge };
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { publishedAt: raw, publishedAtPrecision: 'date', publishedAge: relativeAge };
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return { publishedAt: new Date(parsed).toISOString(), publishedAtPrecision: 'exact', publishedAge: relativeAge };
    }
    return { publishedAt: '', publishedAtPrecision: '', publishedAge: relativeAge };
  }

  function countFromLabel(value) {
    const match = String(value || '').replaceAll(',', '').match(/([\d.]+)\s*([KMB])?/i);
    if (!match) return null;
    const scale = ({ K: 1_000, M: 1_000_000, B: 1_000_000_000 })[String(match[2] || '').toUpperCase()] || 1;
    const count = Number(match[1]) * scale;
    return Number.isFinite(count) ? Math.round(count) : null;
  }

  function readRenderedComments() {
    const section = document.querySelector('ytd-comments#comments, #comments');
    const threads = [...document.querySelectorAll('ytd-comment-thread-renderer')].slice(0, 50);
    const comments = threads.map(thread => {
      const author = thread.querySelector('#author-text, #author-name, a[href*="/channel/"], a[href^="/@"]');
      const authorLink = author?.closest('a') || author;
      const authorImage = thread.querySelector('#author-thumbnail img, #author-thumbnail yt-img-shadow img, #author-thumbnail yt-image img');
      const commentText = text(thread.querySelector('#content-text, yt-attributed-string#content-text'));
      const published = text(thread.querySelector('#published-time-text a, #published-time-text'));
      const authorUrl = authorLink?.href || '';
      let authorId = '';
      try { authorId = new URL(authorUrl, location.origin).pathname.slice(1); } catch {}
      const likesLabel = text(thread.querySelector('#vote-count-middle'));
      return {
        id: thread.getAttribute('data-id') || thread.id || `${authorId}-${published}-${commentText.slice(0, 24)}`,
        author: text(author), author_id: authorId, author_url: authorUrl,
        text: commentText, like_count: countFromLabel(likesLabel) || 0,
        time_text: published, author_thumbnail: imageUrl(authorImage)
      };
    }).filter(comment => comment.text);
    const sectionText = text(section);
    const commentsCaptured = Boolean(section) && (comments.length > 0 || /comments (?:are )?(?:turned off|disabled)|no comments yet/i.test(sectionText));
    return { comments, commentsCaptured };
  }

  function readWatchPageMetadata() {
    const titleElement = document.querySelector('ytd-watch-metadata h1, #title h1, h1.ytd-watch-metadata');
    const title = text(titleElement) || document.querySelector('meta[property="og:title"]')?.content || document.querySelector('meta[name="title"]')?.content || '';
    const channelLink = document.querySelector('ytd-watch-metadata #owner a[href*="/@"], ytd-watch-metadata #owner a[href*="/channel/"], #owner #channel-name a, #upload-info a[href*="/@"], #upload-info a[href*="/channel/"]');
    const channel = text(channelLink) || text(document.querySelector('ytd-watch-metadata #channel-name, #owner #channel-name, #upload-info #channel-name, [itemprop="author"] [itemprop="name"]')) || '';
    const channelId = String(channelLink?.getAttribute('data-channel-id') || document.querySelector('#owner [channel-id]')?.getAttribute('channel-id') || '').trim();
    const channelKey = channelKeyFromLink(channelLink?.href) || (/^UC[A-Za-z0-9_-]{20,32}$/.test(channelId) ? `channel/${channelId}` : '');
    const avatar = imageUrl(document.querySelector('ytd-watch-metadata #owner #avatar img, #owner #avatar img, #upload-info #channel-thumbnail img, ytd-video-owner-renderer #avatar img'));
    const thumbnail = document.querySelector('meta[property="og:image"]')?.content ||
      imageUrl(document.querySelector('ytd-watch-metadata #thumbnail img, ytd-player img'));
    const videoDuration = Number(document.querySelector('video')?.duration);
    const durationSeconds = (Number.isFinite(videoDuration) && videoDuration > 0 ? Math.floor(videoDuration) : 0) ||
      durationSecondsFromLabel(text(document.querySelector('.ytp-time-duration'))) ||
      Number(document.querySelector('meta[property="og:video:duration"]')?.content) ||
      durationSecondsFromIso(document.querySelector('meta[itemprop="duration"]')?.content);
    const comments = readRenderedComments();
    const description = text(document.querySelector('#description-inline-expander, ytd-text-inline-expander#description-inline-expander')) ||
      document.querySelector('meta[name="description"]')?.content || '';
    const viewCount = countFromLabel(text(document.querySelector('ytd-watch-info-text #info, #info span')) ||
      document.querySelector('meta[itemprop="interactionCount"]')?.content || '');
    const publication = publicationDetails(document, text(document.querySelector('#info-strings, ytd-watch-info-text, #info-container')));
    const tags = (document.querySelector('meta[name="keywords"]')?.content || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 100);
    return {
      title: title.slice(0, 500), channel: dedupeLabel(channel).slice(0, 200), channelId,
      channelKey, channelUrl: channelKey ? `https://www.youtube.com/${channelKey}` : '',
      thumbnail, avatar, durationSeconds,
      description, viewCount, tags, ...publication,
      comments: comments.comments, commentsCaptured: comments.commentsCaptured
    };
  }

  function scheduleMetadataPageCapture() {
    if (!metadataCaptureId || metadataCaptureSent || location.pathname !== '/watch' || new URLSearchParams(location.search).get('v') !== metadataCaptureId) return;
    document.querySelector('video')?.pause();
    if (metadataCaptureTimer) clearTimeout(metadataCaptureTimer);
    metadataCaptureTimer = setTimeout(() => {
      metadataCaptureAttempts += 1;
      if (!metadataCommentsScrollStarted && metadataCaptureAttempts >= 3) {
        metadataCommentsScrollStarted = true;
        document.querySelector('ytd-comments#comments, #comments')?.scrollIntoView({ block: 'end' });
      }
      const capture = readWatchPageMetadata();
      const bodyText = String(document.body?.innerText || '').slice(0, 6000);
      const verificationVisible = /sign in to confirm your age|confirm your age|unusual traffic|verify (?:that )?you(?:'|’)re not a robot|complete the captcha|before you continue/i.test(bodyText) ||
        Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]'));
      if (verificationVisible && !metadataChallengeReported) {
        metadataChallengeReported = true;
        chrome.runtime.sendMessage({
          type: 'yourtube:metadata-page-challenge', videoId: metadataCaptureId,
          message: 'YouTube is waiting for age, CAPTCHA, or sign-in verification. Complete it in the open capture tab; YourTube will keep waiting.'
        });
      } else if (!verificationVisible) metadataChallengeReported = false;
      const ready = capture.durationSeconds > 0 && metadataCaptureAttempts >= 5;
      const elapsed = Date.now() - (metadataCaptureStartedAt || Date.now());
      const exhausted = elapsed >= (verificationVisible ? 10 * 60_000 : 60_000);
      if (ready || exhausted) {
        metadataCaptureSent = true;
        chrome.runtime.sendMessage({
          type: 'yourtube:metadata-page-capture', videoId: metadataCaptureId,
          capture, failed: !(capture.durationSeconds > 0),
          error: verificationVisible
            ? 'YouTube verification was not completed within ten minutes.'
            : 'The signed-in YouTube page did not expose a video length within one minute.'
        });
        return;
      }
      scheduleMetadataPageCapture();
    }, metadataChallengeReported ? 4000 : 1500);
  }

  function dedupeLabel(value) {
    const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ');
    if (words.length > 1 && words.length % 2 === 0) {
      const middle = words.length / 2;
      if (words.slice(0, middle).join(' ').toLowerCase() === words.slice(middle).join(' ').toLowerCase()) return words.slice(0, middle).join(' ');
    }
    return words.join(' ');
  }

  function parseDurationLabel(value) {
    const normalized = dedupeLabel(value);
    if (/\blive(?:\s+now)?\b/i.test(normalized)) return 'LIVE';
    if (/\bupcoming\b/i.test(normalized)) return 'UPCOMING';
    const match = normalized.match(/(?<!\d)(\d{1,3}:\d{2}(?::\d{2})?)(?!\d)/);
    if (!match) return '';
    const parts = match[1].split(':').map(Number);
    if (parts.at(-1) > 59 || (parts.length === 3 && parts[1] > 59)) return '';
    return match[1];
  }

  function readDuration(card) {
    const selectors = [
      'ytd-thumbnail-overlay-time-status-renderer',
      '.ytThumbnailOverlayTimeStatusRenderer',
      '[class*="time-status"]',
      '[class*="timeStatus"]',
      '.badge-shape-wiz__text',
      'yt-thumbnail-badge-view-model .yt-badge-shape__text',
      'yt-thumbnail-overlay-badge-view-model .yt-badge-shape__text',
      'yt-thumbnail-bottom-overlay-view-model .yt-badge-shape__text',
      '[class*="ytThumbnailBottomOverlayViewModelBadge"]',
      'yt-thumbnail-overlay-badge-view-model',
      'yt-thumbnail-bottom-overlay-view-model',
      'yt-thumbnail-badge-view-model',
      '[class*="ThumbnailBottomOverlayViewModelBadgeContainer"]',
      '.yt-badge-shape__text'
    ];
    for (const selector of selectors) {
      for (const element of card.querySelectorAll(selector)) {
        const duration = parseDurationLabel([
          text(element), element.getAttribute('aria-label'), element.getAttribute('title'),
          element.getAttribute('data-duration'), element.getAttribute('data-time')
        ].filter(Boolean).join(' '));
        if (duration) return duration;
      }
    }
    for (const element of card.querySelectorAll('[aria-label*="duration" i], [title*="duration" i]')) {
      const duration = parseDurationLabel(element.getAttribute('aria-label') || element.getAttribute('title'));
      if (duration) return duration;
    }
    return '';
  }

  function channelPageSource() {
    const channelKey = channelKeyFromLink(location.href);
    if (!channelKey) return null;
    const segments = location.pathname.split('/').filter(Boolean).map(part => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
    const channelSegments = channelKey.split('/').length;
    const section = (segments[channelSegments] || 'home').toLowerCase();
    const tab = section === 'live' ? 'streams' : ['home', 'videos', 'shorts', 'streams', 'playlists', 'community'].includes(section) ? section : 'home';
    return { channelKey, tab };
  }

  function trackedSearch() {
    if (location.pathname !== '/results') return false;
    const params = new URLSearchParams(location.search);
    activeSearchId = params.get('yourtube_search_id') || activeSearchId;
    activeSearchQuery = params.get('search_query') || activeSearchQuery;
    return /^[a-f0-9-]{36}$/i.test(activeSearchId) && Boolean(activeSearchQuery);
  }

  function isExcluded(card, anchor) {
    if (card.closest('ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, ytd-game-card-renderer')) return true;
    const label = `${card.getAttribute('aria-label') || ''} ${text(card.querySelector('#ad-badge, .ytd-badge-supported-renderer'))}`;
    if (/\b(sponsored|promoted|playables?)\b/i.test(label)) return true;
    if (card.querySelector('a[href*="googleadservices.com"], a[href*="doubleclick.net"]') || /\bSponsored\s*[·•]?\b/i.test(text(card))) return true;
    const href = anchor.getAttribute('href') || '';
    return /\/playables?(?:\/|\?|$)/i.test(href) || /\bplayables?\b/i.test(anchor.getAttribute('aria-label') || '');
  }

  function acquisitionExclusionReason(card) {
    if (card.closest('ytd-movie-renderer, ytd-grid-movie-renderer, ytd-compact-movie-renderer, ytd-movie-playlist-renderer')) {
      return 'movie-listing';
    }
    const markers = [...card.querySelectorAll('ytd-badge-supported-renderer, .yt-badge, [aria-label*="rent" i], [aria-label*="buy" i], [aria-label*="paid" i], [aria-label*="members only" i], [aria-label*="premium" i], [title*="rent" i], [title*="buy" i], [title*="paid" i], [title*="premium" i]')]
      .map(element => `${text(element)} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`).join(' ');
    return /\b(?:buy or rent|rent or buy|paid(?: content)?|members[- ]only|available to rent|available to buy|rent this movie|buy this movie|purchased|included with (?:youtube )?premium|available with (?:youtube )?premium|youtube premium exclusive)\b/i.test(markers)
      ? 'paid-content'
      : '';
  }

  function readCard(card) {
    const anchors = [...card.querySelectorAll('a[href*="/watch"], a[href*="/shorts/"]')];
    const anchor = anchors.find(item => videoIdFrom(item.href));
    if (!anchor || isExcluded(card, anchor)) return null;

    const id = videoIdFrom(anchor.href);
    const titleElement = card.querySelector('#video-title, h3, [title]');
    const title = text(titleElement) || titleElement?.getAttribute('title') || anchor.getAttribute('aria-label') || '';
    const excludedReason = acquisitionExclusionReason(card);
    if (!id || ((!title || /^watch$/i.test(title.trim())) && !excludedReason)) return null;

    const section = card.closest('ytd-rich-section-renderer');
    const sectionTitle = text(section?.querySelector('#title, h2, yt-formatted-string'));
    const topic = ['Music', 'Gaming', 'News', 'Live', 'Sports', 'Learning', 'Movies & TV', 'Podcasts']
      .find(value => sectionTitle.toLowerCase().includes(value.toLowerCase())) || '';
    const thumbnailImage = card.querySelector('ytd-thumbnail img, a#thumbnail img, yt-image#img img, img#img') || card.querySelector('img');
    const thumbnail = thumbnailImage?.currentSrc || thumbnailImage?.getAttribute('src') || '';
    const channelLinks = [...card.querySelectorAll('a[href*="/@"], a[href*="/channel/"], a[href*="/user/"], a[href*="/c/"]')];
    const channelLink = channelLinks.find(link => channelKeyFromLink(link.href) &&
      (text(link) || link.getAttribute('aria-label') || link.getAttribute('title'))) || channelLinks[0];
    const channelKey = channelKeyFromLink(channelLink?.href);
    const avatarImage = card.querySelector('#channel-thumbnail img, ytd-channel-avatar-renderer img, yt-avatar-view-model img, yt-avatar-shape img, .yt-spec-avatar-shape__image, .yt-lockup-metadata-view-model__avatar img, #avatar-container img, #avatar img') ||
      channelLink?.querySelector('img, yt-img-shadow img, yt-image img');
    const avatar = imageUrl(avatarImage);
    const channelMetadata = card.querySelector('#channel-name, ytd-channel-name, #owner-text, #byline, #byline-container, .yt-content-metadata-view-model__metadata-text, .yt-content-metadata-view-model__metadata-row, .yt-lockup-metadata-view-model__metadata-row');
    const channelMetadataText = text(channelMetadata).split(/\s+[·•]\s+/)[0];
    const channelLinkLabel = channelLink?.getAttribute('aria-label') || channelLink?.getAttribute('title') || '';
    const usableChannelLinkLabel = /^(?:(?:visit|open|go to)\s+)?channel$/i.test(channelLinkLabel.trim()) ? '' : channelLinkLabel;
    const channel = dedupeLabel(text(channelLink) || channelMetadataText || usableChannelLinkLabel || card.getAttribute('data-channel-name') || '')
      .replace(/\s*\.\s*New content available\.?$/i, '').trim();
    const duration = readDuration(card);
    const meta = text(card.querySelector('#metadata-line'));
    const publication = publicationDetails(card, meta);
    const source = channelPageSource();

    return {
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: title.slice(0, 500),
      channel: channel.slice(0, 200),
      channelKey,
      channelUrl: channelKey ? `https://www.youtube.com/${channelKey}` : '',
      thumbnail,
      avatar,
      duration: duration.slice(0, 24),
      meta: dedupeLabel(meta).slice(0, 200),
      ...publication,
      kind: anchor.pathname.startsWith('/shorts/') ? 'short' : 'normal',
      acquisitionExclusionReason: excludedReason,
      section: trackedSearch() ? 'search' : new URL(location.href).searchParams.has('list') ? 'playlist' : /top news/i.test(sectionTitle) ? 'news' : 'home',
      topic,
      sourceChannelKey: source?.channelKey || '',
      sourceTab: source?.tab || ''
    };
  }

  function playlistTitleFrom(card, anchor) {
    const titleElement = card?.querySelector('.yt-lockup-metadata-view-model__title, #video-title, #title, h3, [title]');
    return dedupeLabel(text(titleElement) || titleElement?.getAttribute('title') || anchor?.getAttribute('aria-label') || anchor?.getAttribute('title') || card?.getAttribute('aria-label') || '')
      .replace(/\s*\d[\d,.]*\s+videos?\s*$/i, '').trim();
  }

  function playlistItemCount(value) {
    const match = String(value || '').match(/([\d,]+)\s+(?:videos?|songs?|tracks?)\b/i);
    return match ? Number.parseInt(match[1].replaceAll(',', ''), 10) || 0 : 0;
  }

  function hasPlaylistCue(card, id) {
    if (/^RD/i.test(id)) return true;
    const labels = [card?.getAttribute('aria-label'), card?.querySelector('[aria-label]')?.getAttribute('aria-label'), text(card)].filter(Boolean).join(' ');
    return /\b(?:playlist|mix)\b|\d[\d,.]*\s+(?:videos?|songs?|tracks?)\b/i.test(labels) ||
      Boolean(card?.querySelector('ytd-thumbnail-overlay-side-panel-renderer, ytd-thumbnail-overlay-playlist-renderer, yt-playlist-thumbnail, [class*="playlist-thumbnail"]'));
  }

  function adaptYouTubePlaylistRenderer(card, adapter) {
    const anchors = [...card.querySelectorAll('a[href*="list="]')];
    const anchor = anchors.find(candidate => {
      try {
        const url = new URL(candidate.href, location.origin);
        const id = playlistIdFrom(candidate.href);
        if (!id) return false;
        return url.pathname === '/playlist' || (adapter.allowWatchList && url.pathname === '/watch' &&
          (!adapter.requirePlaylistCue || hasPlaylistCue(card, id)));
      } catch { return false; }
    });
    const id = anchor ? playlistIdFrom(anchor.href) : '';
    if (!id) return null;
    const discoveredTitle = playlistTitleFrom(card, anchor);
    const title = discoveredTitle && !/^watch$/i.test(discoveredTitle)
      ? discoveredTitle
      : /^RD/i.test(id) ? 'YouTube Mix' : 'YouTube playlist';
    const itemCount = playlistItemCount(text(card));
    const image = card.querySelector('ytd-thumbnail img, yt-thumbnail-view-model img, img');
    const channelAnchor = card.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/user/"], a[href*="/c/"]');
    return {
      id,
      title: title.slice(0, 300),
      kind: adapter.kind === 'mix' || /^RD/i.test(id) ? 'mix' : 'playlist',
      channel: dedupeLabel(text(channelAnchor)).slice(0, 200),
      thumbnail: image?.currentSrc || image?.getAttribute('src') || '',
      itemCount,
      declaredItemCount: itemCount,
      items: []
    };
  }

  function readPlaylists(renderedVideos) {
    const playlists = new Map();
    const currentId = playlistIdFrom(location.href);
    if (currentId) {
      const header = document.querySelector('ytd-playlist-header-renderer, ytd-playlist-page-header-renderer, ytd-playlist-sidebar-renderer, ytd-playlist-panel-renderer, yt-page-header-renderer');
      const playlistTitle = document.querySelector('ytd-playlist-header-renderer #title, ytd-playlist-page-header-renderer #title, ytd-playlist-sidebar-renderer #title, ytd-playlist-panel-renderer #header-title, ytd-playlist-panel-renderer #title, #playlist-title, yt-page-header-view-model #page-header-view-model-title');
      const pageTitle = location.pathname === '/playlist' ? document.title.replace(/\s*-\s*YouTube.*$/i, '').trim() : '';
      const discoveredTitle = dedupeLabel(text(playlistTitle) || playlistTitle?.getAttribute('title') || '') || pageTitle;
      const title = discoveredTitle && !/^YouTube$/i.test(discoveredTitle)
        ? discoveredTitle
        : /^RD/i.test(currentId) ? 'YouTube Mix' : 'YouTube playlist';
      if (title) {
        const headerText = text(header);
        const itemCount = Math.max(playlistItemCount(headerText), playlistItemCount(text(playlistTitle)));
        const playlistContainers = [...document.querySelectorAll('ytd-playlist-video-list-renderer, ytd-playlist-panel-renderer, ytd-playlist-sidebar-renderer')];
        const sourceCards = playlistContainers.length
          ? [...new Set(playlistContainers.flatMap(container => [...container.querySelectorAll(cardSelector)]))]
          : location.pathname === '/playlist'
            ? renderedVideos.map(item => item.card).filter(card => card.matches('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer'))
            : [];
        const items = [];
        sourceCards.forEach((card, index) => {
          const video = readCard(card);
          if (!video) return;
          const rawPosition = card.getAttribute('index') || card.getAttribute('data-index') || card.querySelector('[data-index]')?.getAttribute('data-index');
          const parsedPosition = Number.parseInt(rawPosition || '', 10);
          items.push({ ...video, position: Number.isInteger(parsedPosition) && parsedPosition >= 0 ? parsedPosition : index });
        });
        items.sort((left, right) => left.position - right.position);
        const thumbnail = header?.querySelector('img')?.currentSrc || header?.querySelector('img')?.getAttribute('src') || '';
        const channelAnchor = header?.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/user/"], a[href*="/c/"]');
        const playlist = {
          id: currentId,
          title: title.slice(0, 300),
          kind: /^RD/i.test(currentId) ? 'mix' : 'playlist',
          channel: dedupeLabel(text(channelAnchor)).slice(0, 200),
          thumbnail,
          itemCount: Math.max(itemCount || 0, items.length),
          declaredItemCount: itemCount,
          complete: itemCount > 0 && items.length >= itemCount,
          items
        };
        playlists.set(currentId, playlist);
      }
    }

    for (const adapter of youtubePlaylistAdapters) {
      for (const card of document.querySelectorAll(adapter.selector)) {
        const playlist = adaptYouTubePlaylistRenderer(card, adapter);
        if (playlist && !playlists.has(playlist.id)) playlists.set(playlist.id, playlist);
      }
    }
    return [...playlists.values()];
  }

  function finishPlaylistCapture(complete, itemCount) {
    if (!playlistCaptureId || !playlistCapturePlaylistId) return;
    chrome.runtime.sendMessage({
      type: 'yourtube:playlist-capture-finished', playlistId: playlistCapturePlaylistId,
      requestId: playlistCaptureId, complete: complete === true, itemCount
    });
  }

  function syncPlaylistRecords(playlists, options = {}) {
    if (!Array.isArray(playlists) || !playlists.length) {
      if (options.finalize) finishPlaylistCapture(options.complete, options.itemCount || 0);
      return;
    }
    const records = options.complete && playlistCapturePlaylistId
      ? playlists.map(playlist => playlist.id === playlistCapturePlaylistId ? { ...playlist, complete: true } : playlist)
      : playlists;
    const signature = JSON.stringify(records);
    if (playlistSyncInFlight.has(signature)) {
      if (options.finalize) pendingPlaylistFinalize = { records, options };
      return;
    }
    if (signature === lastPlaylistSignature && !options.finalize) return;
    playlistSyncInFlight.add(signature);
    chrome.runtime.sendMessage({
      type: 'yourtube:sync', videos: [], subscriptions: [], playlists: records,
      provisionCategory: 'other'
    }, result => {
      const runtimeError = chrome.runtime.lastError;
      playlistSyncInFlight.delete(signature);
      if (!runtimeError && (result?.ok || result?.queued)) {
        lastPlaylistSignature = signature;
        if (options.finalize) finishPlaylistCapture(options.complete, options.itemCount || records[0]?.items?.length || 0);
      }
      if (pendingPlaylistFinalize) {
        const pending = pendingPlaylistFinalize;
        pendingPlaylistFinalize = null;
        syncPlaylistRecords(pending.records, pending.options);
      }
    });
  }

  function currentPlaylistRecord() {
    return readPlaylists([...document.querySelectorAll(cardSelector)].map(card => ({ card })))
      .find(playlist => playlist.id === playlistCapturePlaylistId) || null;
  }

  function playlistScrollContainer() {
    if (location.pathname !== '/watch') return null;
    return document.querySelector('ytd-playlist-panel-renderer #items, ytd-playlist-sidebar-renderer #items');
  }

  function playlistIsAtEnd() {
    const container = playlistScrollContainer();
    if (container && container.scrollHeight > container.clientHeight + 40) {
      return container.scrollTop + container.clientHeight >= container.scrollHeight - 80;
    }
    const root = document.scrollingElement || document.documentElement;
    return (window.scrollY || root.scrollTop) + window.innerHeight >= root.scrollHeight - 100;
  }

  function scrollPlaylistToEnd() {
    const container = playlistScrollContainer();
    if (container && container.scrollHeight > container.clientHeight + 40) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
      return;
    }
    const root = document.scrollingElement || document.documentElement;
    window.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
  }

  function startPlaylistScan() {
    if (!playlistCaptureId || !playlistCapturePlaylistId) return;
    if (playlistScanStarted) {
      if (playlistScanPaused) {
        playlistScanPaused = false;
        if (playlistScanAdvance) playlistScanTimer = setTimeout(playlistScanAdvance, 100);
      }
      return;
    }
    playlistScanStarted = true;
    playlistScanAdvance = () => {
      if (playlistScanPaused) return;
      const currentPlaylistId = playlistIdFrom(location.href);
      if (currentPlaylistId && currentPlaylistId !== playlistCapturePlaylistId) {
        finishPlaylistCapture(false, 0);
        return;
      }
      const playlist = currentPlaylistRecord();
      const itemCount = playlist?.items?.length || 0;
      if (itemCount <= previousPlaylistItemCount) stablePlaylistRounds += 1;
      else stablePlaylistRounds = 0;
      previousPlaylistItemCount = itemCount;
      const declaredCountReached = Boolean(playlist?.declaredItemCount && itemCount >= playlist.declaredItemCount);
      const stableAtEnd = itemCount > 0 && stablePlaylistRounds >= 7 && playlistIsAtEnd();
      const scanLimitReached = playlistScanRounds >= 40 || itemCount >= 500;
      if (declaredCountReached || stableAtEnd || scanLimitReached) {
        syncPlaylistRecords(playlist ? [playlist] : [], {
          finalize: true, complete: declaredCountReached || stableAtEnd || itemCount >= 500, itemCount
        });
        return;
      }
      if (playlist) syncPlaylistRecords([playlist]);
      scrollPlaylistToEnd();
      playlistScanRounds += 1;
      playlistScanTimer = setTimeout(() => {
        capture();
        playlistScanTimer = setTimeout(playlistScanAdvance, 900);
      }, 1200);
    };
    capture();
    playlistScanTimer = setTimeout(playlistScanAdvance, 1100);
  }

  function readSubscriptions() {
    const guide = document.querySelector('ytd-guide-renderer');
    if (!guide) return [];
    const anchors = [...guide.querySelectorAll('a#endpoint[href]')];
    const pathOf = anchor => {
      try { return new URL(anchor.href, location.origin).pathname.replace(/\/$/, ''); } catch { return ''; }
    };
    const subscriptionsIndex = anchors.findIndex(anchor => pathOf(anchor) === '/feed/subscriptions');
    if (subscriptionsIndex < 0) return [];
    const youIndex = anchors.findIndex((anchor, index) => index > subscriptionsIndex && pathOf(anchor) === '/feed/you');
    const channelPath = /^\/(?:@[^/]+|channel\/[^/]+|user\/[^/]+|c\/[^/]+)$/i;
    return anchors.slice(subscriptionsIndex + 1, youIndex < 0 ? anchors.length : youIndex)
      .filter(anchor => channelPath.test(pathOf(anchor)))
      .map(anchor => {
        const item = anchor.closest('ytd-guide-entry-renderer') || anchor.parentElement;
        const label = text(anchor.querySelector('#guide-entry-title, yt-formatted-string')) ||
          anchor.getAttribute('title') || anchor.getAttribute('aria-label') || text(anchor);
        const name = label.replace(/\s*\.\s*(?:New content available|Live streaming)\.?$/i, '').trim();
        if (!name || /show more|show less/i.test(name)) return null;
          const image = item?.querySelector('#avatar img, yt-avatar-shape img, yt-img-shadow img, yt-image img, img');
        let avatar = '';
        if (image) {
          image.loading = 'eager';
          if (!observedAvatarImages.has(image)) {
            observedAvatarImages.add(image);
            image.addEventListener('load', scheduleCapture, { once: true });
            image.addEventListener('error', scheduleCapture, { once: true });
          }
          const imageHost = image.closest('yt-img-shadow, yt-image');
          const srcset = image.getAttribute('srcset') || image.getAttribute('data-srcset') || '';
          const srcsetUrls = srcset.split(',').map(candidate => candidate.trim().split(/\s+/)[0]);
          const sources = [
            image.currentSrc,
            image.getAttribute('src'),
            image.getAttribute('data-src'),
            image.getAttribute('data-thumb'),
            image.getAttribute('data-lazy-src'),
            image.getAttribute('data-original'),
            image.getAttribute('data-original-src'),
            image.getAttribute('data-thumb-url'),
            imageHost?.getAttribute('src'),
            imageHost?.getAttribute('data-src'),
            ...srcsetUrls
          ];
          avatar = sources.find(source => /^https?:\/\//i.test(source || '') || String(source || '').startsWith('//')) || '';
          if (avatar.startsWith('//')) avatar = `https:${avatar}`;
          const lazySource = image.getAttribute('data-src') || image.getAttribute('data-thumb') || image.getAttribute('data-lazy-src');
          if (!image.getAttribute('src') && /^https?:\/\//i.test(lazySource || '')) image.src = lazySource;
        }
        return {
          key: pathOf(anchor) || name.toLowerCase(),
          name: name.slice(0, 200),
          avatar
        };
      })
      .filter(Boolean);
  }

  function expandMoreControls() {
    if (expandedCount >= 80) return;
    for (const control of document.querySelectorAll('button, [role="button"]')) {
      if (expandedCount >= 80) break;
      if (expandedControls.has(control) || text(control).toLowerCase() !== 'show more') continue;
      const section = control.closest('ytd-rich-section-renderer, ytd-item-section-renderer');
      if (section && /playables?/i.test(text(section))) continue;
      expandedControls.add(control);
      control.click();
      expandedCount += 1;
    }
  }

  function readChannelProfile() {
    const key = validChannelKey(channelKeyFromLink(location.href));
    const header = document.querySelector('ytd-c4-tabbed-header-renderer, yt-page-header-view-model, #page-header, ytd-page-header-renderer, ytd-channel-header-renderer, #channel-header');
    const nameElement = header?.querySelector('#channel-name, #text.ytd-channel-name, yt-page-header-view-model #title, h1, [role="heading"]') ||
      document.querySelector('ytd-c4-tabbed-header-renderer #channel-name, yt-page-header-view-model #title, #channel-name');
    const profileText = text(header);
    const subscriberCount = profileText.match(/[\d,.]+\s*(?:K|M|B)?\s+subscribers?/i)?.[0] || '';
    const videoCount = profileText.match(/[\d,.]+\s*(?:K|M|B)?\s+videos?/i)?.[0] || '';
    const avatarElement = header?.querySelector('#avatar img, yt-avatar-shape img, yt-img-shadow#avatar img, yt-page-header-view-model img') ||
      document.querySelector('ytd-c4-tabbed-header-renderer #avatar img, yt-page-header-view-model #avatar img');
    const bannerElement = header?.querySelector('#banner img, yt-image img, img#banner') || document.querySelector('#banner img');
    const descriptionElement = header?.querySelector('#description-container, #description, yt-description-preview-view-model, #description-inline-expander') ||
      document.querySelector('ytd-c4-tabbed-header-renderer #description-container, yt-page-header-view-model #description');
    const name = dedupeLabel(text(nameElement) || document.title.replace(/\s*-\s*YouTube.*$/i, '').trim());
    return {
      key,
      name: name && !/^YouTube$/i.test(name) ? name.slice(0, 200) : '',
      description: text(descriptionElement).slice(0, 4000),
      avatar: imageUrl(avatarElement),
      banner: imageUrl(bannerElement),
      subscriberCount: dedupeLabel(subscriberCount),
      videoCount: dedupeLabel(videoCount)
    };
  }

  function expectedChannelVideoCount(profile) {
    const match = String(profile.videoCount || '').match(/([\d,.]+)\s*([KMB])?\s+videos?/i);
    if (!match) return 0;
    const base = Number.parseFloat(match[1].replaceAll(',', ''));
    const multiplier = ({ K: 1_000, M: 1_000_000, B: 1_000_000_000 })[String(match[2] || '').toUpperCase()] || 1;
    return Number.isFinite(base) ? Math.round(base * multiplier) : 0;
  }

  function minimumChannelCardTarget(profile) {
    if (activeChannelTab !== 'videos') return 0;
    const expected = expectedChannelVideoCount(profile);
    return expected > 0 ? Math.min(24, expected) : 0;
  }

  function visibleChannelVideosMissingDuration() {
    const ids = new Set();
    for (const card of document.querySelectorAll(cardSelector)) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const video = readCard(card);
      if (video?.kind === 'normal' && !video.duration) ids.add(video.id);
    }
    return ids.size;
  }

  function captureChannel(complete = false, phase = 'background', final = false, message = '') {
    pending = 0;
    if (!trackedChannel()) return;
    if (channelComplete) {
      for (const card of document.querySelectorAll(cardSelector)) installThumbnailControl(card, readCard(card));
      return;
    }
    if (complete) channelPendingComplete = true;
    if (final) {
      channelPendingFinal = true;
      channelPendingFinalMessage = message;
    }
    expandMoreControls();
    syncPlaylistRecords(readPlaylists([...document.querySelectorAll(cardSelector)].map(card => ({ card }))));
    const profile = readChannelProfile();
    const changed = [];
    for (const card of document.querySelectorAll(cardSelector)) {
      const video = readCard(card);
      installThumbnailControl(card, video);
      if (!video || (activeChannelTab === 'shorts' && video.kind !== 'short') || (activeChannelTab === 'videos' && video.kind === 'short')) continue;
      const previous = channelCards.get(video.id);
      const channelOwnedTab = ['videos', 'shorts', 'streams'].includes(activeChannelTab);
      const item = {
        ...video,
        channel: video.channel || (channelOwnedTab ? profile.name : ''),
        channelKey: video.channelKey || (channelOwnedTab ? profile.key : ''),
        channelUrl: video.channelUrl || (channelOwnedTab ? `https://www.youtube.com/${profile.key}` : ''),
        position: previous?.position ?? channelCards.size
      };
      const signature = JSON.stringify(item);
      channelCards.set(video.id, item);
      if (sentChannelCards.get(video.id) !== signature) {
        changed.push(item);
      }
    }
    const profileSignature = JSON.stringify(profile);
    const shouldSend = changed.length || profileSignature !== lastChannelSignature || channelPendingComplete || channelPendingFinal;
    if (!shouldSend || channelSyncInFlight) return;
    channelSyncInFlight = true;
    const sendingComplete = channelPendingComplete;
    const sendingFinal = channelPendingFinal;
    chrome.runtime.sendMessage({
        type: 'yourtube:channel-sync', captureId: activeChannelId, channelKey: profile.key,
        channel: profile, tab: activeChannelTab, videos: changed,
        phase: channelRounds === 0 ? 'priority' : phase, complete: sendingComplete,
        final: sendingFinal, message: sendingFinal ? channelPendingFinalMessage : ''
      }, result => {
        const runtimeError = chrome.runtime.lastError;
        channelSyncInFlight = false;
        if (runtimeError || !(result?.ok || result?.queued)) {
          if (result?.fatal || result?.paused) {
            channelComplete = true;
            return;
          }
          channelDeliveryAttempts += 1;
          const retryDetail = runtimeError?.message || result?.error || 'No response from the local server';
          console.warn(`[YourTube] Channel data was not acknowledged; retrying (attempt ${channelDeliveryAttempts}).`, retryDetail);
          chrome.runtime.sendMessage({
            type: 'yourtube:channel-retry-status', captureId: activeChannelId,
            attempt: channelDeliveryAttempts, detail: `Last delivery error: ${retryDetail}`
          });
          clearTimeout(channelRetryTimer);
          channelRetryTimer = setTimeout(() => captureChannel(channelPendingComplete, phase, channelPendingFinal, channelPendingFinalMessage), 1500);
          return;
        }
        channelDeliveryAttempts = 0;
        changed.forEach(item => sentChannelCards.set(item.id, JSON.stringify(item)));
        lastChannelSignature = profileSignature;
        if (sendingComplete || sendingFinal) {
          channelPendingComplete = false;
          channelPendingFinal = false;
          channelPendingFinalMessage = '';
          channelComplete = true;
          return;
        }
        if (channelPendingComplete || channelPendingFinal) {
          captureChannel(channelPendingComplete, phase, channelPendingFinal, channelPendingFinalMessage);
        }
      });
  }

  function startChannelScan() {
    if (channelScanStarted || !trackedChannel()) return;
    channelScanStarted = true;
    const advance = () => {
      if (channelComplete || !trackedChannel()) return;
      const count = channelCards.size;
      if (count <= previousChannelVideoCount) stableChannelRounds += 1;
      else {
        stableChannelRounds = 0;
        channelDurationWaitRounds = 0;
      }
      previousChannelVideoCount = count;
      const visibleMissingDurations = visibleChannelVideosMissingDuration();
      if (visibleMissingDurations > 0 && channelDurationWaitRounds < 2) {
        channelDurationWaitRounds += 1;
        captureChannel(false, 'duration-enrichment');
        setTimeout(advance, 900);
        return;
      }
      channelDurationWaitRounds = 0;
      const target = minimumChannelCardTarget(readChannelProfile());
      const enoughCards = count >= target;
      const stableLimit = count >= 12 ? 8 : 12;
      if (channelRounds >= 50) {
        if (target > 0 && count < target) {
          captureChannel(false, 'incomplete', true, `Loaded ${count} of at least ${target} visible channel videos before reaching the scan limit.`);
        } else captureChannel(true, 'complete');
        return;
      }
      if (enoughCards && stableChannelRounds >= stableLimit) {
        captureChannel(true, 'complete');
        return;
      }
      const scrollRoot = document.scrollingElement || document.documentElement;
      const currentY = window.scrollY || scrollRoot.scrollTop || 0;
      const nextY = Math.min(scrollRoot.scrollHeight, currentY + Math.max(600, Math.floor(window.innerHeight * 0.85)));
      window.scrollTo({ top: nextY, behavior: 'instant' });
      channelRounds += 1;
      setTimeout(() => {
        captureChannel(false, channelRounds === 1 ? 'priority' : 'background');
        setTimeout(advance, 1000);
      }, 1400);
    };
    captureChannel(false, 'priority');
    setTimeout(advance, 1200);
  }

  function capture(searchComplete = false) {
    pending = 0;
    cleanupDetachedThumbnailControls();
    if (metadataCaptureId && location.pathname === '/watch') return;
    if (trackedChannel()) {
      captureChannel(false, channelRounds === 0 ? 'priority' : 'background');
      return;
    }
    expandMoreControls();
    const cardsById = new Map();
    for (const card of document.querySelectorAll(cardSelector)) {
      const video = readCard(card);
      installThumbnailControl(card, video);
      if (video && !cardsById.has(video.id)) {
        cardsById.set(video.id, video);
        if (trackedSearch()) observedSearchVideoIds.add(video.id);
      }
    }
    const cards = [...cardsById.values()].map((video, position) => ({ ...video, position }));
    const subscriptions = readSubscriptions();
    const playlistRecords = readPlaylists([...document.querySelectorAll(cardSelector)].map(card => ({ card })));
    syncPlaylistRecords(playlistRecords);
    if (trackedSearch()) {
      const changedCards = cards.filter(video => {
        const signature = JSON.stringify(video);
        if (sentSearchCards.get(video.id) === signature) return false;
        sentSearchCards.set(video.id, signature);
        return true;
      });
      if (changedCards.length || searchComplete) {
        chrome.runtime.sendMessage({
          type: 'yourtube:search-sync', searchId: activeSearchId, query: activeSearchQuery,
          videos: changedCards, complete: searchComplete
        });
      }
      return;
    }
    const signature = JSON.stringify([
      cards.map(video => [video.id, video.title, video.channel, video.thumbnail, video.avatar, video.duration, video.acquisitionExclusionReason, video.section, video.topic, video.sourceChannelKey, video.sourceTab]),
      subscriptions.map(subscription => [subscription.key, subscription.name, subscription.avatar])
    ]);
    if ((!cards.length && !subscriptions.length) || signature === lastSent) return;
    lastSent = signature;
    chrome.runtime.sendMessage({
      type: 'yourtube:sync', videos: cards, subscriptions,
      provisionCategory: location.pathname === '/' ? 'homepage' : 'other'
    });
  }

  function countSearchVideos() {
    const ids = new Set();
    for (const card of document.querySelectorAll(cardSelector)) {
      const video = readCard(card);
      if (video) {
        ids.add(video.id);
        observedSearchVideoIds.add(video.id);
      }
    }
    return Math.max(ids.size, observedSearchVideoIds.size);
  }

  function scheduleCapture() {
    if (pending) clearTimeout(pending);
    pending = setTimeout(capture, 800);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'yourtube:start-metadata-capture') {
      const videoId = String(message.videoId || '');
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || location.pathname !== '/watch' || new URLSearchParams(location.search).get('v') !== videoId) {
        sendResponse({ ok: false, error: 'This page is not the assigned YouTube watch page.' });
        return;
      }
      if (metadataCaptureId !== videoId) {
        metadataCaptureId = videoId;
        metadataCaptureSent = false;
        metadataCaptureAttempts = 0;
        metadataCommentsScrollStarted = false;
        metadataChallengeReported = false;
        metadataCaptureStartedAt = Date.now();
      }
      scheduleMetadataPageCapture();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'yourtube:mode-changed') {
      if (message.mode === 'online') {
        scheduleCapture();
        startPlaylistScan();
      } else if (playlistCaptureId) {
        playlistScanPaused = true;
        clearTimeout(playlistScanTimer);
      }
      sendResponse({ ok: true });
      return;
    }
    if (message?.type !== 'yourtube:start-channel-capture') return;
    const captureId = String(message.captureId || '');
    const channelKey = validChannelKey(message.channelKey);
    const tab = String(message.tab || '');
    if (!/^[a-f0-9-]{36}$/i.test(captureId) || !channelKey || !['home', 'videos', 'shorts', 'streams', 'playlists', 'community'].includes(tab) || channelKeyFromLink(location.href) !== channelKey) {
      sendResponse({ ok: false, error: 'Capture details do not match this YouTube channel page.' });
      return;
    }
    if (activeChannelId === captureId && activeChannelTab === tab && channelScanStarted && trackedChannel()) {
      sendResponse({ ok: true, alreadyStarted: true });
      return;
    }
    activeChannelId = captureId;
    activeChannelTab = tab;
    channelScanStarted = false;
    channelComplete = false;
    channelRounds = 0;
    stableChannelRounds = 0;
    channelDurationWaitRounds = 0;
    previousChannelVideoCount = 0;
    lastChannelSignature = '';
    channelSyncInFlight = false;
    channelPendingComplete = false;
    channelPendingFinal = false;
    channelPendingFinalMessage = '';
    channelDeliveryAttempts = 0;
    clearTimeout(channelRetryTimer);
    channelCards.clear();
    sentChannelCards.clear();
    startChannelScan();
    sendResponse({ ok: true });
  });

  function startSearchScan() {
    if (searchScanStarted || !trackedSearch()) return;
    searchScanStarted = true;
    const advance = () => {
      const videoCount = countSearchVideos();
      if (videoCount <= previousSearchVideoCount) stableSearchRounds += 1;
      else stableSearchRounds = 0;
      previousSearchVideoCount = videoCount;
      // YouTube often pauses between lazy-loaded batches. Three quiet rounds
      // can mean only the first few cards arrived, so require a fuller result
      // set and a longer quiet period before closing the collection tab.
      if (searchRounds >= 40 || (videoCount >= 12 && stableSearchRounds >= 8)) {
        capture(true);
        return;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      searchRounds += 1;
      setTimeout(() => {
        capture();
        setTimeout(advance, 900);
      }, 1400);
    };
    setTimeout(advance, 900);
  }

  const channelMetadataSelector = '#channel-name, ytd-channel-name, #owner-text, #byline, #byline-container, .yt-content-metadata-view-model__metadata-text, .yt-content-metadata-view-model__metadata-row, .yt-lockup-metadata-view-model__metadata-row';
  const observer = new MutationObserver(records => {
    if (records.every(record => record.type === 'characterData' && !record.target.parentElement?.closest(channelMetadataSelector))) return;
    scheduleCapture();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'data-thumb', 'class']
  });
  document.addEventListener('yt-navigate-finish', scheduleCapture);
  document.addEventListener('yt-navigate-finish', scheduleMetadataPageCapture);
  window.addEventListener('scroll', scheduleCapture, { passive: true });
  document.addEventListener('pointermove', updateActiveThumbnailControls, true);
  document.addEventListener('pointerout', event => {
    if (event.relatedTarget) return;
    for (const control of [...activeThumbnailControls]) {
      if (!['queued', 'downloading'].includes(control.button.dataset.state)) setThumbnailControlHovered(control, false);
    }
  }, true);
  document.addEventListener('click', event => {
    const path = event.composedPath();
    for (const control of activeThumbnailControls) {
      if (path.includes(control.button)) continue;
      const state = control.button.dataset.state;
      if (!control.host.hasAttribute('data-hovered') && !control.host.hasAttribute('data-previewing') && !['queued', 'downloading'].includes(state)) continue;
      const rect = control.button.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) continue;
      event.preventDefault();
      event.stopPropagation();
      if (state === 'play') openLocalThumbnailVideo(control.host.dataset.videoId);
      else if (state !== 'queued' && state !== 'downloading') startThumbnailDownload(control.video);
      break;
    }
  }, true);
  let repositionFrame = 0;
  window.addEventListener('scroll', () => {
    if (repositionFrame) return;
    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = 0;
      updateActiveThumbnailControls();
    });
  }, true);
  refreshLocalAvailability(true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLocalAvailability(); });
  setInterval(() => { if (!document.hidden) refreshLocalAvailability(); }, 20_000);
  scheduleCapture();
  scheduleMetadataPageCapture();
  startSearchScan();
  startChannelScan();
  startPlaylistScan();
})();
