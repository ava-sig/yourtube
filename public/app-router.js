(() => {
  const homeRoot = document.querySelector('#app');
  const homeStyles = document.querySelector('#home-styles');
  const miniPlayer = document.querySelector('#mini-player');
  const miniVideoSlot = document.querySelector('#mini-player-video-slot');
  const miniTitle = document.querySelector('#mini-player-title');
  const miniState = document.querySelector('#mini-player-state');
  const miniQueuePanel = document.querySelector('#mini-player-queue-panel');
  const miniQueue = document.querySelector('#mini-player-queue');
  const miniQueueCount = document.querySelector('#mini-player-queue-count');
  const miniQueueSummary = document.querySelector('#mini-player-queue-summary');
  const miniQueueToggle = document.querySelector('#mini-player-queue-toggle');
  const miniAudioQueue = document.querySelector('#mini-player-audio-queue');
  const miniAudioNodes = {
    title: document.querySelector('#mini-player-audio-title'),
    channel: document.querySelector('#mini-player-audio-channel'),
    avatar: document.querySelector('#mini-player-channel-avatar'),
    initial: document.querySelector('#mini-player-channel-initial'),
    play: document.querySelector('#mini-player-audio-play'),
    current: document.querySelector('#mini-player-audio-current'),
    duration: document.querySelector('#mini-player-audio-duration'),
    seek: document.querySelector('#mini-player-audio-seek'),
    mute: document.querySelector('#mini-player-audio-mute'),
    volume: document.querySelector('#mini-player-audio-volume'),
    queueCount: document.querySelector('#mini-player-audio-queue-count')
  };
  const localizeImageSource = (source, videoId = '') => {
    if (typeof source !== 'string' || !source.trim()) return '';
    try {
      const image = new URL(source, location.origin);
      if (image.origin === location.origin) {
        if (image.pathname === '/api/remote-image' && /^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) {
          image.searchParams.set('video_id', videoId);
        }
        return `${image.pathname}${image.search}${image.hash}`;
      }
      if (image.protocol === 'https:' && /(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com|youtube\.com)$/i.test(image.hostname)) {
        const params = new URLSearchParams({ src: image.href });
        if (/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) params.set('video_id', videoId);
        return `/api/remote-image?${params}`;
      }
    } catch {}
    return '/image-placeholder.svg';
  };
  const miniSessionStorageKey = 'yourtube-mini-player-session-v1';
  const miniQueueExpandedStorageKey = 'yourtube-mini-player-queue-expanded-v1';
  const miniLayoutStorageKey = 'yourtube-mini-player-layout-v1';
  let miniQueueItems = [];
  let miniQueueRequest = 0;
  let miniSessionActive = false;
  let miniRestoreGeneration = 0;
  let miniLayout = 'popup';
  let miniLastVolume = 1;
  let miniServerReconnectTimer = null;
  const routeCaches = new Map();
  const routeLoads = new Map();
  let playerTemplatePromise;
  let playerStyle;
  let activeRoute = 'home';
  let navigationToken = 0;
  let noticeStackBodyObserver = null;
  let noticeStackContentObserver = null;
  let noticeStackPlayerObserver = null;
  let noticeStackResizeObserver = null;
  let observedAppNoticeLayer = null;
  let observedPlayerNoticeLayer = null;
  let noticeStackFrame = 0;

  function syncNoticeLayerStack() {
    const appLayer = document.body.querySelector(':scope > .app-notice-layer');
    const playerLayer = document.body.querySelector(':scope > .player-notice-layer');
    if (!playerLayer) return;
    if (playerLayer !== observedPlayerNoticeLayer) {
      noticeStackPlayerObserver?.disconnect();
      observedPlayerNoticeLayer = playerLayer;
      noticeStackPlayerObserver = new MutationObserver(scheduleNoticeLayerStack);
      noticeStackPlayerObserver.observe(playerLayer, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'], characterData: true });
    }
    if (appLayer !== observedAppNoticeLayer) {
      noticeStackContentObserver?.disconnect();
      noticeStackResizeObserver?.disconnect();
      observedAppNoticeLayer = appLayer;
      if (appLayer) {
        noticeStackContentObserver = new MutationObserver(scheduleNoticeLayerStack);
        noticeStackContentObserver.observe(appLayer, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'], characterData: true });
        if (window.ResizeObserver) {
          noticeStackResizeObserver = new ResizeObserver(scheduleNoticeLayerStack);
          noticeStackResizeObserver.observe(appLayer);
        }
      }
    }
    const appNetworkNotice = appLayer?.querySelector('.network-notice:not([hidden])')?.textContent.trim() || '';
    const playerNetworkNotice = playerLayer.querySelector('.network-mode-feedback');
    if (playerNetworkNotice && !playerNetworkNotice.hidden && appNetworkNotice && playerNetworkNotice.textContent.trim() === appNetworkNotice) playerNetworkNotice.hidden = true;
    const hasVisibleAppNotice = appLayer && [...appLayer.children].some(node => !node.hidden && node.getClientRects().length > 0);
    const appHeight = hasVisibleAppNotice ? Math.ceil(appLayer.getBoundingClientRect().height) : 0;
    const playerTop = 72 + (appHeight ? appHeight + 8 : 0);
    playerLayer.style.setProperty('--player-notice-stack-top', `${playerTop}px`);
    const hasVisiblePlayerNotice = !playerLayer.hidden && [...playerLayer.children].some(node => !node.hidden && node.getClientRects().length > 0);
    const playerHeight = hasVisiblePlayerNotice ? Math.ceil(playerLayer.getBoundingClientRect().height) : 0;
    const routeError = document.body.querySelector(':scope > .route-navigation-error');
    if (routeError) routeError.style.setProperty('--route-notice-stack-top', `${playerTop + (playerHeight ? playerHeight + 8 : 0)}px`);
  }

  function scheduleNoticeLayerStack() {
    if (noticeStackFrame) return;
    noticeStackFrame = requestAnimationFrame(() => {
      noticeStackFrame = 0;
      syncNoticeLayerStack();
    });
  }

  if (window.MutationObserver) {
    noticeStackBodyObserver = new MutationObserver(scheduleNoticeLayerStack);
    noticeStackBodyObserver.observe(document.body, { childList: true });
    scheduleNoticeLayerStack();
  }

  try { miniLayout = localStorage.getItem(miniLayoutStorageKey) === 'bar' ? 'bar' : 'popup'; } catch {}

  function syncMiniBarOffset() {
    const sidebar = document.querySelector('#app .layout > aside');
    const offset = sidebar && sidebar.getBoundingClientRect().width > 0 ? sidebar.getBoundingClientRect().right : 248;
    miniPlayer.style.setProperty('--mini-player-left', `${Math.max(0, Math.round(offset))}px`);
  }

  function setMiniLayout(layout, persist = true) {
    miniLayout = layout === 'bar' ? 'bar' : 'popup';
    syncMiniBarOffset();
    miniPlayer.classList.toggle('is-minimized', miniLayout === 'bar');
    document.body.classList.toggle('yourtube-mini-player-minimized', miniLayout === 'bar' && !miniPlayer.hidden);
    if (persist) {
      try { localStorage.setItem(miniLayoutStorageKey, miniLayout); } catch {}
    }
    if (miniLayout === 'popup') clampMiniPlayer();
  }

  function setMiniPlayerVisible(visible) {
    syncMiniBarOffset();
    miniPlayer.hidden = !visible;
    document.body.classList.toggle('yourtube-mini-player-active', visible);
    document.body.classList.toggle('yourtube-mini-player-minimized', visible && miniLayout === 'bar');
    miniPlayer.classList.toggle('is-minimized', miniLayout === 'bar');
  }

  function formatMiniTime(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const remainder = seconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  function updateMiniAudioState(video) {
    if (!video) return;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const current = Math.max(0, Number(video.currentTime) || 0);
    const progress = duration > 0 ? Math.min(1000, Math.round(current / duration * 1000)) : 0;
    miniAudioNodes.current.textContent = formatMiniTime(current);
    miniAudioNodes.duration.textContent = formatMiniTime(duration);
    if (document.activeElement !== miniAudioNodes.seek) miniAudioNodes.seek.value = String(progress);
    miniAudioNodes.seek.style.setProperty('--played', `${progress / 10}%`);
    miniAudioNodes.play.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    miniAudioNodes.play.title = video.paused ? 'Play' : 'Pause';
    miniAudioNodes.play.querySelector('use').setAttribute('href', video.paused ? '#yt-icon-play' : '#yt-icon-pause');
    miniAudioNodes.volume.value = String(video.muted ? 0 : video.volume);
    if (!video.muted && video.volume > 0) miniLastVolume = video.volume;
    const muted = video.muted || video.volume === 0;
    miniAudioNodes.mute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    miniAudioNodes.mute.title = muted ? 'Unmute' : 'Mute';
    miniAudioNodes.mute.querySelector('use').setAttribute('href', muted ? '#yt-icon-volume-mute' : '#yt-icon-volume');
  }

  function setMiniTrackMetadata(info = {}) {
    const video = miniVideoSlot.querySelector('video');
    const id = String(info.id || video?.dataset.yourtubeVideoId || '');
    if (info.title) miniTitle.textContent = info.title;
    const title = String(info.title || miniTitle.textContent || id || 'Your local video');
    const channel = String(info.channel || 'Playing from your library');
    miniAudioNodes.title.textContent = title;
    miniAudioNodes.channel.textContent = channel;
    miniAudioNodes.initial.textContent = channel.trim().slice(0, 1).toUpperCase() || 'YT';
    if (info.avatar) {
      miniAudioNodes.avatar.src = localizeImageSource(info.avatar);
      miniAudioNodes.avatar.hidden = false;
      miniAudioNodes.avatar.onerror = () => { miniAudioNodes.avatar.hidden = true; };
    } else {
      miniAudioNodes.avatar.removeAttribute('src');
      miniAudioNodes.avatar.hidden = true;
    }
    if (video) saveMiniSession(video, true);
  }

  async function loadMiniTrackMetadata(id, fallback = {}) {
    const requestedId = String(id || '');
    setMiniTrackMetadata({ ...fallback, id: requestedId });
    if (!/^[A-Za-z0-9_-]{11}$/.test(requestedId)) return;
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(requestedId)}?refresh=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const info = await response.json();
      if (miniVideoSlot.querySelector('video')?.dataset.yourtubeVideoId !== requestedId) return;
      setMiniTrackMetadata({ ...info, ...fallback, id: requestedId, title: fallback.title || info.title, channel: fallback.channel || info.channel, avatar: fallback.avatar || info.avatar });
    } catch {}
  }

  function clearMiniSession() {
    miniRestoreGeneration++;
    miniSessionActive = false;
    if (miniServerReconnectTimer) clearInterval(miniServerReconnectTimer);
    miniServerReconnectTimer = null;
    try { localStorage.removeItem(miniSessionStorageKey); } catch {}
  }

  function saveMiniSession(video, force = false) {
    if (!miniSessionActive || !video || !video.dataset.yourtubeVideoId) return;
    if (video.dataset.yourtubeMediaKind === 'short') {
      if (miniVideoSlot.contains(video)) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
      }
      clearMiniSession();
      setMiniPlayerVisible(false);
      return;
    }
    if (video.dataset.yourtubeMiniResumePending === 'true') {
      const target = Math.max(0, Number(video.dataset.yourtubeMiniResumeTarget) || 0);
      const resumeApplied = Math.abs((Number(video.currentTime) || 0) - target) <= 1;
      if (!resumeApplied) return;
      delete video.dataset.yourtubeMiniResumePending;
      delete video.dataset.yourtubeMiniResumeTarget;
    }
    const now = Date.now();
    const lastSaved = Number(video.dataset.yourtubeMiniSessionSavedAt) || 0;
    if (!force && now - lastSaved < 2000) return;
    const id = video.dataset.yourtubeVideoId;
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return;
    const session = {
      id,
      kind: video.dataset.yourtubeMediaKind || 'normal',
      title: miniTitle.textContent || id,
      currentTime: Math.max(0, Number(video.currentTime) || 0),
      duration: Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0,
      updatedAt: new Date(now).toISOString()
    };
    try {
      localStorage.setItem(miniSessionStorageKey, JSON.stringify(session));
      video.dataset.yourtubeMiniSessionSavedAt = String(now);
    } catch {}
  }

  function suppressMiniPlayerForShorts() {
    const video = miniVideoSlot.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    miniVideoSlot.replaceChildren();
    clearMiniSession();
    setMiniPlayerVisible(false);
    miniQueueItems = miniQueueItems.filter(item => item.kind !== 'short');
    renderMiniQueue();
    window.dispatchEvent(new CustomEvent('yourtube-mini-restore-cancelled'));
  }

  function setMiniQueueExpanded(expanded) {
    miniQueuePanel.hidden = !expanded;
    miniQueueToggle.setAttribute('aria-expanded', String(expanded));
    try { localStorage.setItem(miniQueueExpandedStorageKey, String(expanded)); } catch {}
  }

  function watchForMiniServerReconnect(id) {
    if (!miniSessionActive || miniServerReconnectTimer) return;
    let checking = false;
    const probe = async () => {
      if (checking || !miniSessionActive) return;
      let saved;
      try { saved = JSON.parse(localStorage.getItem(miniSessionStorageKey) || 'null'); } catch {}
      if (saved?.id !== id) {
        clearInterval(miniServerReconnectTimer);
        miniServerReconnectTimer = null;
        return;
      }
      checking = true;
      try {
        const response = await fetch(`/api/videos/${encodeURIComponent(id)}?refresh=${Date.now()}`, { cache: 'no-store' });
        if (!miniSessionActive) return;
        let latest;
        try { latest = JSON.parse(localStorage.getItem(miniSessionStorageKey) || 'null'); } catch {}
        if (latest?.id !== id) return;
        if (response.status === 404) {
          clearInterval(miniServerReconnectTimer);
          miniServerReconnectTimer = null;
          miniState.textContent = 'Saved video is unavailable';
        } else if (response.ok) {
          clearInterval(miniServerReconnectTimer);
          miniServerReconnectTimer = null;
          if (routeCaches.has('watch')) {
            window.dispatchEvent(new CustomEvent('yourtube-retry-active-player', {
              detail: { id, resumeAt: Math.max(0, Number(saved.currentTime) || 0) }
            }));
          } else {
            try {
              await ensurePlayerRoute('watch', {
                initialVideoId: id,
                resumeAt: Math.max(0, Number(saved.currentTime) || 0),
                miniRestore: true
              });
            } catch { watchForMiniServerReconnect(id); }
          }
        }
      } catch {} finally { checking = false; }
    };
    miniState.textContent = 'Waiting for YourTube server…';
    miniServerReconnectTimer = setInterval(() => { void probe(); }, 2500);
    void probe();
  }

  async function refreshQueue() {
    const request = ++miniQueueRequest;
    try {
      const response = await fetch(`/api/queue?refresh=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return miniQueueItems;
      const rows = await response.json();
      if (request === miniQueueRequest) {
        miniQueueItems = Array.isArray(rows) ? rows.filter(item => item?.kind !== 'short') : [];
        renderMiniQueue();
      }
    } catch {}
    return miniQueueItems;
  }

  function miniQueueWatchUrl(item) {
    const target = new URL(`/watch/${encodeURIComponent(item.id)}`, location.origin);
    target.searchParams.set('yourtubeQueueItem', String(item.itemId));
    if (item.sourcePlaylistId) {
      target.searchParams.set('yourtubePlaylist', item.sourcePlaylistId);
      if (Number(item.sourcePlaylistPosition) >= 0) target.searchParams.set('yourtubePlaylistPosition', String(item.sourcePlaylistPosition));
      target.searchParams.set('yourtubePlaylistLocal', '1');
      target.searchParams.set('yourtubePlaylistQueue', '1');
    }
    return `${target.pathname}${target.search}`;
  }

  function renderMiniQueue() {
    const items = miniQueueItems;
    miniQueueCount.textContent = String(items.length);
    miniQueueSummary.textContent = items.length ? `${items.length} ${items.length === 1 ? 'video' : 'videos'}` : 'Queue is empty';
    miniQueue.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'mini-queue-empty';
      empty.textContent = 'Add a video to the queue from any Up next list.';
      miniQueue.append(empty);
    }
    items.forEach((item, index) => {
      const row = document.createElement('li');
      const position = document.createElement('span');
      position.className = 'mini-queue-position';
      position.textContent = String(index + 1).padStart(2, '0');
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'mini-queue-play';
      play.title = item.title || item.id;
      play.addEventListener('click', () => navigate(miniQueueWatchUrl(item)));
      const thumbnailWrap = document.createElement('span');
      thumbnailWrap.className = 'mini-queue-thumbnail-wrap';
      const thumbnail = document.createElement('img');
      thumbnail.className = 'mini-queue-thumbnail';
      thumbnail.alt = '';
      thumbnail.loading = 'lazy';
      thumbnail.referrerPolicy = 'no-referrer';
      if (typeof item.thumbnail === 'string' && item.thumbnail) thumbnail.src = localizeImageSource(item.thumbnail, item.id);
      else thumbnail.hidden = true;
      thumbnail.addEventListener('error', () => { thumbnail.hidden = true; });
      thumbnailWrap.append(thumbnail);
      const duration = Math.max(0, Math.floor(Number(item.duration) || 0));
      const durationLabel = duration
        ? `${Math.floor(duration / 3600) ? `${Math.floor(duration / 3600)}:${String(Math.floor(duration / 60) % 60).padStart(2, '0')}` : Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`
        : '';
      if (durationLabel) {
        const badge = document.createElement('span');
        badge.className = 'mini-queue-duration';
        badge.textContent = durationLabel;
        thumbnailWrap.append(badge);
      }
      const progressDuration = Number(item.progressDuration) || duration;
      const progress = Math.max(0, Math.min(100, progressDuration > 0 ? (Number(item.currentTime) || 0) / progressDuration * 100 : 0));
      if (progress > 0 && progress < 100) {
        const bar = document.createElement('span');
        bar.className = 'mini-queue-progress';
        const fill = document.createElement('span');
        fill.style.width = `${progress}%`;
        bar.append(fill);
        thumbnailWrap.append(bar);
      }
      const copy = document.createElement('span');
      copy.className = 'mini-queue-copy';
      const title = document.createElement('span');
      title.className = 'mini-queue-title';
      title.textContent = item.title || item.id;
      const meta = document.createElement('span');
      meta.className = 'mini-queue-meta';
      const availability = item.downloaded ? 'Ready locally' : 'Needs download';
      meta.textContent = [item.channel || 'Channel unavailable', availability].join(' · ');
      copy.append(title, meta);
      play.append(thumbnailWrap, copy);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mini-queue-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${item.title || 'video'} from queue`);
      remove.addEventListener('click', async () => {
        miniQueueRequest++;
        miniQueueItems = miniQueueItems.filter(queued => String(queued.itemId) !== String(item.itemId));
        renderMiniQueue();
        try {
          const response = await fetch(`/api/queue/${encodeURIComponent(item.itemId)}`, { method: 'DELETE' });
          if (!response.ok) await refreshQueue();
        } catch { await refreshQueue(); }
        window.dispatchEvent(new CustomEvent('yourtube-queue-updated'));
      });
      row.append(position, play, remove);
      miniQueue.append(row);
    });
    miniAudioNodes.queueCount.textContent = String(items.length);
    miniAudioQueue.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('span');
      empty.className = 'mini-audio-queue-placeholder';
      empty.textContent = '—';
      miniAudioQueue.append(empty);
    }
    items.slice(0, 8).forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mini-audio-queue-item';
      button.title = item.title || item.id;
      button.setAttribute('aria-label', `Play next: ${item.title || item.id}`);
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      if (typeof item.thumbnail === 'string' && item.thumbnail) image.src = localizeImageSource(item.thumbnail, item.id);
      else image.hidden = true;
      image.addEventListener('error', () => { image.hidden = true; });
      const title = document.createElement('span');
      title.textContent = item.title || item.id;
      button.append(image, title);
      button.addEventListener('click', () => navigate(miniQueueWatchUrl(item)));
      miniAudioQueue.append(button);
    });
  }

  function routeKind(url) {
    if (/^\/(?:watch|shorts)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) return 'watch';
    if (url.pathname === '/downloads') return 'downloads';
    return 'home';
  }

  async function getPlayerTemplate() {
    if (!playerTemplatePromise) {
      playerTemplatePromise = fetch('/__app/player-template', { cache: 'no-store' }).then(async response => {
        if (!response.ok) throw new Error('The local player view could not be loaded.');
        return response.text();
      });
    }
    return playerTemplatePromise;
  }

  async function ensurePlayerRoute(kind, bootOptions = {}) {
    if (routeLoads.has(kind)) return routeLoads.get(kind);
    if (routeCaches.has(kind)) return routeCaches.get(kind);
    const loading = (async () => {
      const html = await getPlayerTemplate();
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const watchApp = parsed.querySelector('#watch-app');
      const playerHeader = parsed.querySelector('.watch-header');
      const inlineScript = [...parsed.scripts].find(script => !script.src);
      if (!watchApp || !playerHeader || !inlineScript) throw new Error('The local player view is incomplete.');
      if (!playerStyle) {
        playerStyle = document.createElement('style');
        playerStyle.id = 'player-route-styles';
        playerStyle.textContent = parsed.querySelector('style')?.textContent || '';
        playerStyle.disabled = true;
        document.head.append(playerStyle);
      }
      const root = document.createElement('div');
      root.className = `yourtube-player-route yourtube-player-route-${kind}`;
      root.append(playerHeader, watchApp);
      const fragment = document.createDocumentFragment();
      fragment.append(root);
      const route = { kind, root, fragment, noticeLayer: null, started: false, initialPath: location.pathname };
      routeCaches.set(kind, route);
      root.hidden = true;
      document.body.insertBefore(root, miniPlayer);
      try {
        window.__yourtubePlayerRootForStartup = root;
        if (bootOptions.initialVideoId) {
          window.__yourtubePlayerInitialVideoId = bootOptions.initialVideoId;
          window.__yourtubePlayerInitialResumeAt = bootOptions.resumeAt;
          window.__yourtubePlayerInitialMiniRestore = Boolean(bootOptions.miniRestore);
        }
        new Function(inlineScript.textContent)();
        route.started = true;
        route.noticeLayer = watchApp.querySelector('.player-notice-layer');
        if (route.noticeLayer) {
          route.noticeLayer.hidden = true;
          document.body.insertBefore(route.noticeLayer, miniPlayer);
          scheduleNoticeLayerStack();
        }
        delete window.__yourtubePlayerRootForStartup;
        delete window.__yourtubePlayerInitialVideoId;
        delete window.__yourtubePlayerInitialResumeAt;
        delete window.__yourtubePlayerInitialMiniRestore;
        // The app shell owns the only visible header. Player code keeps its detached
        // header nodes for compatibility with its existing status and search helpers.
        playerHeader.remove();
      } catch (error) {
        route.noticeLayer?.remove();
        delete window.__yourtubePlayerRootForStartup;
        delete window.__yourtubePlayerInitialVideoId;
        delete window.__yourtubePlayerInitialResumeAt;
        delete window.__yourtubePlayerInitialMiniRestore;
        routeCaches.delete(kind);
        root.remove();
        throw error;
      }
      return route;
    })();
    routeLoads.set(kind, loading);
    try {
      return await loading;
    } finally {
      if (routeLoads.get(kind) === loading) routeLoads.delete(kind);
    }
  }

  function currentPlayerVideo() {
    const route = routeCaches.get('watch');
    return route?.root.querySelector('#stage video') || miniVideoSlot.querySelector('video');
  }

  function updateMiniPlaybackState(video) {
    if (miniVideoSlot.querySelector('video') !== video) return;
    miniState.textContent = video.ended ? 'Finished'
      : video.dataset.yourtubeAutoplayBlocked === 'true' ? 'Autoplay blocked · press play'
        : video.paused ? 'Paused' : 'Playing while you browse';
    updateMiniAudioState(video);
  }

  function bindMiniPlaybackState(video) {
    if (video.dataset.yourtubeMiniStateBound !== 'true') {
      video.dataset.yourtubeMiniStateBound = 'true';
      for (const type of ['play', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'volumechange']) video.addEventListener(type, () => {
        if (type === 'play') delete video.dataset.yourtubeAutoplayBlocked;
        updateMiniPlaybackState(video);
        saveMiniSession(video, type !== 'loadedmetadata');
      });
      video.addEventListener('timeupdate', () => { updateMiniAudioState(video); saveMiniSession(video); });
      video.addEventListener('seeked', () => saveMiniSession(video, true));
    }
    updateMiniPlaybackState(video);
  }

  function clampMiniPlayer() {
    if (miniPlayer.hidden || miniLayout === 'bar' || !miniPlayer.style.left) return;
    const left = Math.max(0, Math.min(window.innerWidth - miniPlayer.offsetWidth, miniPlayer.offsetLeft));
    const top = Math.max(0, Math.min(window.innerHeight - miniPlayer.offsetHeight, miniPlayer.offsetTop));
    miniPlayer.style.left = `${left}px`;
    miniPlayer.style.top = `${top}px`;
  }

  function putVideoInMiniPlayer() {
    if (document.body.classList.contains('yourtube-shorts-page') || Boolean(window.yourtubeIsShortsMode?.())) {
      suppressMiniPlayerForShorts();
      return;
    }
    const route = routeCaches.get('watch');
    const video = route?.root.querySelector('#stage video');
    if (!video) return;
    if (video.dataset.yourtubeMediaKind === 'short') {
      suppressMiniPlayerForShorts();
      return;
    }
    const previous = miniVideoSlot.querySelector('video');
    if (previous && previous !== video) {
      previous.pause();
      previous.removeAttribute('src');
      previous.load();
      previous.remove();
    }
    const id = video.dataset.yourtubeVideoId || '';
    const title = route.root.querySelector('#title')?.textContent?.trim();
    miniTitle.textContent = title || id || 'Your local video';
    miniSessionActive = true;
    video.controls = true;
    miniVideoSlot.replaceChildren(video);
    bindMiniPlaybackState(video);
    void loadMiniTrackMetadata(id, { id, title: title || id });
    saveMiniSession(video, true);
    setMiniPlayerVisible(true);
    clampMiniPlayer();
    renderMiniQueue();
  }

  function handoffWatchPlayback() {
    if (activeRoute !== 'watch') return;
    const shortsActive = document.body.classList.contains('yourtube-shorts-page') || Boolean(window.yourtubeIsShortsMode?.());
    if (shortsActive) {
      suppressMiniPlayerForShorts();
      if (!window.yourtubeEndShortsPlayback?.()) currentPlayerVideo()?.pause();
      return;
    }
    putVideoInMiniPlayer();
  }

  function restoreVideoToPlayer(route) {
    const video = miniVideoSlot.querySelector('video');
    const shell = route?.root.querySelector('#stage .player-shell');
    if (!video) return;
    if (!shell) {
      video.pause();
      clearMiniSession();
      setMiniPlayerVisible(false);
      return;
    }
    clearMiniSession();
    video.controls = false;
    shell.insertBefore(video, shell.firstElementChild);
    setMiniPlayerVisible(false);
  }

  function detachActiveRoute() {
    if (activeRoute === 'home') return;
    const route = routeCaches.get(activeRoute);
    if (route?.noticeLayer) route.noticeLayer.hidden = true;
    if (route?.root.isConnected) {
      route.root.hidden = true;
      route.fragment.append(route.root);
    }
  }

  function activateHome(url, { dispatchPopstate = false } = {}) {
    detachActiveRoute();
    document.body.querySelector('.route-navigation-error')?.remove();
    if (!homeRoot.isConnected) document.body.insertBefore(homeRoot, miniPlayer);
    homeRoot.hidden = false;
    homeRoot.classList.remove('route-shell-only');
    if (playerStyle) playerStyle.disabled = true;
    if (homeStyles) homeStyles.disabled = false;
    activeRoute = 'home';
    document.body.classList.remove('yourtube-shorts-page', 'yourtube-shorts-comments-open');
    if (dispatchPopstate) {
      const event = new PopStateEvent('popstate', { state: { yourtubeInternalShellUpdate: true } });
      window.dispatchEvent(event);
    }
    document.title = 'YourTube';
  }

  function showNavigationError(url, error) {
    handoffWatchPlayback();
    activateHome(url);
    let notice = document.body.querySelector('.route-navigation-error');
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'route-navigation-error';
      notice.setAttribute('role', 'alert');
      const message = document.createElement('span');
      message.className = 'route-navigation-error-message';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => {
        notice.remove();
        navigate(url.href, { replace: true });
      });
      notice.append(message, retry);
      document.body.insertBefore(notice, miniPlayer);
    }
    notice.querySelector('.route-navigation-error-message').textContent = `This YourTube page could not be opened. ${error?.message || 'Try again in a moment.'}`;
  }

  async function activatePlayer(url, kind, token) {
    const targetIsShorts = kind === 'watch' && url.pathname.startsWith('/shorts/');
    if (targetIsShorts) suppressMiniPlayerForShorts();
    if (activeRoute === kind && kind === 'watch') {
      const targetId = decodeURIComponent(url.pathname.split('/').pop() || '');
      const currentId = currentPlayerVideo()?.dataset.yourtubeVideoId || '';
      const queueSelection = new URLSearchParams(url.search).get('yourtubeQueueItem');
      const shortsModeChanged = Boolean(window.yourtubeIsShortsMode?.()) !== targetIsShorts;
      if (currentId !== targetId || queueSelection || shortsModeChanged) window.yourtubeWatchNavigate?.(url.href, { fromRouter: true, refreshSameVideo: Boolean(queueSelection) });
      return;
    }
    if (activeRoute === kind && kind === 'downloads') return;
    if (kind === 'watch' && !miniPlayer.hidden && !miniVideoSlot.querySelector('video')) {
      clearMiniSession();
      setMiniPlayerVisible(false);
      miniVideoSlot.replaceChildren();
      window.dispatchEvent(new CustomEvent('yourtube-mini-restore-cancelled'));
    }
    const route = await ensurePlayerRoute(kind);
    if (token !== navigationToken) return;
    if (activeRoute === 'watch' && kind !== 'watch') handoffWatchPlayback();
    if (kind !== 'watch') document.body.classList.remove('yourtube-shorts-page', 'yourtube-shorts-comments-open');
    detachActiveRoute();
    homeRoot.hidden = false;
    homeRoot.classList.add('route-shell-only');
    route.root.hidden = false;
    document.body.insertBefore(route.root, miniPlayer);
    if (homeStyles) homeStyles.disabled = true;
    if (playerStyle) playerStyle.disabled = false;
    activeRoute = kind;
    if (route.noticeLayer) route.noticeLayer.hidden = false;
    scheduleNoticeLayerStack();
    document.body.querySelector('.route-navigation-error')?.remove();
    document.title = kind === 'downloads' ? 'Downloads in progress · YourTube' : 'YourTube';
    if (kind === 'watch') {
      const requestedId = decodeURIComponent(url.pathname.split('/').pop() || '');
      restoreVideoToPlayer(route);
      const video = route.root.querySelector('#stage video');
      const queueSelection = new URLSearchParams(url.search).get('yourtubeQueueItem');
      const differentLoadedVideo = Boolean(video && video.dataset.yourtubeVideoId !== requestedId);
      const routeWasCreatedForAnotherPath = !video && route.initialPath !== url.pathname;
      if (window.yourtubeWatchNavigate && (differentLoadedVideo || routeWasCreatedForAnotherPath || queueSelection)) {
        window.yourtubeWatchNavigate(url.href, { fromRouter: true, refreshSameVideo: Boolean(queueSelection) });
      }
    }
  }

  async function showUrl(url, options = {}) {
    const token = ++navigationToken;
    const kind = routeKind(url);
    if (kind === 'home') {
      handoffWatchPlayback();
      activateHome(url, { dispatchPopstate: options.dispatchPopstate ?? activeRoute !== 'home' });
      return;
    }
    try {
      await activatePlayer(url, kind, token);
    } catch (error) {
      if (token !== navigationToken) return;
      console.error('[YourTube navigation]', error);
      showNavigationError(url, error);
    }
  }

  function navigate(input, { replace = false } = {}) {
    let url;
    try { url = new URL(input, location.origin); } catch { return false; }
    if (url.origin !== location.origin) return false;
    const method = replace ? 'replaceState' : 'pushState';
    if (url.href !== location.href) history[method]({}, '', `${url.pathname}${url.search}${url.hash}`);
    void showUrl(url);
    return true;
  }

  window.yourtubeNavigate = navigate;
  window.yourtubeIsWatchVisible = () => activeRoute === 'watch';

  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || link.target && link.target !== '_self' || link.hasAttribute('download')) return;
    if (link.closest('#app') && !link.matches('.brand, .playlist-item-link')) return;
    if (link.matches('.recommendation-link')) return;
    let url;
    try { url = new URL(link.href, location.origin); } catch { return; }
    if (url.origin !== location.origin || !['watch', 'downloads'].includes(routeKind(url)) && url.pathname !== '/' && !url.pathname.startsWith('/channel/')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate(url.href);
  }, true);

  window.addEventListener('popstate', event => {
    if (event.state?.yourtubeInternalShellUpdate) return;
    const url = new URL(location.href);
    void showUrl(url, { dispatchPopstate: routeKind(url) === 'home' });
  });
  window.addEventListener('yourtube-main-video-ready', event => {
    if (activeRoute === 'watch' || !event.detail?.video) return;
    if (event.detail.shortsMode || event.detail.kind === 'short' || event.detail.video.dataset.yourtubeMediaKind === 'short' || Boolean(window.yourtubeIsShortsMode?.())) {
      suppressMiniPlayerForShorts();
      return;
    }
    if (event.detail.miniRestore && !miniSessionActive) {
      event.detail.video.pause();
      return;
    }
    const old = miniVideoSlot.querySelector('video');
    if (old && old !== event.detail.video) {
      old.pause();
      old.removeAttribute('src');
      old.load();
      old.remove();
    }
    event.detail.video.controls = true;
    miniTitle.textContent = event.detail.title || event.detail.video.dataset.yourtubeVideoId || 'Your local video';
    miniSessionActive = true;
    if (event.detail.miniRestore || Number(event.detail.resumeAt) > 5) {
      event.detail.video.dataset.yourtubeMiniResumePending = 'true';
      event.detail.video.dataset.yourtubeMiniResumeTarget = String(Math.max(0, Number(event.detail.resumeAt) || 0));
    }
    miniVideoSlot.replaceChildren(event.detail.video);
    bindMiniPlaybackState(event.detail.video);
    void loadMiniTrackMetadata(event.detail.id || event.detail.video.dataset.yourtubeVideoId, {
      id: event.detail.id || event.detail.video.dataset.yourtubeVideoId,
      title: event.detail.title,
      channel: event.detail.channel,
      avatar: event.detail.avatar
    });
    if (!event.detail.miniRestore) saveMiniSession(event.detail.video, true);
    setMiniPlayerVisible(true);
    clampMiniPlayer();
  });
  window.addEventListener('yourtube-autoplay-blocked', event => {
    const video = miniVideoSlot.querySelector('video');
    if (!video || video.dataset.yourtubeVideoId !== event.detail?.id) return;
    video.dataset.yourtubeAutoplayBlocked = 'true';
    updateMiniPlaybackState(video);
  });
  window.addEventListener('yourtube-mini-restore-failed', event => {
    const id = String(event.detail?.id || '');
    if (!miniSessionActive || !/^[A-Za-z0-9_-]{11}$/.test(id)) return;
    const video = miniVideoSlot.querySelector('video');
    if (video?.dataset.yourtubeVideoId === id) {
      saveMiniSession(video, true);
      video.pause();
    }
    const message = document.createElement('p');
    message.className = 'mini-player-restore-error';
    message.setAttribute('role', 'status');
    message.textContent = event.detail?.message || 'Saved playback could not be restored. Open the video to try again.';
    const contents = [message];
    const recoveryAt = Number(event.detail?.recoveryAt);
    if (Number.isFinite(recoveryAt) && recoveryAt > 0) {
      const recover = document.createElement('button');
      recover.className = 'mini-player-restore-recovery';
      recover.type = 'button';
      recover.textContent = `Skip damaged section · continue at ${formatMiniTime(recoveryAt)}`;
      recover.addEventListener('click', () => window.dispatchEvent(new CustomEvent('yourtube-retry-active-player', {
        detail: { id, resumeAt: recoveryAt, skipDamaged: true }
      })));
      contents.push(recover);
    }
    miniVideoSlot.replaceChildren(...contents);
    miniState.textContent = 'Playback needs attention';
    if (/failed to fetch|network|server unavailable/i.test(String(event.detail?.message || ''))) watchForMiniServerReconnect(id);
  });
  window.addEventListener('yourtube-mini-player-network-interruption', event => {
    const video = miniVideoSlot.querySelector('video');
    const id = String(event.detail?.id || '');
    if (!miniSessionActive || !video || video.dataset.yourtubeVideoId !== id) return;
    saveMiniSession(video, true);
    watchForMiniServerReconnect(id);
  });
  window.addEventListener('yourtube-queue-updated', () => { void refreshQueue(); });

  const returnToCurrentVideo = () => {
    const video = miniVideoSlot.querySelector('video');
    const id = video?.dataset.yourtubeVideoId;
    if (id) navigate(`/watch/${encodeURIComponent(id)}`);
  };
  document.querySelector('#mini-player-return').addEventListener('click', returnToCurrentVideo);
  document.querySelector('#mini-player-audio-return').addEventListener('click', returnToCurrentVideo);
  document.querySelector('#mini-player-minimize').addEventListener('click', () => {
    setMiniLayout('bar');
    miniAudioNodes.play.focus();
  });
  document.querySelector('#mini-player-maximize').addEventListener('click', () => {
    setMiniLayout('popup');
    document.querySelector('#mini-player-minimize').focus();
  });
  miniAudioNodes.play.addEventListener('click', () => {
    const video = miniVideoSlot.querySelector('video');
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  });
  miniAudioNodes.seek.addEventListener('input', () => {
    const video = miniVideoSlot.querySelector('video');
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const ratio = Number(miniAudioNodes.seek.value) / 1000;
    video.currentTime = Math.max(0, Math.min(video.duration, ratio * video.duration));
    miniAudioNodes.current.textContent = formatMiniTime(video.currentTime);
    miniAudioNodes.seek.style.setProperty('--played', `${ratio * 100}%`);
  });
  miniAudioNodes.mute.addEventListener('click', () => {
    const video = miniVideoSlot.querySelector('video');
    if (!video) return;
    const shouldUnmute = video.muted || video.volume === 0;
    if (shouldUnmute && video.volume === 0) video.volume = miniLastVolume || 1;
    else if (!shouldUnmute && video.volume > 0) miniLastVolume = video.volume;
    video.muted = !shouldUnmute;
    updateMiniAudioState(video);
  });
  miniAudioNodes.volume.addEventListener('input', () => {
    const video = miniVideoSlot.querySelector('video');
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, Number(miniAudioNodes.volume.value)));
    if (video.volume > 0) miniLastVolume = video.volume;
    video.muted = video.volume === 0;
    updateMiniAudioState(video);
  });
  const closeMiniPlayer = () => {
    const video = miniVideoSlot.querySelector('video');
    if (video) saveMiniSession(video, true);
    if (video) video.pause();
    clearMiniSession();
    window.dispatchEvent(new CustomEvent('yourtube-mini-restore-cancelled'));
    setMiniPlayerVisible(false);
  };
  document.querySelector('#mini-player-close').addEventListener('click', closeMiniPlayer);
  document.querySelector('#mini-player-audio-close').addEventListener('click', closeMiniPlayer);
  miniQueueToggle.addEventListener('click', () => {
    setMiniQueueExpanded(miniQueuePanel.hidden);
  });
  try {
    const savedExpanded = localStorage.getItem(miniQueueExpandedStorageKey) === 'true';
    miniQueuePanel.hidden = !savedExpanded;
    miniQueueToggle.setAttribute('aria-expanded', String(savedExpanded));
  } catch {}
  void refreshQueue();

  const dragHandle = document.querySelector('#mini-player-drag-handle');
  let dragState = null;
  try {
    const saved = JSON.parse(localStorage.getItem('yourtube-mini-player-position') || 'null');
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
      miniPlayer.style.left = `${saved.left}px`;
      miniPlayer.style.top = `${saved.top}px`;
      miniPlayer.style.right = 'auto';
      miniPlayer.style.bottom = 'auto';
    }
  } catch {}
  dragHandle.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    const rect = miniPlayer.getBoundingClientRect();
    dragState = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    dragHandle.setPointerCapture(event.pointerId);
  });
  dragHandle.addEventListener('pointermove', event => {
    if (!dragState) return;
    const left = Math.max(0, Math.min(window.innerWidth - miniPlayer.offsetWidth, dragState.left + event.clientX - dragState.x));
    const top = Math.max(0, Math.min(window.innerHeight - miniPlayer.offsetHeight, dragState.top + event.clientY - dragState.y));
    miniPlayer.style.left = `${left}px`;
    miniPlayer.style.top = `${top}px`;
    miniPlayer.style.right = 'auto';
    miniPlayer.style.bottom = 'auto';
  });
  dragHandle.addEventListener('pointerup', () => {
    if (dragState) {
      try { const rect = miniPlayer.getBoundingClientRect(); localStorage.setItem('yourtube-mini-player-position', JSON.stringify({ left: rect.left, top: rect.top })); } catch {}
    }
    dragState = null;
  });
  dragHandle.addEventListener('pointercancel', () => { dragState = null; });
  window.addEventListener('resize', () => {
    syncMiniBarOffset();
    clampMiniPlayer();
  }, { passive: true });

  window.addEventListener('pagehide', () => {
    saveMiniSession(miniVideoSlot.querySelector('video'), true);
  });

  async function restoreMiniSession() {
    const restoreGeneration = ++miniRestoreGeneration;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(miniSessionStorageKey) || 'null'); } catch { return; }
    if (!saved || !/^[A-Za-z0-9_-]{11}$/.test(String(saved.id || ''))) return;
    if (saved.kind === 'short') {
      clearMiniSession();
      setMiniPlayerVisible(false);
      return;
    }
    if (!saved.kind) {
      try {
        const response = await fetch(`/api/videos/${encodeURIComponent(saved.id)}?refresh=${Date.now()}`, { cache: 'no-store' });
        if (restoreGeneration !== miniRestoreGeneration) return;
        if (!response.ok) return;
        const info = await response.json();
        if (info.kind === 'short') {
          clearMiniSession();
          setMiniPlayerVisible(false);
          return;
        }
        if (!info.kind) return;
        saved.kind = info.kind;
      } catch { return; }
    }
    if (restoreGeneration !== miniRestoreGeneration || document.body.classList.contains('yourtube-shorts-page')) return;
    miniSessionActive = true;
    miniTitle.textContent = saved.title || saved.id;
    miniState.textContent = 'Restoring saved playback…';
    const loading = document.createElement('div');
    loading.className = 'mini-player-restore-loading';
    loading.setAttribute('role', 'status');
    loading.textContent = 'Restoring local playback…';
    miniVideoSlot.replaceChildren(loading);
    setMiniPlayerVisible(true);
    clampMiniPlayer();
    try {
      await ensurePlayerRoute('watch', {
        initialVideoId: saved.id,
        resumeAt: Math.max(0, Number(saved.currentTime) || 0),
        miniRestore: true
      });
      if (restoreGeneration !== miniRestoreGeneration) return;
    } catch (error) {
      if (restoreGeneration !== miniRestoreGeneration) return;
      miniVideoSlot.replaceChildren();
      const message = document.createElement('p');
      message.className = 'mini-player-restore-error';
      message.textContent = `Could not restore playback: ${error?.message || 'local player unavailable'}. Your saved position is kept.`;
      miniVideoSlot.append(message);
      miniState.textContent = 'Playback needs attention';
      watchForMiniServerReconnect(saved.id);
    }
  }

  const initialUrl = new URL(location.href);
  if (routeKind(initialUrl) !== 'home') {
    homeRoot.hidden = false;
    homeRoot.classList.add('route-shell-only');
    void showUrl(initialUrl, { replace: true }).catch(error => console.error('[YourTube startup]', error));
    if (routeKind(initialUrl) === 'downloads') void restoreMiniSession();
  } else {
    void restoreMiniSession();
  }
})();
