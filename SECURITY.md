# Security policy

## Scope

YourTube is a local, single-user application. It is not currently a secured multi-user or public hosted service. The server has no user authentication. By default, it binds to `127.0.0.1`; exposing it with `--host 0.0.0.0` makes its interface reachable from the network. Do not expose it to the public Internet without adding and reviewing an authentication and deployment boundary.

## Reporting a vulnerability

Please do not post credentials, private video metadata, database files, browser profiles, or an exploitable vulnerability in a public issue. Once the public repository is created, use GitHub's **Report a vulnerability** action in the repository's **Security** tab. The repository maintainer must enable private vulnerability reporting before launch. If that option is unavailable, contact the maintainer through their GitHub profile and ask for a private reporting channel.

Include the affected version, the impact, and concise reproduction steps. Redact personal data and avoid attaching a real library database or media files.

## Supported versions

Security fixes are made against the current `main` branch and the latest published release. Older snapshots may not receive fixes.
