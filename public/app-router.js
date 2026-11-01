(() => {
  const homeRoot = document.querySelector('#app');
  const homeStyles = document.querySelector('#home-styles');
  const homeCache = document.createDocumentFragment();
  const miniPlayer = document.querySelector('#mini-player');
  const miniVideoSlot = document.querySelector('#mini-player-video-slot');
  const miniTitle = document.querySelector('#mini-player-title');
  const miniState = document.querySelector('#mini-player-state');
  const miniQueuePanel = document.querySelector('#mini-player-queue-panel');
  const miniQueue = document.querySelector('#mini-player-queue');
  const miniQueueCount = document.querySelector('#mini-player-queue-count');
  const miniQueueSummary = document.querySelector('#mini-player-queue-summary');
  const miniQueueToggle = document.querySelector('#mini-player-queue-toggle');
  let miniQueueItems = [];
  let miniQueueRequest = 0;
  const routeCaches = new Map();
  let playerTemplatePromise;
  let playerStyle;
  let activeRoute = 'home';
  let navigationToken = 0;

  function setMiniPlayerVisible(visible) {
    miniPlayer.hidden = !visible;
    document.body.classList.toggle('yourtube-mini-player-active', visible);
  }

  async function refreshQueue() {
    const request = ++miniQueueRequest;
    try {
      const response = await fetch(`/api/queue?refresh=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return miniQueueItems;
      const rows = await response.json();
      if (request === miniQueueRequest) {
        miniQueueItems = Array.isArray(rows) ? rows : [];
        renderMiniQueue();
      }
    } catch {}
    return miniQueueItems;
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
      play.addEventListener('click', () => navigate(`/watch/${encodeURIComponent(item.id)}?yourtubeQueueItem=${encodeURIComponent(item.itemId)}`));
      const thumbnailWrap = document.createElement('span');
      thumbnailWrap.className = 'mini-queue-thumbnail-wrap';
      const thumbnail = document.createElement('img');
      thumbnail.className = 'mini-queue-thumbnail';
      thumbnail.alt = '';
      thumbnail.loading = 'lazy';
      thumbnail.referrerPolicy = 'no-referrer';
      if (typeof item.thumbnail === 'string' && item.thumbnail) thumbnail.src = item.thumbnail;
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
        await fetch(`/api/queue/${encodeURIComponent(item.itemId)}`, { method: 'DELETE' }).catch(() => {});
        window.dispatchEvent(new CustomEvent('yourtube-queue-updated'));
      });
      row.append(position, play, remove);
      miniQueue.append(row);
    });
  }

  function routeKind(url) {
    if (/^\/watch\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) return 'watch';
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

  async function ensurePlayerRoute(kind) {
    if (routeCaches.has(kind)) return routeCaches.get(kind);
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
    const route = { kind, root, fragment, started: false, initialPath: location.pathname };
    routeCaches.set(kind, route);
    root.hidden = true;
    document.body.insertBefore(root, miniPlayer);
    try {
      window.__yourtubePlayerRootForStartup = root;
      new Function(inlineScript.textContent)();
      route.started = true;
      delete window.__yourtubePlayerRootForStartup;
      const tickerResponse = await fetch('/header-value-ticker.js', { cache: 'no-store' });
      if (tickerResponse.ok) {
        window.__yourtubePlayerRootForStartup = root;
        new Function(await tickerResponse.text())();
        delete window.__yourtubePlayerRootForStartup;
      }
    } catch (error) {
      delete window.__yourtubePlayerRootForStartup;
      routeCaches.delete(kind);
      root.remove();
      throw error;
    }
    return route;
  }

  function currentPlayerVideo() {
    const route = routeCaches.get('watch');
    return route?.root.querySelector('#stage video') || miniVideoSlot.querySelector('video');
  }

  function updateMiniPlaybackState(video) {
    if (miniVideoSlot.querySelector('video') !== video) return;
    miniState.textContent = video.ended ? 'Finished' : video.paused ? 'Paused' : 'Playing while you browse';
  }

  function bindMiniPlaybackState(video) {
    if (video.dataset.yourtubeMiniStateBound !== 'true') {
      video.dataset.yourtubeMiniStateBound = 'true';
      for (const type of ['play', 'pause', 'ended']) video.addEventListener(type, () => updateMiniPlaybackState(video));
    }
    updateMiniPlaybackState(video);
  }

  function clampMiniPlayer() {
    if (miniPlayer.hidden || !miniPlayer.style.left) return;
    const left = Math.max(0, Math.min(window.innerWidth - miniPlayer.offsetWidth, miniPlayer.offsetLeft));
    const top = Math.max(0, Math.min(window.innerHeight - miniPlayer.offsetHeight, miniPlayer.offsetTop));
    miniPlayer.style.left = `${left}px`;
    miniPlayer.style.top = `${top}px`;
  }

  function putVideoInMiniPlayer() {
    const route = routeCaches.get('watch');
    const video = route?.root.querySelector('#stage video');
    if (!video) return;
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
    video.controls = true;
    miniVideoSlot.append(video);
    bindMiniPlaybackState(video);
    setMiniPlayerVisible(true);
    clampMiniPlayer();
    renderMiniQueue();
  }

  function restoreVideoToPlayer(route) {
    const video = miniVideoSlot.querySelector('video');
    const shell = route?.root.querySelector('#stage .player-shell');
    if (!video || !shell) return;
    video.controls = false;
    shell.insertBefore(video, shell.firstElementChild);
    setMiniPlayerVisible(false);
  }

  function detachActiveRoute() {
    if (activeRoute === 'home') {
      if (homeRoot.isConnected) homeCache.append(homeRoot);
      return;
    }
    const route = routeCaches.get(activeRoute);
    if (route?.root.isConnected) {
      route.root.hidden = true;
      route.fragment.append(route.root);
    }
  }

  function activateHome(url, { dispatchPopstate = false } = {}) {
    detachActiveRoute();
    homeRoot.querySelector('.route-navigation-error')?.remove();
    if (!homeRoot.isConnected) document.body.insertBefore(homeRoot, miniPlayer);
    homeRoot.hidden = false;
    if (playerStyle) playerStyle.disabled = true;
    if (homeStyles) homeStyles.disabled = false;
    activeRoute = 'home';
    if (dispatchPopstate) window.dispatchEvent(new PopStateEvent('popstate'));
    document.title = 'YourTube';
  }

  function showNavigationError(url, error) {
    if (activeRoute === 'watch') putVideoInMiniPlayer();
    activateHome(url);
    let notice = homeRoot.querySelector('.route-navigation-error');
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
      const topbar = homeRoot.querySelector('.topbar');
      if (topbar) topbar.after(notice);
      else homeRoot.prepend(notice);
    }
    notice.querySelector('.route-navigation-error-message').textContent = `This YourTube page could not be opened. ${error?.message || 'Try again in a moment.'}`;
  }

  async function activatePlayer(url, kind, token) {
    if (activeRoute === kind && kind === 'watch') {
      const targetId = decodeURIComponent(url.pathname.split('/').pop() || '');
      const currentId = currentPlayerVideo()?.dataset.yourtubeVideoId || '';
      const queueSelection = new URLSearchParams(url.search).get('yourtubeQueueItem');
      if (currentId !== targetId || queueSelection) window.yourtubeWatchNavigate?.(url.href, { fromRouter: true, refreshSameVideo: Boolean(queueSelection) });
      return;
    }
    if (activeRoute === kind && kind === 'downloads') return;
    const route = await ensurePlayerRoute(kind);
    if (token !== navigationToken) return;
    if (activeRoute === 'watch' && kind !== 'watch') putVideoInMiniPlayer();
    detachActiveRoute();
    if (homeRoot.isConnected) homeCache.append(homeRoot);
    homeRoot.hidden = true;
    route.root.hidden = false;
    document.body.insertBefore(route.root, miniPlayer);
    if (homeStyles) homeStyles.disabled = true;
    if (playerStyle) playerStyle.disabled = false;
    activeRoute = kind;
    homeRoot.querySelector('.route-navigation-error')?.remove();
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
      if (activeRoute === 'watch') putVideoInMiniPlayer();
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

  window.addEventListener('popstate', () => {
    const url = new URL(location.href);
    void showUrl(url, { dispatchPopstate: routeKind(url) === 'home' });
  });
  window.addEventListener('yourtube-main-video-ready', event => {
    if (activeRoute === 'watch' || !event.detail?.video) return;
    const old = miniVideoSlot.querySelector('video');
    if (old && old !== event.detail.video) {
      old.pause();
      old.removeAttribute('src');
      old.load();
      old.remove();
    }
    event.detail.video.controls = true;
    miniTitle.textContent = event.detail.title || event.detail.video.dataset.yourtubeVideoId || 'Your local video';
    miniVideoSlot.append(event.detail.video);
    bindMiniPlaybackState(event.detail.video);
    setMiniPlayerVisible(true);
    clampMiniPlayer();
  });
  window.addEventListener('yourtube-queue-updated', () => { void refreshQueue(); });

  document.querySelector('#mini-player-return').addEventListener('click', () => {
    const video = miniVideoSlot.querySelector('video');
    const id = video?.dataset.yourtubeVideoId;
    if (id) navigate(`/watch/${encodeURIComponent(id)}`);
  });
  document.querySelector('#mini-player-close').addEventListener('click', () => {
    const video = miniVideoSlot.querySelector('video');
    if (video) video.pause();
    setMiniPlayerVisible(false);
  });
  miniQueueToggle.addEventListener('click', () => {
    miniQueuePanel.hidden = !miniQueuePanel.hidden;
    miniQueueToggle.setAttribute('aria-expanded', String(!miniQueuePanel.hidden));
  });
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
    clampMiniPlayer();
  }, { passive: true });

  const initialUrl = new URL(location.href);
  if (routeKind(initialUrl) !== 'home') {
    homeRoot.hidden = true;
    void showUrl(initialUrl, { replace: true }).catch(error => console.error('[YourTube startup]', error));
  }
})();
