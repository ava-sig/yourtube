(() => {
  const messages = [
    'Every successful play leaves a local copy.',
    'Your viewing metadata stays on localhost.',
    'Your watch history stays on your machine.',
    'No ad breaks in local playback.',
    'Resume right where you left off.',
    'Rewatch acquired files without streaming again.',
    'Build your library by watching what you choose.',
    'Wi-Fi now. Local replay later.',
    'Local playback adds no watch event to YouTube.',
    'Keep titles, channels and durations with your media.',
    'Turn a passing feed into a library you control.',
    'Your attention feeds your library, not a profile.',
    'A local attractor for the videos you choose.',
    'Each click can move a video from feed to library.'
  ];
  const header = document.querySelector('.watch-header, .topbar');
  const ticker = document.querySelector('#header-value-ticker');
  const line = ticker?.querySelector('.header-value-line');
  const brand = header?.querySelector('.brand');
  const search = header?.querySelector('.watch-search, .search');
  if (!header || !ticker || !line || !brand || !search) return;

  let index = 0;
  let timer = 0;
  const positionTicker = () => {
    const headerBounds = header.getBoundingClientRect();
    const brandBounds = brand.getBoundingClientRect();
    const searchBounds = search.getBoundingClientRect();
    const left = Math.ceil(brandBounds.right - headerBounds.left + 14);
    const right = Math.floor(searchBounds.left - headerBounds.left - 16);
    const width = right - left;
    if (width < 132) {
      ticker.hidden = true;
      return;
    }
    ticker.hidden = false;
    ticker.style.left = `${left}px`;
    ticker.style.width = `${width}px`;
  };

  const showNext = () => {
    const message = messages[index];
    index = (index + 1) % messages.length;
    line.classList.remove('is-animating');
    line.textContent = message;
    line.title = message;
    void line.offsetWidth;
    line.classList.add('is-animating');
    positionTicker();
    clearTimeout(timer);
    timer = setTimeout(showNext, 5000);
  };

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(positionTicker);
    observer.observe(header);
    observer.observe(brand);
    observer.observe(search);
  }
  window.addEventListener('resize', positionTicker, { passive: true });
  positionTicker();
  showNext();
})();
