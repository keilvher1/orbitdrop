# OrbitDrop — progress log

Maintained by the lead. Each stage records what passed, what is open, how to run
things, and the next action, so work can resume after a context reset.

## Commands

| Purpose | Command |
|---|---|
| Install | `pnpm install` (pnpm 11; Electron binary: `node node_modules/electron/install.js` if missing) |
| Unit/integration tests | `pnpm test` |
| Typecheck | `pnpm typecheck` |
| Dev app | `pnpm dev` |
| Build renderer/main bundles | `pnpm build` |
| Native helper (macOS) | `pnpm native:mac` |
| Native helper (Windows) | `pnpm native:win` |
| Package | `pnpm package:mac` / `pnpm package:win` |

## Stage 0 — repo, tools, contracts (2026-10-21)

Environment: macOS 26.6 (25G72) arm64, Xcode 27.1 / Swift 6.4, Node 24.7.0,
pnpm 11.27.1, cmake 4.4.4, mingw-w64 14 (GCC 16.2, for Windows compile checks),
Rosetta 2 available. No Windows machine available.

Chosen versions (npm registry, 2026-10-20; pnpm 11 minimum-release-age policy
respected, so same-day releases were skipped): electron 44.9.0 (Chromium 152,
Node 24.x), electron-vite 6.0.0, vite 8.3.4, react 19.3.1, typescript 7.0.2,
vitest 5.0.5, sharp 0.35.5 (libvips 8.18.7), pdfjs-dist 6.4.299,
@napi-rs/canvas 1.0.11, pdf-lib 1.17.1, docx 9.12.x, zod 4.6.7,
electron-builder 26.15.3, @playwright/test 1.64.1.

Measured sharp support on darwin-arm64: encode JPEG/PNG/WebP/TIFF/GIF/AVIF;
HEIC (HEVC) encode fails ("Unsupported compression"); no BMP; no PDF.

Done:
- pnpm workspace, lockfile, tsconfig base, Vitest projects.
- `packages/contracts`: formats, actions (P0/P1/P2 tiers), wheel menus in the
  reference order, geometry spec, design tokens, error codes, option schemas,
  composition spec + background presets, jobs, files, capabilities, settings
  (versioned + migration), helper NDJSON protocol, processor protocol, renderer IPC.
- `packages/core` basics: wheel hit-test/placement, capability registry + menu
  builder, naming, header sniffing, safe output writing, input validation,
  JobQueue, DragSessionTracker.
- `apps/desktop` skeleton builds with electron-vite (CJS main/preload, React renderer).

Next: parallel workstreams (see docs/architecture.md ownership table).
