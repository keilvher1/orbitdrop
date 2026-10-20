# core — status

Owner: core workstream. Scope: `packages/core/**` (except `src/composition-layout.ts`
and `src/annotations-draw.ts`, owned by processors-edit), `scripts/gen-golden.mjs`,
`tests/fixtures/wheel-golden.json`, this file.

## State (done — 2026-10-21)

| Area | Files | Notes |
|---|---|---|
| Wheel geometry | `src/geometry.ts` | hit-test, placement, arming; platform pipelines `placeWheelFromAppKit` / `placeWheelFromPhysical`, `hitTestFromAppKit` / `hitTestFromPhysical`, `placeWheelOnDisplays`, `hitTestPlacedWheel` |
| Coordinates | `src/coords.ts` (new) | display model, rect helpers, half-open `displayForPoint` with nearest fallback, `clampRectIntoArea` / `fitRectIntoArea`, AppKit ⇄ global DIP, Windows physical ⇄ DIP per monitor (mixed DPI, negative coordinates, virtual screen), pixel rounding |
| Golden vectors | `src/golden/wheel-golden.ts`, `src/golden/probes.ts`, `scripts/gen-golden.mjs`, `tests/fixtures/wheel-golden.json` | 2180 hit-test + 5 non-finite, 260 placement, 25 arming, 42 selection, 10 file-count cases, 5 macOS + 10 Windows layouts, display lookup, clamp, rounding |
| Selection | `src/selection.ts` (new) | `menuKeyForPaths` (shared with the helpers), `fileNameOfPath`, `extensionOfPath`, `buildSelectedFile`, `buildFileSelection`, `resolveSubmission` |
| Capabilities | `src/capabilities.ts` | specific disabled reasons, `isReadableFormat`, `CAPABILITY_REASONS`, typed `HelperMenu` |
| Naming | `src/naming.ts` | grapheme-safe 255-byte trimming, device names incl. `NUL.tar.gz`/COM0/superscripts, no hidden outputs, lone surrogates |
| Sniffing | `src/sniff.ts` | 1 KiB window, strict BMP/PNG, `detectLinkFile` (Finder alias, .lnk) |
| Output | `src/node/output.ts` | unambiguous temp names, exclusive-copy fallback that cleans up, `isTempFileName`, `CommitOptions.strategy` |
| Validation | `src/node/validate.ts` | timeout covers open + read and really returns, cloud roots, empty-file codes, alias/shortcut rejection |
| Queue / sessions | `src/queue.ts`, `src/drag-session.ts` | bug fixes below, `stats()`, generation-tagged messages |

## Commands

| Purpose | Command |
|---|---|
| Typecheck | `node_modules/.bin/tsc -p packages/core/tsconfig.json` |
| Tests | `node_modules/.bin/vitest run --root packages/core` |
| Real FAT32 volume test (macOS, mounts a private disk image) | `ORBITDROP_FS_TESTS=1 node_modules/.bin/vitest run --root packages/core test/output-fat.test.ts` |
| Regenerate golden file | `node scripts/gen-golden.mjs` (re-runs itself under tsx) |
| Check golden file (CI) | `node scripts/gen-golden.mjs --check` (exit 1 when stale) |

## How it was verified

- `tsc` clean; 201 core tests pass + 1 opt-in (20 more tests in `packages/core/test`
  belong to processors-edit). Run 2026-10-21 on macOS 26.6 arm64, Node 24.7.
- Cross-implementation: the Windows team's portable C++ core
  (`native/windows`, host-tests build with Apple clang, built out of tree in a temp
  folder) passes every golden section: hitTest 2185, placement 260, arming 25,
  selection 42, fileCount 10, coords.win 302, lookup/clamp/rounding 34 — 0
  failures. (Not MSVC on Windows; the Swift helper had no golden consumer yet.)
- Golden file: drift test compares the committed file byte for byte with the
  generator; every hit-test case is re-checked for its ≥ 0.01° / ≥ 0.01 DIP
  margins and reproduced by two independent ports written in the test (a float32
  port with a different operation order, and a y-up/radians port like an AppKit
  implementation would use).
- Output safety on real temp folders: 50 concurrent writers (hard link and copy
  strategies) → 50 distinct names with the right content and no temp files; a
  file created between write and commit is never replaced; read-only folder
  (chmod 555) → `OUTPUT_DIR_NOT_WRITABLE`; cancellation removes the temp file;
  999 taken names → clean failure. Hard-link failure codes (`ENOTSUP`, `EPERM`,
  `EXDEV`, `EISDIR`, `EINVAL`) and a copy failing with `ENOSPC` are injected
  (vi.mock); a real FAT32 volume (opt-in test, macOS `hdiutil`) commits through
  the copy fallback. Measured on this Mac: `link()` on FAT32 and exFAT fails with
  `ENOTSUP`; `O_EXCL` still reports `EEXIST` there (case-insensitively).
- Validation on real files: symlinks (absolute, relative, chains, linked folder,
  loop, self-loop, dangling, link to folder), FIFO, folders, chmod 000 file and
  folder, empty files, size limit, Korean NFC/NFD/emoji/space names, 800+ byte
  paths, overlong component/path, sparse file, real JPEG/PNG/WebP/TIFF/GIF/AVIF
  written by the bundled sharp. Hanging `open()`/`read()` are injected; the mock's
  `close()` waits for the pending read like Node's `FileHandle.close()`, which is
  what made the old implementation hang.
- Capability fixture measured with the bundled sharp 0.35.5 on this Mac: JPEG,
  PNG, WebP, TIFF, GIF, AVIF encode+decode; HEIC encode fails ("heifsave:
  Unsupported compression") and decoding a real HEIC made with `sips` fails (no
  libde265); no BMP/PDF in sharp. Menus built from it pass the contracts
  `HelperConfigureSchema` / `HelperMenuSchema` for ko and en.
- `src/index.ts` import graph contains no Node built-in (test) and bundles with
  `esbuild --platform=browser`; core compiles under the desktop web/node,
  processors and integration tsconfigs. Processors (162), integration (5) and
  desktop main tests that use core pass.

## Bugs fixed in existing code

- `JobQueue`: a runner returning a non-promise threw inside `start()` and wedged a
  slot; `cancelAll()` started queued jobs while cancelling running ones; abort
  listeners could still publish progress; a throwing `onUpdate` escaped from
  `enqueue()`/settle and could leave `waitFor` unresolved.
- `DragSessionTracker`: eviction sorted by timestamp and could evict the record it
  had just created when the clock stepped back (a duplicate drop would then be
  accepted again); now LRU by touch order. A repeated `cancelled` was reported
  twice; stale-generation `cancelled` was accepted; helper `Idle` did not close the
  session.
- `validateInputFile`: the header timeout did not bound anything —
  `FileHandle.close()` waits for the pending read and `open()` was outside the
  timeout; extension mismatch was reported for names without extension; empty PDFs
  were `IMAGE_CORRUPT`.
- Output temp files: cleanup for tag `job` also deleted temp files of a running job
  `job-1` (and a user base name containing the marker could match). The copy
  fallback left a partially written final file on failure.
- Capabilities: a PDF menu without a renderer said "Image decoder unavailable"
  (`noPdfRender` was never used); images → PDF/DOCX were enabled without any
  PNG/JPEG encoder to embed with; tools without a PNG encoder had a wrong reason.
- Naming: `NUL.tar.gz`, COM0/LPT0 and superscript device names were allowed; trims
  could split emoji ZWJ sequences; a giant grapheme could produce a hidden
  `.jpg`; leading dots produced hidden outputs.
- Geometry: `minDiameter > diameter` forced a wheel larger than configured;
  NaN/fractional sector counts and non-finite activation points produced NaN.

## Behaviour changes other workstreams should know

Signatures are unchanged (only optional parameters/options were added):
`commitTempFile(…, options?)`, `writeOutput(…, signal?, options?)`,
`DragSessionTracker.handle(message, generation?)`, `helperRestarted()` now returns
the generation, `ValidateOptions.cloudRoots`, `JobQueueOptions.onListenerError`.
- Temp files are named `.orbitdrop.<jobId>.<8 hex>[.<base>]<ext>`; use
  `isTempFileName(name, jobId?)` instead of matching names.
- `assertWritableDir` reports a missing folder or a non-folder as
  `OUTPUT_DIR_NOT_WRITABLE` (so the UI offers another folder).
- Empty files: `.pdf` → `PDF_CORRUPT`, image extensions → `IMAGE_CORRUPT`, else
  `UNSUPPORTED_FORMAT`. `extensionMismatch` is false for names without extension.
- `SNIFF_BYTES` is 1024.
- `supports()` returns false for descriptors whose kind does not match the format.
- `sanitizeBaseName` strips leading dots.

## Golden file for the native helpers

`tests/fixtures/wheel-golden.json` (UTF-8, LF). Its `$comment` and `schema` fields
document every section. The layout is consumed by `native/windows/tests/test_golden.cpp`:
keep changes additive (new cases or sections); bump `formatVersion` for anything
incompatible. Summary:
- Load it from the repository root in the Swift/C++ unit tests, parse with any JSON
  parser, run every case. Numbers: IEEE double, `|a − b| ≤ tolerance.dip` (1e-6);
  booleans, indices, zones, strings exact. Hit-test points are robust even in
  float32.
- Space is y-down: `hitTest.dx/dy` = pointer − center in global DIP. On macOS
  negate the AppKit dy (or use a flipped view). Rounding is `floor(x + 0.5)`;
  enclosing pixel rects use `floor(v + 1e-6)` / `ceil(v − 1e-6)`.
- `selection` pins `menuKeyForPaths` (code-unit semantics, ASCII-only lower-casing,
  both separators, trailing separator = folder). `fileCount` pins the multi-file
  rule helpers apply to received menus.
- `coords.mac` / `coords.win` pin the AppKit flip and the Windows mixed-DPI layout
  (`displaysFromWin32Monitors`), point/rect conversions and full wheel placement
  pipelines with pointer hit-tests.

## Open issues / limits

- Windows mixed-DPI global DIP layout is OrbitDrop's own (Chromium-like:
  aligned starts/ends kept, otherwise the overlap start is anchored). It equals
  physical/scale for single-DPI setups but may differ from Electron's layout in
  unusual arrangements; the helper must never exchange global coordinates with
  main (the protocol does not).
- Cloud placeholder detection is a heuristic (0 allocated blocks on macOS/Linux, or
  a path under `defaultCloudRoots()`), consulted only after the header read timed
  out or failed with a generic I/O error. Node exposes neither `SF_DATALESS` nor
  `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`.
- A hung network read keeps one libuv thread-pool thread (4 by default) busy until
  the OS gives up; several at once can stall all fs work in that process.
- Cancellation after a successful commit keeps the output (it is complete and
  owned by the job). Temp files start with a dot but are not marked hidden on
  Windows (no Node API for file attributes).
- The FAT32 test is opt-in (it mounts a disk image); not run in CI by default.
