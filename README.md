# YourTube

YourTube is a single-user, local-first video library. A browser extension reads structured details from YouTube pages you already have open; a local Node.js server stores video stubs, metadata, playback history, and downloaded WebM files; a Vue interface lets you browse and play that library.

The extension does not copy YouTube's page or send browser cookies or account credentials to the server. The server uses `yt-dlp` without cookies. A YourTube watch page plays the local file and reports acquisition errors instead of silently falling back to YouTube playback.

## Start YourTube

Requirements: Node.js 22.5 or newer, `yt-dlp`, and `ffmpeg` for merging separate WebM video and audio streams. Vue is bundled in `public/vendor`; no npm packages need to be installed.

```sh
npm start
```

Open <http://127.0.0.1:4173>. The server binds to loopback by default. To use YourTube from another device on your trusted home network:

```sh
npm start -- --host 0.0.0.0
```

Then open `http://<computer-LAN-IP>:4173` on the other device. Binding to `0.0.0.0` makes the app and its API reachable from the local network.

## Load the extension

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this project's `extension` directory. Reload the unpacked extension after changing its files, then refresh the YourTube tab. The current source manifest is version **0.5.10**.

Open YouTube in the same browser profile where the extension is installed. The extension captures rendered cards, subscriptions, playlist/Mix structures, channel sections, and page-visible metadata. It sends structured records to `127.0.0.1:4173`; it does not send credentials. Homepage and search captures update the local stub database asynchronously. Channel-page prefetch uses one channel tab at a time; missing video-length jobs can use up to two inactive metadata-capture tabs alongside channel work.

## Local data

By default, YourTube creates `data/` for `yourtube.sqlite`, downloaded media, and cached images. Set `YOURTUBE_DATA_DIR` to keep those files elsewhere. The database includes viewing counts and progress, search history, playlists, metadata, and local-library state. These are personal data, so `data/`, media, image caches, and runtime files are excluded from Git.

See [Architecture](docs/ARCHITECTURE.md) for the data flow and tables, [Features](docs/FEATURES.md) for the implemented user-facing behavior, and [Decision record](docs/DECISIONS.md) for the reasons behind the main choices and current limits.

## Operating controls

- **Online / Offline:** Online mode requires a successful connectivity check. Offline mode pauses discovery and retry work, limits search and Up next to local material, and prepares lengths, comments, thumbnails, and avatars for downloaded files. A status page reports background work. “Go offline immediately” pauses preparation and resumes it next time Online is enabled.
- **Auto-delete:** When enabled, downloaded media expires after 24 hours. Turning it off clears active expiration deadlines. Deleting media preserves its stub and local viewing history.
- **Download retry protections:** `YOURTUBE_DOWNLOAD_PROTECTIONS` accepts `off` (default), `auto`, or `always`. `auto` enables a shared cooldown and serial automatic downloads after a sign-in/bot-check response; `always` serializes downloads from startup. Retries stop after ten failures and remain visible in the paused queue.
- **Duration backfill:** `npm run backfill:durations` checks local progress and media first, then uses sequential, cookie-free `yt-dlp` metadata lookups. It pauses when YouTube rate-limits metadata requests.

## Current boundaries

YouTube's rendered DOM changes over time, so card, duration, ad, and section detection may need updates. Channel and playlist imports are based on content YouTube renders. Captures remain subject to YouTube availability and access restrictions. YourTube has local playback history and metadata search; transcript indexing and the proposed AI-generated multi-video chapter overviews are not implemented yet.
