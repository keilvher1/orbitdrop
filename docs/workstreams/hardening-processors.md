# Workstream: hardening-processors — status

Second, adversarial pass over the processing engines (2026-10-22/23, macOS 26.6 arm64, Node 24.7,
Electron 44.9, sharp 0.35.5 / libvips 8.18.7, pdfjs-dist 6.4.299, @napi-rs/canvas 1.0.11).
Owner files: `packages/processors/**`, `packages/core/**`, `tests/integration/**`, `tests/fixtures/**`,
`docs/conversion-policy.md`, this file; additive contract change in `packages/contracts/src/jobs.ts`
and append-only locale strings in `apps/desktop/src/shared/locales/{ko,en}/errors.json`.

Every case went through the public API (`runJob` / `renderPreview` / `inspectImage` of
`@orbitdrop/processors`) and every output was decoded again. Independent references were used where
the engine under test could hide its own bug: EXIF orientation computed in JS from the stored pixels
(not sharp's auto-orientation), colours from macOS ColorSync (`sips -m sRGB`), PDF renders from
poppler (`pdftoppm -cropbox`), bilevel images from the source bitmap. The regression tests keep the
portable part of those references (JS orientation, source colours, source bitmap).

## Defects found and fixed

| # | Defect (how it showed) | Fix | Regression test |
|---|---|---|---|
| 1 | **Conversions of 16-bit input with an embedded profile had wrong colours** — any profile, sRGB included, and 10-bit HEIC (ImageIO decodes it to a 16-bit PNG with its P3 profile): up to 57 levels off ColorSync in convert.jpeg/png/webp/tiff/avif/bmp, images → PDF and image → DOCX. sharp processes RGB16+profile in Display P3 and writes the numbers back untagged. Tools were already right (they reduce to 8 bits first). | `common/io.ts` `toEightBit()` (shared with the tools' loader) + `openImageSource()`: conversions decode once into an 8-bit lossless intermediate (profile kept, no rotation) before sharp's (correct) 8-bit colour path. Measured after: ≤ 4 levels for sRGB/P3/Adobe RGB/ROMM, 16-bit PNG/TIFF/HEIC. (An explicit sRGB output profile fixed tagged RGB16 but shifted untagged RGB16 by ~28 levels, so it was not used.) | `hardening-colour.test.ts` (5 cases: 16-bit PNG/TIFF, sRGB/P3/none, with alpha; every target incl. the PDF image XObject and the DOCX picture); 16-bit cases in `hardening-orientation.test.ts` |
| 2 | **`keepMetadata` on a CMYK JPEG/TIFF with an embedded profile** (convert option, Compress option) converted with sharp's built-in CMYK profile instead of the embedded one (44–55 levels off) and tagged the result sRGB. | `common/io.ts` `keepMetadataFor()`: `keepMetadata().withIccProfile('srgb')` for CMYK (the conversion then uses the embedded profile); used by `encodeImage` and the tools' `encodeToolImage`. After: same colours as without keepMetadata (≤ 1 level), EXIF kept, sRGB tag. | `hardening-colour.test.ts` (portable: a CMYK JPEG tagged with pdf.js' CGATS001 profile) |
| 3 | **Animated GIF/WebP/APNG and multi-page TIFF silently lost frames/pages** in every conversion and tool. | New warnings `FIRST_FRAME_ONLY {frames, files}` / `FIRST_PAGE_ONLY {pages, files}` (contracts, ko/en strings) from convert image → image, images → PDF (one per kind, counting files), image → DOCX and all tools (Metadata only when it re-encodes; its lossless path keeps every frame). APNG frames read from `acTL` (libvips sees only the default image); `inspectImage().pages` reports them too. | `hardening-inputs.test.ts` "animated…" |
| 4 | An empty file (emptied after main validated it) was `INTERNAL` for images, `PDF_CORRUPT` for PDFs. | `readInputBuffer` / `readInputBytes` → `FILE_EMPTY`. | `hardening-inputs.test.ts` |
| 5 | A truncated PNG was `INTERNAL` ("vipspng: libpng read error") in every action. | `mapSharpError` knows the libpng/spng loader prefixes → `IMAGE_CORRUPT`. | `hardening-inputs.test.ts` |
| 6 | **images → PDF and image → DOCX embedded a truncated JPEG byte for byte** (also one missing only its EOI) and reported success — a PDF/DOCX with a broken picture. | The pass-through JPEG is decoded completely first (JPEG DCT scaling, `failOn: 'error'`): `IMAGE_CORRUPT`, nothing written. Cost: +80 ms for a 15 MB 24 MP JPEG. | `hardening-inputs.test.ts` |
| 7 | Tools noticed an unwritable output folder only after decoding/encoding everything; a missing folder was `OUTPUT_WRITE_FAILED` (conversions: `OUTPUT_DIR_NOT_WRITABLE` up front). | `tools/index.ts` checks the folder first (`assertWritableDir`), like the conversions. | `hardening-inputs.test.ts` (a corrupt input in a read-only/missing folder is reported as the folder) |
| 8 | **Stale previews and Compress estimates**: caches were keyed by path + size + mtime; a file replaced by another of the same size that carries the same mtime (rename-over "safe save", Finder copy or `cp -p` keep the source mtime) showed the old picture and size. | `fileIdentityKey()` (source cache and Compress caches): dev + inode + size + mtime + ctime in nanoseconds. | `hardening-pipeline.test.ts` (rename-over, same size and mtime) |
| 9 | PDF text layout used `Math.min/max(...lines)`: a page with ~120k+ text lines threw RangeError (TXT: `PDF_CORRUPT`, DOCX: `INTERNAL`). | Loops in `pdf/text.ts`. | `hardening-pdf.test.ts` (300 000 lines) |
| 10 | **image → DOCX failed with `INTERNAL` "Invalid array length" for pictures above ~64 MB** (72 MB PNG of a 24 MP photo, 84 MB 96 MP JPEG): docx 9.12's `ImageRun` hashes the bytes through a JS array (hash.js), ~30 bytes of memory per picture byte. | Pictures above 32 MB are resampled to 300 ppi of their size on the page (same size in the document) → `DOWNSCALED {dpi: 300}`. 72 MB PNG: 0.99 s, 478 MB peak (was INTERNAL at 1.3 GB). | `hardening-inputs.test.ts` (35 MB random PNG → 1881 px at 602 px page width) |
| 11 | PDF → JPEG wrote the DPI only as EXIF XResolution (sharp's `withDensity` keeps EXIF and libvips then drops the JFIF APP0) although the docs promised JFIF density. | `withJfifDensity()`: a JFIF APP0 with the same DPI after SOI (EXIF kept). | `hardening-pdf.test.ts` (150/300 DPI and the DOWNSCALED DPI) |
| 12 | A file that grew past `maxInputBytes` after validation was read completely (only main's stale byte count was checked for images). | `readInputBuffer` fstat()s the open file before reading → `FILE_TOO_LARGE`. | `hardening-inputs.test.ts` |
| 13 | Memory: convert X(alpha) → JPEG called `Sharp.clone()`, which deep-copies the whole input buffer. PDF pages kept the canvas alive while encoding although `canvas.data()` is a copy. | Fresh pipelines from one buffer (`ImageSource.open()`); the canvas is freed right after `data()` (copy semantics pinned by a test). Measured below. | `hardening-pdf.test.ts` (copy semantics); numbers below |
| 14 | `codecs-imageio.test.ts` failed once under a loaded full run: the fake helper (a Node script) missed the real helper's 3 s probe budget. | The test gives the fake helper 20 s. | — |

Mutation check: with the original `packages/processors/src` restored (plus a stub for the new
diagnostics export), 21 of the 65 new tests fail — the ones for defects 1–12 (the JBIG2/CCITT test
only through the stubbed load counter; its pixels were already right) — and 44 pass (the "checked,
OK" cases below). My sources were put back afterwards (SHA-256 identical).

## Cases checked

| Case | Result | Fix / test |
|---|---|---|
| EXIF orientation 1–8, JPEG, every action: convert PNG/TIFF/WebP/AVIF/BMP/PDF/DOCX, crop (PNG and JPEG out), add background, edit (identity, rotate 90), annotate, redact solid + mosaic, compress, metadata, previews source/crop/redact, inspect | OK: lossless outputs pixel-exact against the JS-oriented stored pixels, lossy ones close, no orientation left; Redact exact for all 8 | `hardening-orientation.test.ts` (8 tests) |
| Orientation on PNG (eXIf), TIFF tag, WebP, AVIF (8-bit) | OK (exploration, all 8 each) | — |
| Orientation on 16-bit PNG/TIFF | crop/redact/edit OK; conversions had defect 1 | 5 tests |
| HEIC orientation (irot via ImageIO helper, o3/o6/o8) | OK: oriented 40×24, redact at displayed coordinates (exploration) | — |
| 8-bit sRGB/Display P3/Adobe RGB/ROMM PNG+TIFF → every output and tool | OK, ≤ 3 levels vs ColorSync | — |
| 16-bit with profile → conversions | defect 1 | fixed |
| CMYK JPEG with ICC (Adobe-inverted, sharp writes the Adobe marker) | OK (5 levels vs ColorSync); keepMetadata: defect 2 | fixed |
| CMYK JPEG without ICC | libvips' built-in CMYK profile; 58 levels from ColorSync's Generic CMYK (no defined appearance) — documented | policy |
| Grey JPEG (± Gray Gamma 2.2), grey16 (± profile), grey+alpha, palette PNG with tRNS | OK (0–1 levels) | — |
| Animated GIF/WebP/APNG, multi-page TIFF | defect 3 | fixed |
| Zero-byte | defect 4 | fixed |
| Truncated JPEG (10 %, 50 %, missing EOI) | `IMAGE_CORRUPT` in conversions/tools; embedded in PDF/DOCX: defect 6. A JPEG whose data stops early but ends in a marker is filled grey by libjpeg and accepted with `failOn: 'error'` (stricter `'warning'` would reject common harmless warnings) — documented | policy |
| Truncated PNG | defect 5 | fixed |
| Garbage after a valid magic (JPEG/PNG/WebP/GIF/TIFF/AVIF/BMP/HEIC) | `IMAGE_CORRUPT` (HEIC: `ENGINE_UNAVAILABLE` without the helper) | — |
| Progressive, arithmetic-coded, restart-marker, progressive+arithmetic JPEG; PNG named .jpg | OK: same pixels as the source decode in conversion, crop, images → PDF; lossless strip keeps RST markers and scan data | `hardening-inputs.test.ts` (static fixtures) |
| Dimension bombs 60000×60000 (PNG, JPEG, TIFF, BMP RLE) and 65535² GIF | `IMAGE_TOO_LARGE` in ≤ 2 ms per action, no allocation (process max RSS 224 MB = baseline) | `hardening-inputs.test.ts` |
| In-limit bombs (16000² claimed by a 1 KB RLE BMP / solid 776 KB PNG) | allowed by `maxInputPixels`; costs measured below | request 1 |
| PDF `/Rotate` 0/90/180/270 × offset/negative MediaBox × CropBox, 150/300 DPI | OK: crop box size, clockwise, marks where poppler puts them (mean diff ≤ 0.14) | `hardening-pdf.test.ts` (4 tests) |
| PDF UserUnit 2 | OK: 2× physical size (PDF.js honours it; poppler does not) | test |
| Odd page sizes at 150/300 DPI | OK, rounded to the nearest pixel (poppler rounds up) | test |
| Owner-password-only PDF (RC4-128 static fixture; AES-256 checked with pypdf) | opens, renders, extracts — policy: like viewers (documented in conversion-policy.md) | test |
| User password (RC4-128 fixture; AES-256 checked) | `PDF_ENCRYPTED` for PNG/TXT/DOCX | test |
| Broken xref offset; truncated 90 % | recovered by PDF.js | test |
| Truncated 50 %, header only | `PDF_CORRUPT` | test |
| JPX, JBIG2 (MMR), CCITT G4 images | OK, pixel-exact; jbig2.wasm and openjpeg.wasm read through our factory and instantiated — plain Node, `ELECTRON_RUN_AS_NODE`, utilityProcess, app.asar, app.asar with native modules | `hardening-pdf.test.ts`, extended `convert-electron-smoke.mjs` |
| Non-embedded standard-14 fonts | OK (PDF.js loads LiberationSans from `standard_fonts/`) | smoke shows the load |
| Korean, non-embedded font, predefined CMap (UniKS-UCS2-H) | OK: glyphs on the page (system font), "한글 CMap" in TXT and DOCX | `hardening-pdf.test.ts` |
| Annotations and form fields | drawn from appearance streams like on screen; hidden annotations not drawn; TXT/DOCX contain page text only — policy, documented | test |
| Transparency (constant alpha, soft-masked image) | OK (matches poppler) | test |
| Scanned PDF → TXT/DOCX | `PDF_NO_TEXT`, nothing written (existing tests) | — |
| 2001 / 5000 pages | `TOO_MANY_PAGES` before rendering (0.3 s) | existing test |
| 14 400 × 14 400 pt page at 300 DPI | `DOWNSCALED` to 150 Mpx (61.18 DPI) — documented behaviour; memory below | request 1 |
| Names: 255-byte NFC base + " Cropped With Background", "-p001", " (2)"; ZWJ emoji at the cut; NFD Hangul; CON/nul; 20 jobs racing for one long name | OK: ≤ 255 bytes, NFC, whole graphemes, extension kept, device names suffixed, 20 distinct files, no temp files; NFD/case-variant existing names get " (2)" on APFS | `hardening-pipeline.test.ts` |
| Output name is a dangling symlink / a symlink to another file (hard-link and copy commit), symlinked output folder | never followed or replaced; file lands in the folder the link points to | test |
| Input vanished / became a folder / chmod 000 / symlink loop after validation | `FILE_NOT_FOUND` / `NOT_A_FILE` / `READ_PERMISSION_DENIED` / `SYMLINK_LOOP` | test |
| Read-only / missing output folder | `OUTPUT_DIR_NOT_WRITABLE` (tools: defect 7) | tests |
| Disk full (4 MB HFS+ image): 61 MB PNG, TIFF, crop, 12-page PDF at 300 DPI, full volume with small jobs | `DISK_FULL`, no temp file, committed pages rolled back | `hardening-diskfull.test.ts` (opt-in) |
| Cancellation at 0…N ms, at every progress event and at the commit, 16 actions | no temp files, every file left was reported via `onCommitted`, done ⇒ outputs exist and decode, cancelled ⇒ nothing left, 0 unhandled rejections | `hardening-cancel.test.ts` |
| Parallel jobs on one input | OK (20 racing, cancellation runs) | tests |
| Add Background preview ↔ final at maxEdge 256/700/2400 × 4 ratios × preset/image background | preview reports the final size exactly; mean \|Δ\| < 4/255 (≤ 3.62 measured at 2560 px) | `hardening-pipeline.test.ts` |
| Caches after the file changes on disk | defect 8 | fixed |
| PDF → JPG text quality | q ≥ 90 (default 90) → 4:4:4, quant table 3, optimised Huffman; < 90 → 4:2:0 — documented | — |
| DPI metadata | PNG pHYs exact; JPEG: defect 11 | fixed |

## Measurements

Peak RSS. "tsx" = a fresh Node process per action under tsx (its pdf.js transpile adds ~450 MB to
PDF jobs: baseline ≈ 650 MB there vs 189 MB in the bundled utilityProcess); "utility" = real
Electron 44.9 utilityProcess (`convert-electron-smoke.mjs memory`).

| Job | Peak RSS | Time |
|---|---|---|
| 200 MB / 122-page PDF → JPG 150 DPI (utility) | +333 MB over baseline (was +417 MB), max 547 MB (was 616) | 12.9 s |
| same → TXT (utility) | +206 MB (unchanged) | 0.06 s |
| 14 400 × 14 400 pt page → JPG (utility; 150 DPI requested, 30000² capped to 12235² = 150 Mpx, the same size as at 300 DPI) | +1796 MB (peak 1985 MB); single page unchanged by #13 (peak is during the data() copy) | 0.83 s |
| same → PNG (utility) | peak 1309 MB | 0.28 s |
| 480 MB RGBA TIFF → JPEG (tsx) | 2.02–2.12 GB (was 2.43–2.51 GB, #13) | 4.5–5.0 s |
| 1 KB RLE BMP claiming 16000² → JPEG (tsx) | 2.5–2.6 GB | 10.7–12.4 s |
| 776 KB solid 16000² PNG → JPEG / WebP / PDF / DOCX (tsx) | 3.09 / 1.40 / 2.95 / 0.50 GB | 9.7 / 4.8 / 6.4 / 0.4 s |
| 256 Mpx → JPEG encoder settings (sharp alone) | mozjpeg 2.11 GB (1.5 MB file); baseline+optimised Huffman 1.75 GB (3.0 MB); baseline streaming 0.24 GB (7.0 MB) | 10.6 / 1.5 / 0.4 s |
| 24 MP photo, per action (tsx) | convert PNG 272 MB, WebP 586, AVIF 808, PDF 237, DOCX 745–763; crop 397, add bg 377, edit 666, compress 392, metadata 235, annotate 698, redact 704, source preview 224 | 0.03–11 s |
| Over-limit bombs (all formats) | 224 MB (= baseline) | ≤ 2 ms |

## Changes

- `packages/processors/src/common/io.ts`: `toEightBit`, `openImageSource` (+ `ImageSource`), `apngFrameCount`, `droppedFrames`, `framesWarning`, `keepMetadataFor`; `readInputBuffer` stats the open file (FILE_TOO_LARGE / FILE_EMPTY); `readInputBytes` FILE_EMPTY; `mapSharpError` libpng prefixes.
- `convert/image.ts`: `openImageSource` (8-bit, no clone), frames warning. `convert/images-to-pdf.ts`: `assertDecodes` before pass-through, `openImageSource`, frames warnings per kind. `convert/to-docx.ts`: `shrinkForDocx` above 32 MB, frames warning. `convert/pdf-to-image.ts`: `withJfifDensity`.
- `pdf/engine.ts`: canvas freed after `data()`; `pdfResourceLoads()` diagnostics. `pdf/text.ts`: loops instead of spreads.
- `tools/common.ts`: loader uses `toEightBit`, `LoadedImage.dropped`, `framesWarnings`, `keepMetadataFor` in `encodeToolImage`; `tools/index.ts`: output folder check first; `source-cache.ts` / `compress.ts`: `fileIdentityKey`; every tool reports the frames warning; `metadata.ts`: APNG pages.
- Contracts (additive): `WARNING_CODES` += `FIRST_FRAME_ONLY`, `FIRST_PAGE_ONLY` (params documented in `jobs.ts`). Locales (append-only): `warning.FIRST_FRAME_ONLY`, `warning.FIRST_PAGE_ONLY` in ko/en `errors.json`.
- Tests: `packages/processors/test/hardening-{orientation,colour,inputs,pdf}.test.ts` (+ `helpers/hardening.ts`), `tests/integration/hardening-{pipeline,cancel,diskfull}.test.ts`; `convert-smoke-entry.ts` / `convert-electron-smoke.mjs` render CCITT/JBIG2/JPX and assert wasm loads + instantiations in every mode (`CONVERT_MEMORY_INPUT` measures a given PDF).
- Fixtures (static, all < 10 KB): `ccitt-g4.pdf`, `jbig2-mmr.pdf`, `bilevel-source.png` (pure-JS T.6/JBIG2 writer `bilevel-codecs.mjs`), `owner-only.pdf` (CoreGraphics), `jpeg-arithmetic.jpg`, `jpeg-restart.jpg`, `jpeg-source.jpg` (jpegtran). Regenerate: `node tests/fixtures/static/make-static-fixtures.mjs bilevel owner jpegs` (jpegs needs jpegtran on PATH).
- `docs/conversion-policy.md`: 16-bit and CMYK colour rules, frames/pages, damaged/empty/grown files, PDF size rounding, DPI metadata, chroma, annotations/forms, owner-password policy, truncated JPEGs in PDF/DOCX, DOCX picture limit, tools' folder check.

## Verification (2026-10-23)

| Command | Result |
|---|---|
| `node_modules/.bin/tsc -p` contracts / core / processors / tests/integration / apps/desktop node / web | all exit 0 |
| `node_modules/.bin/vitest run packages/processors packages/core tests/integration` | 51 files passed, 2 skipped (opt-in); 525 tests passed, 4 skipped (baseline before this pass: 45 + 1 files, 460 + 1 tests) |
| same + `packages/contracts`, three consecutive runs | 53 passed + 2 skipped files, 544 passed + 4 skipped, all three |
| scoped run once more after the mutation check, then twice | first run: `convert-electron-smoke.test.ts` failed once (load average 8, 11 Electron/Playwright processes of other workstreams running; message not captured); the next two scoped runs and three runs of that file alone passed (51 + 2 files, 525 + 4 tests) |
| `node_modules/.bin/vitest run` (whole repo) | 82 passed, 3 failed, 2 skipped files; 1013 passed, 3 failed, 4 skipped. The 3 failures are desktop renderer editor tests (annotate, editors-p1 Reset, redact: "Save button starts disabled") that started failing after the desktop workstream's uncommitted `EditorFrame.tsx` edits (23:54, again 00:05); the same command passed (1012 passed, 0 failed) at 23:47 with this pass's processor, contract and locale changes already in place |
| `node tests/integration/convert-electron-smoke.mjs` (node, utility, asar) and `… asar-native` | exit 0; every mode: CCITT and JBIG2 0 mismatching pixels, JPX colours right, jbig2.wasm 1 / openjpeg.wasm 1 reads, 3 wasm instantiations, `Buffer.poolSize` 65536 in Electron |
| `CONVERT_MEMORY_MB=200 … memory`, `CONVERT_MEMORY_INPUT=<14 400 pt page> … memory` | numbers above |
| `ORBITDROP_FS_TESTS=1 vitest run --root tests/integration hardening-diskfull.test.ts` | 3/3 (image detached afterwards) |
| `ORBITDROP_FS_TESTS=1 vitest run --root packages/core test/output-fat.test.ts` | 1/1 |

## Open items and requests

1. **lead / contracts — pixel limits vs memory.** One rendered PDF page costs ~12 bytes per pixel at
   the 150 Mpx `maxOutputPixels` cap (+1.8 GB in a utilityProcess); an image at the 268 Mpx
   `maxInputPixels` limit costs 2.5–3.1 GB for JPEG output (mozjpeg buffers every DCT coefficient)
   and can come from a 1 KB file. With 2–4 workers that is 5–12 GB. Options: a PDF page cap of
   ~70 Mpx (A1 at 300 DPI; ≈ 0.85 GB), `maxInputPixels` ~100 M, or running jobs above ~60 Mpx one at a
   time; streaming baseline JPEG for huge outputs cuts 2.1 GB to 0.24 GB but makes files larger
   (4.7× for the flat 256 Mpx test image; photos were not measured). Not changed here (contract
   defaults are lead-owned).
2. **desktop** — show `FIRST_FRAME_ONLY` / `FIRST_PAGE_ONLY` (strings added) and decide whether they
   count as "완료(확인 필요)" in notifications (they mean part of the input is missing from the
   result, so probably yes). Tool previews could carry them in `PreviewResult.warnings`; not done.
3. **desktop-main** — the Order editor's thumbnail cache is keyed by file + size (polish.md); use
   device/inode/ctime like `fileIdentityKey` so a replaced file does not keep its old thumbnail.
4. **docx dependency** — `ImageRun` hashes pictures through a JS array (hash.js): ≤ 32 MB pictures
   still cost ~30× their size in memory (15 MB JPEG → ~750 MB peak). Worth an upstream issue or a
   patch that hashes with `node:crypto`.
5. **packaging-docs / lead** — support matrix and verification.md can cite the new tests and the
   extended Electron smoke (CCITT/JBIG2/JPX decoders in app.asar); processors-convert.md still says
   animated/multi-page inputs convert their first frame without mentioning the new warnings.
6. Not verified: AES-256 PDFs and ColorSync/poppler comparisons are exploration evidence (pypdf,
   `sips`, `pdftoppm`), not automated; Windows behaviour of the read-only/symlink tests (skipped on
   win32) and of HEIC (no codec) is unmeasured.
