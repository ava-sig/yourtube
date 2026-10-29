(() => {
  chrome.runtime.sendMessage({ type: 'yourtube:get-mode' }, result => {
    if (!chrome.runtime.lastError && result?.mode) window.postMessage({ type: 'yourtube:mode-state', mode: result.mode }, location.origin);
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.type === 'yourtube:mode-change' && ['online', 'offline', 'preparing'].includes(message.mode)) {
      chrome.runtime.sendMessage({ type: message.mode === 'preparing' ? 'yourtube:set-mode-state' : 'yourtube:set-mode', mode: message.mode });
      return;
    }
    if (message?.type === 'yourtube:collect-search') {
      if (!/^[a-f0-9-]{36}$/i.test(String(message.searchId || '')) || typeof message.query !== 'string') return;
      chrome.runtime.sendMessage({
        type: 'yourtube:open-search',
        searchId: message.searchId,
        query: message.query
      });
      return;
    }
    if (message?.type === 'yourtube:collect-channel-batch') {
      if (typeof message.channelKey !== 'string' || !Array.isArray(message.captures) || message.captures.length !== 6) return;
      chrome.runtime.sendMessage({
        type: 'yourtube:open-channel-batch',
        channelKey: message.channelKey,
        captures: message.captures
      }, result => {
        window.postMessage({ type: 'yourtube:channel-batch-opened', result: result || null }, location.origin);
      });
      return;
    }
    if (message?.type !== 'yourtube:collect-channel') return;
    if (!/^[a-f0-9-]{36}$/i.test(String(message.captureId || '')) || typeof message.channelKey !== 'string') return;
    chrome.runtime.sendMessage({
      type: 'yourtube:open-channel', captureId: message.captureId,
      channelKey: message.channelKey, tab: message.tab
    }, result => {
      window.postMessage({ type: 'yourtube:channel-opened', captureId: message.captureId, result: result || null }, location.origin);
    });
  });
})();
