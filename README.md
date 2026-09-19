# Spool

A small plain-text capture and chronological store for Web, Linux, and Windows.

## What it is

- 1 record = 1 plain text (nothing more).
- Spool Web and Spool PC Local offer the same basic capture model, but their storage is intentionally different:
  - **Web** — browser-local [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API). Data lives in the browser.
  - **PC Local** — ordinary `.txt` files written by a Go binary. Authoritative PC data is Plain Text.
- Clipboard capture adapters (KDE / Windows) are thin integrations around the same core.

Spool is not a sync app: there is no data sync between the Web and **PC** store.

## Web

- Web build: https://spool.knc.jp/
- Browser-local, no account, no server-side storage.
- The current Web build is being prepared for deployment at that URL.

## PC Local

- Written in Go 1.27.
- Runs Linux and Windows.
- Per-record data stays as ordinary `.txt` files in a local directory you point it at.
- Windows: `scripts/install-spool-windows.ps1` exists as a non-admin PowerShell installer (distribution URL is not yet finalized; see `docs/spool-windows-installer.md`).
- Linux: clipboard capture helper plus KDE launcher (`docs/spool-kde-launcher.md`).

## Build and test

Web (TypeScript + Vite, Node.js):

```sh
cd ui
npm install
npm test          # vitest
npm run build     # tsc + vite build (Web, dist/)
npm run build:pc  # tsc + vite build → ../pc/web/dist (go:embed output)
```

PC (Go 1.27, per `pc/go.mod`):

```sh
cd pc
go test ./...
go build
```

Running `build:pc` regenerates `pc/web/dist/`, which `pc/main.go` embeds so a Go build works from a clean checkout.

## Repository layout

- `ui/` — Web / PC browser UI (TypeScript, Vite)
- `pc/` — Spool PC Local (Go)
- `test/` — shared test vectors
- `docs/` — design checkpoints and launcher/installer docs
- `scripts/` — Linux and Windows local installers
- `assets/` — icons


## Design

Detailed design: [DESIGN-v2.md](DESIGN-v2.md)

## License

MIT — see [LICENSE](LICENSE).
