# Design decisions

These notes capture the current choices and their practical consequences. They describe the implementation as it exists now, including tradeoffs and known boundaries.

## Local-first, single-user data

**Decision:** Keep the library, watch history, playlists, search history, metadata, and media on the user's machine. Use video ID as the canonical key. Do not add tenants or user accounts to this prototype.

**Reason:** The project's central value is a private, portable viewing corpus. Stable IDs make repeated homepage, search, playlist, and channel captures update one stub while provenance remains independently recorded.

**Consequence:** SQLite and the media directory are personal data. They are excluded from Git, and backups must preserve both the database and media/images directory if the library is to be restored completely.

## Browser extension reads rendered pages

**Decision:** Use an extension content script on YouTube to read visible rendered DOM and selected page metadata. Send structured records to localhost, not full page HTML, browser profiles, or cookies.

**Reason:** The extension can observe the signed-in browser's rendered homepage, search, channel, and playlist pages without making the backend a holder of the browser session.

**Consequence:** Captures depend on the YouTube DOM and page rendering. Sponsored/Playable filtering, source classification, and duration detection are heuristic and need maintenance when YouTube changes. Extension version baselines make duration coverage measurable.

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

## Local WebM as the playable unit

**Decision:** Save one merged WebM file per video ID. Use ffmpeg when yt-dlp returns separate WebM audio and video tracks. The watch page plays the saved file.

**Reason:** A single local media file simplifies seeking, pause/resume, autoplay, portability, and file accounting.

**Consequence:** ffmpeg is needed for videos whose available tracks are separate. Without it, only a suitable single-file WebM can be acquired. Unsupported formats and failed downloads remain explicit errors.

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

**Decision:** Recognize playlists and Mixes by rendered YouTube structures and IDs, then import their displayed items as read-only local records. Keep local playlists editable in YourTube.

**Reason:** Homepage/search playlist cards are meaningful content, not just a user's personal playlist list. Renderer adapters can identify them without title-string grep rules.

**Consequence:** The extension imports what YouTube has rendered; it does not change the user's YouTube playlists or guarantee hidden/unloaded entries are captured.

## Keep local metadata bounded and useful

**Decision:** Store capped comment data (up to 50), durations, thumbnails, channel avatars, and commenter avatars for downloaded media, and expose metadata work by phase.

**Reason:** The media file is only part of a useful local library; presentation and context should remain available offline too. Capping comments bounds storage and request cost.

**Consequence:** Comment availability and completeness follow YouTube's output and restrictions. Metadata can remain pending or unavailable with a reason; the app does not claim an item is fully prepared before the local assets are saved.

## Keep analysis and future AI features grounded in local records

**Decision:** Current recommendations use local titles, channels, provenance, search selections, views, progress, and media state. Transcript indexing, semantic search, generated scripts, and stitched multi-video overviews are future work.

**Reason:** A local corpus could support personal analysis without depending on a remote profile, but any content-level AI needs timestamped transcripts and a source-linked editing manifest.

**Consequence:** The recent database analysis was a read-only assistant analysis of current local records, not a built-in YourTube AI feature. Since playback history is aggregated, precise historical watch-session timelines are not available yet.

## Repository and commit boundary

**Decision:** Track source, bundled runtime/license, scripts, and documentation. Ignore `data/`, local media, cached images, SQLite/WAL files, logs, environment files, and machine-specific `.DS_Store` files.

**Reason:** The 14 GB local data folder includes the user's media and personal history. Committing it would duplicate private assets and make the repository impractical to use.

**Consequence:** This project had no prior Git metadata. The first commit is a complete source snapshot, not a continuation of earlier feature-by-feature history. Feature chronology is summarized in the project docs rather than fabricated as commit history.
