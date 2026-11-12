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

## Stage 5 — real Finder drags in a macOS 14 VM (2026-10-22, done)

The user approved a VM test. tart 2.41.1 (Cirrus Labs Developer ID,
notarized) ran `ghcr.io/cirruslabs/macos-sonoma-vanilla` = macOS 14.8.7
(23J520) headless; input went through Virtualization.framework's VNC server
(virtual HID devices inside the guest — the host's input was never touched);
results were read over SSH with a VM-only key. tart pulled at 0.5 MB/s over
one connection, so the 20.8 GB image was fetched with parallel, hash-checked
range requests and served to tart from a local registry.

Result: the whole video flow and spec §12 steps 1–9 pass with the real
Finder and the installed DMG (record + 17 screenshots in verification.md);
the support matrix marks these rows "VM GUI 검증됨" (not human/physical).
Not verified in the VM: second display/negative coordinates, screen lock
(VNC could not send Ctrl+⌘+Q), VoiceOver audio, Intel.

Found and fixed: the first output into Desktop/Documents/Downloads showed a
TCC folder-access prompt because the commit used a hard link (isolated with
five one-line AppleScript apps in the guest); macOS now reserves the name
and renames (78c83b0), verified in the VM on a never-used Downloads folder.
Open improvement: show the unsupported reason in the caption below the ring
too (the drag image can cover the centre capsule).

Follow-ups after the VM run (2026-10-23):
- macOS: the unsupported reason is repeated in the caption below the ring
  (7951bd3), verified in the Retina guest with a text drag.
- Windows: the secondary caption did not exist at all (spec §8); added with
  the macOS panel rule, hit-shape mask moved into the portable core and
  tested (57c1cf8). Host tests 99; src/win compile-checked only (checklist
  item 34 for a real PC).
- Latest macOS packages: source 7951bd3 (hashes in verification.md); later
  commits touch Windows code and docs only.
- Tools to repeat the VM run: scripts/vm/ (64c51ce). The VM `od-sonoma`
  is stopped, not deleted (~27 GB in ~/.tart) — the user decides.

Current verified state: vitest 1071 passed / 4 skipped; Playwright 39/39;
electron-verify 36/36; swift test 167 (isolation check fatal); Windows host
tests 99 + parity + MinGW -Werror; packaged smoke (with the hidden window)
OK on arm64 and x64; macOS 14.8.7 VM GUI run passed (see verification.md).

## Stage 6 — full-function check on macOS (2026-10-23)

The user asked to make sure everything works on the Mac first. In the
macOS 14.8.7 VM, every input format and every tool was used through real
Finder drags (plus Open File and the Drop Zone), and outputs were decoded
again: 14 PDF cases, 24 image conversions, all 7 tool editors, images →
PDF with the order editor, settings (language, login item, DPI, ask for
folder, modifier combos, wheel size, global drag off/on), the Jobs window,
read-only folder → save elsewhere, APFS and exFAT volumes, quit/relaunch,
screen lock, dark mode, HEIC in/out. Record: verification.md "가상 머신 전
기능 점검".

Found and fixed (each re-verified by reinstalling in the VM):
- misnamed image (PNG named .jpg) on PNG → "unsupported format" with no
  file; now re-encoded under the right name (45c6990);
- editors taller than the work area hid the Save button; measured stage
  budget above the editors + sticky footer (4b5375d, 8379e89, 049d644);
- first click into the unfocused Jobs window was swallowed (86c309b);
- jobs from an earlier run offered retry buttons that could only fail;
  "retried" note lost on reopening (d1ce089).

Packages from d1ce089 (hashes in verification.md). vitest 1081 passed,
Playwright 39/39, electron-verify 36/36, smoke with window on arm64/x64.
Next (done in Stage 7): the same core flow on a macOS 26 guest.

## Stage 7 — edge cases, crash cleanup, macOS 26 VM (2026-10-24)

Edge cases in the macOS 14.8.7 VM: 108 Mpx PNG → JPG in ~7 s (streaming
encode); a 248-byte Korean name + suffix → 254-byte output name; 80-page PDF
→ PNG in 3.1 s; cancelling a 24-page A0 PDF rolls back the pages already
written.

Found and fixed: killing the processing worker during a Desktop job made main
list the folder to find leftover temp files. macOS showed the folder-access
prompt, cleanup hit its 10 s timeout, the job ended OUTPUT_WRITE_FAILED with
no retry, and one temp file stayed. The worker now reports each temp path
before writing it (`tempFile` message; AsyncLocalStorage around runJob);
after a crash main removes exactly those paths plus the committed outputs and
never lists a folder on macOS (330a892). Re-verified in the VM with 0 and 8
committed pages. Login item: verified by quitting the app before the VM
restart (not session restore); an ad-hoc rebuild makes macOS turn the login
item off, which Settings then shows.

macOS 26.6.2 (25G83) VM (`macos-tahoe-vanilla`, cloned with the
reference-counted `oci_serve.py --delete-after-serve` to fit the disk): the
330a892 arm64 DMG passed the video flow (PDF → 3 JPGs → Crop 1:1 → Add
Background with a background image; the Save button stays on screen), a drop
beside the ring reaches Finder, a text drag shows "파일이 아님" under the
ring, JPG → HEIC, worker kill with 0 and 4 committed pages → rollback +
retry → 24 pages with no prompt, the menu bar menu, Jobs and Settings, and
the login item across a VM restart. Record: verification.md "가상 머신 핵심
흐름 점검 — macOS 26.6.2".

The x64 DMG under Rosetta 2 in the same guest (Rosetta installed there):
PDF → JPG, Crop, Add Background and HEIC work through real Finder drags,
also with the CPU saturated. Found and fixed, each re-verified in the guest:
- first launch of the x64 build waits ~1 min 40 s for translation; the
  first engine probe hit its 30 s limit, the worker restarted and every
  action was disabled for another 30 s, and nothing pointed to the arm64
  build → probe limit 90 s (service 120 s); on Apple silicon a 'translated'
  startup notice (notification, Settings › General) and "x64 (Rosetta 2)"
  in About (c12378d). Open: one drag during that first launch showed no
  wheel *after* the re-probe had succeeded; not reproduced since (debug
  relaunch, re-signed cold launch with 8 drags, saturated CPU). Likely the
  first-ever Rosetta translation of system frameworks; needs a fresh guest;
- clicking any notification also opened the Drop Zone: macOS sends a reopen
  ~140 ms after the click → ReopenFilter drops a reopen within 3 s of a
  notification click (0a4eef3).

Verified state (dev Mac, 2026-10-24): vitest 1091 passed / 4 skipped;
typecheck clean; Playwright 39/39; electron-verify 36/36 with no console
errors or CSP violations; swift test 167 (9 + 69 + 89), exit 0. Final
packages from 0a4eef3 (arm64 and x64; both DMGs installed in the macOS 26
guest for a last check); hashes in verification.md.

Review of c12378d/0a4eef3 (done by the lead; the review agent stopped on the
account's weekly limit): no correctness bugs. Follow-up: a stuck probe now
fails after up to 110 s (20 s worker start + 90 s), so packaging's smoke-test
kill moved from 120 s to 180 s and a broken package still prints its report
(scripts/package.mjs only — the app in the 0a4eef3 packages is unchanged).

Open — decisions for the user: a human check on a physical Mac; a Windows
PC (the helper is compile- and host-tested only); signing/notarization
credentials; a GitHub remote and the first CI run; product id, licence and
the LGPL review of bundled libvips. The VMs od-sonoma and od-tahoe (~27 GB
each in ~/.tart) are stopped, not deleted.

## Stage 8 — public release (2026-11-12, in progress)

The owner asked to finish the product as a service and decided:
- public direct download: GitHub Releases of github.com/keilvher1/orbitdrop
  (public, MIT) and a website at https://keilvher1.github.io/orbitdrop/ (GitHub Pages);
- name OrbitDrop, product id `io.github.keilvher1.orbitdrop` (helper
  `io.github.keilvher1.orbitdrop.helper`), never to change again;
- free (no accounts, no payments);
- Windows verified through GitHub Actions (no local Windows VM);
- macOS signed with the owner's Developer ID and notarized with an App Store
  Connect API key; a Windows code-signing certificate later (Azure Artifact
  Signing is closed to individuals outside the US/Canada — options: an
  individual-validated certificate with cloud signing, or SignPath Foundation's
  free signing for OSS).

Done so far:
- Repo published (6d75758): MIT `LICENSE`, final product id, neutral wording
  for the reference app; Issues and Pages (workflow) enabled.
- Signing chain proven locally on main@6d75758: Developer ID signature with
  timestamp and hardened runtime on the app and the helper, notarization
  accepted for arm64 and x64, stapled; a quarantined copy taken out of the DMG
  is "accepted, source=Notarized Developer ID" and `syspolicy_check
  distribution` passes. The DMG file itself is still unsigned (being added).
- macOS release packages are signed locally (the Developer ID key never leaves
  the owner's keychain); CI builds Windows and the draft release.
- LGPL/MPL corresponding sources: `scripts/third-party-sources.mjs` builds
  `OrbitDrop-<version>-third-party-sources.tar.gz` (18 components, 27 archives,
  116 MB for 0.1.0) for every release, plus a three-year written offer in
  THIRD_PARTY_LICENSES.md (393234a).
- First run, Help, diagnostics, crash handling (7769f4c): welcome window,
  first-run language from the OS, Windows tools default Ctrl+Shift, Help menu
  (website, issue form, log folder), "copy diagnostics", local-only crash
  dumps, translated crash dialogs and screens, About licences/privacy, data
  folder and settings reset, move to /Applications. vitest 1179 passed /
  4 skipped, typecheck clean.

Also landed (2026-11-12):
- Auto-update (47e594c): electron-updater 6.8.12 with the GitHub provider; checks 60 s after
  launch and every 6 h (Settings › General turns it off; no installation id is sent); restarts only
  when no job, editor, picker or drag is active; unsigned and development builds never update.
  Release pipeline: tag `v*` → CI builds Windows and drafts the release (with the LGPL/MPL sources
  archive and SHA256SUMS.txt); macOS packages are built, signed, notarized (app and DMG) and uploaded
  locally with `scripts/release-mac.mjs`; nothing is ever published by a script (docs/RELEASING.md).
- Website live at https://keilvher1.github.io/orbitdrop/ (Pages workflow, link/claim checker).
- CI green on Windows and macOS for the first time (e4e6e73). Real Windows bugs found and fixed:
  NTFS name limits reported as "not found", blank non-embedded Hangul in PDFs (Malgun Gothic
  first), the MSVC helper build, two packaging path bugs; arithmetic JPEGs report ENGINE_UNAVAILABLE
  on Windows. The macOS runner hang was the helper's ImageIO probe pipe.
- Windows GUI drag test on GitHub's Windows Server 2025 runner (synthesized input in a real
  Explorer window, installed app): 9/9 cases pass; it found and fixed Korean words broken
  mid-word in the Windows wheel's capsule and in the welcome window.
- `scripts/set-version.mjs` keeps the app and both helpers on one version; version 1.0.0.

Verified on the dev Mac at the 1.0.0 commit: vitest 1261 passed / 7 skipped; typecheck clean;
Playwright 39/39; electron-verify 37/37 (no console errors or CSP violations); swift test 167;
licences, golden vectors, icons, site checker and version check up to date.

Next: tag v1.0.0 → CI draft (Windows unsigned beta + sources) → local signed/notarized macOS
upload → the owner decides on publishing. Then SignPath Foundation (the owner chose it for Windows
signing; it requires a released project, a code signing policy page, MFA, and — because of the
update check — a privacy notice during installation with an option to turn the check off).

## Stage 9 — Windows code signing prep: SignPath Foundation (2026-11-12, branch `prep/signpath`)

Goal: meet SignPath Foundation's conditions (signpath.org/terms) now, so that once the application is
accepted only credentials are added; first signed release 1.0.1.

- Website: `/code-signing-policy/` and `/en/code-signing-policy/` (linked from the download section,
  the footer, the Windows FAQ, the privacy pages and the release notes). One state line per page
  (`data-state="pending"`) says Windows is not signed yet and the attribution below it is a plan; the
  replacement line is in an HTML comment above it. What is signed / not signed, roles (keilvher1),
  tag builds on GitHub-hosted runners with per-release approval, privacy, macOS Developer ID.
- Installer (`build/installer.nsh`): privacy notice page after the folder page (nsDialogs, ko/en) with
  the box "업데이트 자동 확인 / Check for updates automatically" (ticked); `/NOUPDATECHECK` for unattended
  installs; the choice goes to `installer-preferences.json` in the installation folder. The app applies
  it on the first run only (`settings/installer-preferences.ts`, logged, never over existing settings);
  the welcome window has the same switch on every platform.
- Every own Windows executable carries ProductName OrbitDrop and ProductVersion = package.json:
  `scripts/win-sign.cjs` (win.signtoolOptions.sign) fixes OrbitDrop.exe's string (electron-builder wrote
  x.y.z.0); the helper's VERSIONINFO strings come from `ORBITDROP_VERSION_STRING` (set-version.mjs).
  package.mjs checks all four and their Authenticode state (`scripts/win-files.mjs`).
- release.yml: SignPath only with the secret + three variables and a run on the tag itself. Two signing
  requests (OrbitDrop.exe + helper + uninstaller, then the installer), `package.mjs --signpath
  prepare|installer|finish`, every returned file checked to be the sent file plus a signature, latest.yml
  recomputed, `-unsigned` dropped. Artifact configurations in `apps/desktop/build/signpath/`. Rehearsal:
  Run workflow without a tag and with `signpath_rehearsal` (self-signed stand-in, "-rehearsal", never
  released).

Verified (GitHub runners, branch prep/signpath): CI 43193136046 green (Windows: the four executables
1.0.0/NotSigned, `/S` → autoCheck true, `/S /NOUPDATECHECK` → false, uninstall removes the file; macOS
unchanged); native-windows 43193105443 green; Release rehearsal 43193146123 green (all four Valid after
the two stand-in requests, NSIS regenerated the same uninstaller so the signed one went in, latest.yml
consistent, signed install test); windows-gui 43195949011 green (interactive installer clicked through
the privacy page with the box unticked → first run logs and keeps autoCheck false; 9/9 drag cases).
Local: vitest 1283 passed / 9 skipped, typecheck clean, site checker ok, actionlint clean; installer.nsh compiled
with electron-builder's NSIS 3.12 (-WX) in a harness, uninstaller output byte-identical across builds.

Not testable without SignPath: the action call itself, SignPath's origin verification, approval, metadata
restrictions and the real certificate. Next: the owner applies (docs/packaging.md §5 "소유자가 할 일"),
configures SignPath and the repository secret/variables, runs a rehearsal, then releases 1.0.1 and switches
the website's state line.

## Stage 10 — wheel opacity (2026-11-13, branch `feat/wheel-opacity`)

The owner asked for a see-through wheel while dragging ("사용할때 배경이 좀 opacity를 넣어서 투명하게").

- Setting `globalDrag.wheelOpacity`: whole percent, `WHEEL_OPACITY_RANGE` 40–100, default **70**. Additive (no
  SETTINGS_VERSION bump; a 1.0.0 settings file gets 70). Settings › 드래그 has a "휠 불투명도" slider under the size
  slider with a hint; the preview follows it live over a stand-in file list.
- `wheelTokens(theme, reduceMotion, opacityPercent = 100)` multiplies the alpha of the background only: wheelDisc,
  sector, sectorHover, sectorDisabled and wheelShadow. Text, icons, sectorActive, the ring and the capsule keep their
  colours, and high contrast stays opaque. design-tokens.json and the helpers' built-in copies stay at the 100 %
  values, so the native code is unchanged: both renderers already apply token alpha, and alphas stay ≥ 1/255 for
  hit-testing. main passes the setting in `buildConfigureMessage`. A change reaches the running helper through the
  existing globalDrag → `reconfigure` path, which sends a new configure only when the message changed (macOS keeps
  the wheel under the pointer unchanged until the next drag). macOS Reduce Transparency still draws an opaque disc.
- React wheel (picker, Drop Zone) and the Settings preview: `--wheel-opacity` sets the fill-opacity of the disc and
  sectors and scales the disc shadow's colour. The highlighted sector (a disabled one under the pointer too), text,
  ring and capsule stay solid; high contrast and forced colours use 1.
- The default comes from native `--render-snapshot` renders (scaled tokens via `--config`) at 100/85/70/55/40 % in
  light and dark over a Finder list and a photo with text. At 70 % the Finder rows read through the wheel: 15–17 % of
  the backdrop shows through the sector band and about half through the gaps and the centre, while the labels stay
  crisp. Worst-case label contrast (sector band over pure black or white) is 7.8:1 light and 6.5:1 dark, and stays
  ≥ 4.5:1 (AA) down to 55 %; at 40 % it falls to 3.0:1 in dark over white (the user's choice). The labels need no
  halo at the default, so the native renderers are unchanged.

Verified on the dev Mac: vitest 1314 passed / 7 skipped, typecheck clean, Playwright 39/39 (helper-drop also checks
the opacity re-configure), electron-verify 38/38 (new check: the real Chromium paint of the opacity), swift test 167;
licences, golden vectors and versions up to date.

Not verified: the live macOS panel's window-server shadow behind a translucent disc and a real Finder/Explorer drag
with the new default (no synthesized input on this Mac; snapshots paint their own shadow outside the disc). The
Windows renderer was checked by reading the code only (Direct2D brushes with token alpha, per-pixel alpha hit shape).

## Stage 11 — Claude analysis, opt-in with the user's own API key (2026-11-13, branch `feat/claude-analysis`)

New tools action `tool.analyze` ("Claude 분석" / "Analyze with Claude", icon `analyze` = sparkles): drop an
image or a PDF on it and Claude (claude-opus-5-5) writes a Markdown report `<base> Analysis.md` next to the
original. Strictly opt-in: off by default, needs the user's own Anthropic API key, no backend; nothing is
sent until a file is dropped on the sector. Everything else stays local.

- Contracts: `analysis.ts` (model, limits — PDFs ≤ 100 pages and ≤ 30 MiB, images ≤ 1568 px, standing request
  ≤ 1000 characters — key format check, `ANTHROPIC_KEYS_URL` = platform.claude.com/settings/keys, allowlisted);
  `md` is an output-only format (no input kind, no signature: a dropped .md stays UNSUPPORTED_FORMAT); settings
  `analysis: { enabled: false, instruction: '' }` (additive, SETTINGS_VERSION 1); options from the settings only;
  error codes `ANALYSIS_NOT_CONFIGURED | _KEY_INVALID | _KEY_STORAGE_UNAVAILABLE | _AUTH_FAILED | _RATE_LIMITED`
  (retryable) `| _INPUT_TOO_LARGE | _UNAVAILABLE` (retryable) `| _REFUSED | _FAILED`; warning `ANALYSIS_TRUNCATED`;
  stage `analyzing`; `ProcessorCredentials` next to the job in the `run` message and ProcessorRunContext.
- Menus: `baseMenuOrder/buildWheelMenu/buildHelperMenus(…, { analysis })`. Only while available (enabled and a
  key saved): last sector of the image tools wheel, the only tools sector of PDFs and mixed selections.
  Unavailable = byte-identical menus and helper configure (golden unchanged). Main re-configures the helper when
  `analysis.enabled` changes and when a key is saved or deleted.
- Key: `<userData>/claude-api-key.json` (0600, atomic) holds Electron safeStorage ciphertext + the last four
  characters; refused when `isEncryptionAvailable()` is false (also Linux `basic_text`). The renderer only sees
  `{ hasKey, keyHint: '…abcd' }`. Main decrypts it per job attempt (crash retry included) and hands it to the
  worker outside the job; never in settings, history, logs (plus a last-line redaction of `sk-ant-…`),
  diagnostics, IPC replies. Workers get no inherited `ANTHROPIC_*` variable.
- Processor (`packages/processors/src/analyze/`): `@anthropic-ai/sdk` 1.8.0 (Apache-2.0; app dependency, shipped
  in node_modules, licences regenerated), `client.beta.messages.stream` with fallbacks "default" and effort
  medium, `finalMessage()`, stop reason checked first, SDK errors mapped by class. Base URL pinned to
  api.anthropic.com, SDK logging and tracing off. Images via the sharp helpers (oriented, first frame, ≤ 1568 px,
  JPEG q85 / PNG with transparency, no metadata); PDFs as they are after a PDF.js page count. Report: heading,
  metadata line, Claude's Markdown, token footer (+ a truncation note). Prompt as tested live by the lead.
- Settings › Claude 분석 tab (enable, what is sent / billing / when / key storage, password field with
  저장·연결 확인·키 삭제…(in-window confirmation), standing request, model). About › 개인정보 gained a line;
  the update wording is unchanged. Automation (E2E, electron-verify) uses a scripted key store and API.
- `scripts/analysis-live-check.mjs`: real API, not in CI (`ANTHROPIC_API_KEY=… node scripts/analysis-live-check.mjs`).

Verified locally (macOS 26, arm64, helper built): typecheck clean; vitest 1370 passed / 7 skipped (was 1286 / 7);
Playwright E2E 46/46 (was 39; +7 analysis); electron-verify 38/38 (was 37; +1); licences and golden `--check`
clean. No test calls the real API (fake `fetch` / scripted backend). One full E2E run failed offline.spec once
(an unconnected `UDP *:*` socket on an Electron process during PDF → JPG); not reproduced in 24 isolated runs
and two more full runs. Open: the native helpers must know `tool.analyze` / icon `analyze` before an
analysis-enabled configure reaches them (parallel branch); the live check with the owner's key; Node's fetch
in main/worker does not use the system proxy; a PDF near 30 MiB grows past the API's 32 MB request limit when
base64-encoded (the API's 413 maps to ANALYSIS_INPUT_TOO_LARGE, but only after the upload).
