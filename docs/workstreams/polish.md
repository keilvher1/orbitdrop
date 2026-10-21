# polish — status

Owner: polish workstream (after the eight original workstreams landed). Scope:
`apps/desktop/src/{main,preload,renderer}/**`, `apps/desktop/src/shared/locales/**`,
`apps/desktop/{test,e2e}/**`, `packages/processors/src/tools/**` (+ its tests), and for
the output rollback `packages/processors/src/convert/**`; additive contract changes in
`packages/contracts/src/{ipc,processor-protocol}.ts` and `design-tokens.json` (lead
pre-approved). Done 2026-10-21 on macOS 26.6 arm64. Parts were built by parallel
sub-agents that stopped on an account session limit; their work was finished,
reviewed and tested here.

## What was built

| Item | What | Main files |
|---|---|---|
| 1 Clear finished jobs | Jobs window toolbar button "끝난 작업 지우기" (hint, polite "작업 N개를 목록에서 지웠습니다.", error notice, focus kept). Sends `finishedUpTo` = newest finish time on screen, so a job finishing during the click stays. Main removes finished session records (completed/failed/cancelled/skipped) and history entries ≤ the cut-off, broadcasts at once; never cancels (a job between crash retries is queued, so it stays), never touches files, outputIds keep working. A finished member of a still-running drag batch is hidden but kept until the batch ends, so its notification counts every file. | `main/jobs/manager.ts` (`clearFinished`), `main/history/store.ts` (`removeWhere`), `renderer/views/jobs/JobsView.tsx` |
| 2 Generic retry (+ lead A) | "다시 시도" for cancelled jobs and failures with `RETRY_JOB_CODES` (TIMEOUT, WORKER_CRASHED, OUTPUT_WRITE_FAILED, DISK_FULL, NETWORK_PATH_FAILED, CLOUD_PLACEHOLDER). Same action, options, output folder and origin; every input and asset (Add Background image) validated again through `FileRegistry.revalidate` (same timeouts and hung-read accounting, no ids) plus the capability check; fileIds kept (images → PDF order). In-flight guard per job and a memo: later calls return the first retry. "다른 폴더에 저장…" now shows for every `RETRY_ELSEWHERE_CODES` code (DISK_FULL / OUTPUT_WRITE_FAILED show both). Refusals: FILE_NOT_FOUND → "다시 시도할 수 없습니다 …" (file gone, or a job from before a restart — options are not persisted), others → "다시 시도하지 못했습니다" + reason. | `main/jobs/submission.ts` (`retryJob`), `main/files/registry.ts`, `JobsView.tsx` |
| 3 PDF-order thumbnails | `getEditorThumbnail`: ≤ 160 px `thumbnail` previews rendered by the aux worker without touching the editors' source cache, tokens owned by the editor session (released on close), cached per file + size while the token is in the store, LRU 120 per editor, failed renders not cached. Requests go through a shared background limiter (≤ 2 on the aux worker across editors; tool and source previews bypass it); closing the editor aborts running and queued ones. Renderer: 40 px thumbnail cell, IntersectionObserver-lazy (immediate without it), cached per file (reorder doesn't refetch), icon placeholder, one re-request when an image 404s. | `main/editor/sessions.ts`, `main/util/limiter.ts`, `processors/tools/thumbnail.ts`, `renderer/views/editor/pdf/PdfOrderEditor.tsx` |
| 4 Batch Compress estimates | `requestEstimate`: per-file estimate = byte length of a real full-size encode (`estimateOnly`, no image decoded), its own per-editor seq (a newer seq aborts every older running/queued estimate → stale), shared limiter. Processors keep a 512-entry estimate cache filled by every compress encode. Renderer: debounced (350 ms) batch with one seq, per-file list (input → estimate, Δ, "작아지지 않음" warning rows, failed rows), totals only when every file is in, honest summary (`batchNotSmaller` / `someNotSmaller` / `batchSmaller`); results view shows final sizes, the estimate made before (muted) and a total. In the real app the estimates equal the written bytes exactly (E2E). | `sessions.ts`, `processors/tools/compress.ts`, `views/editor/compress/{CompressEditor,CompressBatch,useBatchEstimates}` |
| 5 Unsaved-change confirm | `EditorFrame.confirmClose`: × / Esc with unsaved Annotate shapes (or typed text) / Redact regions open an in-window `alertdialog` (portal, editor `inert`, focus trap, Esc = keep editing, Enter/Space, backdrop does nothing, shortcuts of the editor beneath blocked). | `views/editor/EditorFrame.tsx`, `components/ConfirmDialog.{tsx,css}` |
| 6 Wheel-size preview | Settings › 드래그: SVG wheel from the same geometry and `sectorShape` code at 45 % with dashed min/max rings, following the slider live (save still debounced). | `views/settings/{WheelSizePreview,SettingsView}.tsx` |
| 7a `outputFormat` | Processors report the format the job really writes (one `writtenFormat` helper for jobs and previews: GIF → PNG, unencodable AVIF/TIFF → PNG, HEIC only with the ImageIO helper; Compress HEIC → JPEG, TIFF/BMP/GIF → PNG). Compress and Edit show "원본 형식으로 저장하면 GIF 파일은 PNG로 저장됩니다."; Compress picks its controls from the reported format; Edit's file name follows it. | `processors/tools/common.ts`, `editorKit.tsx`, Compress/Adjust editors |
| 7b Dark high contrast | `color.highContrastDark` (renderer-only; existing sets untouched): text/muted ≥ 7:1, accent text ≥ 4.5:1, borders/focus ≥ 3:1 (tested). Renderer theme `highContrastDark` when high contrast applies in dark mode; main uses its `windowBg` for windows before first paint. The native wheel keeps `highContrast`. | `design-tokens.json`, `theme/*`, `styles/base.css`, `main/app.ts` |
| Preview warnings (processors-edit add-on) | `PreviewResponse.warnings`; Annotate asks a tiny text-only preview and shows `ANNOTATION_FONT_FALLBACK` (danger tone + "텍스트 주석 N개는 … 보이지 않습니다" when `unreadable > 0`). | `sessions.ts`, `AnnotateEditor.tsx` |
| B Keyboard creation | Annotate "텍스트/화살표/사각형 추가", Redact "영역 추가": a centred shape in the current style, selected, focus on the canvas; arrows move (Shift ×10), Option/Alt+arrows resize (rect size, arrow tip, text size); announcements + keyboard help in `aria-describedby`. | `annotateModel.ts` (`centeredShape`, `resizeShape`), Annotate/Redact editors |
| C `actionTitle` | Picker hint, job titles (input kind from the name) and notifications name DOCX by input kind; `picker.docxFromImages` removed; the picker hint is part of the menu's `aria-describedby` (no longer aria-hidden). | `SelectionWheel.tsx`, `JobsView.tsx`, `main/notifications.ts` |
| D Honest notifications | A completed job with a noteworthy warning → "완료(확인 필요): …" + short reason, click opens the Jobs window; skipped same-format jobs → "건너뜀"; batches count done / 확인 필요 / 실패 / 건너뜀 separately. METADATA_REMOVED and DOCX_* stay informational. | `main/notifications.ts`, `locales/*/main.json` |
| E Drag job needs another folder | A global-drag job failing with a `RETRY_ELSEWHERE_CODES` code opens the Jobs window without focus (once per drop), notifications on or off. | `main/app.ts`, `main/windows/manager.ts` (`open(…, { inactive })`) |
| F Virtual files, helper texts | Path-less Drop Zone items → VIRTUAL_FILE; `configure` sends `unsupportedFolder / unsupportedNonFile / unsupportedVirtual` (helpers accept them since f3cc53a / b16f472). | `preload/index.ts`, `main/helper/configure.ts` |
| G Crash rollback | Every commit is reported (`ProcessorRunContext.onCommitted` → host `committed` message: path, dev, ino, size) by the convert `OutputLedger` and the tools' writer; the pool removes those files (only while dev/ino/size match) before a crash fails the job (so before the automatic retry — no "report-p001 (2).jpg"), when a worker is killed after a cancel/timeout, and when a cancelled job still reports `done`. | `contracts/processor-protocol.ts`, `processing/{host,pool}.ts`, `processors/convert/common.ts`, `processors/tools/common.ts` |
| H Windows modifier note | win32: note about Alt+Shift (input-language switch) and the Windows key (Start); per-combo warnings in `aria-describedby`. | `settingsValidation.ts` (`comboWarnings`), `SettingsView.tsx` |
| I Input Monitoring hint | darwin: "입력 모니터링 권한이 없으면 Esc는 …" + button to the allowlisted pane (hidden when the status already offers it). No permission requests. | `SettingsView.tsx` |
| J Corner radius | Slider maximum = half the shorter side of the image as drawn (`layout.content`); a note when the radius is clamped. | `BackgroundEditor.tsx` (`maxCornerRadius`) |
| K Editor width | Editor windows are content-sized (520 DIP panel, height from `resizeWindow`): not user-resizable. | `main/windows/specs.ts` |
| L Offline | E2E: network emulated offline, every http(s)/ws(s) request recorded; `lsof` sampled over the whole process tree during PDF → JPG and Add Background: none. | `e2e/offline.spec.ts` |
| M Stronger evidence | electron-verify: the 6 trivial checks now assert real state; annotate/redact/pdf/metadata decode outputs (pixels, page proportions via pdf-lib, EXIF gone); ui-flow crop asserts 2550×2550 and pixel identity with the page's centred square. | `renderer/dev/electron-verify.mjs`, `e2e/ui-flow.spec.ts` |
| N OS appearance → helper | Besides `nativeTheme 'updated'`, macOS accessibility display option changes (reduce motion, increase contrast) re-send `configure` (sent only when it really changed). | `main/app.ts` |

## Contract additions (all optional / additive)

- `ipc.ts`: `IPC_CHANNELS.editorThumbnail` (`orbit:editor:thumbnail`), `editorEstimate` (`orbit:editor:estimate`), `jobsClearFinished` (`orbit:jobs:clear-finished`), `jobRetry` (`orbit:job:retry`); `THUMBNAIL_MAX_EDGE`; `ThumbnailRequestSchema`/`ThumbnailRequest`/`ThumbnailResponse`; `EstimateRequestSchema`/`EstimateRequest`/`EstimateOutcome`; `ClearFinishedJobsRequestSchema`/`ClearFinishedJobsRequest`; `RETRY_JOB_CODES`, `canRetryJob()`, `RETRY_ELSEWHERE_CODES` (moved here from main); `PreviewResponse.outputFormat?`, `PreviewResponse.warnings?`; `OrbitApi.getEditorThumbnail`, `requestEstimate`, `clearFinishedJobs`, `retryJob`.
- `processor-protocol.ts`: `PreviewKind` `'thumbnail'`; `PreviewRequest.estimateOnly?`; `PreviewResult.outputFormat?` (processors-edit added `warnings?` next to it); `CommittedOutput`; `ProcessorRunContext.onCommitted?`; `ProcessorToMainMessage` `{ type: 'committed', jobId, output }`.
- `design-tokens.json`: `color.highContrastDark`.
- Every new channel is zod-validated (strict objects) and sender-checked by the existing router.

## Verification (2026-10-21)

| Check | Result |
|---|---|
| `tsc` contracts, processors, core, integration, desktop node / web / e2e | clean |
| `node_modules/.bin/vitest run` | 902 passed, 1 skipped (was 769) |
| `electron-vite build` + `playwright test` | 25/25 (16 earlier + jobs 4, editor-polish 3, drag-failure 1, offline 1) |
| `node apps/desktop/src/renderer/dev/electron-verify.mjs --out …` | 36/36 (was 26, of which 6 were trivial), no console errors / CSP violations |
| `helper-real` E2E with the rebuilt helper (darwin-arm64) | passes (configure with the new strings accepted) |
| Orphan processes after the runs (`ps`) | none |

New tests: `test/main/editor-background.test.ts`; `test/renderer/{editors-polish,keyboard-shapes,unsaved,tokens-contrast}`; `packages/processors/test/tools-{thumbnail,estimate,output-format,committed}.test.ts`; extended: job-manager, submission, stores, file-registry, ipc, pool (fake mid-job crash with real files), ui-logic, helper-manager; jobs, annotate, flows, settings, shell, p0-editors.

## Open / not done

- Jobs listed from history after a restart cannot be retried (inputs/options are not persisted, on purpose); the window says so.
- The unsaved-change confirm covers × and Esc. An OS-level close (Alt+F4 on Windows) is not intercepted; macOS has no ⌘W item.
- Windows has no event for the OS "show animations" setting; the helper picks a change up with the next `configure` (any settings or theme change).
- The macOS Input Monitoring hint is shown unless the helper reports the permission missing; there is no way to query it without prompting.
- Main chooses the pre-paint window background with `nativeTheme.shouldUseHighContrastColors`, the renderer with `prefers-contrast` / forced colours; they can differ for a frame on some OS settings.
- The dev harness has no multi-file Compress scenario (renderer tests cover the batch UI).
- Running the E2E suite regenerates `docs/screenshots/desktop-main-{jobs,picker-pdf}.png` (existing ui-flow behaviour); they now show the new Jobs toolbar.
- Not GUI-verified with a real Finder drag (as for the rest of the app); Windows parts compile-checked only.
