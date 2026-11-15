# Implemented feature inventory

This inventory reflects the source currently in this project. Feature proposals are listed separately at the end so they are not mistaken for shipped behavior.

## Feed capture and homepage

- The unpacked Chrome extension captures rendered YouTube video cards, subscriptions, thumbnails, channel avatars, visible durations, playlist/Mix cards, and channel-page content.
- The extension toolbar popup shows localhost reachability and mode, video-length queue counts, active metadata tabs, media retry counts, channel work, recent capture events, and a way to claim the next video-length job while Online.
- It filters likely sponsored cards, YouTube Playables, YouTube movie listings, and cards with explicit rent/buy/member-only markers, and rejects generic `Watch` titles. Cards are de-duplicated by video ID.
- Confirmed movie listings and paid/member-only items are removed from the active library, acquisition queues, and media storage; their metadata is archived and an exclusion record blocks later syncs. Permanently unavailable recordings keep their metadata stubs and are marked unavailable without automatic retries.
- The extension captures the rendered homepage as ordered shelves, including each shelf's title, type, position, and ordered video placements. The server stores these snapshots separately from video metadata; the homepage reconstructs the captured categories instead of scattering them into fallback rows.
- Each captured card also records source context: the YouTube page and, when rendered, its homepage section, search query, channel tab, playlist, or Shorts feed. Repeated observations update a separate provenance history rather than overwriting a video's canonical stub identity.
- The extension also reads YouTube's personalized horizontal topic chips. It opens one inactive YouTube tab, walks the available chips sequentially, and stores up to 24 rendered video stubs per category. YourTube builds its chip row from the captured labels and displays each category's own saved results; stale topics are refreshed at most every 24 hours, and Offline mode stops new capture.
- The homepage shows **For you**, a featured **Your Daily Mix**, **Downloaded**, then the captured YouTube shelves in their captured order. Show more expands each shelf independently. A homepage refresh may shuffle only the For you shelf, with newer two-day freshness bands kept ahead of older ones.
- Mix cards retain the playable seed video as a normal video card, while the associated YouTube Mix playlist ID is stored separately. A Mix badge uses that captured identity; playlist handling does not depend on guessing from a `Mix -` title prefix.
- Shorts retain a `short` content kind, appear in the exact homepage shelf where YouTube placed them, and have a working Shorts navigation view. They use the same local video card actions and playback route as other videos.
- Live Shorts form an ordered playlist for the current browser-tab session. It starts from the currently eligible, unplayed Live stubs; viewing a Short does not remove it, so Up/Down can revisit it. Newly captured eligible Shorts join the end of the active list, and refreshing the page restores its IDs and order. Switching to Local clears the Live list; switching back to Live creates a fresh list. Local Shorts remain downloaded-only, and the Unseen action continues to skip viewed items.
- **For you** excludes downloaded files. Its Most recent/Older chips use the two-day boundary; with no chip selected, the current default ordering is retained. Each card can show its exact source and a rounded “pulled … ago” time.
- The sidebar includes subscriptions (the first seven, then Show more), local navigation, and library statistics including local file count, media bytes, tracked view starts, extension stubs, and the extension duration-capture baseline.
- Refreshing the YourTube homepage does not replace accumulated stubs with only the latest extension batch. Downloaded media remains in its own section and is excluded from homepage recommendation shelves.
- **Your Daily Mix** is a date-stable, locally generated playlist featured after For you and before Downloaded. It targets a balance of ready local tracks and recent music stubs, weights familiar artists and detected styles by playback starts/completions/progress, and applies artist and recent-mix diversity penalties. A new day's mix recomputes from the latest local viewing history. Offline mode displays only already downloaded tracks.
- Daily Mix matching is deterministic and metadata-based: artist identity comes from channel names (or a title prefix when unavailable), while broad style tags are inferred from saved video/channel descriptions, topic labels, and playlist names. It does not analyze audio or claim a style match when those fields contain no usable clue. There is no external preference service.

Feed-section identification depends on YouTube's rendered markup. Topic assignment and Top News recognition are best-effort. Existing records receive a one-time best-effort legacy layout grouped from their saved section/topic/kind fields; exact historic shelf order cannot be reconstructed when it was never stored.

## Search

- The header search input is available from the home and single-video views. Results appear as the user types; Enter is not needed.
- The embedded toggle switches between **YouTube** (matching stubs already in the local database, with downloaded media excluded) and **Local** (downloaded media only). In YouTube mode, a compact local-results teaser switches to local search.
- After one second without typing, YouTube mode asks the extension to open an inactive YouTube results tab. The extension streams rendered results back to YourTube while the app remains focused on its own tab.
- The result view combines saved matching stubs with the current extension search session, displays a spinner until the first batch is stable, and polls while collection continues. Results are cached locally for the session; scrolling to the end requests the next batch of 12, with no Show more button or fresh search until the user asks for more. Search dropdown thumbnails expose direct play/download and Up next actions.
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
- A valid 11-character YouTube ID can be opened directly at `/watch/<id>`. If it is not in the catalog yet, Online mode creates a minimal stub and enters the same local acquisition/playback flow; the progress card can add it to Up next. Offline mode does not create a new stub or start acquisition.
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
- A media file is fully decoded with ffmpeg at the save boundary, before YourTube marks it ready. YourTube stores a SHA-256 checksum with the integrity result; later checks hash the file and reuse the saved result when the bytes still match, avoiding another decode. Older integrity records receive a checksum the next time they are checked. Only one media-folder integrity check runs at a time, ffmpeg decoding is limited to one thread, and in-flight integrity ffmpeg processes are stopped when the server exits. Playback does not wait for a new integrity scan. Files that fail are moved out of the playable media folder, retained in `data/quarantine/`, and added to the normal retry/download queue; retries continue when Online. If ffmpeg is unavailable but ffprobe exists, only the container and video stream can be checked; YourTube records that weaker result as `container-checked`.
- The media folder is watched for files added or removed outside YourTube, with a 30-second rescan as a fallback. Stable `VIDEO_ID.webm` and `VIDEO_ID.mp4` files are integrity-checked before being marked playable. Matching stubs keep their metadata; an unknown valid ID gets a minimal stub and local metadata work. Unrecognized filenames are listed at `/api/media-folder/status`. Imported files keep their acquired metadata and are exempt from Auto-delete. `YOURTUBE_MEDIA_DIR` can point media storage to a separate folder or drive.
- Downloads continue when the user navigates away, as long as the local server process stays running. The progress page sorts active downloads by progress and lists paused work separately.
- The Downloaded view can filter All, Videos, or Shorts. Video-only mode adds shortest-first and longest-first duration sorting.
- Downloaded media can also be grouped **By Channel** or **By Topic**. Groups support sorting by views, local item count, YouTube likes, the user's likes, recency, or largest total media size; each group's cards follow the corresponding order, including largest files first for the size sort. **Show only unwatched** filters out anything with a recorded playback start and is remembered separately for channel and topic views. Group actions can queue all locally playable videos or delete that group's media while keeping stubs and metadata. Channel records without usable author details stay in a final unattributed group.
- Failures carry a reason, attempt count, and scheduled retry. First retry delay is 10 seconds with exponential increase up to 30 minutes. After ten failures the item remains paused for user attention.
- Live streams are treated separately from finite videos. A live capture can be ended and saved or discarded. Offline transitions pause download attempts but allow transfers already underway to settle; a captured playable copy is retained.
- A visible status page exposes queues for media, downloaded metadata, video lengths, comments, channel captures, search captures, and Offline preparation.

Optional anti-throttling protections (`off`, `auto`, `always`) are controlled by `YOURTUBE_DOWNLOAD_PROTECTIONS` and default to `off`. `auto` activates a cooldown/serialized retry behavior after a sign-in or bot-check response; `always` serializes from startup. Browser credentials are not passed to yt-dlp in any mode.

## Metadata, Offline mode, and retention

- The duration pipeline can use rendered extension cards, browser-visible watch-page metadata, yt-dlp metadata, or duration probed from a local file/playback. Missing metadata has explicit queued, capturing, retrying, Upcoming, and unavailable states.
- The downloaded-metadata queue checks the local video details, duration, thumbnail, channel avatar, comments, and commenter avatars. It stores up to 1,000 comments per video and caches referenced images locally. Incomplete items retry with phase-specific status.
- Extension duration capture has a versioned coverage baseline: unique stubs record whether first capture contained a duration and whether a later capture filled it.
- Online mode checks connectivity and returns to Offline when the connection is lost. Offline mode blocks discovery, external search capture, and automatic retry work; it restricts recommendations/search to local material.
- Going Offline normally waits for active transfers and the active local metadata pass, then prepares video lengths, comments, thumbnails, channel avatars, and commenter avatars. The status page supports immediate pause and background resume on the next Online transition.
- Auto-delete is independently controlled. With it enabled, each ready media file has a 24-hour lifetime. Turning it off removes active expiry deadlines. The final hour is shown in the Downloaded view and eligible files appear in Deleting soon. Media expiry removes the file but retains its stub and history.

## Storage and limits

`data/yourtube.runtime.sqlite` stores native runtime state by default; the tracked `data/yourtube.sqlite` remains a clean starter copy. With `YOURTUBE_DATA_DIR` set, the runtime database is named `yourtube.sqlite` in that directory. `data/media/` stores WebM or MP4 files unless `YOURTUBE_MEDIA_DIR` points to another folder; `data/images/` stores cached images. `YOURTUBE_DATA_DIR` moves the database and image cache as a unit. There is no tenant model or remote YourTube database in this project.

Transcripts, transcript search, semantic embeddings, and AI-generated multi-video chapter overviews with selection rationales are **not implemented**. The app currently has aggregate view counts, latest playback progress, titles/channels/provenance, comments, and media metadata. It does not retain a complete timestamped event for every playback start.

## Project-maintenance notes

This inventory describes the current source tree. Consult Git history for the sequence of implementation changes; the feature list is not intended as a release chronology.
