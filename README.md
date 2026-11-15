# YourTube

YourTube is a single-user, local-first video library. A browser extension reads structured details from YouTube pages you already have open; a local Node.js server stores video stubs, metadata, playback history, and downloaded WebM files; a Vue interface lets you browse and play that library.

The extension does not copy YouTube's page or send browser cookies or account credentials to the server. It records where captured stubs appeared, including YouTube pages, searches, playlists, channels, and homepage sections. The server uses `yt-dlp` without cookies. A YourTube watch page plays the local file and reports acquisition errors instead of silently falling back to YouTube playback.

Local playback continues while navigating between YourTube pages. Away from the watch view, the same video element appears in a movable mini player; the shared **Add to queue** list is available there and on playlists and Up next cards.

## Start YourTube

Requirements: Node.js 22.5 or newer, `yt-dlp`, and `ffmpeg` for merging separate audio and video streams. YourTube prefers WebM; for videos with a known finite length, it can fall back to a compatible MP4. Vue is bundled in `public/vendor`; no npm packages need to be installed.

```sh
npm start
```

For development, run `npm run dev`. Node watches `server.js` and restarts the server when the backend changes. Refresh the browser after frontend edits; changes under `data/` do not trigger a restart. This uses Node's native `--watch-path` support; see the [Node.js CLI documentation](https://nodejs.org/api/cli.html#--watch-path).

Open <http://127.0.0.1:4173>. The server binds to loopback by default. To use YourTube from another device on your trusted home network:

```sh
npm start -- --host 0.0.0.0
```

Then open `http://<computer-LAN-IP>:4173` on the other device. Binding to `0.0.0.0` makes the app and its API reachable from the local network.

## Run in Docker

Requirements: Docker Desktop (macOS or Windows), or Docker Engine with the Docker Compose v2 plugin (Linux). The image contains the YourTube server, Node.js, `yt-dlp`, `ffmpeg`, and `ffprobe`. The browser extension stays installed in your browser and communicates with the server on localhost.

```sh
cp .env.example .env
mkdir -p docker-data docker-media
docker compose up --build -d
```

Open <http://127.0.0.1:4173>. Check startup and health with:

```sh
docker compose ps
docker compose logs -f yourtube
curl -fsS http://127.0.0.1:4173/healthz
```

Persistent files stay outside the container in two separate host folders. `docker-data/` stores the SQLite database, cached images, optional transcription audio, and other app state. `docker-media/` stores video files and the `shorts/` subfolder. Transcript-ready audio retention is off by default; set `YOURTUBE_KEEP_TRANSCRIPTION_AUDIO=on` in `.env` to enable it. To use a mounted drive instead, set `YOURTUBE_DATA_HOST_PATH` and `YOURTUBE_MEDIA_HOST_PATH` in `.env` to existing folders on that drive. For example, if the drive is mounted at `/media`, use `/media` for app data and `/media/media` for video files. Compose refuses to start if either configured folder is missing, so an absent drive cannot silently become an empty library elsewhere. On Linux, set `YOURTUBE_UID` and `YOURTUBE_GID` to the values from `id -u` and `id -g` so the container can write to the mounted folders. Keep a separate backup of both folders; the media drive itself is not a backup.

If port 4173 is already in use, set `YOURTUBE_PORT` in `.env` to another free port, such as `4174`, and open `http://127.0.0.1:4174`. The default is loopback-only, so the app is not exposed to your network or the public internet.

Docker's `/healthz` endpoint is used for container health reporting. The extension can be loaded from this repository's `extension/` folder as described below. This is the local/self-hosted packaging step; a future Electron app can make installation easier for consumers across operating systems. A later hosted product would be a separate deployment and security project.

Useful commands:

```sh
docker compose logs -f yourtube
docker compose down
docker compose up -d --build
```

`docker compose down` leaves the bind-mounted data and media directories in place.

## Load the extension

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this project's `extension` directory. Reload the unpacked extension after changing its files. On extension updates, the worker reloads open YourTube tabs that are not currently playing audio, so they receive a fresh bridge instead of retaining an invalidated content-script context. The current source manifest is version **0.5.39**. Its toolbar popup shows server connectivity, network mode, queue counts, active browser captures, recent extension events, and the oldest video-length jobs. The Browser work section can pause new video-length capture tabs and set their concurrency from one to five; existing tabs stay open. If its background worker does not respond, the popup probes localhost directly and tells you to reload the extension instead of reporting a false server outage.

For Safari, regenerate or update the Safari Web Extension package from the `extension` directory after changing its manifest. The localhost match patterns omit a port for Safari compatibility; the bridge itself only runs on YourTube's `localhost:4173` or `127.0.0.1:4173` origin.

Open YouTube in the same browser profile where the extension is installed. The extension captures rendered cards, subscriptions, playlist/Mix structures, channel sections, and page-visible metadata. It sends structured records to `127.0.0.1:4173`; it does not send credentials. Homepage and search captures update the local stub database asynchronously. Channel-page prefetch uses one channel tab at a time; missing video-length jobs can use up to five configurable inactive metadata-capture tabs alongside channel work.

## Local data

By default, YourTube stores its runtime database in `data/yourtube.runtime.sqlite`, alongside downloaded media, cached images, and optional transcription audio. On first start, it copies the existing `data/yourtube.sqlite` database into that runtime file; this keeps the tracked starter database clean. If you set `YOURTUBE_DATA_DIR`, the runtime database is named `yourtube.sqlite` inside that folder. Set `YOURTUBE_MEDIA_DIR` to keep the media folder on a separate disk. Transcript-ready audio retention is off by default; set `YOURTUBE_KEEP_TRANSCRIPTION_AUDIO=on` to enable it. YourTube watches the media folder and also rescans every 30 seconds. A stable file named `<11-character YouTube ID>.webm` or `.mp4` is integrity-checked, matched to its existing stub, and added to the local library. If no stub exists, YourTube creates one and fills in metadata in the background. Files with other names are listed as unmatched by `/api/media-folder/status`; rename them to the ID-based format to import them. Removing a recognized file makes its retained stub available for download again. Folder-imported files are not auto-deleted by the 24-hour retention setting.

The repository includes a fresh starter `data/yourtube.sqlite` with the app's default settings and empty library tables. Runtime library data, media, image caches, transcription audio, and other generated files remain excluded from Git. Keep your personal database and assets private when contributing changes.

## License and permitted use

YourTube is source available under the [PolyForm Noncommercial License 1.0.0](LICENSE). It permits personal, noncommercial use, including private entertainment and hobby use without an anticipated commercial application; the license also lists certain noncommercial institutions whose use is permitted regardless of funding. Other commercial use requires a separate license from the copyright holder, who may grant one to Ultima. This is **not an OSI-approved open-source release**, because the license restricts commercial use. The [Open Source Definition](https://opensource.org/osd) requires that open-source licenses not restrict commercial use.

This license applies to YourTube's code. It does not grant rights to YouTube videos, authorize uses that YouTube or applicable law prohibit, or permit bypassing DRM or other technical protections. The repository's `NOTICE` file carries the required attribution. Product names and logos remain separate from the code license.

See [Third-party notices](THIRD_PARTY_NOTICES.md) for bundled and runtime components. Commercial use of a community contribution in Ultima is subject to the contributor agreement in [CLA.md](CLA.md).

See [Architecture](docs/ARCHITECTURE.md) for the data flow and tables, [Features](docs/FEATURES.md) for the implemented user-facing behavior, and [Decision record](docs/DECISIONS.md) for the reasons behind the main choices and current limits.

## Operating controls

- **Online / Offline:** Online mode requires a successful connectivity check. If connectivity drops while Online is selected, YourTube switches Offline and returns Online automatically when the connection comes back. A deliberate Offline choice is remembered and will not be overridden by reconnection. Offline mode pauses discovery and retry work, limits search and Up next to local material, and prepares lengths, comments, thumbnails, and avatars for downloaded files. A status page reports background work. “Go offline immediately” pauses preparation and resumes it next time Online is enabled.
- **Auto-delete:** When enabled, downloaded media expires after 24 hours. Turning it off clears active expiration deadlines. Deleting media preserves its stub and local viewing history.
- **Download retry protections:** `YOURTUBE_DOWNLOAD_PROTECTIONS` accepts `off` (default), `auto`, or `always`. `auto` enables a shared cooldown and serial automatic downloads after a sign-in/bot-check response; `always` serializes downloads from startup. Retries stop after ten failures and remain visible in the paused queue.
- **Duration backfill:** `npm run backfill:durations` checks local progress and media first, then uses sequential, cookie-free `yt-dlp` metadata lookups. It pauses when YouTube rate-limits metadata requests.
- **Topic backfill:** `npm run backfill:topics` previews deterministic topic labels from saved categories, search phrases, titles, channel names, tags, and descriptions. Add `-- --apply` to write high-confidence labels to the runtime database; items without enough evidence remain uncategorized.
- **Downloaded library:** Browse local media by channel or inferred topic, sort groups and their files by total file size, views, likes, availability, or recency, filter to items never played, play a whole group, or delete its local files while retaining metadata. File sizes recorded during integrity checks are reused; when a size is missing, the app reads it from the media file on demand while sorting by size.

## Current boundaries

YouTube's rendered DOM changes over time, so card, duration, ad, and section detection may need updates. Channel and playlist imports are based on content YouTube renders. Captures remain subject to YouTube availability and access restrictions. YourTube has local playback history and metadata search; transcript indexing and the proposed AI-generated multi-video chapter overviews are not implemented yet.
