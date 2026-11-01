(() => {
  if (!['localhost', '127.0.0.1'].includes(location.hostname) || location.port !== '4173') return;

  const isInvalidatedContext = error => /extension context (?:was )?invalidated/i.test(String(error?.message || error || ''));
  const postToPage = message => {
    try { window.postMessage(message, location.origin); } catch {}
  };
  let contextInvalidated = false;

  const sendToExtension = (message, onResponse) => {
    if (contextInvalidated) return;
    const notify = (response, error) => {
      try {
        const result = onResponse?.(response, error);
        if (result && typeof result.then === 'function') {
          result.catch(callbackError => {
            if (isInvalidatedContext(callbackError)) contextInvalidated = true;
          });
        }
      } catch (callbackError) {
        if (isInvalidatedContext(callbackError)) contextInvalidated = true;
      }
    };
    try {
      const runtime = chrome?.runtime;
      if (!runtime?.id) {
        contextInvalidated = true;
        return;
      }
      runtime.sendMessage(message, response => {
        try {
          const runtimeError = runtime.lastError;
          if (isInvalidatedContext(runtimeError)) {
            contextInvalidated = true;
            return;
          }
          notify(runtimeError ? null : response, runtimeError || null);
        } catch (error) {
          if (isInvalidatedContext(error)) {
            contextInvalidated = true;
            return;
          }
          notify(null, error);
        }
      });
    } catch (error) {
      if (isInvalidatedContext(error)) {
        contextInvalidated = true;
        return;
      }
      notify(null, error);
    }
  };

  sendToExtension({ type: 'yourtube:get-mode' }, result => {
    if (result?.mode) postToPage({ type: 'yourtube:mode-state', mode: result.mode });
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.type === 'yourtube:mode-change' && ['online', 'offline', 'preparing'].includes(message.mode)) {
      sendToExtension({ type: message.mode === 'preparing' ? 'yourtube:set-mode-state' : 'yourtube:set-mode', mode: message.mode });
      return;
    }
    if (message?.type === 'yourtube:collect-search') {
      if (!/^[a-f0-9-]{36}$/i.test(String(message.searchId || '')) || typeof message.query !== 'string') return;
      sendToExtension({
        type: 'yourtube:open-search',
        searchId: message.searchId,
        query: message.query
      });
      return;
    }
    if (message?.type === 'yourtube:collect-playlist') {
      const playlistId = String(message.playlistId || '');
      const requestId = String(message.requestId || '');
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(playlistId) || !/^[a-f0-9-]{36}$/i.test(requestId)) return;
      sendToExtension({ type: 'yourtube:open-playlist', playlistId, requestId }, (result, runtimeError) => {
        postToPage({
          type: 'yourtube:playlist-opened', playlistId, requestId,
          result: result || { ok: false, error: runtimeError?.message || 'The extension could not open a playlist capture tab.' }
        });
      });
      return;
    }
    if (message?.type === 'yourtube:collect-channel-batch') {
      if (typeof message.channelKey !== 'string' || !Array.isArray(message.captures) || message.captures.length !== 6) return;
      sendToExtension({
        type: 'yourtube:open-channel-batch',
        channelKey: message.channelKey,
        captures: message.captures
      }, (result, error) => {
        postToPage({ type: 'yourtube:channel-batch-opened', result: result || { ok: false, error: error?.message || 'The extension could not open channel captures.' } });
      });
      return;
    }
    if (message?.type !== 'yourtube:collect-channel') return;
    if (!/^[a-f0-9-]{36}$/i.test(String(message.captureId || '')) || typeof message.channelKey !== 'string') return;
    sendToExtension({
      type: 'yourtube:open-channel', captureId: message.captureId,
      channelKey: message.channelKey, tab: message.tab
    }, (result, error) => {
      postToPage({ type: 'yourtube:channel-opened', captureId: message.captureId, result: result || { ok: false, error: error?.message || 'The extension could not open this channel.' } });
    });
  });
  try {
    chrome.runtime.onMessage.addListener(message => {
      if (contextInvalidated) return;
      if (message?.type !== 'yourtube:playlist-capture-finished') return;
      postToPage(message);
    });
  } catch (error) {
    if (isInvalidatedContext(error)) contextInvalidated = true;
  }
})();
