# Workstream: processors-convert — status

Owner files: `packages/processors/src/{probe.ts,convert/**,codecs/**,pdf/**}`,
`packages/processors/test/{convert*,codecs*,probe*,helpers/convert*}`, `scripts/gen-fixtures.mjs`,
`tests/fixtures/**` (except `wheel-golden.json`), `tests/integration/convert*`, this file.
Not modified: `packages/processors/src/common/io.ts`, `src/index.ts` (lead), contracts, core.

## Status (2026-10-21)

| Item | State | Evidence |
|---|---|---|
| `probeEngines()` — measured, cached, never throws | done | `test/probe.test.ts`; Electron smoke (`probeMs` ≈80–110 ms in a bundled utilityProcess) |
| BMP codec (decoder: core/OS2/INFO/V2–V5, 1/2/4/8-bit palettes, 16/24/32-bit, BI_RGB/BITFIELDS/ALPHABITFIELDS/RLE8/RLE4, top-down/bottom-up; encoder: 24-bit opaque / 32-bit V5 alpha) | done | `test/codecs-bmp.test.ts` (hand-built variants, files written by macOS ImageIO, our output read back by `sips`) |
| ImageIO bridge (`OrbitDropHelper imageio --probe/--decode/--encode`) | done | `test/codecs-imageio.test.ts`: fake helper (timeouts, cancel, errors, cleanup) + the real macOS helper (real HEVC HEIC round trip) |
| **P0-A PDF → JPG/PNG** | done | `test/convert-pdf-image.test.ts`, `tests/integration/convert-pipeline.test.ts`, lead's `video-flow.test.ts` |
| **P0-B JPG/PNG/WebP conversions** (+ AVIF, TIFF, BMP, GIF input) | done | `test/convert-image.test.ts` |
| P1 images → one PDF (ordered) | done | `test/convert-images-pdf.test.ts` |
| P1 PDF → TXT | done | `test/convert-pdf-text.test.ts` |
| P2 PDF → DOCX (text-centric), image → DOCX (picture, no OCR) | done | `test/convert-docx.test.ts` |
| P2 HEIC in/out | done via the macOS helper only; disabled elsewhere (measured) | probe + real-helper test |
| Fixtures (generated on demand + static with generator) | done | `scripts/gen-fixtures.mjs`, `tests/fixtures/static/make-static-fixtures.mjs` |
| Electron smoke (ELECTRON_RUN_AS_NODE, utilityProcess, app.asar) | done | `tests/integration/convert-electron-smoke.{mjs,test.ts}` |

## Measured support matrix (this Mac: macOS 26.6 arm64, Node 24.7 and Electron 44.9 / Node 24.22)

Every cell below is measured by `probeEngines()` (tiny encode→decode round trips, a real PDF.js
render + text extraction, a DOCX pack, the helper's own probe followed by a real HEIC round trip).

| Format | Decode (input) | Encode (output) | Notes |
|---|---|---|---|
| JPEG | sharp 0.35.5 / libvips 8.18.7 | sharp (mozjpeg) | EXIF orientation applied to pixels |
| PNG | sharp | sharp | |
| WebP | sharp | sharp | animated → first frame |
| GIF | sharp | sharp (no `convert.gif` action exists) | animated → first frame |
| TIFF | sharp | sharp (LZW) | multi-page → first page |
| AVIF | sharp (libheif 1.23.5 + aom) | sharp | P1, enabled because the round trip passes |
| HEIC | **ImageIO helper** (macOS) | **ImageIO helper** (macOS) | sharp: decode "Support for this compression format has not been built in: HEVC (a suitable decoder plugin is libde265)", encode "heifsave: Unsupported compression" → disabled unless `ORBITDROP_IMAGEIO_HELPER` points to a working helper (probe round trip). Windows: disabled (no codec). |
| BMP | builtin-bmp | builtin-bmp | libvips has no BMP |
| PDF | PDF.js 6.4.299 (legacy build) + @napi-rs/canvas 1.0.11 | pdf-lib 1.17.1 | `pdfRender: true`, `pdfText: true` |
| DOCX | — (output only) | docx 9.12.0 | |
| TXT | — (output only) | PDF.js text extraction | |

`koreanFont`: `Apple SD Gothic Neo` (same detection as Annotate: `detectKoreanFont()` from
processors-edit / `ANNOTATION_FONT_CANDIDATES` from core). `errors: []`.
Probe time: 600 ms cold under tsx (transpiling pdf.js dominates), 395 ms with the real helper
(includes a HEIC encode+decode), ≈80–110 ms in the bundled app worker.

Resulting actions (`buildCapabilitySnapshot` + `supports`, checked in `probe.test.ts`): JPG/PNG from
images and PDFs; WEBP/AVIF/TIFF/BMP from images; PDF from images (merging); TXT and DOCX from PDFs;
DOCX from images; HEIC only with the helper. Same-format conversions are never offered (and the
executor refuses them with `INVALID_OPTIONS`).

## Conversion policies

Image → image (`convert/image.ts`)
- Pixels are auto-oriented (EXIF), the output has no orientation tag to re-apply.
- Metadata (EXIF incl. GPS, XMP, IPTC) is dropped by default and pixels go to sRGB →
  `METADATA_REMOVED {kinds: "exif,xmp"}` when the input had any. `keepMetadata` keeps EXIF/XMP/ICC
  (sharp resets Orientation to 1).
- No alpha in the target (JPEG) → flattened on `flattenBackground` (default `#FFFFFF`);
  `ALPHA_FLATTENED {background}` only when the image really has transparent pixels
  (`stats().isOpaque`), not for opaque alpha channels.
- BMP output: 24-bit when every pixel is opaque, else 32-bit BGRA (BITMAPV5HEADER, BI_BITFIELDS,
  LCS_sRGB). A BITMAPV4HEADER with LCS_sRGB is rejected by macOS ImageIO ("Cannot extract image
  from file"; measured), which is why V5 is used instead of the V4 the brief mentioned.
- `EXTENSION_MISMATCH {detected, extension}` is reported by the executor when the name's extension
  disagrees with the sniffed format (e.g. a PNG named `.jpg`; its result becomes `x (2).jpg`).

PDF → JPG/PNG (`convert/pdf-to-image.ts`, `pdf/engine.ts`)
- DPI = `options.dpi ?? settings.pdfDpi`; size from PDF.js' viewport (crop box + `/Rotate`), so
  US Letter @300 → 2550×3300, @150 → 1275×1650, A4 @300 → 2480×3508; per-page sizes kept.
- Opaque page on `flattenBackground` (white); DPI written into the file (JFIF density / PNG pHYs).
- Names: `Page 001.pdf` → `Page 001.jpg`; several pages → `report-p001.jpg`… (core `convertedName`).
- Pages over `limits.maxOutputPixels` (or 65 000 px on a side) are rendered at the highest DPI that
  fits → `DOWNSCALED {pages, count, dpi, requestedDpi}` (chosen over failing: the user still gets
  every page). Embedded images above `maxInputPixels` are skipped by PDF.js (`maxImageSize`).
- `limits.pdfPageConcurrency` pages in flight plus a pixel budget (in-flight canvases ≤
  `maxOutputPixels`), determinate progress per page, cancellation checked between pages and wired
  to `RenderTask.cancel()`.
- **Rollback**: when a multi-page job fails or is cancelled, in-flight pages are awaited and every
  file this job committed is removed (`OutputLedger.rollback`) — only if it is still the same file
  (device, inode and size recorded at commit). Nothing else is ever deleted. So a job leaves either
  all pages or none.
- The output folder is checked before any work (`OUTPUT_DIR_NOT_WRITABLE` immediately).
- Errors: user password → `PDF_ENCRYPTED`; unreadable → `PDF_CORRUPT`; > `maxPdfPages` →
  `TOO_MANY_PAGES` (before rendering); page/document resources are released (`page.cleanup()`,
  `loadingTask.destroy()`).
- Page encoders (measured on a dense 300 DPI text page, 2550×3300): full mozjpeg 520 ms / 851 KB vs
  baseline + optimised Huffman + quant table 3: 51 ms / 1084 KB; PNG zlib 9 386 ms / 837 KB vs zlib 6
  33 ms / 1002 KB. Documents have many pages → the fast settings (pdftoppm's defaults) are used.
  40-page Letter PDF @300 DPI: JPEG 1.6 s, PNG 1.3 s with concurrency 2 (bundled, Node 24.7);
  peak RSS 0.5–0.7 GB (0.34–0.44 GB with concurrency 1); no growth across pages.

Images → one PDF (`convert/images-to-pdf.ts`)
- One image per page in `options.order` (must list every input once, else `INVALID_OPTIONS`);
  named after the first file in that order; > `maxPdfPages` images → `TOO_MANY_FILES`.
- `pageSize: 'image'`: points = pixels × 72 / density (72 when absent or implausible, < 36 or
  > 4800), plus `marginPt` on each side, capped at 14 400 pt. `a4`/`letter`: landscape pages for
  landscape images, image centred inside the margins, scaled down to fit, never enlarged.
- Upright baseline 8-bit gray/RGB JPEGs with sRGB or no ICC profile are embedded byte for byte;
  their APP1 (EXIF/XMP), APP13 (IPTC) and COM segments are removed without touching the image data
  (`METADATA_REMOVED`), unless `keepMetadata`. Other JPEGs (EXIF-rotated, progressive, CMYK,
  wide-gamut ICC) are oriented, converted to sRGB and re-encoded as baseline JPEG q95 4:4:4 (PNG
  would multiply the size of photos); all other formats are embedded losslessly as PNG with alpha.

PDF → TXT (`convert/pdf-to-text.ts`, `pdf/text.ts`)
- Text runs in content-stream order (= reading order for nearly all PDFs), grouped into lines by
  baseline and PDF.js EOL markers; a blank line between paragraphs (gap > 1.8 × font size or a jump
  back up = new column). No table/column reconstruction.
- `pageSeparator`: `marker` → `--- Page N ---` line before each page; `formfeed` → `\f` between
  pages; `blank` → empty line. UTF-8 without BOM, LF.
- No text on any page (scanned) → `PDF_NO_TEXT`, nothing written. Some empty pages →
  `PDF_PAGES_WITHOUT_TEXT {pages: "2,5", count}`.
- Fonts that are not embedded use PDF.js' bundled CMaps (e.g. `UniKS-UCS2-H`, verified).

PDF → DOCX / image → DOCX (`convert/to-docx.ts`)
- PDF: the extracted text as re-flowable paragraphs (lines merge only when the previous line fills
  ≥ 60 % of the page's text column, the gap is a normal line gap, size and left edge match; CJK lines
  join without a space), one page break per PDF page (empty pages kept), A4 with 1-inch margins,
  always `DOCX_TEXT_ONLY`. No text → `PDF_NO_TEXT`.
- Image: the picture (JPEG byte-for-byte when possible, else PNG) at its physical size, scaled down
  to the A4 text area. No OCR. (No warning code exists to say so — see requests.)

## PDF.js inside Electron (desktop-main / packaging notes)

- PDF.js decides "Node or browser" with `!(process.versions.electron && process.type &&
  process.type !== 'browser')`, which is **false in a utilityProcess** (`process.type ===
  'utility'`). `pdf/engine.ts` therefore never relies on PDF.js' Node detection: it installs
  `DOMMatrix`/`Path2D`/`ImageData` from @napi-rs/canvas, loads `legacy/build/pdf.worker.mjs` itself
  and exposes it as `globalThis.pdfjsWorker` (parser runs in-process — the host already is a worker
  process), and passes its own `CanvasFactory`, `FilterFactory` (no-op, like PDF.js' Node one) and
  `BinaryDataFactory` (reads `cmaps/`, `standard_fonts/`, `wasm/` from the installed package),
  with `useWorkerFetch: false`, `disableFontFace: true`, `isEvalSupported: false`,
  `isOffscreenCanvasSupported: false`, `isImageDecoderSupported: false`, `useSystemFonts: false`.
- Bundling (electron-vite 6 / rolldown, CJS, dependencies external): nothing special needed.
  rolldown rewrites `import.meta.url` to `require("url").pathToFileURL(__filename).href`; the
  computed `import(fileURL)` of the two ESM files is kept as a native dynamic import; CJS deps
  (sharp, @napi-rs/canvas, pdf-lib, docx) become `require()`. Keep pdfjs-dist external.
- asar: **pdfjs-dist does not need asarUnpack** — verified by running the bundle from an
  `app.asar` that contains pdfjs-dist (ESM import + reads of CMaps/fonts/wasm from the archive in a
  utilityProcess). Native modules need their binaries unpacked: verified with
  `unpack: '**/*.{node,dylib,so,dll}'` and sharp, `@img/*`, `@napi-rs/*` inside the archive.
  pdfjs-dist files needed at runtime: `package.json`, `legacy/build/pdf.mjs`,
  `legacy/build/pdf.worker.mjs`, `cmaps/`, `standard_fonts/`, `wasm/`, `iccs/`; `build/`, `web/`,
  `image_decoders/`, `types/` and `*.map` can be excluded.
- The engine prefers `app.asar.unpacked/node_modules/pdfjs-dist` when it exists, and
  `ORBITDROP_PDFJS_DIR` overrides the folder.
- A utilityProcess forked with `stdio: 'pipe'` keeps its stdout/stderr pipes open and never exits
  on its own — the host must call `process.exit` on shutdown (the smoke entry does).

## Fixed: `convert.pdf` "SOI not found in JPEG" (reported by desktop-renderer)

Root cause, measured in a real Electron 44 utilityProcess: `Buffer.poolSize` is 64 KiB there
(8 KiB in Node), so Buffers under 32 KiB created by `Buffer.concat`/`allocUnsafe` — such as a JPEG
whose EXIF/XMP/COM segments were stripped for the PDF — are views into a shared slab with
`byteOffset ≠ 0`. pdf-lib parses JPEGs with `new DataView(bytes.buffer)`, ignoring `byteOffset`,
and read another Buffer's bytes. Reproduced in the utilityProcess (1600×1200 JPEG with EXIF fails,
plain ones pass) and fixed: pdf-lib and docx now always get an exact copy (`exactBytes`).
Regression coverage:
- `convert-images-pdf.test.ts`: with a 64 KiB Buffer pool, merges 1600×1200 + 1200×900 sharp
  JPEGs, a progressive, a CMYK, an EXIF-rotated and an EXIF-tagged JPEG; re-reads the PDF (6 pages,
  page sizes), extracts every image XObject (DCTDecode) and decodes it with sharp (sizes, 3
  channels), checks byte-for-byte pass-through, and renders the pages back (colours, rotation).
  A second test pins the pdf-lib behaviour (`embedJpg` on an offset view throws, the copy works).
- Electron smoke (`convert-smoke-entry.ts`): the same JPEG merge runs in the real utilityProcess
  and from app.asar (asserts `Buffer.poolSize === 65536` there and the PDF's three page sizes).

## Korean font consistency (processors-edit request)

`EngineProbe.koreanFont` comes from processors-edit's `detectKoreanFont()` (first family of
core's `ANNOTATION_FONT_CANDIDATES` that really draws Hangul), so the probe and Annotate agree.

## Known limitations

- PDF rendering draws glyphs from embedded font programs (no FontFace). Non-embedded standard
  fonts use the bundled standard font data; non-embedded CJK fonts are drawn through the canvas'
  system fonts (works on macOS — verified with HYGoThic/UniKS-UCS2-H; on a system without Hangul
  fonts such text renders blank, while text extraction still works).
- ICC-based colour in PDFs: PDF.js' qcms path needs synchronous XHR, so it is off in Node;
  alternate colour spaces are used (CMYK through PDF.js' own conversion).
- JPEG 2000 is verified (openjpeg wasm loaded through our factory); JBIG2 uses the same loader but
  has no fixture (no encoder available here).
- DOCX/TXT layout is text-only by design; tables and multi-column pages are not reconstructed.

## Tests

| Command | Result |
|---|---|
| `node_modules/.bin/tsc -p packages/processors/tsconfig.json` | clean |
| `node_modules/.bin/tsc -p tests/integration/tsconfig.json` | clean |
| `node_modules/.bin/vitest run --root packages/processors` | 17 files / 187 tests pass (mine: 8 files / 104 tests) |
| `node_modules/.bin/vitest run --root tests/integration` | 4 files / 11 tests pass (mine: 2 files / 6 tests; lead's video-flow passes) |
| `node tests/integration/convert-electron-smoke.mjs [node] [utility] [asar] [asar-native]` | all modes pass (~2 s) |
| `node scripts/gen-fixtures.mjs` | 22 fixtures → `tests/fixtures/generated/` (~30 ms) |
| `node tests/fixtures/static/make-static-fixtures.mjs [pdfs] [bmp] [jpx]` | macOS only: Swift/CoreGraphics + sips |

Tests re-read real outputs: images decoded with sharp (sizes, density, pixel colours at known
spots, rotation marks), PDFs parsed with pdf-lib and rendered back through the engine, DOCX
unzipped (`word/document.xml` paragraphs, page breaks, `word/media/*` decoded), BMPs decoded by an
independent decoder (`sips`), originals' SHA-256 unchanged, no temp files left, `(2)` names.

## Requests

1. lead / contracts: a warning code such as `DOCX_IMAGE_ONLY` ("picture embedded, text not
   recognised") so the UI can make the image → DOCX distinction the spec asks for (5, P2).
2. lead / contracts: document `JobWarning.params` used here — `ALPHA_FLATTENED {background}`,
   `METADATA_REMOVED {kinds}`, `EXTENSION_MISMATCH {detected, extension}`,
   `DOWNSCALED {pages, count, dpi, requestedDpi}`, `PDF_PAGES_WITHOUT_TEXT {pages, count}`.
3. lead / `common/io.ts` (not changed): `encodeImage` uses PNG zlib level 9, ~12× slower than
   level 6 on large images for ~20 % smaller files (numbers above) — consider level 6.
4. desktop-main: processors already emit `EXTENSION_MISMATCH`; don't add it again. Keep pdfjs-dist
   external; exit the utility process explicitly on shutdown.
5. packaging-docs: unpack only native binaries; pdfjs-dist can stay in app.asar (verified); keep the
   pdfjs-dist files listed above.
6. macos-helper: relied-upon contract (verified with the built helper): JSON on the last stdout line
   of `--probe`; exit 0 on success; `--decode` writes upright pixels without an orientation tag
   (checked with an EXIF-rotated HEIC); `--quality` is 0–1 (two decimals).
7. desktop-renderer: the reported `convert.pdf` "SOI not found in JPEG" is fixed (see below).
