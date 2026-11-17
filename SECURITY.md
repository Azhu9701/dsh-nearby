# Security policy

## Reporting

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability), or contact the maintainer through the GitHub profile [@Azhu9701](https://github.com/Azhu9701).

Include the version, the platform, and a minimal reproduction. Please avoid including real share links or tokens in the report.

## Scope

- The guest HTTP server and its API (`/api/room/...`).
- Host routes under `/dsh-nearby/api/...`.
- File uploads, skill-pack packaging and installation.
- Optional tunnel/relay handling.

## Known boundaries

- Host routes (`/dsh-nearby/api/...`) sit behind DSH's own access check (`connection.requestRejection`: Host/Origin fence plus browser session). The guest page and its `/api/room/...` API are served by the plugin's own LAN listener and are gated by the room token plus the private-network rule instead.
- LAN traffic is plain HTTP; there is no end-to-end encryption.
- A room token is a bearer credential: anyone with the full link can join while the room is open.
- Public tunnel mode exposes the room beyond the local network; treat the link as a secret.
