(() => {
  if (window.__yourtubeExternalMediaControls) return;
  window.__yourtubeExternalMediaControls = true;

  const postStates = new Map();
  const articleControls = new WeakMap();
  const liveControls = new Set();
  const statusPath = /\/(?:@?[\p{L}\p{N}._-]{1,100}\/status\/|i\/(?:web\/)?status\/)(\d+)(?:\/video\/\d+)?\/?/u;
  let scanTimer = 0;
  let contextInvalidated = false;

  const cleanText = (value, max = 5000) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const safeImage = value => {
    try {
      const url = new URL(value || '', location.href);
      return url.protocol === 'https:' && /(^|\.)(pbs\.twimg\.com|abs\.twimg\.com)$/i.test(url.hostname) ? url.href : '';
    } catch { return ''; }
  };
  const postUrlFrom = article => {
    const links = [...article.querySelectorAll('a[href*="/status/"]')]
      .filter(link => link.closest('article[data-testid="tweet"]') === article);
    const candidate = links.map(link => {
      let url;
      try { url = new URL(link.href, location.href); } catch { return null; }
      const match = url.pathname.match(statusPath);
      if (!match || !/^https:$/.test(url.protocol) || !['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname)) return null;
      return { sourceId: match[1], url };
    }).filter(Boolean);
    const selected = candidate.find(item => item.url.pathname.includes('/status/'));
    if (!selected) return null;
    const statusUrl = new URL(`https://x.com/i/web/status/${selected.sourceId}`);
    const handle = selected.url.pathname.match(/^\/@?([\p{L}\p{N}._-]{1,100})\/status\//u)?.[1]?.replace(/^@/, '');
    if (handle && handle.toLowerCase() !== 'i') statusUrl.pathname = `/${encodeURIComponent(handle)}/status/${selected.sourceId}`;
    return { sourceId: selected.sourceId, sourceUrl: statusUrl.href };
  };

  function capturePost(article, player) {
    const identity = postUrlFrom(article);
    if (!identity) return null;
    const video = player.matches?.('video') ? player : player.querySelector('video');
    const text = cleanText(article.querySelector('[data-testid="tweetText"]')?.innerText || '', 5000);
    const userName = cleanText(article.querySelector('[data-testid="User-Name"]')?.innerText || '', 400);
    const handle = identity.sourceUrl.match(/x\.com\/([^/]+)\/status\//)?.[1] || '';
    const displayName = cleanText(userName.split(/\n|@/)[0], 200);
    const avatar = safeImage(article.querySelector('[data-testid^="UserAvatar"] img[src]')?.src || '');
    const poster = safeImage(video?.poster || player.querySelector('img[src]')?.src || '');
    const durationSeconds = Number(video?.duration);
    return {
      ...identity,
      title: text,
      description: text,
      authorName: displayName || (handle ? `@${handle}` : ''),
      avatar,
      thumbnail: poster,
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.floor(durationSeconds) : 0
    };
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        if (contextInvalidated || !chrome.runtime?.id) {
          contextInvalidated = true;
          reject(new Error('YourTube extension was reloaded. Refresh this X tab to reconnect.'));
          return;
        }
        chrome.runtime.sendMessage(message, response => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            if (/extension context invalidated/i.test(runtimeError.message || '')) contextInvalidated = true;
            reject(new Error(runtimeError.message || 'YourTube extension could not respond.'));
            return;
          }
          resolve(response || { ok: false, error: 'The YourTube extension returned no response.' });
        });
      } catch (error) {
        if (/extension context invalidated/i.test(String(error?.message || error))) contextInvalidated = true;
        reject(error);
      }
    });
  }

  function compactIssues(issues = []) {
    const labels = { 'title-missing': 'title missing', 'author-missing': 'author missing', 'thumbnail-missing': 'thumbnail missing', 'avatar-missing': 'avatar missing', 'duration-pending': 'duration pending', 'extractor-id-differs': 'source ID mapped' };
    return issues.map(issue => labels[issue?.code] || issue?.message).filter(Boolean).slice(0, 3);
  }

  function stateLabel(state) {
    if (state.status === 'submitting') return 'Sending to YourTube';
    if (state.status === 'downloading') return `Downloading · ${Math.floor(state.progress || 0)}%`;
    if (state.status === 'queued') return 'Queued';
    if (state.status === 'ready') return 'Play locally';
    if (state.status === 'error') return 'Retry download';
    return 'Download to YourTube';
  }

  function paint(state) {
    for (const control of liveControls) {
      if (control.sourceId !== state.sourceId || !control.host.isConnected) continue;
      control.host.dataset.state = state.status;
      const button = control.button;
      button.style.setProperty('--progress', `${Math.max(0, Math.min(100, Number(state.progress) || 0))}%`);
      button.innerHTML = state.status === 'ready'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'
        : state.status === 'error'
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v7m0 3v.1M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18h14"/></svg>';
      button.setAttribute('aria-label', stateLabel(state));
      button.title = [stateLabel(state), state.message, ...compactIssues(state.issues).map(label => `Capture note: ${label}`), ...(state.issues || []).map(issue => issue?.mitigation)].filter(Boolean).join('\n');
      control.caption.textContent = state.status === 'idle' || state.status === 'ready' ? '' : state.status === 'error' ? 'Retry' : stateLabel(state);
      control.caption.title = button.title;
      if (control.issues) {
        const notes = compactIssues(state.issues);
        control.issues.textContent = notes.length ? notes.join(' · ') : '';
        control.issues.hidden = notes.length === 0;
      }
    }
  }

  function setState(sourceId, changes) {
    const previous = postStates.get(sourceId) || { sourceId, status: 'idle', progress: 0, issues: [] };
    const state = { ...previous, ...changes, sourceId };
    postStates.set(sourceId, state);
    paint(state);
    return state;
  }

  function schedulePoll(sourceId, delay = 1200) {
    const state = postStates.get(sourceId);
    if (!state?.localId || !liveControls.size) return;
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(async () => {
      if (![...liveControls].some(control => control.sourceId === sourceId && control.host.isConnected)) return;
      try {
        const result = await sendRuntimeMessage({ type: 'yourtube:get-external-download-progress', videoId: state.localId });
        if (!result?.ok) throw new Error(result?.error || 'Could not read download progress.');
        applyDownload(sourceId, result.download || {});
      } catch (error) {
        setState(sourceId, { status: 'error', message: error?.message || 'Could not read download progress.' });
      }
    }, delay);
  }

  function applyDownload(sourceId, download = {}) {
    const state = postStates.get(sourceId) || { sourceId, issues: [] };
    const progress = Number(download.progress) || 0;
    if (download.status === 'ready') {
      setState(sourceId, { status: 'ready', progress: 100, message: '', localId: state.localId || download.id });
      clearTimeout(state.pollTimer);
      return;
    }
    const retryPending = ['pending', 'running', 'waiting-live', 'paused-offline'].includes(download.retryStatus);
    if (download.status === 'error' && !retryPending) {
      setState(sourceId, { status: 'error', progress, message: download.message || download.retryError || 'The download failed.' });
      return;
    }
    setState(sourceId, {
      status: download.status === 'downloading' ? 'downloading' : 'queued',
      progress,
      message: download.stage || download.message || 'Waiting for the YourTube download queue.'
    });
    schedulePoll(sourceId, download.status === 'downloading' ? 1200 : 3000);
  }

  async function activate(sourceId) {
    const state = postStates.get(sourceId);
    if (!state || state.status === 'submitting' || state.status === 'downloading' || state.status === 'queued') return;
    if (state.status === 'ready' && state.localId) {
      try {
        const result = await sendRuntimeMessage({ type: 'yourtube:open-external-local-media', videoId: state.localId });
        if (!result?.ok) throw new Error(result?.error || 'Could not open the local copy.');
      } catch (error) { setState(sourceId, { status: 'error', message: error?.message || 'Could not open local playback.' }); }
      return;
    }
    if (!state.capture?.sourceUrl) {
      setState(sourceId, { status: 'error', message: 'The post URL could not be read. Open the post and try again.' });
      return;
    }
    setState(sourceId, { status: 'submitting', progress: 0, message: 'Sending the captured post details to YourTube…' });
    try {
      const result = await sendRuntimeMessage({ type: 'yourtube:queue-external-media', capture: state.capture });
      if (!result?.ok) throw new Error(result?.error || 'Could not queue this X post.');
      if (result.download?.status === 'ready') {
        setState(sourceId, {
          status: 'ready', localId: result.id, progress: 100,
          issues: Array.isArray(result.issues) ? result.issues : [], message: ''
        });
        const opened = await sendRuntimeMessage({ type: 'yourtube:open-external-local-media', videoId: result.id });
        if (!opened?.ok) throw new Error(opened?.error || 'Could not open the local copy.');
        return;
      }
      setState(sourceId, {
        status: 'queued', localId: result.id, progress: Number(result.download?.progress) || 0,
        issues: Array.isArray(result.issues) ? result.issues : [], message: result.download?.stage || result.download?.message || 'YourTube accepted the post.'
      });
      applyDownload(sourceId, result.download || {});
    } catch (error) {
      setState(sourceId, { status: 'error', message: error?.message || 'Could not queue this X post.' });
    }
  }

  function addControl(article, player, capture) {
    let control = articleControls.get(article);
    if (control?.host.isConnected) {
      control.player = player;
      control.capture = capture;
      const state = postStates.get(capture.sourceId) || { sourceId: capture.sourceId, status: 'idle', progress: 0, issues: [], capture };
      state.capture = capture;
      postStates.set(capture.sourceId, state);
      control.sourceId = capture.sourceId;
      position(control);
      paint(state);
      return;
    }

    const host = document.createElement('div');
    host.className = 'yourtube-x-media-control';
    host.style.cssText = 'position:fixed;z-index:2147483647;width:60px;height:72px;pointer-events:none;visibility:hidden;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host{font-family:Arial,sans-serif}.wrap{position:relative;width:60px;height:72px;pointer-events:none}.action{position:absolute;top:0;right:4px;width:48px;height:48px;padding:0;display:grid;place-items:center;border:2px solid #ffffff80;border-radius:50%;background:conic-gradient(#fb3152 var(--progress,0%),#ffffff45 0) padding-box,#101113;box-shadow:0 3px 14px #0009;color:#fff;cursor:pointer;pointer-events:auto;opacity:0;transform:translateY(3px) scale(.94);transition:opacity .15s ease,transform .15s ease,background-color .15s ease}.action::before{content:"";position:absolute;inset:4px;border-radius:50%;background:#17191ceF;z-index:0}.action svg{position:relative;z-index:1;width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.action[data-state="ready"] svg{fill:currentColor;stroke:none}.action:hover{transform:scale(1.04)}.caption{position:absolute;top:51px;right:0;max-width:190px;padding:4px 7px;border-radius:5px;background:#111e;color:#fff;font-size:11px;white-space:nowrap;pointer-events:none}.issues{position:absolute;top:73px;right:0;max-width:250px;padding:4px 7px;border-radius:5px;background:#251e16ed;color:#ffd693;font-size:10px;white-space:nowrap;pointer-events:none}.issues[hidden]{display:none}:host([data-hovered="true"]) .action,:host([data-state="submitting"]) .action,:host([data-state="queued"]) .action,:host([data-state="downloading"]) .action,:host([data-state="ready"]) .action,:host([data-state="error"]) .action{opacity:1;transform:translateY(0) scale(1)}:host([data-state="ready"]) .action{border-color:#93ddb3}.caption:empty{display:none}
    </style><div class="wrap"><button class="action" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18h14"/></svg></button><span class="caption"></span><span class="issues" hidden></span></div>`;
    const button = shadow.querySelector('button');
    const caption = shadow.querySelector('.caption');
    const issues = shadow.querySelector('.issues');
    control = { article, player, host, button, caption, issues, sourceId: capture.sourceId, capture, hovered: false };
    articleControls.set(article, control);
    liveControls.add(control);
    host.addEventListener('mouseenter', () => { control.hovered = true; host.dataset.hovered = 'true'; });
    host.addEventListener('mouseleave', () => { control.hovered = false; updateHover(control); });
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void activate(control.sourceId); });
    player.addEventListener('pointerenter', () => { control.hovered = true; host.dataset.hovered = 'true'; }, { passive: true });
    player.addEventListener('pointerleave', () => { control.hovered = false; updateHover(control); }, { passive: true });
    (document.body || document.documentElement).append(host);
    position(control);
    const state = postStates.get(capture.sourceId) || { sourceId: capture.sourceId, status: 'idle', progress: 0, issues: [], capture };
    state.capture = capture;
    postStates.set(capture.sourceId, state);
    paint(state);
  }

  function updateHover(control) {
    if (!control.host.isConnected) return;
    const insideButton = Boolean(control.host.matches(':hover') || control.button.matches(':hover'));
    control.host.dataset.hovered = String(control.hovered || insideButton);
  }

  function position(control) {
    if (!control.host.isConnected || !control.player?.isConnected) return;
    const rect = control.player.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 70 || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
      control.host.style.visibility = 'hidden';
      return;
    }
    control.host.style.visibility = 'visible';
    control.host.style.left = `${Math.max(4, Math.min(innerWidth - 64, rect.right - 56))}px`;
    control.host.style.top = `${Math.max(4, Math.min(innerHeight - 76, rect.top + 8))}px`;
    updateHover(control);
  }

  function scan() {
    scanTimer = 0;
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      const player = article.querySelector('[data-testid="videoPlayer"]') || article.querySelector('video')?.parentElement;
      if (!player) continue;
      const capture = capturePost(article, player);
      if (!capture) continue;
      addControl(article, player, capture);
    }
    for (const control of [...liveControls]) {
      if (!control.article.isConnected) {
        control.host.remove();
        liveControls.delete(control);
        continue;
      }
      position(control);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, 350);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('pointerover', event => {
    if (event.target?.closest?.('article[data-testid="tweet"]')) scheduleScan();
  }, { passive: true });
  window.addEventListener('scroll', () => requestAnimationFrame(() => liveControls.forEach(position)), { passive: true });
  window.addEventListener('resize', () => requestAnimationFrame(() => liveControls.forEach(position)), { passive: true });
  scheduleScan();
})();
