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

## Stage 1 — parallel workstreams (2026-10-21)

Eight background workstreams, each with its own status file in
`docs/workstreams/<name>.md`. The lead re-ran each workstream's checks before
committing it. All agents were interrupted twice (API connection drop, then
the account usage limit) and resumed from their transcripts. Every workstream
also had an independent code review; all findings were fixed and re-tested.

| Workstream | Result | Commits |
|---|---|---|
| core | golden vectors, coords, selection, hardened queue/output/validate | 0e016b6 |
| processors-convert | PDF↔image, image formats, BMP codec, images→PDF, PDF→TXT/DOCX, probe; Electron-pool JPEG bug fixed | 797ba39 |
| processors-edit | crop, add background, compress, metadata, edit, annotate, redact; review: 16-bit/wide-gamut/memory fixes | f148070, b6245d7 |
| macos-helper | Swift/AppKit observer, wheel panel, Copy-only drop target, imageio CLI; 116 Swift tests | ca13dd1 |
| windows-helper | C++/Win32/OLE; 81 host tests incl. golden (ASan/UBSan clean), zod parity fuzzing, MinGW -Werror cross-build; never run on Windows | 678271c |
| desktop-main | main, preload, workers, helper manager, smoke; review: pool size, cleanup, path redaction, env overrides | 2b5b268 |
| desktop-renderer | wheel, editors, jobs, settings, Drop Zone, ko/en; review fixes; macOS modifier rule | 84d25c2, 5b18167 |
| packaging-docs | electron-builder mac/win, native-check, CI, docs, licences | 1563f4f |

## Stage 2 — integration (2026-10-21)

Lead changes after the workstreams landed:
- `FILE_EMPTY` error code; `DOCX_IMAGE_ONLY` warning; warning params documented.
- `clearPreviewCaches` worker message (sent when the last editor closes).
- Light accent/active sector #F2552C → #D4441C (white text 3.44:1 → 4.52:1);
  warning colours moved into the shared tokens; macOS defaults/fixtures follow.
- PNG compression level 9 → 6 in `encodeImage`.
- Packaged builds ignore `ORBITDROP_HELPER_PATH` (security review); docs updated.
- `package.mjs` refuses a Windows build whose staged helper says CROSS-COMPILED.

Verification on the dev Mac (macOS 26.6 arm64), all passing:

| Check | Result |
|---|---|
| `node_modules/.bin/vitest run` | 768 passed, 1 skipped (opt-in FAT32) |
| typecheck (contracts, core, processors, integration, desktop node/web/e2e) | clean |
| Playwright E2E against the built app | 16/16 |
| `electron-verify.mjs` (every window and editor in the real app) | 26/26, no console errors/CSP violations |
| `swift test --package-path native/macos` | all suites pass |
| `electron . --smoke-test` with the real helper | ok, helper ready |
| `node scripts/package.mjs mac --arch all` | see below |

Not verifiable here (needs the user or other hardware):
- A real Finder drag with the wheel (checklist: `docs/workstreams/macos-helper.md` §8,
  `docs/verification.md`). Nothing is marked GUI-verified yet.
- Windows build/run/install (no Windows machine; CI configured, not run).
- Signing/notarization (no credentials); Intel Mac (x64 ran under Rosetta only).

Decisions left to the user: OrbitDrop's own licence, the final product id
(`app.orbitdrop.desktop` is a placeholder), and how LGPL sources are offered
before any public release.

Open polish (not blocking): PDF-order thumbnails, batch Compress estimates beyond
the first file, "clear finished jobs", a generic retry for retryable errors,
`PreviewResult.outputFormat`, live wheel-size preview in Settings, unsaved-change
prompt for Annotate/Redact, a dark high-contrast token set.
