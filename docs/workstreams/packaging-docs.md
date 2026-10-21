# Workstream: packaging-docs — status (2026-10-21, final)

Owner files: `apps/desktop/electron-builder.yml`, `apps/desktop/build/**`,
`apps/desktop/resources/{icons,tray}/**`, `scripts/{package,after-pack,gen-icons,licenses}.*`,
`.github/workflows/{ci,release}.yml`, `docs/**` (except architecture/PROGRESS and other
workstreams' files), `README.md`, `THIRD_PARTY_LICENSES.md`.

## Result

Real macOS packages built and verified on this Mac (macOS 26.6 arm64) with
`node scripts/package.mjs mac --arch all` (no skipped steps; helper built by
`scripts/build-native-mac.mjs`, bundles by `electron-vite build`). **Unsigned (ad-hoc)** — no signing
credentials here; file names carry `-unsigned`.

| | macOS arm64 | macOS x64 |
|---|---|---|
| DMG | `apps/desktop/release/OrbitDrop-0.1.0-mac-arm64-unsigned.dmg` 137.9 MB | `apps/desktop/release/OrbitDrop-0.1.0-mac-x64-unsigned.dmg` 146.7 MB |
| ZIP | `…-mac-arm64-unsigned.zip` 137.6 MB | `…-mac-x64-unsigned.zip` 146.4 MB |
| Installed app | 328.9 MB (asar 23.6 MB, unpacked 44.9 MB) | 342.6 MB (asar 23.6 MB, unpacked 51.7 MB) |
| Helper `Resources/helper/OrbitDropHelper` | arm64, `com.orbitdrop.helper`, hardened runtime, no entitlements | x86_64, same |
| sharp + libvips (`app.asar.unpacked`) | `sharp-darwin-arm64-0.35.5.node`, `libvips-cpp.8.18.7.dylib` (arm64) | `sharp-darwin-x64…`, `libvips…` (x86_64) |
| @napi-rs/canvas | `skia.darwin-arm64.node` (arm64) | `skia.darwin-x64.node` (x86_64) |
| `codesign --verify --deep --strict` / Gatekeeper | valid / rejected (unsigned, expected) | valid / rejected |
| `--smoke-test` (run from the mounted DMG) | ok, exit 0, `helper.ready: true`, PNG→JPEG + PDF→PNG | ok under Rosetta 2, `helper.ready: true` |
| Native-module check (librsvg 2.63.2, canvas from unpacked, Apple SD Gothic Neo Hangul) | OK | OK |

SHA-256 values, the full smoke line and all checks: `docs/verification.md` §자동 검증 증거.
Windows: config + CI written; NSIS installer compiled on macOS for config validation only
(asInvoker, per-user mode macro, ko/en, locales pruned); real Windows build/smoke/install test
pending a Windows CI run.

## Cross-workstream findings

1. pdf.js does not detect Node in an Electron utilityProcess (`process.type === "utility"`); handled
   by processors-convert, confirmed in the package (`pdfRender`, `pdfText`, PDF→PNG smoke).
2. asar works in utilityProcess (`fs`, `fs/promises`, `import()`, `require`), `fetch(file://)` does
   not. Native code needs real paths → only native packages are unpacked.
3. electron-builder 26: an exclusion-only platform-level `files` list replaces the top-level include
   list (the whole `apps/desktop` got packed; caught by the after-pack hook). All rules are top level.
4. electron-builder's macOS output deletes Electron's `LICENSE`/`LICENSES.chromium.html`; shipped via
   `mac.extraResources`.
5. Packaging while another workstream rebuilds `apps/desktop/out` produced ENOENT once;
   `package.mjs` now detects changes to `out/` during packaging and fails clearly.

## Deliverables

- Icons: `apps/desktop/build/icon.svg`, `tray-template.svg`, `tray-color.svg` → `node scripts/gen-icons.mjs`
  → `build/icon.{png,icns,ico}`, `resources/icons/icon.png`, `resources/tray/*` (own ICNS/ICO writers,
  PNG entries; verified by re-parsing and `iconutil`).
- `apps/desktop/electron-builder.yml`; `build/entitlements.mac{,.inherit,.adhoc,.helper}.plist`;
  `build/installer.nsh` (per-user NSIS); `build/sign.cjs` (helper signed with hardened runtime, no
  entitlements, secure timestamp with Developer ID); `build/after-pack.cjs` shim →
  `scripts/after-pack.cjs`; `build/native-check/` (packaged native-module check harness).
- `scripts/package.mjs`, `scripts/after-pack.cjs`, `scripts/gen-icons.mjs`, `scripts/licenses.mjs`
  (+ `docs/licenses/{LGPL-3.0,GPL-3.0}.txt`, `docs/licenses/native-components.json`).
- `.github/workflows/ci.yml` (macOS + Windows: icons/licences/`gen-golden.mjs --check`, typecheck,
  tests, Swift tests, helper build, bundles, unsigned packages + smoke + native check, Windows
  install/uninstall test), `release.yml` (manual; signs/notarizes only with secrets; never publishes).
- Docs: `README.md`, `docs/{requirements,decisions,development,support-matrix,verification,permissions,packaging}.md`,
  `THIRD_PARTY_LICENSES.md`.

## Open items / requests

- Lead: commit the files above (CI's Windows licence check needs `docs/licenses/native-components.json`).
- Lead / owner: OrbitDrop's own licence; final product id (`app.orbitdrop.desktop` is a placeholder;
  desktop-main's AUMID matches it); how LGPL sources are offered for a public release.
- macos-helper (optional): align the helper bundle id `com.orbitdrop.helper` with the app id
  (e.g. `app.orbitdrop.desktop.drag-helper`) in `native/macos/Support/Info.plist` and
  `scripts/build-native-mac.mjs` when the product id is final.
- windows-helper: `scripts/build-native-win.mjs` must stage `apps/desktop/resources/helper/win32-x64/OrbitDropHelper.exe`
  (the after-pack hook requires x64 PE, static CRT or app-local runtime DLLs).
- desktop-main (optional): an Add Background job in `--smoke-test` would exercise librsvg inside the
  packaged binary itself (today covered by the native-module check harness).
- GUI verification on real Finder/Explorer (docs/verification.md) and a first Windows CI run.

## Commands

| Purpose | Command |
|---|---|
| Package (macOS) | `node scripts/package.mjs mac --arch all` |
| Package (Windows) | `node scripts/package.mjs win --arch x64 --install-test` |
| Pipeline test without helper/smoke | add `--allow-incomplete` (artifacts labelled `-incomplete`) |
| Icons | `node scripts/gen-icons.mjs` / `--verify` |
| Licences | `node scripts/licenses.mjs` / `--check` |
