# desktop-renderer — status

Owner: desktop-renderer workstream. Scope: every renderer window's UI
(`apps/desktop/src/renderer/**`), renderer locales
(`apps/desktop/src/shared/locales/{ko,en}/{ui,errors}.json`), renderer tests
(`apps/desktop/test/renderer/**`), screenshots `docs/screenshots/desktop-renderer-*.png`.

## State (2026-10-21) — all views implemented against OrbitApi

| Area | Files (under `apps/desktop/src/renderer/src/`) | Notes |
|---|---|---|
| Shell | `main.tsx`, `app/bootstrap.tsx`, `app/env.tsx`, `app/App.tsx`, `app/errors.ts`, `app/useWindowFit.ts`, `app/useEscapeKey.ts`, `zod-jitless.ts` | `getWindowContext()` + settings → view. Drop guard (no `file://` navigation). `asErrorInfo` recovers the ErrorCode from preload rejections (`"CODE: message"`). zod runs jitless so the CSP never sees an eval probe. Windows ask main for their content size (`resizeWindow`). |
| Theme | `theme/tokensCss.ts`, `theme/appearance.ts`, `styles/base.css` | `design-tokens.json` → CSS variables per theme (light / dark / highContrast). prefers-color-scheme, prefers-contrast, forced-colors, prefers-reduced-motion, plus the settings overrides (system/on/off). Reduced motion zeroes all transitions/animations. Forced-colors rules use system colours. |
| i18n | `i18n/catalog.ts`, `i18n/format.ts`, `src/shared/locales/{ko,en}/{ui,errors}.json` | Typed `t()` (keys from ko/ui.json; tsc fails if en misses a key or an ErrorCode/WarningCode lacks a message), plurals (`.one/.other`), `t.error(code)`, `t.warning(code)`, `t.text(LocalizedText)`. Korean default. |
| Title bar | `components/TitleBar.tsx` | Frameless windows: drag region, centred title, × (left on macOS, right on Windows). |
| Controls | `components/{Segmented,SliderField,NumberInput,Notice,ActionIcon}.tsx` | Radio-group segmented control, slider + numeric field, notices with live regions, IconId → Lucide (ISC) icons. |
| Wheel | `wheel/sectorPath.ts`, `wheel/Wheel.tsx`, `wheel/wheel.css` | See "Wheel" below. |
| Picker | `views/picker/{PickerView,SelectionWheel}.tsx` | File summary, wheel, mode toggle (변환/도구), hint line, unusable-file notes, rejected results shown in place; closes after jobs/editor. |
| Drop Zone | `views/dropzone/DropZoneView.tsx` | HTML5 drop → `registerDroppedFiles` → inline wheel; "파일 열기…"; non-file drops, unsupported files and registration errors explained; "작업 보기" after a start. |
| Editors (shared) | `views/editor/{EditorView,EditorFrame,editorKit,usePreview,previewSequencer}.tsx/ts` | Reset · × / Esc = cancel (`cancelEditor`) · orange primary (⌘/Ctrl+Enter). Previews: 60 ms debounce, monotonic seq, stale/out-of-order answers ignored, last good preview kept, errors shown. Nothing is written before the primary action. |
| Crop (P0) | `views/editor/crop/{cropMath.ts,CropEditor.tsx}` | Pure, tested mapping preview ↔ oriented source px; selection with corner/edge handles, darkened outside, rule-of-thirds while dragging, draw-new by dragging outside; aspect presets; W/H integer fields synced both ways with validation (1…source, ratio limit, no upscale) — typed values apply to the selection as it was when the field got focus (no centre drift), Esc first reverts a field edit; arrow/Shift/Option(Alt) keyboard nudging. |
| Add Background (P0) | `views/editor/background/{BackgroundEditor.tsx,backgroundCss.ts}` | Processor preview only (orbit-preview://), preset gradients rendered in CSS for swatches only, solids, custom colour, background image via `pickBackgroundImage`; Padding/Corners/Shadow sliders + px fields (ranges relative to the output size, final output px); ratio Auto/1:1/16:9/4:5; notes from layout flags (ratio, shadow, maxEdge reduction); output size; PNG/JPEG + quality. |
| Compress (P1) | `views/editor/compress/CompressEditor.tsx` | Format, quality / PNG mode, max edge (never above the source), keep metadata; input vs estimated size; warning (never "success") when not smaller; stays open after commit to show the finished job's real size. |
| Metadata (P1) | `views/editor/metadata/MetadataEditor.tsx` | `inspectImage` table (format, size, DPI, colour space, ICC, EXIF, capture data), GPS warning, ICC policy, strip. |
| Edit (P1) | `views/editor/adjust/AdjustEditor.tsx` | Rotate ±90, flip H/V, brightness/contrast/saturation, processor preview. |
| Annotate (P1) | `views/editor/annotate/{annotateModel.ts,AnnotateEditor.tsx,SwatchGroup.tsx}` | Text/arrow/rect, colour, stroke, font size; select/move/delete; undo/redo (⌘Z, ⇧⌘Z, Ctrl+Z, Ctrl+Y); IME-safe textarea overlay; shapes in source px; canvas drawn with core `drawAnnotations` + `annotationFontFamilyCss(probe.koreanFont)`. |
| Redact (P1) | `views/editor/redact/RedactEditor.tsx` | Draw/move/resize regions, solid or mosaic (block size), region list for keyboard users, mosaic caveat, processor preview. |
| Images → PDF (P1) | `views/editor/pdf/PdfOrderEditor.tsx` | Reorder by drag, buttons or Alt+↑/↓ (live announcements), page size, margin, Create. |
| Jobs | `views/jobs/JobsView.tsx` | Active/recent, determinate bars vs indeterminate animation (static under reduced motion), cancel, reveal/open, size change for Compress, localized warnings/errors, "다른 폴더에 저장…" for OUTPUT_DIR_NOT_WRITABLE. |
| Settings / About | `views/settings/{SettingsView,settingsValidation,AboutView}.tsx` | Tabs: general, output, drag (modifier combos must differ, validated before saving; wheel diameter 320–380; helper status with guidance and allowlisted System Settings links on macOS), processing, accessibility, about. Changes apply immediately (sliders debounced). |
| Dev harness | `src/dev/{mockOrbit,mockPreviews,mockImages,harness}.ts(x)`, `../dev/{index.html,vite.config.mts,screenshots.mjs,electron-verify.mjs}` | Mock OrbitApi with generated canvases; never bundled into the app. `electron-verify.mjs` checks the renderer in the real built app. |

### Wheel

* Geometry: contracts `DEFAULT_WHEEL_GEOMETRY` + core `innerRadius` / `sectorOuterRadius`;
  the pointer is hit-tested with core `hitTestWheel` (same as the native helpers;
  gaps belong to the nearest sector, the centre is a dead zone).
* `sectorShape()` builds each sector outline: the radial boundary lines are offset
  by gap/2 into the sector (so the gap is a constant-width strip, not a wedge),
  the outer/inner circles close it, and each of the 4 corners is replaced by a
  fillet tangent to both edges (centres at `R − c` / `r + c` from the origin and
  `gap/2 + c` from the boundary). The radius is clamped so fillets never overlap.
  Full derivation in the file header; `test/renderer/sectorPath.test.ts` checks
  gap width, tangency, arc flags and agreement with `hitTestWheel`.
* States: normal / orange active / disabled (greyed, dashed outline when
  highlighted, reason in the capsule and the hint line) / busy. Capsule shows the
  hovered or selected label, the disabled reason, or the file size by default.
* Keyboard: one tab stop (`role=menu`, `aria-activedescendant`), →/↓ clockwise,
  ←/↑ counter-clockwise, Home/End, Enter/Space activate (disabled items are
  reachable, never activated), Esc closes, Tab moves to the mode toggle. Items are
  `menuitem`s with `aria-disabled` and `aria-describedby` → reason; a polite live
  region announces the highlighted item. The focus ring appears only for keyboard
  focus (not when the window auto-focuses the wheel).
* High contrast outlines every sector; forced-colors mode uses system colours.

## Verification

| Check | Result |
|---|---|
| `node_modules/.bin/tsc -p apps/desktop/tsconfig.web.json` | clean |
| `node_modules/.bin/vitest run --root apps/desktop test/renderer` | 14 files, 182 tests, all pass, no React warnings |
| `cd apps/desktop && ../../node_modules/.bin/electron-vite build` | builds; renderer bundle 1.1 MB (unminified, see requests) |
| Real Electron app (built `out/`, desktop-main E2E hooks, `ORBITDROP_E2E=1`, Playwright clicks — no OS input) | 25 of 26 checks pass, no console errors or CSP violations in any window: picker PDF menu order, window fit 408×549, close after submit, PDF→JPG 2550×3300, keyboard End/←/Enter opens Crop, Crop 1:1 → 2550×2550 file, Add BG preview via `orbit-preview://`, 16:9 note + "출력 2400 × 1350 px" → PNG 2400×1350, Compress result view (real final size), Metadata, Edit rotate → 1200×1600 file, Annotate (Korean text) saved, Redact saved, Drop Zone in-memory File → localized FILE_NOT_FOUND through the real preload, live language switch persisted by main, Jobs/Settings/Drop Zone/About render. The failing check is images → PDF (`IMAGE_CORRUPT … SOI not found in JPEG`, a processor bug — see requests). Script: `apps/desktop/src/renderer/dev/electron-verify.mjs` (same hooks as desktop-main's e2e). |

Test files (`apps/desktop/test/renderer/`): `wheel` (keyboard + ARIA), `sectorPath`,
`cropMath` (mapping preview↔source incl. EXIF-rotated, aspect lock, W/H sync,
clamping, no upscale), `preview` (seq / stale / out-of-order / errors / unmount),
`flows` (picker + drop zone), `p0-editors` (Crop, Add Background), `editors-p1`,
`annotate` (undo/redo, source-px shapes, IME), `redact`, `jobs`, `settings`
(modifier conflicts), `i18n` (every ErrorCode/WarningCode in ko+en; identical ko/en
key sets; placeholders match), `shell` (appearance, tokens CSS, error parsing, drop guard),
`windowFit` (resize requests, element attached after loading).
Shared setup: `setup.ts` (jsdom gaps), `helpers.tsx` (fake OrbitApi, fixtures).

## Screenshots (`docs/screenshots/`)

From the dev harness (mock OrbitApi, headless Chromium, ko UI unless noted;
regenerate with `node apps/desktop/src/renderer/dev/screenshots.mjs`):
`desktop-renderer-picker-convert-pdf`, `-picker-tools`, `-picker-convert-jpg`
(disabled HEIC with reason), `-crop`, `-add-background`, `-jobs`, `-settings`,
`-settings-drag`, `-dropzone`, `-compress`, `-metadata`, `-edit`, `-annotate`,
`-redact`, `-pdf-order`, `-about`, `-picker-tools-dark`, `-picker-tools-en-hc`.

From the built Electron app with real processors and outputs: `desktop-renderer-electron-picker-pdf`, `-picker-tools`, `-crop`, `-add-background-16x9`, `-compress-result`, `-annotate`, `-redact`, `-jobs`.

## Dev harness

```
node_modules/.bin/vite --config apps/desktop/src/renderer/dev/vite.config.mts
# → http://127.0.0.1:5199/dev/index.html (gallery)
#   ?view=picker&menu=pdf|jpg|png|images|mixed|unsupported&mode=convert|tools
#   ?view=editor&tool=crop|addBackground|compress|metadata|edit|annotate|redact|pdf
#   ?view=jobs|settings|dropzone|about   &lang=en &platform=win32 &helper=needsPermission &hc=on &rm=on
```

## Requests / notes for other workstreams

desktop-main
- Editors close themselves with `closeWindow()` after a successful `commitEditor`
  (Compress stays open to show the finished job). `cancelEditor` is only called for
  uncommitted editors; closing a committed Compress result view must not cancel jobs.
- Editor `minHeight` 400 leaves empty space under short views (PDF order ≈ 402,
  Compress result ≈ 300); the renderer already requests its exact content size.
- `electron.vite.config.ts`: consider `renderer.build.minify: true` (bundle is
  1.1 MB unminified today; React's production files are no longer pre-minified).
- `HelperStatus.reason` strings are developer English and are shown verbatim.
- OrbitApi gaps: per-file thumbnails for the PDF order list
  (`getFileThumbnail(editorId, fileId, maxEdge)` or URLs in `EditorContext.files`);
  batch Compress previews only estimate the first file; no "clear finished jobs";
  no generic retry for retryable errors other than OUTPUT_DIR_NOT_WRITABLE.

lead (contracts / tokens)
- Contrast: white text on `accent` #F2552C is 3.4:1 (AA only for large text); it is
  used for 13–15 px bold labels (primary buttons, active sector, selected segments).
  Consider a darker text-bearing accent (≈ #D9481F gives 4.5:1) — highContrast is fine.
- No warning colours in `design-tokens.json`; the renderer derives warning/danger
  tints per theme in `styles/base.css`.
- Document `JobWarning.params` names; the renderer shows `pages` and
  `width`/`height` and ignores anything else.

processors-convert
- `convert.pdf` fails for plain baseline sRGB JPEGs: `IMAGE_CORRUPT` "Image could not
  be embedded in the PDF", detail "SOI not found in JPEG" (pdf-lib `embedJpg` after the
  pass-through path `stripJpegMetadata` in `convert/images-to-pdf.ts`). Repro: two
  sharp-generated JPEGs (1600×1200, 1200×900) through the Images → PDF editor.

## Known limitations

- The live wheel-size preview in Settings is not implemented (the slider applies immediately).
- Closing Annotate/Redact with unsaved shapes does not ask for confirmation.
- The highContrast token set is light; dark mode + "increase contrast" uses it.
- The renderer wheel serves the picker and Drop Zone (keyboard path). The wheel
  shown during a real OS drag is the native helper's.

## Commands

| Purpose | Command |
|---|---|
| Typecheck | `node_modules/.bin/tsc -p apps/desktop/tsconfig.web.json` |
| Tests | `node_modules/.bin/vitest run --root apps/desktop test/renderer` |
| Build | `cd apps/desktop && ../../node_modules/.bin/electron-vite build` |
| Harness | `node_modules/.bin/vite --config apps/desktop/src/renderer/dev/vite.config.mts` |
| Screenshots | `node apps/desktop/src/renderer/dev/screenshots.mjs` |
| Real-app check (after a build; brief inactive windows) | `node apps/desktop/src/renderer/dev/electron-verify.mjs [--out dir]` |
