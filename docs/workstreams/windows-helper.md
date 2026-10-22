# Workstream: windows-helper

Native drag helper for Windows 11 x64: `OrbitDropHelper.exe` (C++17, Win32 + OLE +
Direct2D/DirectWrite). It owns everything that happens during an OS drag on
Windows: observing the drag and its modifiers, the single wheel window (visual and
OLE drop target in one HWND), hit-testing, highlight, and accepting the drop as
**Copy only**. It reports to Electron main over the NDJSON helper protocol v1
(`packages/contracts/src/helper-protocol.ts`).

**There was no Windows machine available.** Everything Windows-specific is written,
compiled and linked (MinGW-w64, warnings as errors), but **nothing in `src/win/` has
been run**. The portable core (protocol, JSON, geometry, coordinates, classification,
state machine) is built and tested on macOS. MSVC builds, unit tests, a stdio smoke
test and PNG snapshots on Windows are prepared in CI and in the build script; they
have not been run yet.

## Status

| Area | Implemented | Run here (macOS) | Compile-checked only | Not verified |
|---|---|---|---|---|
| Protocol v1: parse, validate (strict, zod-equivalent), serialize | yes | unit tests; parity vs zod: 56 C++-serialized helper→main messages pass `HelperToMainSchema`; 5,058 (CI default) fuzzed + edge-case main→helper lines get identical verdicts from zod and C++; the macOS helper's 155-line zod corpus too (hardening pass) | MSVC | — |
| JSON parser/writer (UTF-8, surrogate pairs, lone-surrogate escapes → U+FFFD, limits, duplicate keys in O(n log n)) | yes | unit tests; 20,002 corrupted inputs under ASan + UBSan, no findings; a 1 MiB line of distinct keys parses in ~3 ms (was ~2 s) | MSVC | — |
| Wheel geometry (`hitTestWheel`, `placeWheel`, `isArmed`), V8-identical `Math.atan2`/`Math.hypot` | yes | golden: hitTest 2185, placeWheel 260, isArmed 25 — all pass; 6,578 atan2/hypot vectors from Node bit-exact | MSVC | — |
| Coordinates (`displaysFromWin32Monitors`, physical↔DIP, wheel frame, rounding) | yes | golden coords.win 302 + displayForPoint/clamp/rounding 34 — all pass; per-pixel alpha-mask = hit-test invariant at 100–200 % | MSVC | real monitors |
| Classification (`menuKeyForPaths`, multi-file adjustment, payload checks) | yes | golden selection 42 + fileCount 10 — all pass | MSVC | real Explorer payloads |
| Session state machine (`DragSessionController`) | yes | 23 scenario tests (drop, dead zone, disabled, Copy-only, leave/re-enter, grace, Esc, modes, arming, multi-file, unsupported, sleep, cancel, config freeze, 150 % negative coords) | MSVC | real drags |
| Win32 app: stdio threads, Per-Monitor V2, OLE, message loop, polling observer, power/session events | yes | — | MinGW GCC 16 `-Wall -Wextra -Wshadow -Werror`: 0 warnings | **all GUI behaviour** |
| Wheel window (layered, topmost, no-activate) + Direct2D/DirectWrite rendering | yes | geometry preview rasterised on macOS (no fonts) | MinGW | look on Windows, icons, Hangul fallback |
| `IDropTarget` (CF_HDROP, virtual files via `FileGroupDescriptorW` or `FileGroupDescriptor`, `IDropTargetHelper`, Copy/None), no file-system calls in callbacks | yes | — | MinGW | **Explorer drag & drop** |
| OLE glue tests (`orbitdrop-ole-tests`: real `DropTarget` + controller, fake `IDataObject`; COPY/MOVE/LINK mapping, one drop per session, CF_HDROP Unicode/long paths, virtual (W and ANSI descriptor) and non-file data) | yes | — (Windows-only) | MinGW (built, **not run**); runs in CI under MSVC | first CI run |
| Folder **and cloud-only placeholder** detection off the UI thread (`folder_check`, attributes only, never hydrates) + specific unsupported texts | yes | controller side unit-tested (`fileInfo`, folder/cloud/non-file/virtual texts, fallback); attribute classification unit-tested | worker thread: MinGW | real folders, network shares, OneDrive Files On-Demand |
| UI Automation (window name, notification of the armed sector for Narrator) | yes | — | MinGW | Narrator (checklist 24) |
| Display/DPI changes cancel a wheel on a changed monitor; diagnostics written by the writer thread | yes | `displaysChanged` unit-tested | MinGW | real hot-plug (checklist 25) |
| `--render-snapshot` (WIC PNG) | yes | — | MinGW | runs in CI on Windows (not yet run) |
| Built-in defaults (snapshot/test configure) vs `packages/contracts/design-tokens.json` | yes | drift test reads the JSON (all 42 wheel colours, sizes, motion); light `sectorActive` = `#D4441C` (WCAG AA update) | MSVC | — |
| Build: CMake + presets (MSVC /MT + CFG on every compile unit, MinGW, host tests, ASan/UBSan fatal), build script, CI | yes | host + ASan + MinGW presets, script modes `--core-tests --parity` (now incl. ASan/UBSan) and `--cross` | MSVC presets, CI workflow | first CI run |

The second, adversarial review of this helper (hardening pass, 2026-10-22) is recorded in
[`hardening-windows.md`](hardening-windows.md): every check, its result, the fixes and the
evidence.

The staged `apps/desktop/resources/helper/win32-x64/OrbitDropHelper.exe` (1,638,912 bytes,
stripped) is the **MinGW cross build**; its `BUILD_INFO.txt` says *CROSS-COMPILED …
NOT VERIFIED ON WINDOWS — do not ship*. Ship the MSVC artifact from CI or from
`node scripts/build-native-win.mjs` run on Windows.

## Files

```
native/windows/
  CMakeLists.txt, CMakePresets.json, cmake/mingw-w64-x86_64.cmake
  res/OrbitDropHelper.manifest        PerMonitorV2, asInvoker, longPathAware, Win10/11 (MinGW, via .rc)
  res/OrbitDropHelper.msvc.manifest   same without trustInfo (MSVC linker adds asInvoker)
  res/OrbitDropHelper.rc.in           version resource (+ manifest for MinGW)
  src/core/   portable, no Windows headers (also built with clang/GCC on macOS/Linux)
    jsmath      V8's fdlibm atan/atan2 + Math.hypot (bit-identical to Node)
    utf, json   strict UTF-8/16, JSON parser/writer
    protocol    message types, zod-equivalent validation, serializers
    geometry    port of packages/core/src/geometry.ts
    coords      port of packages/core/src/coords.ts (Windows parts) + wheel frame
    selection   port of selection.ts menuKeyForPaths + payload classification
    wheel_layout  sector outlines (constant gaps, rounded corners) for the renderer
    session     DragSessionController
    helper_core protocol dispatch, NDJSON line splitter
    defaults    reference configure (tokens, menus) for snapshots/tests
  src/win/    Win32 layer
    main        wWinMain, --version, --render-snapshot
    app         message window, stdio, polling, OLE, power/lock, deferred window ops
    stdio_channel  reader thread (parse off the UI thread) + serialized writer thread
    drop_target IDropTarget
    wheel_window  layered window, UpdateLayeredWindow, fades, WM_GETOBJECT
    accessibility UI Automation provider (name, notifications for Narrator)
    folder_check  worker thread: are dragged paths folders or cloud-only placeholders? (attributes
                  only, no FS calls in OLE callbacks)
    renderer    Direct2D DC render target + DirectWrite + alpha mask
    snapshot    --render-snapshot (WIC PNG)
    win_util    ComPtr, UTF-16, monitors, OS version, elevation
  tests/      test_*.cpp (tiny built-in framework), data/jsmath-vectors.txt
  tests/win/  test_ole_glue.cpp (Windows-only: DropTarget + fake IDataObject)
  tests/tools/ protocol_tool.cpp + protocol-parity.mjs (zod cross-check), stdio-smoke.mjs
               (Windows runtime smoke test), layout_preview.cpp, gen-jsmath-vectors.mjs
scripts/build-native-win.mjs
.github/workflows/native-windows.yml
docs/screenshots/windows-helper-layout-preview-*.png   (geometry only, see below)
```

## Design

### Process and threads

* GUI-subsystem exe (no console window), spawned by main with three pipes. Started
  without std handles it exits with code 2.
* **UI thread** = OLE STA (`OleInitialize`): message loop, session controller, wheel
  window, drop target, timers. `OleUninitialize` at exit.
* **Reader thread**: blocking `ReadFile` on stdin → `LineSplitter` (1 MiB limit; an
  over-long line is discarded and reported once) → parse + validate off the UI thread →
  a locked inbox, plus a coalesced wake message that carries no data.
  - The UI thread drains the inbox on wake and on a 1 s housekeeping timer, so a lost wake
    is harmless.
  - EOF or a broken pipe sets a channel flag (not a message). Then the helper hides the
    wheel, sends `cancelled` (best effort) and exits 0. `ERROR_MORE_DATA` (a message-mode
    pipe with a long message) is data, not EOF; Node's pipes are byte mode anyway.
  - Parent death closes main's pipe end (libuv creates it non-inheritable), so EOF is the
    parent-death signal; `ORBITDROP_PARENT_PID` is not needed.
  - The message window is top-level and reachable by other processes, so no message
    carries a pointer or a decision. A spoofed wake is just an empty drain, and an exit
    message is honoured only after our own `requestExit()`.
* **Writer thread**: drains a queue to stdout, so an OLE callback never blocks on a full
  pipe. A failed write means main is gone → exit. Non-critical lines (`log`) are dropped
  above 8 MiB of backlog; `drop`/`cancelled`/`ready`/`pong`/`error` are never dropped.
  Stopping retries `CancelSynchronousIo` until the reader leaves `ReadFile`. Debug
  diagnostics (`ORBITDROP_HELPER_DEBUG=1`) go to stderr through the same thread, never
  synchronously from the UI thread.
* **Folder worker thread** (`folder_check`): answers "is any dragged path a folder or a
  cloud-only placeholder?" with `GetFileAttributesW` off the UI thread (metadata only, so
  nothing is downloaded). The latest request wins, and results come back through a locked
  slot plus a payload-less wake message.
* A hidden **top-level** window (not `HWND_MESSAGE`) receives these broadcasts:
  - `WM_POWERBROADCAST` and `WM_WTSSESSION_CHANGE` (`WTSRegisterSessionNotification`).
  - `WM_QUERYENDSESSION`/`WM_ENDSESSION`, including Restart Manager's `ENDSESSION_CLOSEAPP`.
    The helper hides the wheel, cancels the session and exits.
  - `WM_CLOSE` (`taskkill` without `/F`): cancels the session, then exits.
* The window procedures catch C++ exceptions, and the draw path always closes
  `BeginDraw`/`EndDraw`.
* `SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX | SEM_NOGPFAULTERRORBOX`: the helper
  never shows a dialog, not even the Windows Error Reporting dialog after a crash (main
  restarts it).
* Before `ready`, start-up problems are buffered and sent as `log` after `ready`.
  `ready.globalDrag.available` is false (with a reason) when OLE, the drop target,
  Direct2D/DirectWrite or the window failed, or when the helper runs at a **higher integrity
  level than Explorer** (elevated under UAC: UIPI blocks drags from Explorer). The test
  compares integrity levels with the shell's process (`GetShellWindow`), falling back to
  `TokenElevationTypeFull`; plain `TokenIsElevated` would also refuse administrators with UAC
  off and the built-in Administrator, where Explorer runs at the same level and drags work.
  Then nothing is observed and no wheel is shown.

### Observation (no hooks, no injection)

A timer polls `GetAsyncKeyState` and `GetCursorPos`: 50 ms coalescable while idle,
15 ms while the button is down or a session is open, off while disabled, before the
first `configure`, while the session is locked or the system sleeps. A tick that would run
inside an `IDropTarget` method (a COM wait loop in `GetData` dispatching the timer) is
skipped, so a release sampled mid-`DragEnter` cannot end the session just before OLE
delivers the `Drop` for that release.

* Primary button: `VK_LBUTTON`, or `VK_RBUTTON` when `SM_SWAPBUTTON` (async state is
  physical).
* Modifiers: Shift, Alt (`VK_MENU`), Control, Win (`command` in the protocol).
* While idle only the primary button is read. Modifiers and Esc are read only while the
  button is down or a session is open, because GetAsyncKeyState's shared "pressed since
  the last query" bit would otherwise be consumed for other programs.
* Candidate: button down and moved beyond the `SM_CXDRAG`×`SM_CYDRAG` rectangle
  (`GetSystemMetricsForDpi` for the pointer's monitor). Window moves/resizes and menu
  tracking of the foreground thread (`GetGUIThreadInfo`, read-only) never become candidates.
* No `SetWindowsHookEx`, no `SendInput`, no code injection, no clipboard access.

### Session state machine (`src/core/session.cpp`)

```
Idle ─ button down (held modifiers = baseline) ─▶ Pressed ─ moved beyond drag rect ─▶ PotentialDrag (not announced)
PotentialDrag ─ a key press after the button press completes an exact combo, held ≥ 40 ms ─▶ AwaitingPayload: neutral wheel  → state AwaitingPayload
AwaitingPayload ─ OLE DragEnter ─▶ WheelActive: menu from the extension map, order frozen        → state WheelActive
WheelActive ─ Drop on enabled + armed sector, source allows Copy ─▶ drop (once), hide
any wheel ─ Esc / drag ended / refused release / sleep / lock / cancelSession / disable / EOF / monitor changed ─▶ cancelled, hide
```

Rules shared with the macOS helper (checked against its controller), followed by the
Windows-only additions:

* **Shift held before the button press never opens the wheel.** Shift + text selection,
  Shift + marquee and Shift + click-drag in an editor therefore show nothing. Modifiers
  held when the button goes down are the baseline. Only a key **press** observed after
  the button press that completes an exact combo opens a wheel: press the button, drag,
  then press Shift. Pressing Alt while still holding that Shift completes the tools combo
  and does open the tools wheel. macOS behaves the same way (it ignores a combo already
  held at mouse-down).
* Modifier sets must match a configured combo **exactly** (Ctrl+Shift does not open the
  convert wheel). *Windows only:* activation also waits for 40 ms of a stable set, so
  Shift-then-Alt opens tools without flashing convert. While open, a key press that
  completes the other combo switches mode; releases never switch. Each switch freezes
  that mode's order and restarts arming.
* Wheel-less candidates are not reported (no `PotentialDrag`/`Idle` traffic for every text
  selection). A session is announced with `AwaitingPayload` and ends with exactly one
  `drop` or `cancelled`. This helper never sends `Idle`.
* Session ids: `w<pid hex>-<start time hex>-<counter>`, unique across helper restarts.
* Centre fixed at activation, clamped to the monitor work area (`placeWheel`).
* Dead zone and outside never select. Arming is `isArmed` for the current pointer
  (moved `armDistance` from the activation point, or passed through the dead zone, which
  latches). Disabled sectors are rejected with their reason in the capsule.
* Copy only when `*pdwEffect & DROPEFFECT_COPY`, else `DROPEFFECT_NONE`. Never Move or
  Link, so Explorer's Shift = Move never deletes the source.
* DragLeave keeps the wheel for re-entry. Releasing the modifier keeps an active wheel.
  Hover never commits.
* Button-up seen by the poll: if the pointer is over the wheel (DragEnter without
  DragLeave), wait up to 600 ms for OLE's cross-process `Drop`/`DragLeave`. A pending
  drop is never lost to the poll racing it. Otherwise cancel at once (`dragEnded`).
* A refused release on the disc (OLE calls `DragLeave` instead of `Drop`) reports
  `outsideRing` (dead zone or outside, or not armed), `disabledSector` or `invalidPayload`
  (unsupported payload or Copy not allowed). The result is the same for either event order.
* *Windows only, second guard:* no DragEnter while the pointer moves ≥ 24 DIP over the
  neutral wheel for ≥ 350 ms means this is not an OLE drag (e.g. Shift pressed during a
  text selection): `cancelled invalidPayload`, hidden until release.
* Unsupported drags get the specific optional texts from `configure.strings` and fall
  back to `unsupported`:
  - `unsupportedFolder`: a folder.
  - `unsupportedNonFile`: text, a URL or other non-file data (also IDList-only items such
    as Control Panel entries, the Recycle Bin icon or a library).
  - `unsupportedVirtual`: virtual items such as e-mail attachments or zip contents.
  - Cloud-only placeholder: built-in "먼저 내려받으세요" / "Download it first" until configure
    carries a string for it (requested: `strings.unsupportedCloud`).
* **No file-system calls in DragEnter/Drop.** Folders and cloud-only placeholders are
  detected by a worker thread (`src/win/folder_check.*`, `GetFileAttributesW`, latest
  request wins). The result is applied to the open session through `Controller::fileInfo`:
  the drag becomes unsupported with the folder (or cloud) text, and `state WheelActive` is
  re-sent with `menuKey: null` if it was supported. A folder wins over a placeholder; a
  placeholder only changes an otherwise supported drag. A drop that happens before the
  answer arrives is validated by main (`NOT_A_FILE`, `CLOUD_PLACEHOLDER`).
* `WM_DISPLAYCHANGE`/`WM_DPICHANGED` re-check the open session's monitor. If it disappeared
  or changed size or DPI, the session ends with `cancelled error`.
* Esc cancels (`escape`) and suppresses the wheel until the button is released.
* `configure` during a session: the session keeps its snapshot. `enabled:false` cancels
  (`parentRequest`).
* Drop: the paths are re-read from the drop's data object before `Drop` returns. They
  must classify as at DragEnter (same menu key and count), else `invalidPayload`.

### Coordinates (matches the golden `coords.win` cases)

Per-Monitor DPI Aware v2 (manifest + `SetProcessDpiAwarenessContext`). Monitors are
enumerated at each activation (`EnumDisplayMonitors`, `GetDpiForMonitor`). They are
laid out in global DIP with the core's `displaysFromWin32Monitors`, so negative
coordinates and mixed DPI are handled.

The integer cursor position is converted with the monitor's affine map. The wheel is
placed with `placeWheel` in that display's work area. The window is the enclosing pixel
rectangle of the DIP frame (`placeWheelFromPhysical`). Pointers are hit-tested in the
wheel display's DIP.

The pointer comes from our own `GetCursorPos`, not OLE's `POINTL`. That value is in the
source's coordinate space, which is virtualised for DPI-unaware sources.

### Wheel window, hit-testing and rendering

* One `WS_POPUP` window with `WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW |
  WS_EX_NOACTIVATE`. It is created hidden at start-up (the first `ShowWindow` consumes any
  `STARTUPINFO` override) and reused. It is shown with `SW_SHOWNOACTIVATE`, and
  `WM_MOUSEACTIVATE` returns `MA_NOACTIVATE`. `RegisterDragDrop` runs at start-up and
  `RevokeDragDrop` runs before `DestroyWindow`.
* Content: Direct2D DC render target (software) → premultiplied 32-bit DIB →
  `UpdateLayeredWindow(ULW_ALPHA)`. Text uses DirectWrite with grayscale AA (ClearType
  needs an opaque background).
  - Fonts: Segoe UI Variable Text, else Segoe UI. Hangul comes through DirectWrite system fallback.
  - Icons come from Segoe Fluent Icons, else Segoe MDL2 Assets: compress U+E73F, metadata U+E8EC,
    edit U+E9E9, annotate U+E70F, background U+E8B9, crop U+E7A8, redact U+ED1A.
  - Labels shrink to fit, then get an ellipsis. Reasons wrap in the capsule.
* **Alpha mask**: after drawing, every disc pixel gets alpha ≥ 1 and every pixel outside
  gets alpha 0. This covers the dead zone and the gaps. It uses `coords::windowPixelInsideDisc`, the
  *same* expression as pointer hit-testing. So "OLE finds our window at this pixel" and
  "`hitTestWheel` is not outside" are one predicate (unit-tested per pixel at 100–200 %).
  The rule relied on (Window Features → Layered Windows): "Hit testing of a layered window is
  based on the shape and transparency of the window. This means that the areas of the
  window that are color-keyed or whose alpha value is zero will let the mouse messages
  through." `DoDragDrop` "determines the window under the current cursor location", so the
  alpha-0 corners pass drops to the window below while the whole disc, dead zone included,
  stays our (refusing) target. The window never has `WS_EX_TRANSPARENT`, which would make the
  whole window click-through.
* **No outer drop shadow.** Any non-zero alpha outside the disc would make OLE treat
  the shadow as drop target. `wheelShadow` is used as a soft inner rim instead.
  `windowMargin` stays transparent.
* High contrast tokens get sector and capsule outlines. Fades use `appearMs`/`disappearMs`
  (none with reduced motion), changing only the constant alpha.
* **UI Automation**: the window answers `WM_GETOBJECT` with a server-side provider.
  - Name "OrbitDrop wheel" / "OrbitDrop 휠", control type Pane, localized type "radial menu",
    not keyboard-focusable.
  - When the armed sector (or the centre text) changes, it raises a UIA notification
    event (`NotificationProcessing_MostRecent`), so Narrator speaks the choice without the
    wheel taking focus. It also sends an MSAA name change.
  - `uiautomationcore.dll` is loaded on demand, so the import table does not change.
* Window operations requested inside an `IDropTarget` method are deferred with
  `PostMessage`, so OLE callbacks return immediately. The guard covers the whole method,
  including `IDataObject::GetData` and the `IDropTargetHelper` calls, whose COM wait loops
  can dispatch messages such as `WM_POWERBROADCAST`. DragOver only updates state;
  rendering happens on change.
* After raising the wheel to the top of the topmost band, the helper places it directly
  below a visible shell drag-image window (class `SysDragImage`), so the drag image stays
  on top. This is best effort and unverified (item 17); it is a no-op when that window is
  absent.
* If rendering fails in `show()`, the window is hidden rather than left showing a stale frame.

### Drop target

* `DragEnter` (first entry of a session) reads `CF_HDROP` with `DragQueryFileW` into
  owned UTF-8 strings. Lone UTF-16 surrogates are rejected (`WC_ERR_INVALID_CHARS`)
  rather than corrupted. More than 200 files, a path over 32,767 units, or a payload
  whose `drop` line could exceed 1 MiB means unsupported.
* `CFSTR_FILEDESCRIPTORW` or the ANSI `CFSTR_FILEDESCRIPTORA` without `CF_HDROP` means
  virtual files (`unsupportedVirtual`). Neither format present means non-file data
  (`unsupportedNonFile`), which covers IDList-only (`CFSTR_SHELLIDLIST`) drags.
* The callbacks only copy data. There is no `GetDriveTypeW` or `GetFileAttributesW` in
  DragEnter/Drop.
  - Folders are detected afterwards by the folder worker (see above).
  - `SEM_FAILCRITICALERRORS` means a disk-less drive never prompts.
  - **Cloud placeholders** (decision of the hardening pass): OneDrive/Dropbox Files
    On-Demand online-only files carry `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (and
    `FILE_ATTRIBUTE_OFFLINE`); offline HSM files carry `FILE_ATTRIBUTE_OFFLINE`. The
    worker reads them with `GetFileAttributesW`, which never opens the file's data, so
    nothing is downloaded, and the wheel refuses the drag ("download it first"; spec §9:
    local files only). `FILE_ATTRIBUTE_RECALL_ON_OPEN` is not used: it only appears in
    directory enumeration, and with `GetFileAttributesW` its bit means
    `FILE_ATTRIBUTE_EA`. Node cannot see these attributes, so this is the only place that
    can tell without reading the file; main keeps its timeout heuristic for drops that beat
    the worker and for the Drop Zone/dialog.
* `IDropTargetHelper` keeps the source's drag image visible over the wheel.
* Test seams: an injectable cursor source and an optional drag-image helper, used by the
  Windows-only OLE glue tests (`tests/win/test_ole_glue.cpp`).
* COM exceptions never cross the boundary (`try/catch` → `DROPEFFECT_NONE`).

### Protocol details

* Validation mirrors the zod schemas: strict objects, ranges, regexes, enums, and
  `.int()` = safe integer. **String lengths are counted in Unicode code points**, like
  zod 4.6.7 (`$ZodCheckMaxLength` uses `codePointLength`), not in UTF-16 units.
* Escaped lone surrogates (`"\ud800"`, which JSON.stringify writes for a split pair) are
  accepted like JSON.parse does and read as U+FFFD, one code point, exactly as zod counts
  a lone surrogate. Same rule as the macOS helper.
* Intentional differences from `JSON.parse` + zod, checked by the parity script: duplicate
  object keys are rejected (JSON.parse keeps the last key; the contract documents this for
  both helpers), and so is a line with more than 50,000 JSON values (memory bound; main's
  configure has about 1,600). Main never produces either.
* Duplicate keys are found with one sort per object, so a 1 MiB line costs milliseconds
  on the reader thread.
* Invalid input → non-fatal `error` with code `invalidJson`, `invalidMessage`,
  `unknownType`, `protocolVersion` or `lineTooLong`. The message is a field path and
  never echoes content: an unknown key is named only when it is a short identifier
  (`[A-Za-z0-9_]{1,40}`), otherwise as `<key>`. At most 50 reports. Blank lines are ignored.
* `queryPermissions` → `permissions {items: []}` (Windows needs none). `ping` → `pong`.
  `shutdown` → hide, flush, exit 0.

## Build and test

| Where | Command | What it does |
|---|---|---|
| any OS | `node scripts/build-native-win.mjs --core-tests [--parity] [--no-asan]` | host compiler, 91 tests incl. all golden sections and the design-token drift check (`--require-golden`), then the same tests under ASan + UBSan on macOS/Linux (UBSan findings are fatal); `--parity` = zod cross-check (needs `node_modules/tsx`) |
| macOS/Linux | `node scripts/build-native-win.mjs --cross` | MinGW-w64 build, warnings as errors, DLL import allowlist, stages a stripped exe + `BUILD_INFO.txt` (UNVERIFIED) |
| Windows | `node scripts/build-native-win.mjs` | MSVC x64 `/MT` (preset `msvc-x64`), core tests, OLE glue tests, `stdio-smoke.mjs` (pipes, ready/ping/errors/EOF exit + 13 PNG snapshots incl. folder/cloud/virtual/non-file texts), stages exe + `BUILD_INFO.txt` |
| CMake directly | `cmake --preset host-tests && cmake --build --preset host-tests && ctest --preset host-tests` | also `host-tests-asan`, `mingw-x64`, `msvc-x64`, `ninja-msvc-x64` |

* **Static CRT**: the MSVC preset sets `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` (`/MT`),
  so no VC++ redistributable is needed. MinGW links libstdc++/libgcc/winpthread statically.
  Both use the OS-provided UCRT (Windows 10+).
* **Exploit mitigations (MSVC)**: `/guard:cf` on every compile unit, the static core library
  included (CFG only checks indirect calls in objects compiled with it), and
  `/DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /guard:cf` at link. MinGW has no CFG; its exe has
  ASLR, high-entropy VA and NX (DllCharacteristics 0x160) and is never shipped.
* **Warnings policy**: GCC/Clang build with `-Wall -Wextra -Wshadow -Werror` (MinGW and host
  presets). MSVC builds at `/W4` without `/WX`, because this code has not met MSVC yet and
  the first CI run must still produce an artifact; enable `ORBITDROP_WARNINGS_AS_ERRORS` in
  the msvc presets once a CI log is clean.
* Floating point: `-ffp-contract=off` / `/fp:precise`. `jsmath.cpp` reproduces V8's
  rounding with explicit `std::fma`. Node on arm64 was compiled with fused multiply-adds
  in fdlibm, and `tests/data/jsmath-vectors.txt` comes from it.
* CI `.github/workflows/native-windows.yml` (on changes to native/windows, the build
  script, the golden file or the related contracts/core sources):
  - `windows-latest`: configure, build, `ctest` (golden required), golden summary, the build
    script (smoke test + snapshots + staging), dumpbin, upload of the exe and the snapshots.
  - `ubuntu-latest`: GCC tests, ASan/UBSan tests, and the MinGW cross check
    (continue-on-error: distribution headers may lag).
  - `protocol-parity`: pnpm install, then core tests and parity (`--no-asan`: the job above
    runs the sanitizers). The trigger paths include the contract files that define the
    protocol's enums and ids (`schemas.ts`, `actions.ts`, `menus.ts`, `formats.ts`),
    `core/capabilities.ts` and the macOS helper's protocol corpus.

### Evidence from this machine (macOS 26.6 arm64, Apple clang 21, MinGW-w64 14 / GCC 16.2)

* `orbitdrop-core-tests --require-golden`: 91 tests, 0 failures (86 before the hardening
  pass). This includes every section of `tests/fixtures/wheel-golden.json`: derived 4,
  hitTest 2,185 (incl. 5 non-finite), placeWheel 260, isArmed 25, selection 42, fileCount 10,
  coords.win 302, displayForPoint/clamp/rounding 34. Also clean under AddressSanitizer +
  UBSan (UBSan findings abort the run since the hardening pass).
* Protocol parity: 56/56 helper→main samples valid. Main→helper verdicts are identical on
  5,058 lines (default, hardening pass: incl. whitespace/escape/number-spelling and
  lone-surrogate cases), 12,025 lines (`PARITY_ITERATIONS=6000`, after adding the three
  optional `strings` keys) and earlier 30,015 lines (`PARITY_ITERATIONS=15000`). The macOS
  helper's zod corpus (155 lines) gets the same verdicts, except the documented duplicate key.
* `orbitdrop-ole-tests.exe` (Windows-only OLE glue tests) **compiles and links under MinGW
  with `-Werror` but has not been run**. It runs in CI under MSVC (`ctest` plus a dedicated
  step) and in the build script on Windows.
* `Math.atan2`/`Math.hypot`: 1,000,800 Node vectors bit-exact at `-O0`/`-O2` with
  contraction off (the C libm differs on 21 % of them).
* MinGW from a clean build: 0 warnings with `-Werror`.
  - Imports: KERNEL32, USER32, GDI32, ole32, OLEAUT32 (BSTRs for UIA), SHELL32, SHCORE,
    ADVAPI32, WTSAPI32, d2d1, DWrite, and `api-ms-win-crt-*` (UCRT) only.
    `uiautomationcore.dll` is loaded on demand.
  - GUI subsystem; DllCharacteristics 0x160 (ASLR, high-entropy VA, NX).
  - `RT_MANIFEST` #1 with PerMonitorV2 and the version resource are embedded.

* An independent code review of `src/win/` read the code only; nothing was executed. It
  found no critical issues. Its findings were all fixed:
  - `WM_ENDSESSION`/Restart Manager exit
  - no pointers in window messages
  - the OLE guard covering whole `IDropTarget` methods
  - `WM_CLOSE` going through the core
  - the `CancelSynchronousIo` retry
  - hiding on `show()` failure
  - the bounded folder check
  - the no-dialog error mode and exception guards
  - idle-light key polling

  It confirmed COM lifetimes, shutdown order, the layered-window and Direct2D/DirectWrite/WIC
  calls, and the message return values.

`docs/screenshots/windows-helper-layout-preview-*.png` are **geometry-only
rasterisations on macOS** by `orbitdrop-layout-preview`: sector outlines, gaps, corners,
ring, capsule, highlight and alpha mask, with dots where labels go. They are *not*
Direct2D output. The real renderer's PNGs come from the CI artifact
`windows-helper-snapshots`.

## Manual verification checklist (Windows 11 x64, items 1–33)

Use the MSVC build (CI artifact or `node scripts/build-native-win.mjs` on Windows) and the
app's normal start. Set `ORBITDROP_HELPER_DEBUG=1` to get helper diagnostics on stderr and
as `log` messages. Record the OS build, display setup and result for each item.

1. **Start**: main receives `ready` with `globalDrag.available: true`. No window,
   taskbar entry or Alt+Tab entry appears. Task Manager shows one `OrbitDropHelper.exe`.
2. **Explorer drag + Shift → convert wheel**: drag `Page 001.pdf` a few pixels and press
   Shift.
   - The wheel appears centred on the pointer within ~100 ms, in neutral state with "여기에 놓기".
   - Explorer keeps focus (title bar stays active) and the drag continues.
   - On the next move: DOCX, JPG, PNG, TXT clockwise from the top. Capsule "PDF".
3. **Hover**: moving over JPG turns it orange with "JPG" in the capsule and the cursor
   shows Copy (+). Nothing is converted by hovering. The dead zone and the space outside
   the ring show no highlight and the no-drop cursor.
4. **Drop on JPG**: exactly one conversion job. `Page 001.jpg` appears next to the PDF and
   **the PDF is still there**. The wheel disappears.
5. **Copy vs Move**: hold Shift the whole time (Explorer's Shift default is Move) and drop
   on a sector. The source file must not be moved or deleted. Repeat with Ctrl+Shift
   (must not open the wheel; Explorer creates a link where you drop) and with Alt+Shift.
6. **Alt+Shift → tools wheel** with a JPG: COMPRESS, METADATA, EDIT, ANNOTATE, ADD BG, CROP,
   REDACT clockwise, with icons.
   - Press Shift then Alt quickly: tools without a visible convert flash.
   - Press Shift, wait, then add Alt: switches to tools.
   - Check that Alt+Shift does not switch the input language (OS hotkey conflict). If it
     does, note it and change the combo in settings.
7. **Modifier release**: after the wheel appears, release Shift and keep dragging. The
   wheel stays and a drop still works.
8. **Esc** during the drag: the wheel disappears (main gets `cancelled escape`) and does
   not come back during the same drag. Explorer cancels its drag.
9. **Leave / re-enter**: leave the ring (wheel stays, highlight clears), come back, drop.
   Leave and drop on the desktop instead: Explorer performs its normal action, the wheel
   disappears, main gets `cancelled dragEnded`.
10. **Refused drops**: release over the centre, outside the ring and over a disabled
    sector. Nothing runs and the wheel disappears (`outsideRing` / `disabledSector`).
11. **Non-file drags**:
    - Text from a browser, and a URL: the wheel shows "unsupported" and refuses.
    - An Outlook attachment or a file inside a .zip (virtual files): unsupported.
    - A folder: unsupported.
    - Shift held, then a text selection or marquee in an editor/Explorer: **no wheel at
      all**.
    - Shift pressed during such a selection: the neutral wheel disappears after a short
      movement.
    - A folder shows the folder text, an attachment the virtual text, plain text the
      non-file text.
12. **Multi-file**: two JPGs show "파일 2개". Crop/Edit/Annotate/Add BG/Redact are greyed
    with the multi-file reason; Compress works. PDF + PNG → mixed menu (DOCX, JPG, PNG).
13. **Rapid drops**: five drops in quick succession. Each produces exactly one job and no
    wheel stays on screen.
14. **DPI** 100, 125, 150 and 200 % (Settings → Display → Scale), at each step:
    - The wheel is crisp and has the same size in DIP.
    - Highlight follows the pointer exactly at sector borders, the dead-zone edge and the
      outer ring edge.
    - The transparent corners of the window are click-through and drag-through to the
      windows below.
15. **Secondary monitor left of / above the primary** (negative coordinates) with a
    different scale: the wheel appears on that monitor, inside its work area, with correct
    hit-testing. Drag across the monitor boundary with the wheel open: still consistent.
16. **Screen edges and corners and the taskbar**: activate at each edge and corner. The
    wheel is shifted fully inside the work area. An immediate release without moving does
    not select (arming); moving ≥ 6 DIP or through the centre arms.
17. **Drag image**: the file's drag image stays visible above the wheel. If it is hidden
    behind the wheel, report the z-order problem.
18. **Focus**: typing in the previously focused app keeps working after the wheel was shown.
19. **Sleep / lock**: Win+L or sleep during a drag hides the wheel (`cancelled sleep`).
    After unlock the next drag works.
20. **Parent exit**: kill the Electron app from Task Manager. The helper exits within about
    1 s and leaves no wheel or process behind.
21. **Elevation**: run OrbitDrop as administrator. `ready.globalDrag.available` is false with
    the UIPI reason and the app offers the Drop Zone.
22. **High contrast** theme and **reduced motion** (Settings → Accessibility): outlines
    visible, no fade.
23. **Swapped mouse buttons** (left-handed): the drag with the primary (right) button opens
    the wheel.
24. **Narrator** (Win+Ctrl+Enter):
    - On opening, the wheel is announced ("OrbitDrop wheel: Drop here"). Moving over
      sectors speaks each armed sector ("JPG") or a disabled sector's reason, without the
      wheel taking focus.
    - Inspect.exe shows the window as "OrbitDrop wheel" (Pane, not keyboard-focusable).
25. **Display change during a drag**: unplug a monitor or change its scale while the wheel
    is open on it. The wheel disappears (`cancelled error`) and the next drag works.

Added by the hardening pass (see `hardening-windows.md`):

26. **Immediate release** (OLE re-targeting without movement): drag a file over a *different*
    Explorer folder window, press Shift and release the button the moment the wheel appears,
    without moving. Expected: nothing is moved or copied into that folder, main gets
    `cancelled` (`outsideRing` or `dragEnded`). If the file lands in the folder underneath,
    OLE did not re-target to the wheel without a mouse move: report it (the wheel would then
    need a "move to arm" hint or a delayed release check).
27. **OneDrive Files On-Demand**: with an online-only file (cloud icon) the wheel shows
    "먼저 내려받으세요" / "Download it first" and refuses the drop; the file's status icon stays
    "online-only" (the drag did not download it). After "Always keep on this device" the same
    file converts normally. A locally available but unpinned file (green outline) converts.
28. **IDList-only drags**: Recycle Bin icon, a Control Panel item, a library in the
    navigation pane, "This PC": the wheel shows the non-file text and refuses.
29. **Recycle Bin contents**: drag a deleted file out of the Recycle Bin window and drop on
    a sector. Record what happens (refused because the source offers only Move, or
    converted with the output written inside `$Recycle.Bin`); report the second case to
    desktop-main.
30. **Virtual files**: an Outlook attachment, a file inside a .zip, an image dragged from a
    browser, a photo from a phone (MTP): the virtual text ("먼저 파일로 저장하세요"), refused.
31. **UAC variants**: (a) OrbitDrop run normally: `ready.globalDrag.available: true`;
    (b) run as administrator with UAC on: `false` with the integrity-level reason (item 21);
    (c) on a test machine with UAC off (`EnableLUA=0`) or as the built-in Administrator:
    `true`, and Explorer drags open the wheel.
32. **Long paths and mapped drives**: a file under a > 260-character path, a file on a
    mapped network drive (`Z:\`) and on a UNC path (`\\server\share`): menus and drops work,
    and a folder on each shows the folder text.
33. **Reduced motion toggled while running** (Settings → Accessibility → Animation effects):
    record whether the next wheel follows the new setting without restarting OrbitDrop
    (Electron reports no change event for this setting; see Requests).

## Known limitations and risks

* **Nothing GUI-related has run on Windows.** First risks to check:
  - Drag-image z-order versus our topmost layered window (item 17).
  - Whether the constant-alpha fade affects layered-window hit-testing during the first
    ~140 ms.
  - The Segoe icon code points (visual check).
  - Alt+Shift as the input-language hotkey (item 6).
* There is no global "OLE drag in progress" signal without hooks.
  - Ordinary Shift + drags (Shift held before the button) never show the wheel.
  - Pressing the combo *during* a non-file mouse drag (e.g. pressing Shift mid text
    selection) can show the neutral wheel briefly. It hides after movement without
    DragEnter, or on release.
* `GetAsyncKeyState`/`GetCursorPos` return nothing useful on the secure desktop (UAC prompt,
  lock screen). Behaviour with an elevated foreground window is unverified.
* Touch and pen drags: unverified (async button state may not reflect touch).
* The Win key is accepted as a modifier (`command`), but releasing it alone opens the Start
  menu. Settings do not currently warn about this; a Windows note is being added on the
  renderer side.
* Folder and cloud-placeholder detection runs after DragEnter on a worker thread. A drop
  made before it answers (normally milliseconds; longer on a slow network share) is
  validated by main instead, whose header read may then download a cloud-only file.
* The cloud-placeholder text is built into the helper (ko/en) until configure carries one.
* Whether OLE re-targets a drag to the freshly shown wheel without a mouse move is not
  documented (DoDragDrop "tracks mouse cursor movements and changes in the keyboard or mouse
  button state"); checklist item 26 verifies it.
* The UI Automation provider (window name and notifications of the armed sector) has not
  been checked with Narrator (checklist item 24).
* Lock and session disconnect are reported as `sleep` (there is no dedicated cancel reason).

## Requests

**desktop-main**

* Spawn: `child_process.spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })`.
  - Use plain `'pipe'`, **not `'overlapped'`**: the helper does synchronous I/O on its std handles.
  - Not `detached`. Keep stdin open for the helper's lifetime.
  - Path: `resources/helper/OrbitDropHelper.exe` when packaged (dev:
    `apps/desktop/resources/helper/win32-x64/`).
* Lifecycle:
  - Wait for `ready` (normally < 1 s), then send `configure`. The helper observes nothing
    before `configure`.
  - `shutdown`, or closing stdin, gives an orderly exit with code 0 after the wheel is
    hidden. A failing stdout write also makes it exit.
  - Restart on unexpected exit. Treat exit code 2 as "started without pipes".
* `ready.globalDrag.available === false` (e.g. elevated) → use the Drop Zone / open-file
  fallback and show the reason in diagnostics. Do not run OrbitDrop elevated.
* On Windows, wheel sessions start with `AwaitingPayload` and end with exactly one `drop`
  or `cancelled`. `Idle` is never sent; candidates are never announced. Ids are
  `w<pid hex>-<start hex>-<n>`.
* Stderr is diagnostics only (`ORBITDROP_HELPER_DEBUG=1`). Do not log `drop.files`.
* (hardening pass) Electron emits no event when Windows' "Animation effects" setting
  changes (`nativeTheme` 'updated' covers high contrast only), so `reduceMotion` in
  `configure` stays stale until something else reconfigures. Re-read
  `systemPreferences.getAnimationSettings()` on window focus or another regular trigger and
  reconfigure when it changed.
* (hardening pass) A wheel drop can no longer contain a cloud-only placeholder once the
  helper's attribute check has answered; the Drop Zone, the open dialog and drops faster
  than that check still reach `validateInputFile`, whose header read downloads the file.

**lead / contracts** (optional)

* zod 4.6.7 measures `z.string().max()` in code points. `HELPER_MAX_PATH_LENGTH`'s comment
  speaks of UTF-16 units. That is harmless (≤ 32,767 units implies ≤ 32,767 code points),
  but worth a note.
* Optionally add a `sessionLocked` cancel reason (Windows maps lock/disconnect to `sleep`).
* (hardening pass) Add an optional `strings.unsupportedCloud` (`z.string().max(60).optional()`)
  for the "download it first" centre text, then main sends it and both helpers accept it
  (both parse `strings` strictly, so all three must change together). Until then the Windows
  helper uses a built-in ko/en text.

**packaging-docs**: package the CI MSVC `OrbitDropHelper.exe` as an extra resource outside
asar. Refuse to ship a staged binary whose `BUILD_INFO.txt` says `CROSS-COMPILED`.

**macos-helper**: semantics were aligned with your controller (unannounced candidates,
press-completed mode switch, unlatched arming). Windows additionally waits for 40 ms of a
stable modifier set before activating, and hides a neutral wheel that gets no DragEnter
while moving. Both may be worth sharing. (hardening pass) Windows now reads escaped lone
surrogates as U+FFFD like your parser, and refuses cloud-only placeholders in the wheel;
iCloud "dataless" files (`SF_DATALESS`) could get the same treatment on macOS. Windows
accepts `1e-400` as 0 like JSON.parse, where Foundation refuses it.

**lead** (hardening pass): after the first green `native-windows` run, read the MSVC `/W4`
log and turn on `ORBITDROP_WARNINGS_AS_ERRORS` in the msvc presets.
