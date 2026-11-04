# Third-party notices

YourTube's own source is licensed under the PolyForm Noncommercial License 1.0.0. Third-party components retain their own licenses; this file does not relicense them.

## Bundled component

- **Vue.js runtime** — `public/vendor/vue.global.prod.js`. The corresponding license text is in [`public/vendor/LICENSE.vue.txt`](public/vendor/LICENSE.vue.txt). Preserve that notice when redistributing the bundle.

## Installed at runtime or in the Docker image

- **Node.js** — the Docker image uses the official Node.js container image. See the [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE) and notices for the selected base image.
- **yt-dlp** — installed into the Docker image at build time; it is not vendored in this repository. See the [yt-dlp project license](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE).
- **FFmpeg** — installed from the container's Debian package repository at build time. Package licensing and enabled components follow that distribution's package build; inspect the image/package notices when redistributing a built image.

The project has no npm runtime dependencies. Before publishing a binary or container image, review the licenses and notices for the exact dependency versions and packages included in that artifact.
