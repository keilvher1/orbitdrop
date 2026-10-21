# Workstream: processors-edit — status

Owner files: `packages/processors/src/tools/**`, `packages/processors/test/tools*`
(+ `test/helpers/tools-fixtures.ts`), `packages/core/src/composition-layout.ts`,
`packages/core/src/annotations-draw.ts` (+ `packages/core/test/{composition-layout,annotations-draw}.test.ts`),
`tests/integration/editors*`, this file, `docs/screenshots/processors-edit-*`.

## Status (2026-10-21)

| Item | Tier | State |
|---|---|---|
| `computeCompositionLayout` / `scaleCompositionLayout` (+ `computeCompositionLayoutDetails`, `shadowFromSlider`, `previewScaleFor`) | P0 | implemented, auto-verified |
| `drawAnnotations` (+ `arrowGeometry`, `annotationBounds`, font helpers) | P1 | implemented, auto-verified with @napi-rs/canvas |
| Crop (`tool.crop`) + preview | P0 | implemented, auto-verified |
| Add Background (`tool.addBackground`) + preview | P0 | implemented, auto-verified (incl. preview ↔ final pixel comparison) |
| Compress (`tool.compress`) + preview (`estimatedBytes`) | P1 | implemented, auto-verified |
| Metadata (`inspectImage`, `tool.metadata` strip) | P1 | implemented, auto-verified (lossless JPEG/PNG/WebP/GIF paths + re-encode) |
| Edit (`tool.edit`) + preview | P1 | implemented, auto-verified |
| Annotate (`tool.annotate`) + preview, Korean text | P1 | implemented, auto-verified (Hangul glyph pixels) |
| Redact (`tool.redact`) + preview | P1 | implemented, auto-verified |
| `source` preview + decoded-source LRU | P0 | implemented, auto-verified |

Visual record: `docs/screenshots/processors-edit-add-background.png` — real `tool.addBackground`
outputs (every preset, the recording's padding/corner/shadow proportions, 16:9 and 4:5), rendered
by the job pipeline, not the editor.

Not verified here: anything in a real Electron utilityProcess or real editor windows
(GUI). HEIC input/output depends on the ImageIO helper (processors-convert/macos-helper);
tools fall back to PNG output when HEIC/BMP encoders are unavailable.

## Commands

```
node_modules/.bin/tsc -p packages/core/tsconfig.json
node_modules/.bin/tsc -p packages/processors/tsconfig.json
node_modules/.bin/vitest run --root packages/core          # composition-layout (14), annotations-draw (6) + core's own
node_modules/.bin/vitest run --root packages/processors    # tools-*.test.ts (92): crop 8, add-background 10, compress 7,
                                                           # metadata 14, edit 7, annotate 7, redact 8, preview/runTool 9,
                                                           # matrix 13 (every tool × 13 input variants),
                                                           # colour 9 (16-bit + wide-gamut outputs decoded, resource use)
node_modules/.bin/vitest run --root tests/integration      # editors.test.ts (4) + video-flow
```

## Files

- `core/src/composition-layout.ts` — layout math (documented at the top of the file).
- `core/src/annotations-draw.ts` — one drawing routine for the browser canvas and @napi-rs/canvas.
- `processors/src/tools/index.ts` — `runTool`, `renderToolPreview`, `inspectImage` (dispatcher entry points) + `renderComposition`, `resolveAnnotationFont`, `detectKoreanFont`, `clearPreviewCaches`, `clearCompressCaches`.
- `tools/common.ts` (option parsing → INVALID_OPTIONS, loading + 8-bit normalization, format resolution, encoding with PNG fallback, naming, writing, preview encoding), `profile.ts` (sRGB overlay colours → kept ICC profile), `boxes.ts` (clustering of overlay/region boxes), `source-cache.ts` (LRU of downscaled decodes), `preview.ts` (preview dispatcher + `source`), `crop.ts`, `add-background.ts`, `backgrounds.ts` (preset SVG, CSS-angle gradients, masks), `compress.ts`, `metadata.ts`, `metadata-lossless.ts`, `exif.ts`, `icc.ts`, `edit.ts`, `annotate.ts`, `fonts.ts`, `redact.ts`.

## Design decisions

### Add Background layout (spec §7) — `composition-layout.ts`
- All values in **final output px**. Content = oriented source size; aspect kept, centred.
- `auto`: canvas = content + 2·margin. Fixed ratios (1:1, 16:9, 4:5): smallest canvas of that ratio containing content + margins (never crops); the grown axis sets `paddingExpandedByRatio` (≥ 2 px growth; 1 px is rounding).
- **Shadow** from slider S: σ = S/4, offsetY = S/4 (down), opacity 0.35; visible reach (3σ) outside the image: top ⌈S/2⌉, sides ⌈3S/4⌉, bottom S. Margins per axis = max(padding, shadow extents of that axis) → centred and never clipped; `paddingExpandedByShadow` when the shadow needed more than padding.
- **maxEdge** caps the canvas's longest edge (per-axis limits Lw/Lh derived from the ratio); padding/corners/shadow keep their px, only the content shrinks: `scale = min(1, (Lw − 2mx)/W0, (Lh − 2my)/H0)` → never upscaled.
- **Padding too large** (would push the content below min(natural size, 20 % of the canvas limit), including 2·padding ≥ maxEdge): padding and shadow are scaled by one factor so the content keeps that minimum. `computeCompositionLayoutDetails` reports `paddingReducedByMaxEdge`, `effectivePadding`, `effectiveShadow`.
- **Rounding**: content = floor(W0·scale) (exactly W0 when scale = 1); canvas from integer minimums, derived side of a ratio = round(·) (never below its minimum, exact ratio within 0.5 px); x/y = floor of half the remainder (odd pixel to right/bottom); corner radius ≤ floor(min(w, h)/2); `contentScale` from the long side.
- `scaleCompositionLayout(layout, k ≤ 1)`: canvas round(·k), content rect rounded by edges (margins + content = canvas), radius/σ/offset scaled exactly, extents ⌈·k⌉, flags unchanged.

### Add Background rendering — `add-background.ts`
- One renderer (`renderComposition`) for final and preview: background → shadow → content.
- Presets: SVG rendered by sharp/librsvg at the exact canvas size; linear layers use **CSS linear-gradient semantics** (line through the centre, direction (sin θ, −cos θ), length |W·sin θ| + |H·cos θ| — corners hit 0 %/100 %, iso-lines perpendicular in pixel space on non-square canvases); radial layers centre (cx·W, cy·H), radius r·max(W, H). `#RRGGBBAA` stops → stop-color + stop-opacity.
- Image background: assets[fileId], auto-oriented, resized with `fit: cover` (only the background is cropped).
- Content: converted to sRGB, Lanczos-3 downscale to the content rect, rounded corners via an antialiased SVG rounded-rect mask (`dest-in`).
- Shadow: rounded rect (same radius), offset, rendered as a 1-channel mask inside its box (content ± 3σ) and Gaussian-blurred with `minAmplitude: 0.01` (libvips' default 0.2 truncates the kernel at ~1.8σ and was ~10 levels off a true Gaussian; 0.01 is within ~1 level), then composited as black at `opacity`.
- Output: PNG (RGB when opaque, RGBA when the composition has transparency) or JPEG at `quality`, flattened on white (opaque). Name `"<base> With Background.png|.jpg"`.
- Preview: final layout computed from the oriented full size, `k = maxEdge / max(canvas)` (≤ 1), rendered with the same function from a downscaled decode; returns `layout` (final px) and `outputWidth/Height` = final canvas. Measured: preview ↔ downscaled final mean abs diff < 3/255.

### Previews — `preview.ts`, `source-cache.ts`
- Every kind validates options with the same schema and renders with the same code as the job. Cancellation is checked between steps (sharp operations themselves are not interruptible).
- Decoded sources (oriented, sRGB, RGBA, fitted to the request's maxEdge) are cached per path + size + mtime + edge (LRU 8 entries / 160 MB); a larger cached decode is shrunk instead of decoding the file again; concurrent requests share one in-flight decode, which is cached even when its requester was cancelled (the newer request needs it).
- Measured preview ↔ downscaled final mean |Δ| (2400×1600 source, previews 480/960 px): Add BG 0.66–0.77, Edit 0.47–0.88, Annotate 0.79–0.90, Redact 0.58–0.68 (of 255). Tests assert < 3–4.
- `source`: JPEG q90, PNG when transparent; `sourceWidth/Height` = oriented full size.
- Result fields per kind: crop → region preview, `output*` = rect; addBackground → canvas preview + `layout`; edit → edited preview, `output*` = rotated full size; compress → image decoded from the real full-size encode (PNG, no extra artefacts), `output*` = encoded size, `estimatedBytes` = its byte length (encode cached per options; a new maxEdge reuses it); annotate/redact → full image with overlays, `output*` = source size.
- Compress previews: full-resolution encodes run one at a time per worker; a request superseded while queued never starts its encode, and a queued request whose options were encoded meanwhile is served from the cache (slider drags cannot pile up full-size encodes). Decoding the encoded result uses the input pixel limit (what jobs accept), not the output limit.
- Crop preview: reuses the cached downscaled decode when the region needs at most a 2×maxEdge decode; otherwise (small rect on a big photo) only the region is decoded from the file — no full-resolution copy in the cache.
- Measured (6000×4000 JPEG, M-series Mac): first `source` decode 41 ms, cached 6 ms; addBackground previews 27–42 ms; edit/annotate/redact previews ~10 ms (the first annotate in a worker also loads the canvas module and checks the Hangul font: ~0.25 s once); compress preview 0.45 s first (full-res encode), cached 0 ms; crop preview of a small region 18 ms. Jobs: crop 0.7 s, addBackground (2400) 0.3 s, edit 1.9 s, annotate 1.6 s, redact 1.4 s, compress 0.4 s, lossless strip 37 ms; extreme addBackground (8000 px, shadow 400) 2.3 s.

### Output formats and names — `common.ts`
- `outputFormat: 'input'`: JPEG/PNG/WebP kept; AVIF/TIFF kept when sharp encodes them; BMP/HEIC kept when their codecs are available, else PNG; GIF → PNG (tools work on the first frame).
- Name = `toolResultName(displayName, ACTIONS[id].outputSuffix, ext)`; when the format is unchanged the input's own extension spelling is kept (`IMG.JPEG` → `IMG Cropped.JPEG`), otherwise the canonical one.
- Colour: crop/edit/annotate/redact keep an RGB ICC profile (P3/Adobe RGB stay exact, no gamut clipping); drawn colours (annotation strokes/text, solid redaction boxes) are converted from sRGB into that profile so they display as requested and as in the preview (profile.ts; the embedded profile is written to a private temp folder for sharp and removed). CMYK/grey profiles are converted to sRGB. Add Background and Compress (without keepMetadata) convert to sRGB. EXIF/XMP/IPTC are never copied by tools (orientation is applied to pixels first). Output is 8-bit.
- Loading (`loadImage`): `open()` builds a fresh pipeline from one shared buffer (never `Sharp.clone()`, which deep-copies the input on every call). BMP is decoded once by the builtin codec. HEIC and every input that is not 8 bits per channel (16-bit PNG/TIFF, high-bit-depth AVIF, float TIFF) are normalized once into an 8-bit lossless PNG intermediate: depth only, no geometry, RGB profile kept, CMYK converted, EXIF/XMP carried (so Compress' keepMetadata still works); `open()` applies the EXIF orientation on that 8-bit data. Reason (all reproduced with sharp 0.35.5): RGB16 with a profile is processed in Display P3 and written back without conversion (wrong colours, no profile); recomb casts to 8-bit before linear (16-bit Edit offsets turned images black/white); rotating 16-bit data (incl. auto-orientation) drops a kept profile.
- JPEG targets flatten alpha (`flattenBackground` for crop, white elsewhere); `ALPHA_FLATTENED` only when the image really had transparent pixels.

### Crop
- Rect in oriented px, validated inside the oriented bounds (else `INVALID_OPTIONS`), output = rect exactly; `aspect` is an editor constraint only.

### Compress
- `'input'`: JPEG/PNG/WebP/AVIF keep (AVIF → WebP if unencodable), HEIC → JPEG, TIFF/BMP/GIF → PNG. JPEG mozjpeg (4:2:0 below q90), WebP effort 6, PNG palette = libimagequant ≤ 256 colours at `quality`, PNG lossless = zlib 9. `maxEdge` downscales only. `keepMetadata` keeps EXIF/XMP/ICC (Orientation reset to 1).
- Result not smaller than the input → still written, warning `OUTPUT_LARGER_THAN_INPUT {inputBytes, outputBytes}`.

### Metadata
- `inspectImage`: sharp metadata + exif-reader → `ImageInfo`/`ExifSummary` (make, model, lens, software, date as wall-clock `YYYY-MM-DD HH:MM:SS`, exposure `1/250`, f-number, ISO, focal length, GPS decimal degrees, short `other` tags, `EmbeddedThumbnail: yes` when IFD1 holds a thumbnail), ICC description (v2 `desc` / v4 `mluc`), density, bit depth, oriented size, XMP/IPTC presence.
- Strip — **lossless** when the output format equals the input (JPEG/PNG/WebP/GIF), EXIF orientation is absent/1 and no colour conversion is needed (`keep`, no profile, or an sRGB profile): JPEG keeps SOI/SOFn/DHT/DQT/DRI/SOS+data/EOI, JFIF (thumbnail cut out), Adobe APP14, ICC (if kept); drops APP1 (EXIF+GPS+IFD1 thumbnail, XMP), MPF/FlashPix, APP3–13 (IPTC), APP15, COM and everything after EOI (MPF secondary images). PNG keeps critical + colour/transparency/physical/APNG chunks (iCCP if kept), drops tEXt/zTXt/iTXt/eXIf/tIME/others. WebP drops EXIF/XMP (+ICCP) and fixes VP8X flags/RIFF size. GIF drops comment/XMP/other application extensions. The result is verified (decodes, carries no EXIF/XMP/IPTC) or the re-encode path is used.
- **Re-encode** otherwise: orientation ≠ 1 → pixels rotated; `convertToSrgb` with a non-sRGB profile → pixels converted, profile dropped; `keep` → RGB profile attached (CMYK/grey converted); JPEG/WebP/AVIF at q95 (JPEG 4:4:4), lossless WebP stays lossless, PNG/TIFF lossless.

### Edit
- Rotation (clockwise) first, then flips mirror the rotated view. sharp 0.35 applies flip/flop before an explicit rotate regardless of call order, so screen-space flips are mapped (90/270: H↔V) — pinned by pixel tests.
- Tone = CSS filter semantics on 8-bit sRGB values, 0 = identity: brightness `×(1+b/100)` (−100 → black), contrast `(v−½)·(1+c/100)+½` (−100 → grey), saturation CSS `saturate(1+s/100)` matrix (luma 0.213/0.715/0.072; −100 → greyscale). Brightness+contrast are one `linear(a, b)`; alpha untouched.

### Annotate
- `drawAnnotations` rules: rect outline centred on the edge (miter); arrow shaft with round tail, filled head length max(4·stroke, 10), half-width ½·length (shrinks on short arrows), tip exactly at (x2, y2); text top-left anchored (`textBaseline: 'top'`), lines split on `\n`, advance 1.25·fontSize, bold flag; everything × `scale`; shapes in order.
- Final render: transparent @napi-rs/canvas tiles per cluster of nearby shapes (cluster boxes are disjoint, so marks in opposite corners of a 100 MP photo are two small tiles; ≤ 16 Mpx per tile), composited with sharp at full resolution; format kept (JPEG stays JPEG).
- Font: first of `ANNOTATION_FONT_CANDIDATES` (Apple SD Gothic Neo, AppleGothic, Malgun Gothic, Noto Sans CJK KR, Noto Sans KR, NanumGothic) that the canvas backend has **and** that draws distinct Hangul glyphs; `(await resolveAnnotationFont()).css` puts it first in the family list (`detectKoreanFont()` returns just the family).
- @napi-rs/canvas is imported lazily (`loadCanvas()`): a missing/broken canvas binary only makes Annotate fail with `ENGINE_UNAVAILABLE`; the other tools never load it.

### Redact
- `solid`: opaque box in the exact colour. `mosaic`: blockSize cells aligned to the region's top-left (partial cells at the edges), each the alpha-weighted mean of its pixels. **Mosaic is not a guaranteed removal of information** — use solid for anything that must not be recoverable (UI should say so).
- Regions partly outside are clipped; fully outside → `INVALID_OPTIONS`. On transparent images the region is cleared first (`dest-out`) so nothing shows through. Output re-encoded from pixels: no EXIF/GPS/thumbnail/XMP/IPTC (ICC kept for RGB).

### Redact resource use
- Solid boxes are sharp `create` inputs (no W×H×4 buffers); mosaic pixels are decoded per cluster of nearby mosaic regions, not for the union of all regions.

### Review log
- 2026-10-21: independent code review (in progress when this was written) flagged the JFIF APP0
  thumbnail cutter: it read the thumbnail size at offsets 18/19 instead of 16/17 and cut the
  segment at 20 bytes, which corrupted APP0 when a JFIF thumbnail was present (verification then
  forced the re-encode path). Fixed (`jfifWithoutThumbnail`, 18-byte segment, malformed APP0
  dropped) and covered by a test with a real 2×2 JFIF thumbnail (lossless path proven by identical
  scan data).
- Review verdict (REQUEST CHANGES), all reproduced and fixed with regression tests in
  `test/tools-colour.test.ts`: (1) 16-bit Edit tone → black/white; (2) 16-bit profiled input written as
  P3 numbers without a profile on every sRGB path (Compress, Add BG, Metadata convertToSrgb, previews);
  (3) Edit rotate/flipV on 16-bit dropped the kept profile (also EXIF auto-orientation) — all three via the
  8-bit normalization above; (4) overlay colours on wide-gamut images → converted into the profile;
  (5) `open()` deep copies → factory; (6) overlays/mosaic decodes sized from the union of all shapes →
  clusters, solid patches via `create`; (7) Compress preview queueing + pixel-limit mismatch; (8) crop
  preview full-resolution decode for small rects → region decode; (9) shadow blur ran on 4 channels →
  1-channel buffer (2.3 s instead of 4.5–5.2 s for the 8000 px / shadow 400 case).

## Notes for the renderer / main

- Crop editor: map preview px → oriented source px with `sourceWidth / preview.width`; send integer rects inside `[0, sourceWidth] × [0, sourceHeight]`.
- Add BG editor: show `outputWidth × outputHeight`; explain `layout.paddingExpandedByRatio` ("비율 맞춤으로 여백이 늘어남") and `layout.paddingExpandedByShadow`; for "padding reduced to fit maxEdge" call `computeCompositionLayoutDetails(sourceWidth, sourceHeight, spec)` from `@orbitdrop/core` (browser-safe) → `paddingReducedByMaxEdge`, `effectivePadding`. `layout.cornerRadius` is the clamped radius. The preview image is the composition at `k = preview.width / layout.canvas.width`.
- Annotate editor: draw live with `drawAnnotations(ctx, shapes, { scale: canvasPx / sourcePx, fontFamily: annotationFontFamilyCss(probe.koreanFont) })` — same routine as the export; the `tool.annotate` preview is authoritative.
- Edit editor: instant approximation with CSS `transform` + `filter: brightness(1+b/100) contrast(1+c/100) saturate(1+s/100)`; the `tool.edit` preview is authoritative.
- Compress editor: input bytes vs `estimatedBytes` vs final `outputs[0].bytes`; never show success when the job has `OUTPUT_LARGER_THAN_INPUT`.
- Redact editor: show the mosaic caveat.
- Background image: main registers the picked file and passes it in `job.assets` / `request.assets` keyed by `background.fileId`.

## Requests (not done — outside this workstream)

1. contracts (optional): `CompositionLayout.paddingReducedByMaxEdge` / `effectivePadding` so the renderer does not need to recompute (available today via `computeCompositionLayoutDetails`).
2. contracts (optional): a way to report the metadata strip method (e.g. `ProcessorOutput.note?: 'lossless' | 'reencoded'` or a `REENCODED` warning code); `PreviewResult.outputFormat?: FileFormat` so editors can show what `'input'` resolves to (Compress: HEIC → JPEG, GIF/TIFF/BMP → PNG).
3. processors-convert: `probe.ts` has its own Korean font list; please use `ANNOTATION_FONT_CANDIDATES` from `@orbitdrop/core` (or `detectKoreanFont()` from `src/tools`) so `EngineProbe.koreanFont` and the annotate renderer always agree.
4. lead (`src/index.ts`): if main needs them, re-export `detectKoreanFont`, `resolveAnnotationFont`, `clearPreviewCaches` (free memory when an editor closes) from the package root.
5. packaging: Add Background relies on librsvg inside sharp's prebuilt libvips (gradients, masks) and annotate on @napi-rs/canvas system fonts — keep both in the packaged app.
