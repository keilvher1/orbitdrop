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

## Stage 1 — parallel workstreams (2026-10-21, in progress)

Eight background workstreams, each with its own status file in
`docs/workstreams/<name>.md`. The lead commits one workstream at a time after
re-running its checks.

| Workstream | State | Commit |
|---|---|---|
| core | landed: golden vectors, coords, selection, hardened queue/output/validate (221 tests) | 0e016b6 |
| processors-convert | running | |
| processors-edit | landed: crop, add background, compress, metadata, edit, annotate, redact (83 tool tests + 20 core + editors integration) | f148070 |
| macos-helper | running | |
| windows-helper | running (mingw compile + host tests only) | |
| desktop-main | running | |
| desktop-renderer | landed: wheel, all editors, jobs, settings, Drop Zone, ko/en (182 tests; 25/26 real-app checks, the failure is convert.pdf) | 84d25c2 |
| packaging-docs | running | |

All workstream agents were interrupted twice on 2026-10-21 (API connection
drop, then the account usage limit) and were resumed from their transcripts.

Lead-owned checks so far:
- `tests/integration/video-flow.test.ts` reproduces the reference recording
  through the real processor API: `Page 001.pdf` → `Page 001.jpg` (2550×3300 at
  300 DPI) → `Page 001 Cropped.jpg` (2550×2550) → `Page 001 Cropped With
  Background.png`; inputs unchanged, exactly four files. Passing.
- Whole repo: `node_modules/.bin/vitest run` → 712 passed, 1 skipped (opt-in FAT32 test).
- `node scripts/gen-golden.mjs --check` → golden file up to date.

Contract follow-ups queued for the integration pass (they touch shared types
other workstreams compile against, so they wait until everyone has landed):
- `errors.ts`: non-retryable `FILE_EMPTY` (core currently reports empty files
  as PDF_CORRUPT / IMAGE_CORRUPT / UNSUPPORTED_FORMAT); needs ko/en strings.
- Done now (doc comments only): sessionId uniqueness across helper restarts,
  `Idle` ends a session, effective minimum diameter `min(minDiameter, diameter)`.
- Tokens: white on light `accent`/`sectorActive` #F2552C is 3.44:1 but is used
  for 13–15 px bold labels. Change to #D4441C (4.52:1; the reference's active
  sector is this deep red-orange too), hover/pressed darker, and update the
  native defaults (`DefaultConfig.swift`, `defaults.cpp`) and the macOS
  ProtocolTests assertion in the same commit. Add `warning`/`warningBg` tokens.
- Document `JobWarning.params` names (UI reads `pages`, `width`, `height`).
- Optional, from processors-edit: `CompositionLayout.paddingReducedByMaxEdge` /
  `effectivePadding`, a lossless-vs-re-encoded flag for metadata removal,
  `PreviewResult.outputFormat`; re-export `clearPreviewCaches` /
  `detectKoreanFont` from `@orbitdrop/processors` if main uses them.
- Renderer API gaps (P1/P2 polish): PDF-order thumbnails, batch Compress
  estimates beyond the first file, "clear finished jobs", generic retry.
