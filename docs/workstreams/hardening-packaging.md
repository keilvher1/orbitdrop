# hardening-packaging — status

Second, adversarial pass over packaging, bundle contents, licences, CI and build docs, after the
packaging-docs workstream. Owner files: `apps/desktop/electron-builder.yml`, `apps/desktop/build/**`,
`scripts/package.mjs`, `scripts/after-pack.cjs`, licence scripts (`scripts/licenses*.mjs`),
`THIRD_PARTY_LICENSES.md`, `docs/licenses/**`, `docs/packaging.md`, `docs/development.md`, `README.md`,
`.github/workflows/{ci,release}.yml`, this file. Done 2026-10-22/23 on the dev Mac (macOS 26.6 25G72 arm64,
Node 24.7.0, pnpm 11.27.1, electron-builder 26.15.3, Electron 44.9.0).

Rules followed: `scripts/package.mjs` and `electron-vite build` were **not** run (shared `apps/desktop/out`);
`apps/desktop/release/` was only read. Experiments ran on `ditto` copies of the 0.1.0 app bundles in the
scratchpad: re-assembled `app.asar` (same asarUnpack globs, integrity hash written to Info.plist, ad-hoc
re-signed with `build/entitlements.mac.adhoc.plist`), flipped fuses, edited Info.plist, then ran the copy's
`--smoke-test`, the native-module check and a DevTools probe of a real window. electron-builder's own
node-module collector and file matcher were run in isolation against an APFS clone of the repo.

## Defects found and fixed

| # | Severity | Defect (evidence) | Fix |
|---|---|---|---|
| 1 | **P0** | **Every window of the installed 0.1.0 app is blank.** `electronFuses.grantFileProtocolExtraPrivileges: false`, but the windows load the UI with `loadFile()` from `file://` inside `app.asar`. With the fuse off Electron's `file://` handler does not read asar: opening the Drop Zone in a copy of the shipped arm64 app logs `Failed to load URL: file:///…/app.asar/out/renderer/index.html with error: ERR_FILE_NOT_FOUND` and the page is `chrome-error://chromewebdata/` (no React root, 0 CSS rules). Stock Electron with only this fuse flipped: inside asar → `ERR_FILE_NOT_FOUND`; outside asar → module script and CSS blocked by CORS. The packaged smoke test never opens a window, E2E/electron-verify run the unpackaged app (fuse on), so nothing caught it. | `electron-builder.yml`: fuse **enabled** with the reason. `package.mjs` reads the fuses back from every package (`@electron/fuses`), fails on any difference from the yml, and fails if this fuse is off while the main bundle uses `loadFile(`. Verified on a copy with the fuse on: the Drop Zone renders (root 1 child, 414 CSS rules, text "Drop Zone / 파일을 여기에 놓으세요 / 이미지 또는 PDF / 파일 열기…"), smoke test ok. |
| 2 | P1 | **Wrong dependency versions in `app.asar`.** electron-builder 26.15.3's pnpm collector + pnpm 11 `nodeLinker: hoisted`: `pnpm list --json` reports non-existent `.pnpm/<name>@<ver>/…` paths, the collector's "accept a version outside the declared range" fallback copies the root-hoisted copy (logged at debug level only). Shipped: `pdf-lib 1.17.1` → `tslib 2.8.1` (needs `^1.11.1`), `docx 9.12.0` → `nanoid 3.3.20` (needs `^6.0.1`); also `@types/node`/`undici-types` (pruned anyway). Works today only by luck (tslib 2 keeps the 9 helpers pdf-lib uses; docx inlines nanoid). Reproduced with the collector itself: 40 modules, 4 version mismatches. | `apps/desktop/build/before-pack.cjs` (`beforePack`): the collector first looks up the exact name@version pnpm reported in the real hoisted tree (`<dir>/node_modules/<name>`, then nested `…/node_modules/<pkg>/node_modules/<name>`), only for app-builder-lib 26.15.3 (otherwise warns). Collector re-run: 40 modules, **0 mismatches**, the "outside the declared range" log is gone. `scripts/after-pack.cjs` now checks the packaged dependency tree Node-style (every dependency of the app and of each packaged package must resolve inside the package to a version satisfying its range; type-only packages and absent optional deps skipped): the shipped asar → 2 problems (the two above), a re-assembled asar with the fix → 35 packages, 42 resolved dependencies, 0 problems. |
| 3 | P1 | **THIRD_PARTY_LICENSES.md missed shipped code and texts.** (a) 45 npm packages compiled into `docx/dist/index.{cjs,mjs}` (buffer, ieee754 [BSD-3-Clause], events, util, stream-browserify + readable-stream 3.6.2, sax 1.2.4 [ISC], ljharb helpers, …) and core-js 3.50.0 compiled into pdf.js's legacy build were not listed; (b) libvips' 28 bundled libraries were listed by name only — the npm packages ship no texts, but BSD/MIT/IJG/libpng/FTL/zlib require the notice (libimagequant's BSD-2-Clause text included); (c) librsvg is Rust and statically links 161 crates nobody listed; (d) Skia, the 12 C/C++ libraries and 93 crates in @napi-rs/canvas had names only; (e) FFmpeg (`libffmpeg.dylib`/`ffmpeg.dll`, LGPL) inside Electron was not mentioned; (f) Liberation's source pointer named the 2.x project for the 1.07.4 fonts. | `scripts/licenses-sources.mjs` + `scripts/licenses-fetch.mjs` build a committed snapshot `docs/licenses/upstream/` (343 components, 554 texts, source URL + SHA-256 each, LF line endings so git normalization keeps the hashes): libvips libraries at the versions.json tags, libnsgif (vendored), Skia, canvas C libs at the commits the SBOM names, canvas crates, librsvg crates (`--librsvg-crates`: `cargo tree -p librsvg-c -e normal --locked` for aarch64/x86_64-apple-darwin and x86_64-pc-windows-gnullvm → `docs/licenses/librsvg-crates.json`), Rust std, compiled-in npm packages (versions from docx 9.12.0's own package-lock.json and the core-js banner). `scripts/licenses.mjs` (still offline) finds compiled-in packages by module markers in the files electron-builder ships, renders all texts (identical texts once, 376 back-references), verifies the snapshot (missing/modified/outdated → fails `--check`), adds the FFmpeg, cairo-MPL, libnsgif, librsvg and core-js notes, fixes the Liberation pointer (pdf.js `v6.4.299/external/standard_fonts`, byte-identical). 170,507 → 878,675 bytes. |
| 4 | P2 | **release.yml never prepared the notarization API key.** `if: env.APPLE_API_KEY_P8 != ''` read a variable defined only in that step's own `env:`, which a step's `if:` cannot see → the step was always skipped. All signing/notarization secrets were job-level (visible to `pnpm install` lifecycle scripts, tests, build scripts). | Presence check moved into the shell (`[ -z "$APPLE_API_KEY_P8" ] && exit 0`), key written with `umask 077`; secrets passed only to the packaging step / key step. |
| 5 | P2 | **CI actions on the deprecated Node 20 runtime** (`checkout@v4`, `setup-node@v4`, `cache@v4`, `upload-artifact@v4`, `pnpm/action-setup@v4` all `using: node20`; Node 20 is EOL; action-setup v4 predates pnpm 11). | ci.yml/release.yml → `checkout@v7`, `setup-node@v7`, `cache@v6`, `upload-artifact@v7`, `pnpm/action-setup@v6` (all `node24`; every input used checked against each action.yml). actionlint 1.7.12 + shellcheck 0.11.0: 0 findings. Not run on GitHub (no remote). |
| 6 | P2 | **Unneeded privacy usage descriptions in Info.plist**: Electron's template `NSCamera`, `NSMicrophone`, `NSBluetoothAlways`, `NSBluetoothPeripheral`, `NSAudioCapture…UsageDescription` ("This app needs access to the camera" …), although every permission request is denied and the hardened runtime has no device entitlements. | `mac.extendInfo` sets them to `null` (electron-builder 26 deletes null keys; merge replayed with its own `deepAssign`: 0 left). `package.mjs` fails if any `*UsageDescription` key remains. Copy with the keys deleted: smoke ok, window renders. |
| 7 | P2 | **Windows uninstall left a startup entry**: with "launch at login" on, Electron writes `HKCU\…\CurrentVersion\Run` (value = AppUserModelID); the NSIS uninstaller did not remove it (Windows keeps a startup item pointing at a deleted exe). | `build/installer.nsh` `customUnInstall`: deletes the `Run` and `Explorer\StartupApproved\Run` values named `${APP_ID}`, except when a newer installer runs the uninstaller with `--updated`. Compiles with makensis 3.0.4.1 `-WX` (LogicLib + FileFunc in an uninstall section). Not executed (no Windows). |
| 8 | P3 | **10 MB of unused files in `app.asar`**: browser/ESM duplicates (docx's other entry points, `pdf-lib/es`, `@pdf-lib/*/{dist,es}`, `pako`/`jszip`/`xml-js` `dist`), CLIs, `xml-js/types/xml-js-tests.ts`, eslint/editorconfig/tsconfig files. | `files` exclusions (each target checked: nothing in the remaining code references them). electron-builder's own FileMatcher over the collector's modules predicted exactly the 1,131 shipped node_modules files for the old yml (0 differences) and 911 for the new one; re-assembled copy: `app.asar` 24,893,171 → 14,878,510 bytes, 1,294 → 1,041 entries; smoke ok, packaged pdf-lib and docx work. |
| 9 | P3 | Windows-only tray icons (`tray.ico`, `tray.png`, `tray@2x.png`) shipped on macOS and the template PNGs on Windows. | Per-OS `extraResources` filters with exactly the files `tray/controller.ts` loads (after-pack still checks them). |
| 10 | P3 | Product id hard-coded in two places (`electron-builder.yml` appId, `src/main/index.ts` AUMID) with nothing keeping them equal; consequences of changing it undocumented. | `package.mjs` fails when the AUMID literal in the built main bundle differs from appId, and when `CFBundleIdentifier` differs; yml comment + packaging.md "제품 ID" (three places incl. the helper id, NSIS GUID and TCC consequences). |
| 11 | P3 | The packaged native-module check never exercised pdf-lib or docx (the smoke test covers PNG→JPEG and PDF→PNG only), so a wrong-version or trimmed dependency there would ship unnoticed. | `build/native-check/check.mjs`: pdf-lib embeds a PNG and re-reads the PDF; docx packs a Korean paragraph (ZIP magic). Ran with stock Electron 44.9.0 utilityProcess against the shipped and the fixed copy: both ok. |
| 12 | doc | README had no install/uninstall procedure; development.md listed env switches packaged builds now ignore (hardening-desktop request); packaging.md lacked the NSIS removal details, the C++ runtime evidence, the LGPL/MPL decision, the snapshot workflow; after-pack comment said `-nohelper` (label is `-incomplete`). | README "설치와 제거" (both OSes, unsigned local build stated, no Gatekeeper/SmartScreen bypass); development.md env table with a "packaged app" column; packaging.md updated throughout. |

## Checks

| Area | Case | Result | Evidence / fix |
|---|---|---|---|
| macOS bundle | `CFBundleIdentifier` | OK (placeholder kept) | `app.orbitdrop.desktop`; Electron helpers `app.orbitdrop.desktop.helper{,.Renderer,.GPU,.Plugin}`; one-place change documented, consistency enforced (#10) |
| | `LSMinimumSystemVersion` vs docs | OK | 14.0 in Info.plist (x2), ADR-10, README, packaging.md; helper `minos 14.0` (`vtool -show-build`), Swift `.macOS(.v14)`; Electron 44's own minimum 13.0 |
| | Dock / `LSUIElement` | OK | `LSUIElement=true` + `app.dock.hide()`; Edit/Window menu set for ⌘C/⌘V (and ⌘W by hardening-desktop) |
| | `NSHumanReadableCopyright`, `LSApplicationCategoryType` | OK | "Copyright © 2026 OrbitDrop contributors", `public.app-category.utilities`; now recorded in build reports |
| | Usage descriptions | Fixed (#6) | |
| | `NSAppTransportSecurity` (`NSAllowsArbitraryLoads`) | Accepted | electron-builder always adds it (electron-updater); affects only Apple URL-loading APIs, not Chromium; no network use. Documented |
| | Helper bundle (`Resources/helper/OrbitDropHelper`) | OK | thin arm64 / x86_64, embedded Info.plist (`com.orbitdrop.helper`, LSUIElement, minos 14.0), links only system frameworks + `/usr/lib/swift` (`otool -L`), signed `adhoc,runtime`, entitlements `<dict/>` |
| | `codesign --verify --deep --strict --verbose=2` | OK | arm64 and x64 copies: valid, satisfies DR; ZIP extracted with `ditto`: valid; app inside the DMG: valid |
| | Entitlements | OK | ad-hoc: app + Electron helpers + crashpad/app_shim `allow-jit` + `disable-library-validation`; Developer ID files: `allow-jit` only (matches osx-sign's renderer/GPU defaults); helper none; all nested code `flags=…runtime` |
| | Electron helper `CFBundleName` "Electron Helper …" | Accepted | electron-builder renames executable/display name only; not visible |
| Contents | Dev files in asar (src/test/e2e/maps/tools) | OK + #8 | none except `xml-js/types/xml-js-tests.ts` and tool configs (trimmed); E2E test hooks are compiled into `out/main/index.js` but inert in packaged builds (`ORBITDROP_E2E` ignored) |
| | Native binaries per arch | OK | `lipo -archs`: main, helper, sharp `.node`, `libvips-cpp.8.18.7.dylib`, `skia.darwin-*.node` = target arch only; `files` excludes foreign packages; after-pack prunes/fails otherwise |
| | Dependency versions | Fixed (#2) | |
| | Size breakdown (arm64, KiB) | measured | Electron Framework 244,200 (binary 197,792); app.asar.unpacked 45,880 (canvas 27,268, libvips 17,732); app.asar 24,312; LICENSES.chromium.html 19,648; helper 812. `electronLanguages` already ko/en (only `en.lproj`, `ko.lproj`), pdf.js modern build/viewer/QuickJS and sourcemaps already excluded |
| | Trims | Fixed (#8) | Squirrel/Mantle/ReactiveObjC frameworks (904 KiB) are linked by Electron Framework (`otool -L`: `@rpath/Squirrel.framework/…`) → kept |
| | DMG | OK | UDIF zlib (UDZO), HFS+, volume "OrbitDrop 0.1.0 (unsigned)", `Applications → /Applications`, background + volume icon. Measured on a copy: UDZO-9 145,517,575 B, ULFO 142,370,298 B (−2.2 %), UDBZ 133,459,478 B (−8.3 %, 3× slower) → keep UDZO (ULFO optional) |
| | ZIP | OK | 176 entries, 14 framework symlinks stored as symlinks, no `__MACOSX`; extracted copy verifies |
| Fuses | Packaged state | Fixed (#1) | read with `@electron/fuses`: RunAsNode, NODE_OPTIONS, CLI inspect off; cookie encryption, embedded asar integrity, OnlyLoadAppFromAsar on; GrantFileProtocolExtraPrivileges was off → on; wire index 8 (WasmTrapHandlers, unknown to fuses 1.8.0) default on |
| | Nothing else broken | OK | RunAsNode off: app uses `utilityProcess` (no `ELECTRON_RUN_AS_NODE`/fork); OnlyLoadAppFromAsar/integrity: smoke + window ok on re-signed copies; `--remote-debugging-port` is a Chromium switch no fuse controls (localhost only; used once on a scratch copy for the probe) |
| Windows | Per-user, no elevation | OK | `oneClick:false`, `perMachine:false`, `allowElevation:false`, `packElevateHelper:false`, `RequestExecutionLevel user`, `requestedExecutionLevel: asInvoker`; `customInstallMode` forces current-user — makensis confirms `!ifmacrodef customInstallmode` matches `!macro customInstallMode` (macro names are case-insensitive) |
| | Install path choice | OK | directory page; electron-builder appends `\OrbitDrop` when the chosen path lacks it |
| | Uninstall entry / what it removes | OK + #7 | HKCU entry (GUID from appId); removes the install folder recursively (documented: dedicated folder), shortcuts, AUMID; keeps `%APPDATA%\OrbitDrop` (`--delete-app-data` documented) |
| | Start menu shortcut | OK | `createStartMenuShortcut: true`, `shortcutName: OrbitDrop`; desktop shortcut too |
| | Helper exe in resources | OK (config) | `win.extraResources` `helper/OrbitDropHelper.exe` (+ app-local DLLs), after-pack requires x64 PE |
| | C++ runtime policy | OK | helper `/MT` (preset `msvc-x64`); npm `@img/sharp-win32-x64@0.35.5` and `@napi-rs/canvas-win32-x64-msvc@1.0.11` (tarball SHA-512 = lockfile) and Electron 44.9.0 `electron.exe`: no `vcruntime*/msvcp*` imports (after-pack's PE parser), UCRT only |
| | Unsigned → SmartScreen | OK | documented honestly (warning expected, no advice to disable) in packaging.md and README |
| Licences | Production npm packages vs lockfile | OK after #2 | 35 packages in the asar; list now matches lockfile resolution (nanoid 6.0.2, tslib 1.14.1 ship after re-package) |
| | sharp-libvips libraries incl. LGPL libvips, libimagequant | Fixed (#3) | 28 libs + libnsgif, texts at exact tags; Windows `versions.json` = darwin's (compared) |
| | @napi-rs/canvas + Skia | Fixed (#3) | 105 SBOM components + Skia; Windows SBOM = darwin's (compared) |
| | pdf.js fonts / cmaps / wasm / iccs | OK + #3f | Foxit (BSD-3 style), **Liberation Sans 1.07.4 = GPL-2.0 + font exception, not OFL** (name table + `LICENSE_LIBERATION`), Adobe cmaps BSD-3, ICC CC0, wasm licence files present |
| | Electron + Chromium | OK + #3e | `LICENSE.electron.txt`, `LICENSES.chromium.html` (20,115,518 bytes, 779 entries incl. "ffmpeg") in `Contents/Resources` (macOS) / next to the exe (Windows) |
| | Helpers' dependencies | OK | none (system frameworks / Windows system libs + static CRT) |
| | LGPL obligations | **Decision for the user** | see below |
| CI | actionlint (ci, release, native-windows) | OK | 0 findings (shellcheck on) |
| | macOS job end to end | OK (static) | pnpm from `packageManager`, Node 24, `pnpm install --frozen-lockfile` (electron postinstall allowed), checks, typecheck, Vitest, `swift test` (tools 6.0), helper arm64+x64 (the x64 stdio smoke and the x64 package smoke are skipped, not failed, when the runner has no Rosetta 2), bundles, E2E, unsigned packages + smoke + native check, upload |
| | Windows job end to end | OK (static) | `shell: bash`, same steps; helper via CMake preset `msvc-x64` (no fixed generator); NSIS install test; the new checks are platform-neutral (fuse read on the exe, AUMID, dependency tree, Windows paths in the collector patch) |
| | Secrets / signing | Fixed (#4) | unsigned unless secrets exist; empty secrets treated as absent by package.mjs |
| Docs | Commands cross-platform | OK | package.json scripts use only `&&` (works in cmd.exe and sh), no env assignments or POSIX tools |
| | Install / uninstall both OSes, unsigned stated | Fixed (#12) | |

## Commands and results (exact)

- Shipped asar dependency check: `node dep-check.cjs scripts/after-pack.cjs <copy>/app.asar` → `packages 35, edges 42`, problems: `docx@9.12.0 depends on nanoid@^6.0.1 but resolves to nanoid@3.3.20`, `pdf-lib@1.17.1 depends on tslib@^1.11.1 but resolves to tslib@2.8.1` (arm64 and x64). Fixed copy → 0.
- Whole after-pack hook (`afterPack(context)` on the copies): fixed copy → `app.asar 14.2 MB, 1041 entries`, `dependency tree: 35 packages, 42 resolved dependencies, 0 problems`, natives/helper/tray/licences ok, `ok (darwin-arm64)`; shipped 0.1.0 copy → fails with the two dependency problems. The required-entry list now also names `pdf-lib/cjs/index.js` and `docx/dist/index.cjs` (what `require()` loads after the trims).
- Collector (`getCollectorByPackageManager('pnpm', apps/desktop).getNodeModules`): baseline 40 modules / 4 mismatches; with `before-pack.cjs` 40 / 0.
- File selection (app-builder-lib FileMatcher + NodeModuleCopyHelper rules): old yml 1,131 files = shipped asar (0 diff); new yml 911 files (arm64 and x64, only target natives).
- Re-assembled arm64 copy (fix + trims + fuse + plist): `--smoke-test` exit 0, `ok:true` ×5; native check ok (librsvg 2.63.2, Apple SD Gothic Neo 739 px, pdf-lib 1 page 939 B, docx 9,559 B); DevTools probe of the Drop Zone: rendered (see #1). Shipped copy: `chrome-error://chromewebdata/`.
- `node scripts/licenses-fetch.mjs` → 343 components, 554 files, 0 failures; `--librsvg-crates` → 161 crates (= manual `cargo tree` union); `git hash-object --path` vs `--no-filters` over the 556 snapshot files: 0 change under `.gitattributes`.
- `node scripts/licenses.mjs` → 857 KiB, deterministic (same SHA-256 twice); `--check` exit 0.
- `node validate-eb.cjs` (app-builder-lib `validateConfiguration` + extendInfo merge): schema valid, usage descriptions left: [].
- makensis 3.0.4.1: macro case test → `MACRO_FOUND_CASE_INSENSITIVE`; `installer.nsh` in an uninstaller section with `-WX` → exit 0.
- `actionlint` 1.7.12: exit 0 for all three workflows.

Harness scripts (scratchpad, not committed): `collector-probe.cjs`, `files-sim.cjs`, `rebuild-app.sh`, `dep-check.cjs`, `dep-smoke.cjs`, `fuse-check.mjs`, `cdp-probe.mjs`, `validate-eb.cjs`, `pe-imports.cjs`.

## Needs a re-package (lead)

`node scripts/package.mjs mac --arch all` (then CI for Windows). Expected, observable:

1. `• [before-pack] pnpm collector: exact name@version lookup in the hoisted node_modules tree enabled (app-builder-lib 26.15.3)` per arch.
2. after-pack: `dependency tree: 35 packages, 42 resolved dependencies, 0 problems`; `app.asar` ≈ 14–15 MB (was 23.7 MB), ≈ 1,041 entries (was 1,294; varies with `out/`); `node_modules/nanoid/package.json` 6.0.2, `node_modules/tslib/package.json` 1.14.1.
3. Inspection prints `fuses: … GrantFileProtocolExtraPrivileges=enabled`; build report `inspection.fuses`, `inspection.infoPlist.usageDescriptions: []`.
4. `Contents/Resources/tray/` holds only `trayTemplate.png`, `trayTemplate@2x.png`; `THIRD_PARTY_LICENSES.md` ≈ 879 KB.
5. Native-module check line `pdf-lib: 1 page, … bytes; docx: … bytes`.
6. **The installed app's windows render** (open the Drop Zone / Settings from the menu-bar icon). This is the one thing the automated pipeline still cannot see (request 1 below).
7. Windows (CI): installer/uninstaller build with the new `customUnInstall`; `resources\tray\` has `tray.ico`, `tray.png`, `tray@2x.png`.

Then update `docs/verification.md` (new hashes; record that the 0.1.0 packages had blank windows) and commit
`docs/licenses/upstream/` (554 files, ≈2.6 MB of text) and `docs/licenses/librsvg-crates.json`.

## Requests for other workstreams

1. **desktop-main / hardening-desktop**: make `--smoke-test` open one hidden window with the real renderer and fail unless it rendered (e.g. wait for `did-finish-load`, then `executeJavaScript('document.getElementById("root").childElementCount')` > 0, or a renderer "ready" IPC). It would have caught #1; packaged builds now ignore `ORBITDROP_USER_DATA_DIR`, so an external probe would have to touch the user's real profile.
2. desktop-main (longer term): serve the renderer from a privileged custom protocol (e.g. `app://`, standard + secure, strict path map into `app.asar/out/renderer`); then set `grantFileProtocolExtraPrivileges: false` again — `package.mjs` stops requiring it as soon as the main bundle no longer calls `loadFile(`.
3. desktop-main: take the AppUserModelID from one source (e.g. an electron-vite `define` read from `electron-builder.yml`); `package.mjs` enforces equality meanwhile.
4. desktop-main (their #9 `open-file`): Finder only offers "Open With" / drop-on-app-icon for apps that declare `CFBundleDocumentTypes` (electron-builder `fileAssociations`, e.g. `role: Viewer`, `rank: Alternate`). Product decision; packaging adds it on request.
5. macos-helper: align the helper id `com.orbitdrop.helper` (`native/macos/Support/Info.plist`, `scripts/build-native-mac.mjs`) with the final product id.
6. windows-helper: bump the actions in `native-windows.yml` to the Node 24 majors used in ci.yml.
7. lead (optional alternative to the before-pack workaround): pnpm `overrides` (`pdf-lib>tslib`, `docx>nanoid`) or bundling docx/pdf-lib with electron-vite would remove the conflicts at the source; the after-pack check guards either way.
8. lead: `docs/verification.md` (not mine) — add a GUI step "every window shows content in the installed app" and the hardening-desktop steps they listed.

## Decisions for the user

1. **How LGPL/MPL sources are offered** before a public release (libvips + glib/pango/fribidi/libexif/libheif/librsvg/proxy-libintl, Electron's FFmpeg; cairo MPL-1.1, MPL-2.0 crates): (a) ship the exact source bundles next to each release, (b) a written offer valid ≥ 3 years, or (c) upstream links only (current state; availability risk stays with the distributor). Details: packaging.md "LGPL·MPL 소스 제공 — 결정 필요".
2. Final product id and name (packaging.md "제품 ID") — change before the first public release.
3. OrbitDrop's own licence (README).
4. Whether OrbitDrop registers document types (Finder "Open With"; request 4).
5. Optional: DMG format ULFO (−2.2 %).

## Not verified here

- No Windows machine: installer/uninstaller behaviour (incl. the Run-value cleanup) and the Windows CI run.
- No signing credentials: Developer ID signing/notarization paths (entitlement layout reviewed only).
- The fixes were verified on re-assembled copies, not on a fresh `package.mjs` run (not allowed during this pass).
- librsvg crates assume librsvg-c default features (sharp-libvips' build may enable a slightly different set); Skia's and Rust std's texts come from their default branches (stable for years).
