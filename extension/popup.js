const button = document.querySelector('#mode');
const status = document.querySelector('#status');
let mode = 'online';

function render() {
  button.textContent = mode === 'preparing' ? 'Preparing offline cache…' : mode === 'offline' ? 'Offline · click for Online' : 'Online · click for Offline';
  button.disabled = mode === 'preparing';
  if (mode !== 'preparing') status.textContent = '';
}

function refreshMode() {
  chrome.runtime.sendMessage({ type: 'yourtube:get-mode' }, result => {
    if (chrome.runtime.lastError) { status.textContent = 'Open YourTube to connect.'; return; }
    mode = result?.mode || 'online';
    render();
  });
}
refreshMode();
setInterval(refreshMode, 1000);

button.addEventListener('click', () => {
  const next = mode === 'online' ? 'offline' : 'online';
  button.disabled = true;
  status.textContent = next === 'offline' ? 'Caching local comments and images…' : '';
  chrome.runtime.sendMessage({ type: 'yourtube:set-mode', mode: next }, result => {
    if (chrome.runtime.lastError || !result?.ok) {
      status.textContent = result?.error || 'Could not reach the local YourTube server.';
      button.disabled = false;
      return;
    }
    mode = result.mode;
    render();
  });
});
