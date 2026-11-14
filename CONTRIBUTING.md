# Contributing

Thanks for taking a look at NextSeat.

## Development setup

1. Clone the repository.
2. Make sure you have Node.js 20+ and a local DeepSeek Harness installation.
3. Run the checks:

```sh
npm test
```

4. Install the plugin into a scratch profile while developing:

```sh
dsh plugin --profile nearbytest add /absolute/path/to/dsh-nearby
```

Changes to JavaScript files can usually be reloaded from the DSH sidebar refresh button; config or `cordis.patch.yml` changes require a full restart.

## Pull requests

- Keep changes focused; one concern per PR.
- Run `npm test` before pushing.
- Update `README.md` / `README.en.md` if user-facing behaviour changes.
- Add an entry to `CHANGELOG.md` for notable changes.

## Code style

- Plain ESM, no build step, no new dependencies unless unavoidable (the only vendored dependency is the QR generator).
- Keep the guest page dependency-free and mobile-first.
- All user-visible strings are in Chinese by default; keep the English README in sync.

## Security

See [SECURITY.md](SECURITY.md). Do not include real room tokens or personal share links in issues or PRs.
