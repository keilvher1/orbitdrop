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

## Stage 3 — spec audit and fixes (2026-10-21, done)

An independent read-only audit compared the spec section by section with the
code (31 findings). Lead fixes so far: Swift rendering test after the accent
change (98c0ac8 — `swift test` had been failing; my earlier check read only
the last summary lines), CI shells on Windows + E2E in CI (f3aa429), build
reports record the source commit (2e73323), `actionTitle` and specific
unsupported strings in contracts (88a209b), conversion policy doc, support
matrix and permissions doc corrections.

Running in parallel (each owns its files): macOS helper (margin pass-through,
modifier order, no FS in drag callbacks, panel pre-creation, captions/VoiceOver,
Reduce Motion), Windows helper (OLE glue test, Shift+drag guard, no FS in
callbacks, UIA, display changes), polish (retry incl. cancelled, clear finished,
PDF-order thumbnails, batch Compress estimates, keyboard shape creation,
notifications from warnings, read-only folder signal, offline E2E, stronger
evidence, rollback of committed pages after a crash), processors-convert (PDF
memory), processors-edit (Annotate font fallback warning).

Next actions after they land:
1. Re-run everything (tsc, vitest, swift test with exit code, Windows host
   tests, E2E, electron-verify, smoke); commit per workstream.
2. Flip main to send the specific unsupported strings once both helpers accept them.
3. Regenerate screenshots (accent changed), rebuild and package, record the
   new SHA-256s and source commit in verification.md.
4. Hand the user the Finder PoC checklist (macos-helper.md §8) and record
   the results as "PoC 결과" in verification.md and the support matrix.

Stage 3 result (all landed and re-verified by the lead):
- macos-helper f3cc53a, windows-helper b16f472, processors-convert 123b5c6,
  polish df1c903 + d279bc0 (incl. processors-edit's font warning),
  screenshots d4f6d1e.
- vitest 902 passed / 1 skipped (twice in a row); Playwright 25/25;
  electron-verify 36/36; swift test exit 0 (138); Windows host tests 86 +
  zod parity + MinGW -Werror; packaged smoke ok on arm64 and x64 (Rosetta).
- Final macOS packages: see verification.md (source d4f6d1e).

Remaining (cannot be done here):
1. The user runs the Finder PoC checklist (macos-helper.md §8) and the
   packaged-app steps (verification.md) and records results.
2. Windows: push to a GitHub remote to run ci.yml / native-windows.yml (needs
   the user's decision), then the windows-helper.md checklist on a real PC.
3. Signing/notarization credentials; product id and licence decisions.


## Stage 4 — second adversarial pass per area (2026-10-22/23, done)

Five background workstreams, each owning its files, re-checked their area
against the spec with adversarial inputs and fixed what they found (status
files `docs/workstreams/hardening-*.md`). All were stopped twice by the
account session limit and resumed from their transcripts. The lead re-ran
every check before each commit.

| Workstream | Found and fixed | Commits |
|---|---|---|
| windows-helper | 9 defects (quadratic duplicate-key check, admin integrity check, CFG, ANSI virtual files, lone surrogates, …); cloud placeholders refused from attributes | 1f82717 |
| macos-helper | 10 defects (zod-exact JSON, exit watchdog, screen lock, transparency leak beside the disc, Reduce Transparency, …), then its own signal-handler regression (abort on SIGTERM when Swift's isolation check is fatal) | 63e1be3, de7e1d7 |
| processors | 12 defects (16-bit + ICC colours up to 57 levels off, CMYK keepMetadata, silent frame loss → FIRST_FRAME_ONLY/FIRST_PAGE_ONLY, truncated JPEGs embedded in PDF/DOCX, stale caches, …) | a9bac2f |
| packaging | **P0: every window of the installed 0.1.0 app was blank** (file:// fuse off); wrong hoisted dependency versions in app.asar; licence gaps; CI fixes; 10 MB smaller asar | 0615906, b1bd6ea |
| desktop | 32 defects (OS-level close losing unsaved work, smoke test without a window, IME keys as commands, lifecycle: sleep/lock/second instance/corrupt settings, packaged builds honouring dev switches, a11y and contrast, …) | 7faf031 |

Lead changes: streaming JPEG above 60 Mpx and a 100 Mpx PDF page cap
(a011e18: 256 Mpx → JPEG peak 3.17 GB → 0.27 GB); `strings.unsupportedCloud`
in the helper protocol, both helpers and main (b2705cf, 7faf031).

Verification after the pass (dev Mac, macOS 26.6 arm64):
- vitest 1060 passed / 4 skipped (opt-in); all typechecks clean.
- Playwright 39/39; electron-verify 36/36, no console errors/CSP violations.
- swift test 167 (Core 89, Kit 69, Process 9), exit 0, also with
  `SWIFT_UNEXPECTED_EXECUTOR_LOG_LEVEL=2`.
- Windows host tests 92 (Release + ASan/UBSan), parity 5,061 + 162-line macOS
  corpus, MinGW -Werror clean.
- Re-packaged (source 7faf031): smoke OK on arm64 and x64 with the hidden
  window rendered; fuses read back; dependency tree 0 problems. Hashes in
  verification.md. The d4f6d1e packages are withdrawn (blank windows).

Next: real Finder drags in a macOS 14 VM (tart, input through the VM's own
VNC server — the host's input is never touched), recorded separately from a
human check on physical hardware.
