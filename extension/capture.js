(() => {
  const cardSelector = 'ytd-rich-item-renderer, ytd-rich-grid-slim-media, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model';
  const youtubePlaylistAdapters = [
    { selector: 'ytd-radio-renderer, ytd-compact-radio-renderer', kind: 'mix', allowWatchList: true },
    { selector: 'ytd-grid-playlist-renderer, ytd-compact-playlist-renderer, ytd-playlist-renderer', kind: 'playlist', allowWatchList: true },
    { selector: 'yt-lockup-view-model', kind: 'playlist', allowWatchList: false }
  ];
  let pending = 0;
  let lastSent = '';
  let lastPlaylistSearchSignature = '';
  let expandedCount = 0;
  const expandedControls = new WeakSet();
  const observedAvatarImages = new WeakSet();
  const initialSearchUrl = new URL(location.href);
  const metadataCaptureId = /^[A-Za-z0-9_-]{11}$/.test(initialSearchUrl.searchParams.get('yourtube_metadata_capture') || '')
    ? initialSearchUrl.searchParams.get('yourtube_metadata_capture') : '';
  let metadataCaptureSent = false;
  let metadataCaptureAttempts = 0;
  let metadataCaptureTimer = 0;
  let metadataCommentsScrollStarted = false;
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
      if (!['www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return '';
      return ['/playlist', '/watch'].includes(url.pathname) ? (url.searchParams.get('list') || '') : '';
    } catch { return ''; }
  }

  function text(element) {
    return (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function imageUrl(image) {
    if (!image) return '';
    const imageHost = image.closest('yt-img-shadow, yt-image');
    const srcsetUrls = (image.getAttribute('srcset') || image.getAttribute('data-srcset') || '')
      .split(',').map(candidate => candidate.trim().split(/\s+/)[0]);
    return [image.currentSrc, image.getAttribute('src'), image.getAttribute('data-src'), image.getAttribute('data-thumb'),
      imageHost?.getAttribute('src'), imageHost?.getAttribute('data-src'), ...srcsetUrls]
      .find(source => /^https?:\/\//i.test(source || '')) || '';
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
    const tags = (document.querySelector('meta[name="keywords"]')?.content || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 100);
    return {
      title: title.slice(0, 500), channel: dedupeLabel(channel).slice(0, 200), channelId,
      channelKey, channelUrl: channelKey ? `https://www.youtube.com/${channelKey}` : '',
      thumbnail, avatar, durationSeconds,
      description, viewCount, tags,
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
      const ageGateVisible = /sign in to confirm your age|confirm your age/i.test(String(document.body?.innerText || '').slice(0, 3000));
      // Length is the job's blocking field. Give YouTube time to render the
      // player and start loading comments, but don't hold the queue open for
      // twelve seconds when the duration is already available.
      const ready = capture.durationSeconds > 0 && metadataCaptureAttempts >= 5;
      const exhausted = metadataCaptureAttempts >= 36 || (ageGateVisible && metadataCaptureAttempts >= 5);
      if (ready || exhausted) {
        metadataCaptureSent = true;
        chrome.runtime.sendMessage({
          type: 'yourtube:metadata-page-capture', videoId: metadataCaptureId,
          capture, failed: !(capture.durationSeconds > 0),
          error: ageGateVisible ? 'YouTube did not render video details in the browser page. Check the signed-in YouTube tab and age confirmation.' : 'The signed-in YouTube page did not expose a video length.'
        });
        return;
      }
      scheduleMetadataPageCapture();
    }, 1500);
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

  function readCard(card) {
    const anchors = [...card.querySelectorAll('a[href*="/watch"], a[href*="/shorts/"]')];
    const anchor = anchors.find(item => videoIdFrom(item.href));
    if (!anchor || isExcluded(card, anchor)) return null;

    const id = videoIdFrom(anchor.href);
    const titleElement = card.querySelector('#video-title, h3, [title]');
    const title = text(titleElement) || titleElement?.getAttribute('title') || anchor.getAttribute('aria-label') || '';
    if (!id || !title || /^watch$/i.test(title.trim())) return null;

    const section = card.closest('ytd-rich-section-renderer');
    const sectionTitle = text(section?.querySelector('#title, h2, yt-formatted-string'));
    const topic = ['Music', 'Gaming', 'News', 'Live', 'Sports', 'Learning', 'Movies & TV', 'Podcasts']
      .find(value => sectionTitle.toLowerCase().includes(value.toLowerCase())) || '';
    const thumbnailImage = card.querySelector('ytd-thumbnail img, a#thumbnail img, yt-image#img img, img#img') || card.querySelector('img');
    const thumbnail = thumbnailImage?.currentSrc || thumbnailImage?.getAttribute('src') || '';
    const channelLink = card.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/user/"], a[href*="/c/"]');
    const channelKey = channelKeyFromLink(channelLink?.href);
    const avatarImage = card.querySelector('#channel-thumbnail img, ytd-channel-avatar-renderer img, yt-avatar-view-model img, yt-avatar-shape img, .yt-spec-avatar-shape__image, .yt-lockup-metadata-view-model__avatar img, #avatar-container img, #avatar img') ||
      channelLink?.querySelector('img, yt-img-shadow img, yt-image img');
    const avatar = imageUrl(avatarImage);
    const channel = dedupeLabel(text(channelLink) || text(card.querySelector('#channel-name, ytd-channel-name')) || channelLink?.getAttribute('aria-label') || channelLink?.getAttribute('title') || '')
      .replace(/\s*\.\s*New content available\.?$/i, '').trim();
    const duration = readDuration(card);
    const meta = text(card.querySelector('#metadata-line'));
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
      kind: anchor.pathname.startsWith('/shorts/') ? 'short' : 'normal',
      section: trackedSearch() ? 'search' : new URL(location.href).searchParams.has('list') ? 'playlist' : /top news/i.test(sectionTitle) ? 'news' : 'home',
      topic,
      sourceChannelKey: source?.channelKey || '',
      sourceTab: source?.tab || ''
    };
  }

  function playlistTitleFrom(card, anchor) {
    const titleElement = card?.querySelector('.yt-lockup-metadata-view-model__title, #video-title, #title, h3, [title]');
    return dedupeLabel(text(titleElement) || titleElement?.getAttribute('title') || anchor?.getAttribute('aria-label') || '')
      .replace(/\s*\d[\d,.]*\s+videos?\s*$/i, '').trim();
  }

  function adaptYouTubePlaylistRenderer(card, adapter) {
    const anchors = [...card.querySelectorAll('a[href*="list="]')];
    const anchor = anchors.find(candidate => {
      try {
        const url = new URL(candidate.href, location.origin);
        return url.pathname === '/playlist' || (adapter.allowWatchList && url.pathname === '/watch');
      } catch { return false; }
    });
    const id = anchor ? playlistIdFrom(anchor.href) : '';
    if (!id || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) return null;
    const title = playlistTitleFrom(card, anchor);
    if (!title || /^watch$/i.test(title)) return null;
    const itemCountMatch = text(card).match(/([\d,]+)\s+videos?/i);
    const itemCount = itemCountMatch ? Number.parseInt(itemCountMatch[1].replaceAll(',', ''), 10) : 0;
    const image = card.querySelector('ytd-thumbnail img, yt-thumbnail-view-model img, img');
    const channelAnchor = card.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/user/"], a[href*="/c/"]');
    return {
      id,
      title: title.slice(0, 300),
      kind: adapter.kind === 'mix' || /^RD/i.test(id) ? 'mix' : 'playlist',
      channel: dedupeLabel(text(channelAnchor)).slice(0, 200),
      thumbnail: image?.currentSrc || image?.getAttribute('src') || '',
      itemCount,
      items: []
    };
  }

  function readPlaylists(renderedVideos) {
    const playlists = new Map();
    const currentId = new URL(location.href).searchParams.get('list') || '';
    if (currentId && /^[A-Za-z0-9_-]{1,160}$/.test(currentId)) {
      const header = document.querySelector('ytd-playlist-header-renderer, ytd-playlist-page-header-renderer, ytd-playlist-sidebar-renderer, yt-page-header-renderer');
      const title = playlistTitleFrom(header, null) || document.title.replace(/\s*-\s*YouTube.*$/i, '').trim();
      if (title && !/^YouTube$/i.test(title)) {
        const headerText = text(header);
        const countMatch = headerText.match(/([\d,]+)\s+videos?/i);
        const itemCount = countMatch ? Number.parseInt(countMatch[1].replaceAll(',', ''), 10) : 0;
        const playlistContainers = [...document.querySelectorAll('ytd-playlist-video-list-renderer, ytd-playlist-panel-renderer, ytd-playlist-video-list-renderer')];
        const sourceCards = playlistContainers.length
          ? playlistContainers.flatMap(container => [...container.querySelectorAll(cardSelector)])
          : renderedVideos.map(item => item.card);
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
        const image = item?.querySelector('img');
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
            imageHost?.getAttribute('src'),
            imageHost?.getAttribute('data-src'),
            ...srcsetUrls
          ];
          avatar = sources.find(source => /^https?:\/\//i.test(source || '')) || '';
          const lazySource = image.getAttribute('data-src') || image.getAttribute('data-thumb');
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
    if (!trackedChannel() || channelComplete) return;
    if (complete) channelPendingComplete = true;
    if (final) {
      channelPendingFinal = true;
      channelPendingFinalMessage = message;
    }
    expandMoreControls();
    const profile = readChannelProfile();
    const changed = [];
    for (const card of document.querySelectorAll(cardSelector)) {
      const video = readCard(card);
      if (!video || (activeChannelTab === 'shorts' && video.kind !== 'short') || (activeChannelTab === 'videos' && video.kind === 'short')) continue;
      const previous = channelCards.get(video.id);
      const item = { ...video, channelKey: profile.key, channelUrl: `https://www.youtube.com/${profile.key}`, position: previous?.position ?? channelCards.size };
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
    if (metadataCaptureId && location.pathname === '/watch') return;
    if (trackedChannel()) {
      captureChannel(false, channelRounds === 0 ? 'priority' : 'background');
      return;
    }
    expandMoreControls();
    const cardsById = new Map();
    for (const card of document.querySelectorAll(cardSelector)) {
      const video = readCard(card);
      if (video && !cardsById.has(video.id)) {
        cardsById.set(video.id, video);
        if (trackedSearch()) observedSearchVideoIds.add(video.id);
      }
    }
    const cards = [...cardsById.values()].map((video, position) => ({ ...video, position }));
    const subscriptions = readSubscriptions();
    const playlistRecords = readPlaylists([...document.querySelectorAll(cardSelector)].map(card => ({ card })));
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
      const playlistSignature = JSON.stringify(playlistRecords);
      if (playlistSignature !== lastPlaylistSearchSignature && playlistRecords.length) {
        lastPlaylistSearchSignature = playlistSignature;
        chrome.runtime.sendMessage({ type: 'yourtube:sync', videos: [], subscriptions: [], playlists: playlistRecords, provisionCategory: 'other' });
      }
      return;
    }
    const signature = JSON.stringify([
      cards.map(video => [video.id, video.title, video.channel, video.thumbnail, video.avatar, video.duration, video.section, video.topic, video.sourceChannelKey, video.sourceTab]),
      subscriptions.map(subscription => [subscription.key, subscription.name]),
      playlistRecords
    ]);
    if ((!cards.length && !subscriptions.length) || signature === lastSent) return;
    lastSent = signature;
    chrome.runtime.sendMessage({
      type: 'yourtube:sync', videos: cards, subscriptions, playlists: playlistRecords,
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

  const observer = new MutationObserver(scheduleCapture);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'data-thumb', 'class']
  });
  document.addEventListener('yt-navigate-finish', scheduleCapture);
  document.addEventListener('yt-navigate-finish', scheduleMetadataPageCapture);
  window.addEventListener('scroll', scheduleCapture, { passive: true });
  scheduleCapture();
  scheduleMetadataPageCapture();
  startSearchScan();
  startChannelScan();
})();
