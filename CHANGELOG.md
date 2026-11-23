# Changelog

## 0.7.0

- 新增「有分享码？」入口：在面板里填 4 位房间码，自动匹配同一 Wi-Fi 下附近的房间并打开；也可以直接粘完整房间链接。
- 新增本地插件分享：以目录方式安装的插件（`link:` / `file:`）可以整包放进房间，对方下载后一键装成本地插件。
- 新增 `/dsh-nearby/api/local-plugins`、`/share-local-plugin`、`/install-local-plugin`、`/match-room` 四个宿主接口。
- 访客页支持插件包条目与下载。

## 0.6.3 — 2026-11-17

Share **plugins**, not just files — the thing the person next to you usually wants most.

- **Plugin packs.** Tick the plugins you have installed, get one short code (`NSP1-…`, deflate + base64url), and put it in the room. People who run DSH paste it in the panel and install everything in one go.
- Host endpoints `/dsh-nearby/api/{plugins,export-plugins,preview-plugins,apply-plugins,share-pack}`; entries installed from `link:`/`file:`/git/URLs are reported as not portable instead of silently dropped.
- Nothing is installed without a preview: `apply-plugins` lists every row as install / enable / manual-update before anything runs, and stops at the first failure.
- Guests without DSH still see the pack (plugin list + copy button); guests with DSH can copy the code from the phone page.
- Room feed understands `pack` items in the panel and on the guest page.

## 0.6.2 — 2026-11-17

Adopts the plugin-directory publishing contract, following `dsh-plugin-share`.

- **Host routes now go through DSH's access check.** Every `/dsh-nearby/api/*` route calls `connection.requestRejection` before touching any state, so the Host/Origin fence (DNS rebinding, cross-site calls) and browser authentication apply. Skipped automatically on hosts that do not expose `connection`.
- Declare `peerDependencies` on `@deepseek-ai/dsh-client-ui-conversation` (`>=0.2.0-rc.1 <0.3.0-0`) so the version gate can refuse an incompatible runtime.
- Ship `README.md`, `README.en.md`, `CHANGELOG.md`, `screenshots.json` and `assets/` inside the published package.
- Add `screenshots.json` (market screenshot declaration) and `test/manifest.test.mjs` pinning the publishing contract; CI now runs the tests and verifies the packed tarball.

## 0.6.1 — 2026-11-15

- Publish to npm as `dsh-nearby` (the package is no longer private).
- `dsh plugin --profile web add dsh-nearby` is now the primary install command.
- Declare `engines.dsh` so the plugin market can match supported DSH versions.

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
