# desktop-main — status

Owner: desktop-main workstream. Scope: Electron main process and preload
(`apps/desktop/src/main/**`, `apps/desktop/src/preload/**`), main-process
strings (`apps/desktop/src/shared/locales/{ko,en}/main.json`),
`apps/desktop/electron.vite.config.ts`, E2E (`apps/desktop/e2e/**`,
`apps/desktop/playwright.config.ts`), unit tests (`apps/desktop/test/main/**`),
screenshots `docs/screenshots/desktop-main-*.png`.

## State (2026-10-21)

| Area | State |
|---|---|
| Lifecycle & shell: single instance, tray app (dock hidden), `orbit-preview` privileged scheme, permission denial, navigation/window.open blocking, `--smoke-test` | done; unit + E2E + smoke |
| Tray / menu bar (ko/en): 파일 열기…, Drop Zone 열기/닫기, 최근 작업 ▸, 작업 창, 전역 드래그 상태 + on/off, 권한/다시 시작, 설정…, 정보, 종료 | done; unit + E2E (real tray built in Electron) |
| Windows (picker, editor, jobs, settings, dropzone, about): sandboxed frameless panels near the pointer / drop point, clamped resize, renderer-driven editor height | done; E2E |
| IPC for every OrbitApi method (zod- and sender-validated), preload exposing exactly `OrbitApi` | done; unit + E2E |
| FileRegistry / selections (core `buildFileSelection`), submission (core `resolveSubmission`), editor sessions, outputs | done; unit + E2E |
| Processor pool (utilityProcess job workers + preview/inspect/probe worker), host, cancel/timeout/kill/crash/cleanup, parent-loss exit | done; unit (fake workers) + E2E/smoke with the real processors |
| Capabilities (probe in worker → snapshot → menus) | done (with the real helper, HEIC decode is detected through the ImageIO mode) |
| HelperManager | done; unit (fake child) + E2E with a stub helper + **E2E and smoke with the real macOS helper** (arm64; x64 under Rosetta in smoke) |
| Settings store (+ macOS modifier rule), history.json (100 jobs), launch at login (packaged only) | done; unit + E2E (restart) |
| Notifications for drag-started jobs | done; unit + E2E (recorded in automation); not GUI-verified with a real Finder drag |

## Commands and results

Run from the repo root unless noted.

| Purpose | Command | Result (2026-10-21) |
|---|---|---|
| Typecheck main/preload/tests | `node_modules/.bin/tsc -p apps/desktop/tsconfig.node.json` | clean |
| Typecheck E2E | `node_modules/.bin/tsc -p apps/desktop/e2e/tsconfig.json` | clean |
| Build | `cd apps/desktop && ../../node_modules/.bin/electron-vite build` | OK — preload 5.7 kB (only `require("electron")`), renderer 509 kB minified |
| Unit tests (main) | `node_modules/.bin/vitest run --root apps/desktop test/main` | 11 files, 128 tests pass |
| All desktop unit tests | `node_modules/.bin/vitest run --root apps/desktop` | 25 files, 325 tests pass (main + renderer) |
| E2E | `cd apps/desktop && ../../node_modules/.bin/playwright test` (`pnpm --filter @orbitdrop/desktop e2e` builds first) | 16 tests pass; 5 consecutive full runs green |
| Smoke test, real helper | `cd apps/desktop && electron . --smoke-test` (`pnpm --filter @orbitdrop/desktop smoke`) | `ok:true`, exit 0 — helper `0.1.0` (dev staging, arm64) ready in ~35 ms, `globalDrag.available:true`; PNG→JPG 64×48; PDF→PNG 300×150 |
| Smoke test, x64 helper (Rosetta) | `ORBITDROP_HELPER_PATH=…/darwin-x64/OrbitDropHelper electron . --smoke-test` | `ok:true`, exit 0 |
| Smoke test, stub helper | `ORBITDROP_HELPER_PATH=apps/desktop/e2e/fixtures/stub-helper.mjs electron . --smoke-test` | `ok:true`, exit 0 |

The smoke test prints exactly one `ORBITDROP_SMOKE {json}` line on stdout
(logs go to stderr): `probe`, `helper`, `conversion` (PNG → JPG, the
architecture's check) and `pdfConversion` (an extra check: a generated
one-page PDF rendered by PDF.js inside the utility process). `ok` = probe ok
&& both conversions ok && helper ready within 5 s (unless
`ORBITDROP_SMOKE_OPTIONAL_HELPER=1`). It uses a temp app-data folder, no
windows, no tray, and never configures the helper (no global observation).

### E2E (Playwright `_electron`, `apps/desktop/e2e`)

Launch: built app, `ORBITDROP_E2E=1` (unpackaged only): temp app data via
`ORBITDROP_USER_DATA_DIR`, no tray unless `ORBITDROP_E2E_TRAY=1`, no helper
unless `ORBITDROP_E2E_HELPER=1`, windows shown without taking focus,
notifications recorded instead of shown, `globalThis.__orbitdrop` hooks (they
wait until startup finished) to open windows for generated fixtures — no OS
dialogs, no synthesized OS input.

- `pipeline.spec.ts` (7, through the real preload + IPC, independent of the
  renderer's markup): renderer surface is exactly `OrbitApi`; capabilities
  from the real probe; PDF → JPG (2550×3300, PDF menu order, no paths in the
  selection); Crop 1:1 editor session (source preview over `orbit-preview://`,
  superseded preview → stale, older seq → stale, unknown token → image error,
  commit → 2550×2550); Add Background → PNG (square, ≤ 2400 px, gradient
  corner, white page centre, preview `outputWidth` = final width); closing a
  Compress editor right after commit → the job still completes (2550×3300
  `Page 001 Compressed.jpg`); security (window.open denied, navigation
  blocked, `openExternal` allowlist, bad ids → `INVALID_OPTIONS`, fake `File`
  → `FILE_NOT_FOUND`, `Notification.requestPermission()` → denied).
- `ui-flow.spec.ts` (4, real renderer windows): picker wheel → JPG; tools →
  자르기 → 1:1 → 적용; tools → 배경 추가 → 배경과 함께 저장; the four files of
  the recording side by side, no temp files left; jobs window lists them.
- `shell.spec.ts` (3): every window kind in an OS-sandboxed renderer with its
  WindowContext; single-instance windows reused; Drop Zone always on top;
  `resizeWindow(4000, 4000)` clamped to the work area; a settings change
  reaches another window and re-localizes the tray; invalid patch →
  `INVALID_OPTIONS`; six hung FIFO opens do not stall `fs` in main
  (`UV_THREADPOOL_SIZE` 16); history survives a restart.
- `helper-drop.spec.ts` (1): the real HelperManager drives
  `e2e/fixtures/stub-helper.mjs` (protocol-faithful stub): the `configure` it
  receives validates against `HelperConfigureSchema`; a convert drop sent
  twice → exactly one job (2550×3300 PNG); notification recorded
  (`완료: PNG로 변환` / `Page 001.png`); a tool drop opens an editor; a locale
  change re-sends `configure`; quit sends `shutdown`.
- `helper-real.spec.ts` (1, skipped if no helper is staged): the real native
  helper with global drag configured OFF: `ready`, `configure` accepted (no
  `error`/invalid lines in the main log), status `disabled`, re-configure on a
  locale change, no restarts, process gone after quit.

Screenshots: `docs/screenshots/desktop-main-{picker-pdf,crop-editor,background-editor,jobs,dropzone,settings,about}.png`.

Other checks: after a normal quit and after `kill -9` of main, no Electron
helper/utility processes remain (`ps`); with main SIGKILLed the worker exits
within ~1 s (parent watchdog).

## Code review (REQUEST CHANGES → fixed)

All findings of the main-process review were fixed and covered by tests:
pool sized from settings survives `start()`; job timeout counted from
dispatch (not while waiting for a worker; manager keeps only a safety net);
crash cleanup bounded (10 s) — the slot is always freed and an unfinished
cleanup fails the job without auto-retry (`OUTPUT_WRITE_FAILED`); quit waits
for worker exits and interrupted-job cleanups (host waits ≤ 1.5 s for aborted
handlers; router, tray and drops stop first; a second quit no longer cuts the
sequence short); an unresponsive aux worker is killed and restarted;
UtilityProcess `'error'` handled; error message/detail scrubbed of paths at the
worker boundary (JobSnapshot, previews, history, probe notes, selection
problems); `ORBITDROP_HELPER_PATH` and the E2E switches ignored in packaged
builds and inherited `ORBITDROP_IMAGEIO_HELPER`/`ORBITDROP_PARENT_PID`
stripped from worker env; whole validations time-limited (8 s) and counted as
hung reads; superseded previews aborted even while the aux worker starts;
stale kill timers cleared; late `done` after cancel reported and logged;
smoke cleanup guarded; `retryJobElsewhere` and `commitEditor` deduplicated.

## Design notes for other workstreams

- **Errors over IPC**: rejected OrbitApi promises reject with
  `Error("<ErrorCode>: <message>")`; unexpected errors become
  `INTERNAL: Unexpected error`. Messages/details never contain paths.
- **HelperStatus.reason** is localized text (main.json `helper.reason.*`):
  not installed / not started for this run / unavailable / stopped after N
  failures / global drag not available right now. Developer reasons stay in
  the main log and the smoke report.
- **Windows** are frameless panels (renderer draws title bar + close).
  Editor: 520 wide (min 440), height follows `resizeWindow` (min 200).
  `resizeWindow` keeps the top edge and horizontal centre, clamps to
  [window minimum, work area] (requests > 4000 are invalid per contract).
- **Editors**: closing/cancelling an editor after its commit never cancels the
  committed jobs; closing it while the commit is still validating or asking
  for a folder returns `rejected/CANCELLED` and nothing is written. A double
  Apply returns the first result (one folder dialog).
- **Picker → editor**: main opens the editor centred on the picker and closes
  the picker once the editor is shown; from the Drop Zone, the Drop Zone stays.
  Global drag: editor at the drop point, focused on the next tick.
- **Drop Zone / openFileDialog** return a `FileSelection`; main does not open a
  picker for them. The tray's 파일 열기… opens a picker near the tray icon.
- **Settings (macOS)**: modifier combos with Control or Command are rejected
  (`INVALID_OPTIONS`); a stored file with them falls back to the default
  modifiers. On every platform the convert and tools combos must differ.
- **Selections**: problem files kept in order; files this build cannot read
  get `UNSUPPORTED_FORMAT`; empty-file codes are core's (by extension today).
  Validation: 2 files at a time, ≤ 8 s each; after (pool − 4) timed-out reads
  within 2 min, further validations fail fast with `TIMEOUT`.
- **Preview protocol**: `orbit-preview://p/<token>`, 144-bit tokens, LRU
  192 MB / 256 entries, 10 min TTL (source image pinned per editor).
- **Workers**: `processing.concurrency` job workers (lazy, stopped after 3 min
  idle) + 1 aux worker; cancel grace 3 s then kill; crash → bounded cleanup →
  one retry. Workers get `ORBITDROP_IMAGEIO_HELPER` (the located helper, macOS)
  and `ORBITDROP_PARENT_PID`; main's own libuv pool is 16 (workers keep theirs).
- **Helper**: dev `resources/helper/<platform>-<arch>/` (or `-universal`),
  packaged `<resources>/helper/`; `ORBITDROP_HELPER_PATH` only in unpackaged
  builds. No arguments, stdio pipes, cwd = its folder. One tracker generation
  per spawned process (`tracker.handle(msg, generation)`); `configure` re-sent
  when its content changes; `queryPermissions` on macOS (polled while
  missing); ping 10 s (3 missed → restart); restarts back off 0.5–15 s, max 5
  per 10 min, then `crashed`; quit → `shutdown` + stdin EOF, kill after 1.5 s.

## Open items / waiting on others

- Real Finder drag (global drag end to end, editor focus after drop,
  notifications on screen): needs a GUI session with the helper configured
  on — not automated (no synthesized OS input).
- `retryJobElsewhere` / `output.location: 'ask'` dialogs: unit-tested only.
- Freeing processor preview caches when the last editor closes needs a
  processor-protocol message (requested from the lead).
