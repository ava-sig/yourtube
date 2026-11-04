# Contributing to YourTube

Thanks for helping improve YourTube. It is currently a single-user, local-first application. The backend is not designed as a public multi-user service.

## Before opening a pull request

- Read the [PolyForm Noncommercial license](LICENSE), [required notices](NOTICE), and [Contributor License Agreement](CLA.md). Code contributions require agreement to the CLA because the project owner reserves separate commercial licensing for Ultima.
- Keep user data private. Do not submit media, thumbnails, comments, avatars, personal SQLite databases, SQLite WAL/SHM files, browser profiles, cookies, credentials, `.env` files, or logs containing private information. The tracked database is only the clean starter file at `data/yourtube.sqlite`.
- Check whether your change affects Chrome and Safari extension behavior, local Docker use, or the background queues. Update the README and relevant architecture/feature notes when behavior changes.
- Keep third-party code and assets clearly identified with their source and license. Do not remove existing notices.

## Development setup

Requirements: Node.js 22.5 or newer. The app has no npm package dependencies; Vue is bundled with its license notice. `yt-dlp` and `ffmpeg` are needed for acquisition features.

```sh
npm run dev
```

Open <http://127.0.0.1:4173>. For Docker setup, follow [Run in Docker](README.md#run-in-docker). Load the unpacked browser extension from `extension/` for browser-capture changes.

## Pull requests

Describe the problem and the change, list the user-visible effects, and include the manual verification you performed. Keep changes focused. Do not claim a check passed unless you ran it. There is not yet an automated test suite; release-build and deployment checks are coordinated with the maintainer.
