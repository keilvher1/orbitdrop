# Workstream: hardening-windows

Second, adversarial pass over the Windows drag helper (`native/windows`, C++17 Win32/OLE)
on 2026-10-22, after the windows-helper workstream (`windows-helper.md`, 86 host tests,
zod parity, MinGW `-Werror` build).

**There is no Windows machine.** The portable core (`src/core`) was built and run on macOS
(Apple clang 21, plus AddressSanitizer + UBSan). The Win32 layer (`src/win`) was
cross-compiled with MinGW-w64 (GCC 16.2, `-Werror`) and reviewed against the Microsoft
documentation, but **never executed**. Every row below says whether a test verified it or
it was reviewed only. Nothing here counts as a GUI verification of Explorer drags.

## Summary

Defects found and fixed:

| # | Defect | Where | Verified by |
|---|---|---|---|
| D1 | Duplicate-key detection compared every key with all earlier keys (O(n²)): a 1 MiB line of distinct keys kept the stdin reader thread busy for 2.1–2.5 s on an M-series Mac, delaying `cancelSession`/`shutdown` behind it. Now one sort per finished object: 3.3 / 2.4 ms. | `src/core/json.cpp:82`, `:202` | host tests `json: duplicate keys are found in objects of any size`, `json: lines with tens of thousands of keys …` (+ timing) |
| D2 | `ready.globalDrag.available` was false for every **administrator with UAC off and for the built-in Administrator**: `TokenIsElevated` is true there, yet Explorer runs at the same integrity level and drags work. Now the helper compares its integrity level with the shell's process (`GetShellWindow`), falling back to `TokenElevationTypeFull`. | `src/win/win_util.cpp:57`, `:78`; `src/win/app.cpp:105` | reviewed only (checklist 31) |
| D3 | Control Flow Guard covered only the helper's own sources: `orbitdrop_core` (session controller calling its `Host` through virtual functions, `std::function`, `std::visit`) was compiled without `/guard:cf`, so its indirect calls were unchecked. Now `/guard:cf` is in the shared MSVC compile flags. | `CMakeLists.txt:41`, `:193` | reviewed only (first MSVC CI run) |
| D4 | Virtual files offered only as the ANSI `FileGroupDescriptor` (no `…W`, no `CF_HDROP`) were classified as non-file ("Not a file") instead of virtual ("Save it as a file first"). | `src/win/drop_target.cpp:133` | OLE glue test (Windows-only, built, not run) |
| D5 | Protocol errors echoed an unknown key verbatim (`"C:\Users\…\secret.pdf: unknown field"`), although errors must never echo message content. Keys are now named only when they look like field names (`[A-Za-z0-9_]{1,40}`), else `<key>`. | `src/core/protocol.cpp:183`, `:241` | host test `helper core: invalid messages are reported without echoing contents` |
| D6 | An escaped lone surrogate (`"\ud800"`, valid for JSON.parse and zod, written by JSON.stringify for a split pair) made the whole line `invalidJson`, while the macOS helper (its own hardening pass) reads it as U+FFFD. Now Windows does the same; verdicts equal zod's. | `src/core/json.cpp:257`, `:306` | host test `json: escaped lone surrogates read as U+FFFD …`; parity; macOS corpus |
| D7 | UBSan was recoverable: a test run could pass with "runtime error" lines in its log. `-fno-sanitize-recover=undefined` makes findings fatal. | `CMakeLists.txt:58-59` | clean ASan build: flag on all 26 units, 0 reports |
| D8 | `build-native-win.mjs --core-tests` did not run the ASan/UBSan build although the command is described (and was used as) "host tests with ASan/UBSan"; `--parity` silently skipped when the protocol tool was missing. | `scripts/build-native-win.mjs:158`, `:165` | the command now runs both builds (output below) |
| D9 | The CI trigger paths missed the contract files that define the protocol's enums and ids (`schemas.ts`, `actions.ts`, `menus.ts`, `formats.ts`) and `core/capabilities.ts` (used by the parity check), so a change there would not re-run Windows parity. | `.github/workflows/native-windows.yml:10-25`, `:28-43` | YAML parsed (3 jobs, 16 paths each) |

Hardening (not reachable with today's main, made robust anyway):

| # | Change | Where | Verified by |
|---|---|---|---|
| H1 | A poll tick dispatched by a COM wait loop *inside* an `IDropTarget` method (e.g. during `IDataObject::GetData` in `DragEnter`) could see the button release and end the session (`dragEnded`) just before OLE delivers the `Drop` for that release. The poll now skips while an OLE method runs; the next tick follows 15 ms later. Window operations were already deferred. | `src/win/app.cpp:336` | reviewed only |
| H2 | `ReadFile` → `ERROR_MORE_DATA` (a message-mode pipe with a message longer than the buffer) was treated as end of input → exit. Node's pipes are byte mode, so main never triggers it. | `src/win/stdio_channel.cpp:85` | reviewed only |
| H3 | The long-path rewrite in the folder worker turned a `\\.\` device path into `\\?\UNC\.\…`. | `src/win/folder_check.cpp:13` | reviewed only |

Decision (asked for by the lead): **cloud-only placeholders** are detected by the helper's
existing worker thread with `GetFileAttributesW` (metadata only: nothing is downloaded, no
file-system call in `DragEnter`/`DragOver`) and refused in the wheel with
"먼저 내려받으세요" / "Download it first". Details in check 1.6. Code:
`src/core/selection.cpp:192`, `src/core/session.cpp:357`, `:572`, `src/win/folder_check.cpp:84`.
Tests: `selection: file attributes → folder / cloud-only placeholder`,
`session: cloud-only placeholders are refused, never read`, two new CI snapshots with
capsule assertions.

No protocol change. One request for an optional configure string (see Requests).

## Checks

Legend: **test** = verified by a test that ran here; **CI test** = test written and
compiled (MinGW), runs on `windows-latest`, not run yet; **reviewed** = code read against
the cited documentation, nothing executed.

### 1. Data objects

| # | Case | How | Result | Fix / test |
|---|---|---|---|---|
| 1.1 | CF_HDROP sizing: `DragQueryFileW(h, i, NULL, 0)` = "required size, in characters, of the buffer, *not including* the terminating null character"; the copy call returns "a count of the characters copied, not including the terminating null" ([DragQueryFileW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-dragqueryfilew)) | reviewed + CI test | OK: buffer `len + 1`, result must equal `len`, else `badPath` | — |
| 1.2 | Paths > MAX_PATH, `\\?\…`, UNC | CI test (> MAX_PATH, UNC, Hangul, emoji) + reviewed | OK. `\\?\` paths pass through unchanged; the worker adds `\\?\` / `\\?\UNC\` for long paths | H3 (`\\.\` device path) |
| 1.3 | Mapped drives (`Z:\`) | reviewed | OK: the helper runs non-elevated in Explorer's logon session, so the drive letter resolves (an elevated process would not see it) | checklist 32 |
| 1.4 | Virtual files (`CFSTR_FILEDESCRIPTORW` + `CFSTR_FILECONTENTS`, no `CF_HDROP`: Outlook attachments, zip items, browser images, MTP) | CI test + reviewed | W form OK; **ANSI-only descriptor misclassified** | D4; checklist 30 |
| 1.5 | IDList-only drags (`CFSTR_SHELLIDLIST`: Control Panel item, Recycle Bin icon, library, This PC) | reviewed | OK: no `CF_HDROP`, no descriptor → non-file text ("파일이 아님"), refused | checklist 28 |
| 1.6 | OneDrive / Dropbox Files On-Demand placeholders | test (classifier, controller) + CI test (snapshots) + reviewed | Before: offered; main's header read downloads ("hydrates") the file and reports `CLOUD_PLACEHOLDER` only on a 5 s timeout. **Decision**: Node cannot see the attributes and any read hydrates, so the helper's worker (already calling `GetFileAttributesW` off the UI thread for folders) also reports `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (0x400000, "reading the file … will cause at least some of the file … content to be fetched from a remote store") and `FILE_ATTRIBUTE_OFFLINE` (0x1000); the wheel refuses such a drag (spec §9: local files only; same advice as main's `CLOUD_PLACEHOLDER` text). `FILE_ATTRIBUTE_RECALL_ON_OPEN` is deliberately **not** used: it "only appears in directory enumeration classes", and with `GetFileAttributesW` its value 0x40000 is `FILE_ATTRIBUTE_EA` (files with extended attributes would be refused) ([File Attribute Constants](https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants)). A folder wins; a placeholder only changes an otherwise supported drag; a drop faster than the worker still goes to main | implemented; checklist 27; request `strings.unsupportedCloud` |
| 1.7 | Lone surrogates in NTFS names | CI test + reviewed (+ portable `utf16ToUtf8` tests) | OK: `WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS)` fails "by returning 0 and setting the last-error code to ERROR_NO_UNICODE_TRANSLATION" ([docs](https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-widechartomultibyte)) → `badPath` → refused with the generic text, reason `badPath` in the debug log. The name never reaches JSON, so the output stays valid UTF-8 | — |
| 1.8 | Items dragged out of the Recycle Bin | reviewed | Open: either refused (if the source offers Move only) or converted with output inside `$Recycle.Bin` | checklist 29 |

### 2. OLE / COM

| # | Case | How | Result | Fix / test |
|---|---|---|---|---|
| 2.1 | `OleInitialize` / `OleUninitialize` on the UI thread (STA); S_FALSE balanced too | reviewed | OK (`app.cpp` initialize/shutdown, same thread; failure → `globalDrag.available: false`) | — |
| 2.2 | `RegisterDragDrop` / `RevokeDragDrop` pairing and order | reviewed | OK: revoke before `DestroyWindow`, after `wheel_.hide`; `WM_ENDSESSION` revokes early only outside OLE callbacks; `detach()` stops forwarding while OLE may still hold references | — |
| 2.3 | `QueryInterface` / `AddRef` / `Release` | reviewed + CI test | OK (IUnknown/IDropTarget only, `E_NOINTERFACE` + null out, interlocked count, private destructor) | — |
| 2.4 | `IDataObject` not kept after `Drop` | reviewed | OK: paths copied into owned UTF-8 strings, medium released; only the shell's `IDropTargetHelper` holds it between `DragEnter` and `Drop`/`DragLeave`, by design | — |
| 2.5 | `DROPEFFECT_COPY` only when the source allows Copy, else `DROPEFFECT_NONE`; never Move/Link. "On entry … *pdwEffect* … must be set to the allowed effects passed to the *pdwOkEffect* parameter of DoDragDrop" ([DragOver](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nf-oleidl-idroptarget-dragover)) | test (session) + CI test (all 7 allowed-effect sets) | OK | — |
| 2.6 | `grfKeyState`; Shift's default Move ("No keys or SHIFT → DROPEFFECT_MOVE" in the DragOver table) must never produce a move | reviewed + tests | OK: modifiers come from the poll; the returned effect is Copy or None regardless of keys, so the source never deletes | — |
| 2.7 | Re-entrancy: COM wait loops inside `GetData` / `IDropTargetHelper` may dispatch messages | reviewed | Window operations were deferred (OleGuard); a nested poll tick could still end a session mid-`DragEnter` | H1 |

### 3. Threads

| # | Case | How | Result | Fix / test |
|---|---|---|---|---|
| 3.1 | stdin reader → UI thread only via a payload-less `PostMessage` + locked inbox; 1 s housekeeping drain | reviewed | OK (a spoofed wake is an empty drain) | — |
| 3.2 | stdout writes serialized | reviewed | OK: one writer thread owns stdout; critical lines never dropped, `log` lines capped at 8 MiB backlog | — |
| 3.3 | Broken pipe → clean exit | reviewed + CI test (smoke: EOF → exit 0) | OK | — |
| 3.4 | Parent death | reviewed | OK: libuv creates main's pipe end non-inheritable, so main's death breaks the pipe → `ERROR_BROKEN_PIPE` → exit. `ORBITDROP_PARENT_PID` (set by main) is not needed | — |
| 3.5 | Message-mode pipes | reviewed | `ERROR_MORE_DATA` ended the helper | H2 |
| 3.6 | Reader-thread CPU on a 1 MiB line | test (timed) | quadratic duplicate-key scan | D1 |

### 4. System events

| # | Case | How | Result | Fix / test |
|---|---|---|---|---|
| 4.1 | `WM_DPICHANGED` (Per-Monitor V2 manifest + `SetProcessDpiAwarenessContext`) | reviewed + test (`displaysChanged`) | OK: the wheel window posts a re-check; moving the wheel to another monitor keeps the session (its monitor is unchanged), a rescaled monitor cancels (`error`) | — |
| 4.2 | `WM_DISPLAYCHANGE` | reviewed + test | OK (hidden top-level message window receives it) | — |
| 4.3 | `WM_POWERBROADCAST` suspend/resume | reviewed + test (`setSuspended`) | OK: `cancelled sleep`, polling off until resume. Main now also sends `cancelSession` on suspend/lock and re-sends `configure` on resume: compatible (an ended session ignores the cancel; a re-configure keeps an open session's snapshot) | — |
| 4.4 | WTS lock/unlock (`WTSRegisterSessionNotification`, `NOTIFY_FOR_THIS_SESSION`) | reviewed | OK. If registration fails at early logon, polling just continues; on the secure desktop `GetAsyncKeyState`/`GetCursorPos` report nothing, so no session can start | — |
| 4.5 | `WM_SETTINGCHANGE` (high contrast, client-area animations) | reviewed | Helper: nothing to do (main owns `highContrast`/`reduceMotion` through `configure`; a session keeps its snapshot; drag width and swapped buttons are read on every poll). Gap on main's side: Electron emits no event for the animation setting | request; checklist 33 |

### 5. Layered window

| # | Case | How | Result | Fix / test |
|---|---|---|---|---|
| 5.1 | `UpdateLayeredWindow(ULW_ALPHA)` with premultiplied BGRA | reviewed | OK: Direct2D DC target `B8G8R8A8_UNORM` + `D2D1_ALPHA_MODE_PREMULTIPLIED`; the mask keeps colour ≤ alpha; `SetLayeredWindowAttributes` never called (it would make later `UpdateLayeredWindow` calls fail) | — |
| 5.2 | Pixels outside the disc alpha 0 → not hit-testable for OLE drops | test (per-pixel mask = hit-test predicate at 100–200 %) + reviewed | OK. Rule: "Hit testing of a layered window is based on the shape and transparency of the window. This means that the areas of the window that are color-keyed or whose alpha value is zero will let the mouse messages through. However, if the layered window has the WS_EX_TRANSPARENT extended window style, the shape of the layered window will be ignored" ([Window Features → Layered Windows](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features#layered-windows)); `DoDragDrop` "determines the window under the current cursor location" ([DoDragDrop](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-dodragdrop)). The wheel has no `WS_EX_TRANSPARENT` | — |
| 5.3 | Dead zone and gaps stay hit-testable (alpha ≥ 1), so OLE asks us and we refuse | test | OK | — |
| 5.4 | No focus stealing: `WS_EX_NOACTIVATE`, `SW_SHOWNOACTIVATE`, `MA_NOACTIVATE`, `SWP_NOACTIVATE`, `WS_EX_TOOLWINDOW` | reviewed | OK | — |
| 5.5 | Topmost without activation; drag image above the wheel | reviewed | OK; the `SysDragImage` z-order tweak stays best effort (checklist 17) | — |
| 5.6 | Fade-in constant alpha 40 | reviewed | Disc alpha 0xB8 × 40/255 ≈ 29 > 0, so the disc stays hit-testable even if Windows multiplies the constant alpha in; only anti-aliased edge pixels could flicker for ~140 ms | — |
| 5.7 | OLE re-targeting to a freshly shown wheel without a mouse move | reviewed | Not documented (DoDragDrop "tracks mouse cursor movements and changes in the keyboard or mouse button state") | checklist 26 |

### 6. Protocol robustness (same rules as macOS)

| # | Case | How | Result | Fix / test |
|---|---|---|---|---|
| 6.1 | String limits in Unicode code points like zod | test (parity) + zod source read | OK: zod 4.6.7 `$ZodCheckMaxLength` uses `util.codePointLength` (pair = 1, lone surrogate = 1); parity covers astral, escaped pairs and lone surrogates at the 32-label limit | — |
| 6.2 | Oversized lines (> 1,048,576 bytes) | test + CI test (smoke) | OK (`lineTooLong`, reported once per line, line discarded) | — |
| 6.3 | Invalid UTF-8 | test | OK (`invalidJson`) | — |
| 6.4 | Duplicate keys | test | Rejected (documented in the contract), but quadratic | D1 |
| 6.5 | Escaped lone surrogates | test + parity + macOS corpus | Rejected, unlike zod and macOS | D6 |
| 6.6 | Out-of-range and odd numbers | test (parity) | OK: `1e400` rejected; `1e-400` → 0 (valid nonce, like JSON.parse); `5e-324` not an integer; `9007199254740991.4` rounds to MAX_SAFE (valid); `9007199254740992.5` invalid; `1E0`, `1.0`, `-0` valid; `v: 1.0000000000000002` → `protocolVersion` | — |
| 6.7 | Unknown types, wrong `v` | test + CI test | OK (`unknownType`, `protocolVersion`) | — |
| 6.8 | Errors never echo content | test | Unknown keys were echoed | D5 |
| 6.9 | Whitespace, BOM, NBSP, escaped keys | test (parity) | OK: leading space / trailing CR / tab accepted, BOM and trailing NBSP rejected (JSON.parse too), `"\u0076"` key = `v` | — |
| 6.10 | Value-count limit (50,000) | test (parity, intentional difference) | A zod-valid configure with > 50,000 JSON values (e.g. 50,001 extension keys, ~700 KB) is rejected by the helper; main's configure has ~1,600 values. Kept as a memory bound and now pinned by the parity script | — |

### 7. Build and CI

| # | Case | How | Result | Fix / test |
|---|---|---|---|---|
| 7.1 | Static CRT `/MT` (no VC++ redistributable) | reviewed | OK (`CMAKE_MSVC_RUNTIME_LIBRARY`, CMP0091 NEW via `cmake_minimum_required(3.21)`) | — |
| 7.2 | Warning levels | test (GCC/Clang `-Werror`: 0 warnings, clean builds) + reviewed | MSVC `/W4` without `/WX`: policy now documented (first MSVC compile ever must still yield an artifact) | request to the lead |
| 7.3 | Control Flow Guard | reviewed | core library not instrumented | D3 |
| 7.4 | ASLR / DEP / high-entropy VA | reviewed (MSVC flags) + test (MinGW PE: DllCharacteristics 0x160) | OK | — |
| 7.5 | Manifest: `PerMonitorV2, PerMonitor` + `true/pm`, Win10/11 `supportedOS`, `asInvoker` (MinGW explicit, MSVC linker default `/MANIFESTUAC`), `longPathAware` | reviewed | OK | — |
| 7.6 | `native-windows.yml` would build and test on `windows-latest` | reviewed + YAML parsed | OK: presets need CMake ≥ 3.25 (runner has newer), default VS generator with `-A x64`, `ctest` runs core + OLE tests, build script runs the smoke test with 13 snapshots (2 new, with capsule assertions); path filters fixed | D9 |
| 7.7 | Sanitizers | test | UBSan was recoverable | D7 |
| 7.8 | Build script `--core-tests` | test | ran no ASan; `--parity` could skip silently | D8 |
| 7.9 | MSVC readiness of includes (MSVC's STL has fewer transitive includes) | test (indicative) | All 26 core/test sources compile with libc++ `_LIBCPP_REMOVE_TRANSITIVE_INCLUDES`; Win32 includes audited by hand | — |

### 8. Elevation / UIPI

| # | Case | How | Result | Fix / test |
|---|---|---|---|---|
| 8.1 | Helper must report global drag unavailable exactly when UIPI blocks Explorer's drags | reviewed | False negatives with UAC off / built-in Administrator | D2; checklist 21, 31 |

## What changed

| File | Change |
|---|---|
| `src/core/json.cpp`, `json.h` | D1 (sort-based duplicate check per object), D6 (lone surrogate escapes → U+FFFD) |
| `src/core/protocol.cpp` | D5 (`safeKey` for unknown-field reports) |
| `src/core/selection.h`, `.cpp` | `PathFacts`, `addFileAttributes`, `Unsupported::CloudPlaceholder` |
| `src/core/session.h`, `.cpp` | `Host::checkFolders` → `checkPaths`; `fileInfo(sessionId, PathFacts)`; built-in cloud text |
| `src/win/folder_check.h`, `.cpp` | worker reports folders and cloud-only placeholders; H3 |
| `src/win/drop_target.h`, `.cpp` | D4 (ANSI file group descriptor) |
| `src/win/app.h`, `.cpp` | `checkPaths`; H1 (no poll inside OLE methods); D2 wiring and reason text |
| `src/win/win_util.h`, `.cpp` | D2 (`shellDragsBlockedByIntegrity` replaces `isProcessElevated`) |
| `src/win/stdio_channel.cpp` | H2 |
| `src/win/snapshot.cpp`, `main.cpp` | `--render-snapshot --state cloud` |
| `CMakeLists.txt` | D3 (`/guard:cf` everywhere), D7 (fatal UBSan), MSVC warnings policy comment |
| `tests/test_json.cpp`, `test_selection.cpp`, `test_session.cpp`, `test_helper_core.cpp` | 5 new tests (86 → 91), updated lone-surrogate and folder tests |
| `tests/win/test_ole_glue.cpp` | ANSI-descriptor case; `checkPaths` |
| `tests/tools/protocol-parity.mjs` | 19 parser edge cases, 5 lone-surrogate cases, pinned intentional differences, optional macOS corpus |
| `tests/tools/stdio-smoke.mjs` | 2 cloud snapshots; capsule assertions for 4 snapshots |
| `scripts/build-native-win.mjs` | D8 (`--core-tests` runs ASan/UBSan, `--no-asan`; `--parity` fails without the tool) |
| `.github/workflows/native-windows.yml` | D9 (path filters); parity job `--no-asan` |
| `docs/workstreams/windows-helper.md` | design sections, protocol details, build policy, evidence, checklist 26–33, requests |

## Verification (macOS 26.6 arm64, 2026-10-22)

| Command | Exit | Result |
|---|---|---|
| `node scripts/build-native-win.mjs --core-tests --parity` | 0 | host Release: **91 tests run, 0 failed, 0 failed checks**; ASan + UBSan (Debug): **91 run, 0 failed**, 0 sanitizer reports; parity: **56** helper→main samples valid, **5,058** main→helper lines with identical verdicts (360 accepted by zod, 4,698 rejected), **2** intentional differences confirmed, macOS corpus **155** lines equal (1 duplicate-key line rejected as documented) |
| `node scripts/build-native-win.mjs --cross` | 0 | MinGW `-Werror`, DLL imports within the allowlist (ADVAPI32, DWrite, GDI32, KERNEL32, OLEAUT32, SHCORE, SHELL32, USER32, WTSAPI32, d2d1, ole32, `api-ms-win-crt-*`); staged `OrbitDropHelper.exe` sha256 `4230665e0055a9ede2e7365660b1b08e9a3cc01990575eeb4a1236b19c8b00d3`, labelled CROSS-COMPILED / NOT VERIFIED |
| `node scripts/gen-golden.mjs --check` | 0 | `wheel-golden.json is up to date` |
| Clean builds in fresh directories (host Release `-Werror`; host ASan/UBSan; MinGW `-Werror` incl. helper + OLE tests) | 0 / 0 / 0 | 0 warnings; 91/91 and 91/91; MinGW 40 objects, 0 warnings, GUI subsystem, DllCharacteristics 0x160 |
| Perf harness (same 1 MiB lines, `-O2`) | — | before: 2,071.7 ms and 2,503.6 ms; after: 3.3 ms and 2.4 ms |
| C++ verdicts on the macOS zod corpus (155 lines) | — | before D6: 6 mismatches (1 duplicate key + 5 lone surrogates); after: 1 (duplicate key, documented in the contract) |
| libc++ without transitive includes, `-fsyntax-only`, 26 core/test sources | — | 0 failures |

Not run anywhere: everything in `src/win/` (and `orbitdrop-ole-tests.exe`, `stdio-smoke.mjs`,
the snapshots). They run on the first `native-windows` CI run on `windows-latest`.

## What a person must verify on real Windows

The manual checklist in `windows-helper.md` (items 1–33). Items added by this pass:

* 26 — immediate release right after the wheel appears (does OLE re-target without a move?).
* 27 — OneDrive online-only file refused with "Download it first" and **not** downloaded.
* 28 — IDList-only drags (Recycle Bin icon, Control Panel, libraries) → non-file text.
* 29 — files dragged out of the Recycle Bin (record the outcome).
* 30 — virtual files (Outlook, zip, browser image, phone).
* 31 — UAC on / off / built-in Administrator → `globalDrag.available` as expected (D2).
* 32 — long paths, mapped drives, UNC.
* 33 — reduced-motion toggle while running.

Also on the first CI run: the MSVC compile itself (never done), the `/W4` warning log, and the
`dumpbin /headers` "Guard" line (D3).

## Open items

* MSVC has never compiled this code; compile errors are possible on the first CI run (the
  includes were audited and compile without libc++'s transitive includes, which is a good
  but not complete proxy for MSVC's STL).
* `/CETCOMPAT` (CET shadow stacks) is not set. It would be a further exploit mitigation;
  left out because it changes runtime behaviour that cannot be tried here.
* Cloud-placeholder text is built into the helper until configure carries one.
* Whether a drop beats the attribute check (then main reads, and hydrates, the file) is
  timing-dependent; normally the worker answers in milliseconds.
* Checklist 26 may show that OLE does not re-target without movement; then an immediate
  release over the centre would drop onto the window underneath (Explorer's normal action
  for that window).
* `WTSRegisterSessionNotification` is not retried if it fails at early logon (harmless, see 4.4).

## Requests

* **lead / contracts**: optional `strings.unsupportedCloud: z.string().max(60).optional()` in
  `HelperConfigureSchema`. Both helpers parse `strings` strictly, so contracts, main and both
  helpers must change together; the Windows helper then prefers it over its built-in text.
* **lead**: after the first green MSVC CI run, read the `/W4` log and enable
  `ORBITDROP_WARNINGS_AS_ERRORS` in the msvc presets; consider `/CETCOMPAT`.
* **desktop-main**: re-read `systemPreferences.getAnimationSettings()` on a regular trigger
  (e.g. window focus) and reconfigure the helper when it changed — Electron has no change
  event for Windows' "Animation effects".
* **macos-helper**: for parity with the Windows decision, consider refusing iCloud
  "dataless" files (`SF_DATALESS`) in the wheel. FYI: Windows now reads escaped lone
  surrogates as U+FFFD like your parser; Windows accepts `1e-400` as 0 like JSON.parse.

## Follow-up: secondary caption (2026-10-23)

The macOS VM run found that a wide drag image can cover the centre capsule
([verification.md](../verification.md), finding 2). The macOS helper repeats the choice in a
caption pill outside the ring. The Windows helper had no such caption; it now has the same one.
Design and checklist item 34 are in [windows-helper.md](windows-helper.md). Effect on the checks
above:

| # | Change | Where | Verified by |
|---|---|---|---|
| C1 | The window is the disc's bounding square plus a caption strip, with the macOS rule and numbers: 6 + 26 DIP below the disc, above it near the bottom of the work area, none if neither fits. In pixels it is the enclosing rectangle plus a one-pixel border, instead of placeWheel's 408 DIP `windowFrame` (still computed for the golden `coords.win` vectors). | `src/core/coords.cpp` (`computePanelLayout`, `computeWheelFrame`) | test (work-area edges, 150 % negative coordinates, the exact-edge pixel; golden coords.win 302/302 unchanged) |
| C2 | Hit shape (5.2, 5.3): alpha ≥ 1 on the disc **and the visible caption pill**, 0 everywhere else. The mask moved from the renderer into the portable core (`coords::applyHitShape`), so the code the renderer runs is the code under test. | `src/core/coords.cpp`, `src/win/renderer.cpp` | test (per pixel against `hitTestWheel` + the pill at 100/125/150/175/200 %, both placements, painted and blank buffers); layered-window behaviour on the pill: reviewed only |
| C3 | Caption rule: the capsule's text while it is in the Active or Reject style (armed choice, refused sector, unsupported drag). Never for the neutral wheel, the info text or an enabled sector hovered before arming, and never without a strip (the macOS rule; a disabled or Copy-refused sector's reason shows before arming, as the Windows capsule already did). | `src/core/session.cpp` (`refreshModel`) | test (scenario tests incl. arming on a shifted wheel and the pre-arming refusal) |
| C4 | OLE (2.x): a refused release on the visible pill reaches our `DragLeave` and is reported like one on the disc (`outsideRing`; `invalidPayload` for an unsupported drag). Anywhere else in the strip the window below gets the drop (`dragEnded`). In practice only an unsupported drag keeps a pill under the pointer: a supported drag's pill vanishes when the pointer reaches it, and a release there reports `dragEnded`. | `src/core/session.cpp` (`dragLeave(…, onCaption)`), `src/win/app.cpp`, `src/win/wheel_window.cpp` | controller: test; glue: MinGW `-Werror`, reviewed |
| C5 | Rendering: pill measured with DirectWrite (one line: separators become spaces; the ellipsis at the shrunk size), opaque `capsule`/`capsuleReject` fill, `capsuleText`, high-contrast outline inside the pill, no shadow. UI Automation unchanged: the caption repeats the centre text, which is already announced. | `src/win/renderer.cpp` (`drawCaption`) | MinGW `-Werror`, reviewed; CI snapshots assert caption text, placement and that the pill was drawn |

An independent review read the diff and ran scratch experiments (nothing on Windows). It
mutated the new core code 26 ways and the tests caught 24; the two survivors change no
behaviour. It fuzzed the layout and the hit shape over 20,000 random frames (12 DPIs from 100
to 400 %, negative monitor origins, the taskbar on every edge): no shape pixel fell outside the
window, and the pill never overlapped the disc or left its strip. Its findings were fixed: a
comment that called the caption rule identical to macOS (Windows shows a refused sector's
reason before arming), the missing test for that, a race-only test case, and three renderer
details (stale pill after a failed render, ellipsis size, line breaks in a reason).

No protocol or contract change.

Verification (macOS 26.6 arm64, 2026-10-23):

| Command | Exit | Result |
|---|---|---|
| `node scripts/build-native-win.mjs --core-tests --parity` | 0 | host Release **99 run, 0 failed** (92 before; 7 new caption tests); ASan + UBSan **99 run, 0 failed**, no sanitizer reports; parity unchanged: 56 helper→main samples, 5,061 main→helper lines (370 accepted, 4,691 rejected), 2 intentional differences, macOS corpus 162 lines |
| `node scripts/build-native-win.mjs --cross` | 0 | MinGW `-Werror`, DLL imports within the allowlist, staged exe labelled CROSS-COMPILED / NOT VERIFIED (sha256 in `windows-helper.md`) |
| `node scripts/gen-golden.mjs --check` | 0 | `wheel-golden.json is up to date` |
| Clean builds in fresh directories (MinGW `-Werror` incl. helper + OLE tests; host Release `-Werror`) | 0 / 0 | 40 and 26 compile units, 0 warnings; host 99/99 |

Not run anywhere: the pill on screen, the layered window's hit-testing on it, and the new CI snapshot
assertions (`stdio-smoke.mjs`, 15 snapshots). A person checks checklist item 34 on Windows.
