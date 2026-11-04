# Design decisions

These notes capture the current choices and their practical consequences. They describe the implementation as it exists now, including tradeoffs and known boundaries.

## Local-first, single-user data

**Decision:** Keep the library, watch history, playlists, search history, metadata, and media on the user's machine. Use video ID as the canonical key. Do not add tenants or user accounts to this prototype.

**Reason:** The project's central value is a private, portable viewing corpus. Stable IDs make repeated homepage, search, playlist, and channel captures update one stub while provenance remains independently recorded.

**Consequence:** SQLite and the media directory are personal data. They are excluded from Git, and backups must preserve both the database and media/images directory if the library is to be restored completely.

## Media-folder imports use the video ID as the filename key

**Decision:** Watch the media directory and import only stable `.webm` or `.mp4` files named with an 11-character YouTube video ID. Reuse the matching stub; if none exists, create a minimal stub and queue metadata completion. Integrity-check an imported file before marking it ready. Keep unmatched filenames visible in media-folder diagnostics rather than guessing their identity.

**Reason:** A media file copied back from a USB backup should reconnect with the library's retained metadata. The canonical ID avoids title-based collisions and supports stubs restored separately from media.

**Consequence:** Files with arbitrary names need to be renamed to the ID format before import. Folder-imported media is exempt from the app's 24-hour Auto-delete policy so restoring a backup does not silently start a deletion timer.

## Browser extension reads rendered pages

**Decision:** Use an extension content script on YouTube to read visible rendered DOM and selected page metadata. Send structured records to localhost, not full page HTML, browser profiles, or cookies.

**Reason:** The extension can observe the signed-in browser's rendered homepage, search, channel, and playlist pages without making the backend a holder of the browser session.

**Consequence:** Captures depend on the YouTube DOM and page rendering. Sponsored/Playable filtering, source classification, and duration detection are heuristic and need maintenance when YouTube changes. Extension version baselines make duration coverage measurable.

## Preserve rendered homepage shelf placement

**Decision:** The extension sends ordered homepage shelf records and video placements alongside the normal video metadata. SQLite stores capture snapshots, shelf order, within-shelf order, content kind, topic label, and any Mix playlist identity separately from the video row. The app renders those shelves in that order; a refresh may shuffle only For you, preserving two-day recency bands.

**Reason:** A video can be recommended in several contexts, and its source category is part of the feed structure. A single `videos.section` or `topic` value cannot represent multiple placements without losing the homepage layout.

**Consequence:** Homepage grouping follows the DOM YouTube rendered during capture. A one-time migration builds a best-effort layout for older stubs, but cannot recover exact historical shelf order. Shorts keep their own content kind and navigation while using the ordinary local playback path. Mix seed videos remain playable video cards; their Mix playlist IDs remain separate identities handled by the playlist adapter.

## Capture personalized homepage topics separately

**Decision:** Read the rendered YouTube topic chips, persist their labels and order, and capture each chip's results in one sequential inactive tab. Keep category membership separate from the canonical video row and refresh category results no more than daily.

**Reason:** Topic chips vary by account and session. A fixed YourTube chip list cannot match YouTube's changing categories, and one video can belong to several captured contexts.

**Consequence:** The category row reflects topics that the extension has actually seen. Capture is bounded to 24 cards per topic and uses rendered-page data; it stops when YourTube goes Offline. Category identity and titles can change when YouTube changes the personalized chips or their DOM.

## Keep acquisition credentials separate

**Decision:** The Node backend invokes yt-dlp with cookies disabled. Browser-visible metadata can be read by the extension, but session cookies and credentials are never sent to the server or downloader. Do not bypass DRM or technical protections; do not fall back to online playback when local acquisition fails.

**Reason:** This keeps the downloader independent of the user's signed-in profile and makes local playback behavior explicit.

**Consequence:** Age-gated, members-only, paid, unavailable, or otherwise restricted videos may fail. YourTube exposes the failure and retry state; it does not silently borrow browser credentials.

## SQLite queues instead of RabbitMQ

**Decision:** Use SQLite tables for durable server-side queues and `chrome.storage.local` for extension-side delivery retries. Do not add RabbitMQ.

**Reason:** There is one local Node process and one user's library. A broker would require installation, configuration, another persistent service, and recovery behavior without a current multi-host consumer.

**Consequence:** The Node process must remain running for server jobs. SQLite is the source of durable status after restart; extension retries survive service-worker suspension in Chrome storage. A future multi-user/multi-worker hosted system would need a deliberate queue and tenancy redesign.

## Keep capture work asynchronous and bounded

**Decision:** Feed sync, channel capture, browser metadata capture, comments, durations, and downloaded-file metadata run in background queues with visible state. Channel sections are serialized through one tab; missing video-length jobs use at most two concurrent inactive watch tabs and can overlap channel capture when capacity allows.

**Reason:** Large page scans and metadata operations should not block navigation or require users to open every section manually. Bounded concurrency reduces bursts and gives the user a path to see and diagnose work.

**Consequence:** Browser work needs the extension loaded, YouTube reachable, and the server online. A queued state is distinct from a claimed/capturing state; stale tabs are timed out and retried rather than treated as success.

## Prefer WebM and support finite-video MP4 fallback

**Decision:** Prefer one merged WebM file per video ID. For finite videos with no compatible WebM formats, accept a compatible MP4. Use ffmpeg when yt-dlp returns separate audio and video tracks. The watch page plays the locally saved container and serves its matching MIME type.

**Reason:** A single local media file simplifies seeking, pause/resume, autoplay, portability, and file accounting. A container fallback prevents videos available only as MP4 from entering a futile retry loop.

**Consequence:** ffmpeg is needed for videos whose available tracks are separate. Without it, only a suitable single-file WebM or MP4 can be acquired. MP4 fallback is limited to items with a recognized finite duration; live and unknown-duration captures keep the WebM path used by the partial-recording finalizer. If neither supported container is available, the item pauses with a clear error rather than retrying unchanged.

## Verify media integrity before playback

**Decision:** Fully decode audio/video files with ffmpeg at the save boundary, before marking a new or recovered file ready. Keep playback direct and do not run integrity checks before it starts. Move a file that fails verification to `data/quarantine/` and send the video through the ordinary retry policy.

**Reason:** A successful yt-dlp exit and a plausible container do not prove that the video packets can be decoded. A damaged file can otherwise be reported as downloaded while the player produces audio with missing or undecodable video frames.

**Consequence:** Save-time verification reads and decodes the whole file and can take time, especially for large high-resolution videos; the download remains in progress and reports a verification stage until it passes. A failed copy is not exposed as ready and is queued for replacement, which pauses while Offline. When ffmpeg is unavailable, ffprobe can only confirm the container and presence of a video stream, and the result is explicitly recorded as `container-checked`, not fully decoded. Previously saved files are not rechecked automatically. Quarantined files still occupy disk space and are included in storage totals; deleting the video removes its quarantine copy too.

**Transcription audio:** Keep a model-ready 16 kHz mono FLAC in `data/transcription-audio/` instead of discarding decoded audio. Store its path, size, SHA-256, source-media SHA-256, format, and status in `transcription_assets`. Successful assets begin at `awaiting_transcription`; files with no audio and extraction failures receive explicit states. Audio extraction failure does not invalidate an otherwise verified playable video. Imported media uses the same save-boundary process.

## Preserve progress and distinguish counters

**Decision:** Save the latest playback position and a per-video play-start count. Resume unfinished playback and use local progress in Up next.

**Reason:** The local library should remember where playback stopped without relying on YouTube's profile.

**Consequence:** The count represents starts, not watch duration. The current schema stores a count and latest timestamp per video plus one progress snapshot; it does not preserve a full per-session playback event log. Any historical time-of-day analysis is therefore approximate.

## Keep acquisition provenance

**Decision:** Record provision category independently of the canonical video row, and show the source and pull age on cards. Channel captures retain channel and section identifiers.

**Reason:** The same video may arrive through a homepage refresh, search, playlist, or channel. Provenance helps explain why it appears and supports separate recommendation policies.

**Consequence:** Video ID deduplication does not erase the fact that a stub has multiple sources. Some section assignment is still best-effort because YouTube may not expose reliable category data in its rendered cards.

## Separate library discovery from media acquisition

**Decision:** A stub is useful before its media is downloaded. Search and feed views can contain stubs; the local search mode contains downloaded files only. Playback starts the acquisition pipeline for an eligible stub.

**Reason:** The extension can build a searchable local catalog from what the user has browsed, while the user chooses which videos to retain as media.

**Consequence:** A recommendation can be a stub that needs downloading before it plays. Downloaded media has its own queue and expiry lifecycle. YouTube-mode search is a hybrid of locally indexed stubs and asynchronous extension capture, not a direct backend search endpoint.

**Direct ID entry:** A user can open `/watch/<11-character YouTube ID>` without first collecting a feed card. When Online, YourTube creates a minimal stub with `direct` provenance and hands it to the existing download-and-play flow; downloaded metadata can replace the ID placeholder with the rendered title. Offline mode refuses to create that stub, preserving the rule that no new discovery occurs while Offline.

## Handle access limits with transparent retry states

**Decision:** Use classified errors, scheduled retries, attempt limits, a paused queue, and optional download-protection modes. Keep protections off by default, with `auto` and `always` available.

**Reason:** YouTube may rate-limit or temporarily fail requests; repeatedly retrying a blocked connection can worsen the problem. Users also asked to retain control over those protections.

**Consequence:** Ordinary failures retry with increasing delays; after ten failures items remain paused. In `auto` mode, a sign-in/bot-check signal starts a shared cooldown and serializes requests. The downloader still does not use cookies.

## Online and Offline are policy modes

**Decision:** Online requires connectivity validation. Offline pauses discovery and retries, restricts surfaces to local content, and runs a preparation sequence over downloaded assets. A normal switch waits for active work; an immediate switch pauses preparation for later resume.

**Reason:** Offline should describe what the app can actually serve without a network, not merely a visual preference.

**Consequence:** Offline preparation can be long and reports its current phase/item. If internet connectivity is lost, Online is revoked with a visible notice. The extension follows the server's persisted mode.

## Retention is separate from Offline mode

**Decision:** Auto-delete is a distinct switch with a 24-hour lifetime per ready file. Turning it off clears active expiry deadlines; media expiry preserves the stub and history.

**Reason:** Temporary local caching gives the user storage control without erasing the catalog or their playback history.

**Consequence:** Deleting soon is a separate Up next section and is not labeled “unwatched.” Deletion rechecks the saved setting and deadline transactionally immediately before unlinking the media file.

## Use a read-only adapter for YouTube playlists

**Decision:** Normalize YouTube playlist and Mix identity across rendered tile, search, channel, and playlist-page captures. Treat `/playlist?list=` and valid `/watch?list=` links as inputs to one adapter and one sync path. Import captured entries as read-only local records; keep local playlists editable in YourTube.

**Reason:** Homepage/search/channel playlist cards are meaningful content, not just a user's personal playlist list. Structural cues and list IDs are more stable than title-string rules, and a shared sync path prevents a surface-specific capture from being silently skipped.

**Consequence:** The extension imports what YouTube has rendered; it does not change the user's YouTube playlists or guarantee hidden/unloaded entries are captured. Playlist records discovered from tiles can initially have no entries; opening an incomplete playlist in YourTube asks the extension to open an inactive acquisition tab, scroll and capture the playlist container, and update the same record while the detail view polls for new entries.

## Keep local metadata bounded and useful

**Decision:** Store capped comment data (up to 50), durations, thumbnails, channel avatars, and commenter avatars for downloaded media, and expose metadata work by phase.

**Reason:** The media file is only part of a useful local library; presentation and context should remain available offline too. Capping comments bounds storage and request cost.

**Consequence:** Comment availability and completeness follow YouTube's output and restrictions. Metadata can remain pending or unavailable with a reason; the app does not claim an item is fully prepared before the local assets are saved.

## A displayed video thumbnail is a permanent local asset

**Decision:** Every video thumbnail shown by YourTube is served from `data/images/`. The first successfully cached thumbnail is linked to the video ID and remains canonical across later extension captures and metadata refreshes. Uncached, unsupported external image URLs are not displayed directly.

**Reason:** Once a thumbnail has appeared in the local library, the app already owns the image bytes and should not fetch or transfer that thumbnail again just because a capture repeats or changes its URL.

**Consequence:** The first display waits for the local server to cache the image; if acquisition fails, YourTube shows a placeholder. The per-video asset link and image cache are stored in SQLite and `data/images/`, so both must be included in backups. A later upstream thumbnail change does not replace the saved one.

## Keep analysis and future AI features grounded in local records

**Decision:** Current recommendations use local titles, channels, provenance, search selections, views, progress, and media state. Transcript indexing, semantic search, generated scripts, and stitched multi-video overviews are future work.

**Reason:** A local corpus could support personal analysis without depending on a remote profile, but any content-level AI needs timestamped transcripts and a source-linked editing manifest.

**Consequence:** The recent database analysis was a read-only assistant analysis of current local records, not a built-in YourTube AI feature. Since playback history is aggregated, precise historical watch-session timelines are not available yet.

## Generate a deterministic Daily Mix from local viewing behavior

**Decision:** Build one immutable Daily Mix playlist per Europe/Berlin calendar day, using a deterministic weighted score over saved playback and metadata. Use repeat starts and completion/progress as implicit preference evidence; favor artist matches and shared style tags, then apply recency, local availability, and diversity rules. Recompute tomorrow from the updated database.

**Reason:** A reproducible ranking can make an explainable daily selection without sending viewing history to a service or requiring users to manually rate every artist.

**Consequence:** Artist affinity is inferred from channel identity and title prefixes; style affinity is limited to tags discoverable in stored titles, channel descriptions, topic/section fields, and playlist names. It is not an audio fingerprint or a promise that a never-heard artist is similar. Missing tags mean the candidate receives freshness/variety consideration but no invented style affinity.

## Preserve one local player across app navigation

**Decision:** Keep one watch view and one media element alive in the app shell. Move that same element into a draggable mini player when a user navigates away, and restore it on return. Use the existing SQLite playback queue for playlist, card, and mini-player actions.

**Reason:** Recreating the video element on each route interrupts playback and loses its live playback state. A second player or separate queue would create conflicting playback and ordering state.

**Consequence:** SPA navigation preserves the active media element and local progress handlers. Queued items take priority after the current clip ends, even with Autoplay off; automatic playlist and recommendation progression still follows the Autoplay setting. Full page reloads still recreate the document and are outside this in-page continuity behavior.

## Repository and commit boundary

**Decision:** Track source, bundled runtime/license, scripts, and documentation. Ignore `data/`, local media, cached images, SQLite/WAL files, logs, environment files, and machine-specific `.DS_Store` files.

**Reason:** The 14 GB local data folder includes the user's media and personal history. Committing it would duplicate private assets and make the repository impractical to use.

**Consequence:** This project had no prior Git metadata. The first commit is a complete source snapshot, not a continuation of earlier feature-by-feature history. Feature chronology is summarized in the project docs rather than fabricated as commit history.
