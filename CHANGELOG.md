# Changelog

## 0.6.0 — 2026-11-14

First public release.

- One-to-many LAN rooms: 4-digit code, QR code and tokenized join link.
- Zero-install guest page in a phone browser: files, prompt cards, skill packs and room notes.
- Streaming uploads with SHA-256, 2 GiB per-file limit and 32 MB chunking.
- Prompt-card import into the local prompt library.
- Skill-pack sharing and one-click install into `~/.dsh/skills` with path/symlink checks.
- Nearby discovery over UDP broadcast on the same Wi-Fi.
- Optional remote-host mode via Cloudflare quick tunnel (or a self-hosted SSH relay).
- Agent tools: `nearby_room`, `nearby_share`, `nearby_inbox`.
- DSH sidebar panel with live room state, QR code, participant list and inbox.
