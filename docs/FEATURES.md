# Implemented feature inventory

This inventory reflects the source currently in this project. Feature proposals are listed separately at the end so they are not mistaken for shipped behavior.

## Feed capture and homepage

- The unpacked Chrome extension captures rendered YouTube video cards, subscriptions, thumbnails, channel avatars, visible durations, playlist/Mix cards, and channel-page content.
- The extension toolbar popup shows localhost reachability and mode, video-length queue counts, active metadata tabs, media retry counts, channel work, recent capture events, and a way to claim the next video-length job while Online.
- It filters likely sponsored cards, YouTube Playables, YouTube movie listings, and cards with explicit rent/buy/member-only markers, and rejects generic `Watch` titles. Cards are de-duplicated by video ID.
- Confirmed movie listings and paid/member-only items are removed from the active library, acquisition queues, and media storage; their metadata is archived and an exclusion record blocks later syncs. Permanently unavailable recordings keep their metadata stubs and are marked unavailable without automatic retries.
- The homepage is a local projection of accumulated stubs. It has **For you**, a featured **Your Daily Mix**, **Downloaded**, **Top News**, topic rows, Shorts, and normal-video rows, with YouTube-style section separators and Show more controls.
- **For you** excludes downloaded files. Its Most recent/Older chips use the two-day boundary; with no chip selected, the current default ordering is retained. Each card can show its exact source and a rounded “pulled … ago” time.
- The sidebar includes subscriptions (the first seven, then Show more), local navigation, and library statistics including local file count, media bytes, tracked view starts, extension stubs, and the extension duration-capture baseline.
- Refreshing the YourTube homepage can reshuffle undownloaded stubs; downloaded items are ordered by acquisition time. It does not replace accumulated stubs with only the latest extension batch. Current undownloaded shuffling is not weighted by acquisition recency.
- **Your Daily Mix** is a date-stable, locally generated playlist featured after For you and before Downloaded. It targets a balance of ready local tracks and recent music stubs, weights familiar artists and detected styles by playback starts/completions/progress, and applies artist and recent-mix diversity penalties. A new day's mix recomputes from the latest local viewing history. Offline mode displays only already downloaded tracks.
- Daily Mix matching is deterministic and metadata-based: artist identity comes from channel names (or a title prefix when unavailable), while broad style tags are inferred from saved video/channel descriptions, topic labels, and playlist names. It does not analyze audio or claim a style match when those fields contain no usable clue. There is no external preference service.

Feed-section identification depends on YouTube's rendered markup. Topic assignment and Top News recognition are best-effort.

## Search

- The header search input is available from the home and single-video views. Results appear as the user types; Enter is not needed.
- The embedded toggle switches between **YouTube** (matching stubs already in the local database, with downloaded media excluded) and **Local** (downloaded media only). In YouTube mode, a compact local-results teaser switches to local search.
- After one second without typing, YouTube mode asks the extension to open an inactive YouTube results tab. The extension streams rendered results back to YourTube while the app remains focused on its own tab.
- The result view combines stored matching stubs with the live extension search session, displays a spinner until the first batch is stable, polls for more results, and requests further batches of 12 as the user scrolls or chooses Show more.
- Search sessions, clicked results, and query text are saved locally. A selected search result can contribute an unclicked recommendation to Up next.

Search collection requires Online mode and the extension. YouTube-mode results are limited to what the extension has rendered and what the local database has collected.

## Channels and playlists

- Local channel pages show captured channel identity, banner/avatar, description, and section tabs for Home, Videos, Shorts, Live, Playlists, and Community.
- Opening a channel asks the extension to prefetch the requested section first, then the remaining requested sections. Section progress and delivery failures are recorded; channel-section tabs are processed sequentially.
- Captured cards retain channel and section provenance. The channel page renders saved items while background capture fills more.
- One adapter recognizes playlist and Mix cards across homepage, search, channel playlist tabs, and open playlist pages. It normalizes `/playlist?list=` and `/watch?list=` links and sends metadata and captured entries through the same extension sync path. Opening an incomplete YouTube playlist in YourTube automatically opens an inactive acquisition tab; the extension scrolls the playlist, syncs loaded entries, and closes the tab when finished. The detail view polls for new local entries and hydrates without a manual refresh. A capture is marked delivered only after server or retry-queue acknowledgement; open YouTube pages recapture when the app returns Online. Playlist-page entries are taken from the playlist container, so watch recommendations are not mistaken for playlist members. Imports are read-only relative to YouTube; entries still unloaded on YouTube remain marked incomplete.
- Local playlists support create, rename, add/remove, reorder, Watch later, shuffle, sequential playback, and adding items to the shared playback queue. Captured YouTube playlists and Mixes remain available in the Playlists view. Playlist cards use layered thumbnails, a Mix/Playlist badge, and an explicit Playlist label to distinguish them from playable video cards. The homepage playlist row is replaced by the Daily Mix feature. Video card menus also expose download and recommendation feedback. Share and Report are present as inactive choices.

## Local playback and Up next

- Opening a stub routes to a local watch page immediately. It shows acquisition progress, waits for local media, then plays the saved file. WebM is preferred; finite videos can use a compatible MP4 fallback. Failure is shown explicitly; playback does not silently switch back to YouTube.
- Playback position is persisted and restored for unfinished videos. The local view-start count increments when playback starts; it is a start counter, not a measure of watch time.
- The player supports speed/volume controls, a local download link, autoplay, smooth expanded/theater layout, fullscreen, and a responsive layout that keeps navigation and comments available around the player.
- The same local `<video>` element continues across internal navigation. On other pages it moves into a draggable mini player; returning to the watch view moves that element back without restarting playback. Its position is saved locally.
- **Add to queue** on playlist and Up next cards uses the existing server-side playback queue. That queue appears in the mini player and watch view, takes priority when the current clip ends even if Autoplay is off, and removes each item after its local file is ready to play. Unavailable local media is acquired when its queued item starts.
- Keyboard shortcuts: **J** seeks back 10 seconds, **K** and **Space** toggle play/pause, **L** seeks forward 10 seconds, **0–9** seek to 0–90%, and **F** toggles fullscreen.
- Up next is split into **Downloaded & unwatched**, **Deleting soon**, **Because you searched**, and **From your homepage**, with separators and per-section toggles. Disabled sections collapse to an expand arrow; enabled sections receive more of the 12-item recommendation budget.
- Downloaded & unwatched can include partially watched, unfinished files and displays their saved position as a thin red thumbnail bar. Deleting soon is driven only by active expiration deadlines.
- Because you searched excludes already opened or partially watched results and labels an item with its query. From your homepage excludes downloaded videos and search-provided stubs; it selects from a pool of up to 48 recent homepage stubs and can expand in six-item increments. The current UI shuffles this pool without weighting each stub by acquisition time.
- Autoplay proceeds through playlist items and then Up next when the playlist ends.

The current recommendation endpoint considers up to 100 recent searches and returns as many as 12 eligible candidates; the UI initially allocates three to each enabled section and redistributes unused slots. This is broader than the earlier design note of selecting only from the last three searches.

## Downloads and durable work

- yt-dlp runs in the Node process. Progress output is parsed into a percentage and human-readable stage shown in the browser and downloads view.
- Separate audio/video tracks are merged with ffmpeg when needed. Completed media is one local WebM or MP4 per video ID, with WebM preferred. A missing compatible format pauses for attention instead of retrying the same request.
- Downloads continue when the user navigates away, as long as the local server process stays running. The progress page sorts active downloads by progress and lists paused work separately.
- Failures carry a reason, attempt count, and scheduled retry. First retry delay is 10 seconds with exponential increase up to 30 minutes. After ten failures the item remains paused for user attention.
- Live streams are treated separately from finite videos. A live capture can be ended and saved or discarded. Offline transitions pause download attempts but allow transfers already underway to settle; a captured playable copy is retained.
- A visible status page exposes queues for media, downloaded metadata, video lengths, comments, channel captures, search captures, and Offline preparation.

Optional anti-throttling protections (`off`, `auto`, `always`) are controlled by `YOURTUBE_DOWNLOAD_PROTECTIONS` and default to `off`. `auto` activates a cooldown/serialized retry behavior after a sign-in or bot-check response; `always` serializes from startup. Browser credentials are not passed to yt-dlp in any mode.

## Metadata, Offline mode, and retention

- The duration pipeline can use rendered extension cards, browser-visible watch-page metadata, yt-dlp metadata, or duration probed from a local file/playback. Missing metadata has explicit queued, capturing, retrying, Upcoming, and unavailable states.
- The downloaded-metadata queue checks the local video details, duration, thumbnail, channel avatar, comments, and commenter avatars. It stores capped comment data (up to 50) and caches referenced images locally. Incomplete items retry with phase-specific status.
- Extension duration capture has a versioned coverage baseline: unique stubs record whether first capture contained a duration and whether a later capture filled it.
- Online mode checks connectivity and returns to Offline when the connection is lost. Offline mode blocks discovery, external search capture, and automatic retry work; it restricts recommendations/search to local material.
- Going Offline normally waits for active transfers and the active local metadata pass, then prepares video lengths, comments, thumbnails, channel avatars, and commenter avatars. The status page supports immediate pause and background resume on the next Online transition.
- Auto-delete is independently controlled. With it enabled, each ready media file has a 24-hour lifetime. Turning it off removes active expiry deadlines. The final hour is shown in the Downloaded view and eligible files appear in Deleting soon. Media expiry removes the file but retains its stub and history.

## Storage and limits

`data/yourtube.sqlite` stores structured state; `data/media/` stores WebM or MP4 files; `data/images/` stores cached images. `YOURTUBE_DATA_DIR` moves this local state as a unit. There is no tenant model or remote YourTube database in this project.

Transcripts, transcript search, semantic embeddings, and AI-generated multi-video chapter overviews with selection rationales are **not implemented**. The app currently has aggregate view counts, latest playback progress, titles/channels/provenance, comments, and media metadata. It does not retain a complete timestamped event for every playback start.

## Project-maintenance notes

The project originally had no Git repository. The requested commit therefore creates an initial tracked snapshot; there is no prior commit history available to reconstruct individual feature commits or exact implementation dates. This inventory records the present code and known limits.
