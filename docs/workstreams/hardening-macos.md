# hardening-macos — second, adversarial pass over the macOS helper

Date: 2026-10-22. Machine: macOS 26.6 (25G72) arm64, single built-in Retina display (2056 × 1329 pt, 2×),
Xcode 27.1 / Swift 6.4, Node 24.7.0. Scope: `native/macos/**`, `scripts/build-native-mac.mjs`,
`native/macos/scripts/**`, §8 of [macos-helper.md](macos-helper.md). No OS input was synthesized and no window
was put on screen: every check below runs on fakes (fake `NSDraggingInfo`, scripted input source, private
pasteboards, in-process notification centres, pipes), on the real binary over stdio, or is listed as **needs real
input** with the §8 step that covers it.

**Result: 11 defects fixed (plus 3 latent/theoretical ones and 2 test-harness gaps), each with a test, and
the lead's parity request (refuse online-only iCloud files like the Windows helper) implemented. D11 was a
regression of this pass's own D2 fix, caught by the independent review. `swift test` exit 0 — 167 tests
(Core 89, Kit 69, Process 9), 0 failures, 0 skipped, also with Swift's isolation checks made fatal (before: 138).**
The staged `darwin-arm64` helper was rebuilt (see Verification).

## 1. Defects found and fixed

| # | Defect | Fix | Test |
|---|---|---|---|
| D1 | **Protocol ≠ zod at the JSON level.** zod's verdict starts with `JSON.parse`; Foundation's decoder accepts trailing commas (`{"a":1,}`, `[1,]`, nested) and a UTF-8 BOM, which `JSON.parse` rejects — and it **rejects lone surrogate escapes** (`"\ud800"`), which `JSON.parse` keeps and zod accepts (`JSON.stringify` emits them for a split surrogate pair). One bad character in any label/reason made the helper drop the **whole `configure`** (global drag silently dead). Against HEAD's decoder the regenerated corpus disagreed on 10 lines. The review's fuzzing then found raw control bytes: a NUL-interleaved (UTF-16LE) `ping` line passes the UTF-8 check and Foundation decodes it as UTF-16; `JSON.parse` refuses any raw byte below 0x20 except tab/LF/CR. | `NDJSON.swift:83-101`: BOM and raw control bytes (`:87`) → `invalidJSON`; the one-pass pre-scan (`JSONKeyScanner.scan`, `:139`) also reports trailing commas and the offsets of lone-surrogate escapes (`:247`), which are rewritten to `\uFFFD` (same 6 bytes; zod counts one code point either way). | `ProtocolTests.testJSONParseParityForCommasBOMAndLoneSurrogates`; corpus +24 JSON-level cases (159 total) in `gen-fixtures.mjs`, `testDecoderAgreesWithZodOnEveryCase` |
| D2 | **A wedged AppKit thread kept a dead parent's helper (and its wheel) alive.** stdin EOF, EPIPE and SIGTERM/SIGINT/SIGHUP were all handled by queuing `terminate` on the main queue (signal sources even lived *on* the main queue). If the main thread was blocked — e.g. in a pasteboard read from a hung drag source — the helper never exited and a visible wheel stayed on screen after Electron died or killed it (spec §4: no window may remain). | `HelperApp.swift:31` `ExitWatchdog`; `parentGone` (`:195`) arms it from the reader thread, the writer queue or a background signal source (`:621`), then queues the graceful exit. If that has not finished after 3 s, `_exit(0)` ends the process (the window server removes its windows). `terminate` arms it too (`:204`). | `testExitWatchdogEndsTheProcessWhenMainIsWedged` (real `StdinReader` on a pipe, main thread blocked 0.6 s, forced exit at 0.2 s off-main, graceful path afterwards), `testExitWatchdogArmsOnceAndOnlyFiresAfterItsDeadline`, process `testSignalsExitCleanly` |
| D3 | **Screen lock did not end a session.** Only sleep, screens-asleep and fast user switching were observed; `com.apple.screenIsLocked` exists only as a distributed notification, which AppKit also *suspends* for inactive apps (this accessory helper is never active). | `HelperApp.swift:590-599`: observer with `suspensionBehavior: .deliverImmediately` → `.sleep` (`cancelled: sleep`, wheel hidden). | `testScreenLockEndsTheSession` (uniquely named distributed notification — posting the real one would reach every app), `testWorkspaceSleepAndUserSwitchEndTheSession` |
| D4 | **High contrast leaked opaque pixels outside the hit shape.** The caption pill's 1.5 pt outline was stroked centred on the pill edge: 772 opaque device pixels in the transparent 6 pt gap next to the disc (both caption placements), i.e. a strip where a drop beside the ring became our cancel instead of Finder's drop. The old alpha test only covered the light theme with the caption below. | `WheelRenderer.swift:220`: outline stroked inside the pill. | `testHitShapeStaysTransparentInEveryThemeAndPlacement` (light/dark/high contrast × caption below/above × Reduce Transparency) |
| D5 | **Reduce Transparency ignored.** Nothing (helper, main, tokens) honoured System Settings ▸ Accessibility ▸ Reduce transparency; the disc stayed 72 % translucent (spec §8: opaque background of the same palette when translucency hurts legibility). | `HelperApp.swift:445`: when the OS setting is on (read when a wheel is shown), `wheelDisc` is drawn opaque; everything else is drawn over it, outside the disc stays alpha 0. | `testReduceTransparencyDrawsAnOpaqueDisc` (dead-zone pixel alpha 0.72 → 1.0, corner 0) |
| D6 | **VoiceOver was silent for unsupported drags.** Announcements fired only for an armed sector, so "Folders aren't supported" / "Not a file" / "Save it as a file first" were visual-only. | `SessionTypes.swift:193`: the reject text of `.unsupported` content is announced (once per change). | `testUnsupportedDragIsAnnouncedOnce`, `SessionControllerTests.testUnsupportedPayloadIsAnnouncedButTheNeutralWheelIsNot` |
| D7 | **TCC queried on the AppKit thread.** `queryPermissions` called `AXIsProcessTrusted()` / `CGPreflightListenEventAccess()` (IPC to tccd) synchronously on main, contradicting macos-helper.md §3 ("off the main thread … never inside a mouse callback"); main sends it at every `ready` and polls it while permissions are missing. | `HelperApp.swift:242`: computed on a utility queue, sent from main. | `testPingAndPermissions` (provider runs off main; reply still arrives; cache updated) |
| D8 | **Session start and wheel position depended on global dragged events during another app's drag loop** — the main unmeasured assumption (§9). The 60 Hz poll read modifiers, buttons and the pasteboard but not the pointer, so without monitor `leftMouseDragged` events the wheel would open at a stale point, and the no-enter hide never armed. | `GlobalDragObserver.swift:199`: the poll also reports the pointer while the button is down (before the pasteboard and modifier checks; `:152` the same order for monitor events, so the controller also learns the button is down if it missed the mouse-down), so a combo completed in a tick opens the wheel at the current pointer. | `GlobalDragObserverTests.testPointerIsPolledWhenTheMonitorMissesDraggedEvents` |
| D9 | **`StderrLog` could crash the helper.** `FileHandle.write(_: Data)` raises an Objective-C exception on EPIPE once main closed stderr. | `StdioTransport.swift:136`: throwing `write(contentsOf:)` with `try?`. | (exception path; covered by code review — the stdio mode only logs to stderr when an outgoing message fails validation) |
| D10 | **Staging rewrote a signed binary in place.** `build-native-mac.mjs` copied over `resources/helper/<arch>/OrbitDropHelper` and stripped/signed it there; a helper running from that path (dev app, E2E, PoC harness) could be killed with a code-signature fault, and macOS caches signatures per file. | `scripts/build-native-mac.mjs:103-147`: finished under `.OrbitDropHelper.staging-<pid>` and renamed into place (temp file removed on failure). | stage run below (exit 0, no leftover file, smoke 18/18) |
| D11 | **Regression from D2, caught by the review: every signal tripped Swift 6's isolation check.** The new signal-source handler was a closure written inside a `@MainActor` method and passed to a non-`@Sendable` parameter (`DispatchSourceHandler`), so it inherited the main actor; on the global queue its entry check failed. With this runtime's default it printed "data race detected: @MainActor function at HelperApp.swift:623 was not called on the main thread" and still exited 0 (so the tests passed). With `SWIFT_UNEXPECTED_EXECUTOR_LOG_LEVEL=2` the helper aborted (SIGABRT) on every SIGTERM/SIGINT/SIGHUP — main's kill after a stop, its hang restarts, a Ctrl+C in the harness — with no `cancelled` for an open session. | `HelperApp.swift:626`: the handler is `@Sendable` (nonisolated). | process `testSignalsExitCleanly` (SIGTERM, SIGINT, SIGHUP); every process test and the smoke test now run the helper with `SWIFT_UNEXPECTED_EXECUTOR_LOG_LEVEL=2` and the smoke test fails on an isolation report (the pre-fix binary: `FAIL exits 0 on SIGTERM — signal SIGABRT`, 17/19); whole suite also green with the variable set |

Parity request from the lead (Windows refuses cloud-only placeholders itself):

| # | Change | Where | Test |
|---|---|---|---|
| P1 | **Online-only iCloud / File Provider files are refused by the helper**, from file attributes only: the existing off-main `stat()` of the dragged paths now also reads `st_flags`; `SF_DATALESS` → unsupported reason `cloudPlaceholder` with the built-in text **"먼저 내려받으세요" / "Download it first"** (by `configure.locale`, until `strings.unsupportedCloud` exists — not added to the contract), no Copy anywhere, release → `cancelled: invalidPayload`, VoiceOver hears the text. Nothing is opened or read (no hydration); nothing happens in the drag callbacks. A folder found by the same stat wins. | `Config.swift` (`UnsupportedReason.cloudPlaceholder`, `HelperStrings.cloudPlaceholderText`, `HelperConfig.unsupportedText`), `DragSessionController.swift` (`.fileInfo`), `DragPayload.swift` (`FileInfoResolver.Info`, `summarize`), `HelperApp.swift` (`Options.fileInfoResolver`) | `SessionControllerTests.testCloudPlaceholderIsRefusedWithTheBuiltInText` (ko + en), `PasteboardTests.testDatalessFlagMarksACloudPlaceholder` (synthetic `stat` — only root can set `SF_DATALESS`), `testOnlineOnlyCloudFileIsRefusedEndToEnd` (real view/drop target, injected stat result); real file: §8 step 24 |

Latent / theoretical, fixed because they were cheap:

| # | Issue | Fix | Test |
|---|---|---|---|
| L1 | `FileInfoResolver` summed `st_size` with `+=` → a trap (crash) on Int64 overflow. APFS caps a file at 2^55 bytes (measured here: 36 028 797 018 963 967), so it needs > 256 maximal files — only a network/FUSE file system reporting huge sizes could reach it. | `DragPayload.swift:93,101`: overflow → size unknown. | `testFileSizeSumNeverTraps` |
| L2 | Stale comment: the controller claimed displays are refreshed on every mouse-down (they are refreshed on `configure` and screen changes). | `DragSessionController.swift:20` | — |
| L3 | `HelperApp` left its distributed-notification observer registered after deallocation (one instance per process in production; many in tests). | `deinit` removes it. | — |

Test-harness gaps found on the way:

| # | Gap | Fix |
|---|---|---|
| T1 | The parity test read the corpus with `JSONSerialization`, which **drops a leading U+FEFF from string values** — the BOM case would silently have become a plain valid line. (`String(bytes:encoding:)` strips it as well; the helper only uses it as a UTF-8 check and parses the original bytes.) | `ProtocolTests` decodes the corpus with `JSONDecoder` and asserts the BOM survived. |
| T2 | `PasteboardTests.testFileURLsBecomeOwnedPaths` compared paths with Swift `==` (canonical equivalence), so NFC vs NFD was never checked byte for byte. | New `testNamesPassToTheDropMessageByteExact` compares UTF-8 bytes. |
| T3 | Swift 6 runtime isolation violations only *warn* by default, so the process tests could not see one (D11 passed every test). | Process tests and the smoke test run the helper with `SWIFT_UNEXPECTED_EXECUTOR_LOG_LEVEL=2`; the smoke test also fails on an isolation report on stderr. |
| T4 | The glue tests did not ignore SIGPIPE: an app from an earlier test writing to its replaced (closed) pipe would kill the whole xctest process. | `signal(SIGPIPE, SIG_IGN)` in `setUp` (as `HelperMain.run` does) and a flush before a pipe is replaced. |

Also: the configure fixtures were stale against main's current strings (changed in df1c903: "Folders aren’t
supported", "Save it as a file first", "Unsupported file", Korean equivalents); regenerated with
`gen-fixtures.mjs`, and §8 step 11 now quotes them.

## 2. Every check

Legend: **OK** = checked, behaves as specified (test named, or code reviewed where a test cannot reach); **fixed** =
see §1; **needs real input** = cannot be decided without a person dragging (the §8 step that covers it).

### 2.1 System events during a session

| Case | Result | Evidence |
|---|---|---|
| System sleep (`willSleep`) | OK → `cancelled: sleep`, hidden | `testWorkspaceSleepAndUserSwitchEndTheSession` |
| Display sleep (`screensDidSleep`) | OK → `sleep` | same |
| Fast user switching (`sessionDidResignActive`) | OK → `sleep` | same |
| Wake | OK: nothing to restore; the observer re-syncs from the hardware button state (poll emits the missed mouse-up, then stops) and a drag still in progress after wake cannot open a wheel (drag already confirmed) | code review, `testMissedMouseUpIsRecoveredFromTheButtonStateAndPollingStops` |
| Screen lock (`com.apple.screenIsLocked`) | **fixed (D3)**; main now also sends `cancelSession` for open sessions on sleep/lock — a cancel for an id the helper already ended is a no-op (exactly one terminal message) | `testScreenLockEndsTheSession`; real lock: §8 step 21 |
| Screen parameters change, wheel still on a screen | OK: wheel kept; hit-testing is panel-local, so a relocated panel stays consistent with its drawing | `testDisplayRemovalUnderTheWheelEndsTheSession` (first half) |
| Display under the wheel removed | OK → `cancelled: error`, hidden | same (screen frames injected, real notification path); real unplug: §8 step 21 |
| Spaces / full-screen apps | OK by configuration: `.canJoinAllSpaces + .fullScreenAuxiliary + .transient + .ignoresCycle`, level ≥ `.popUpMenu`, `hidesOnDeactivate = false`, non-activating, never key/main — pinned | `testPanelIsCreatedHiddenWhenObservationIsEnabled`; **needs real input** §8 step 17 |
| Mission Control / Stage Manager during a drag | `.transient` hides the panel in Mission Control; Stage Manager behaviour unknown | **needs real input** §8 step 17 |
| Focus stealing | OK: the real binary runs as an accessory app, is never active or frontmost, shows no window without a drag | process `testEnabledObservationNeedsNoPrompt` (extended) |
| Displays with different `backingScaleFactor` | Hit-testing is in points through the flipped view (golden `coords.mac` 150/150, mixed-scale layouts); the panel never moves during a session and is drawn after `setFrame`, AppKit re-renders layer-backed `drawRect:` views on backing changes | **needs real input** (one 2× display here) §8 step 23 |
| Secure Event Input (password field / Secure Keyboard Entry) | Mouse monitoring is unaffected (not keyboard input). Whether `NSEvent.modifierFlags` and the Esc key state are still readable is not documented | **needs real input** §8 step 22 |

### 2.2 Pasteboard content

| Case | Result | Evidence |
|---|---|---|
| File promises (Photos, Mail, Safari images) | OK: every `NSFilePromiseReceiver.readableDraggedTypes` type and the legacy `NSFilesPromisePboardType` (arrives as its dyn UTI) → virtual item, never Copy, "save it as a file first" | `testEveryPromiseFlavourIsVirtual` |
| Item with a file URL **and** promise types | Treated as the file (the source states it exists; main validates). Decision kept and pinned; reading a lazily provided file URL can make the source write a file — inherent to reading drag data in drag-enter | `testEveryPromiseFlavourIsVirtual`; §9 of macos-helper.md |
| iCloud dataless files | Now refused **by the helper too** (P1): `SF_DATALESS` from the off-main `stat()` → "Download it first", `invalidPayload`. Main keeps its own check for drops made before the stat result arrives (`packages/core/src/node/validate.ts`: header read with a 5 s timeout, `blocks == 0` / cloud-root heuristic → `CLOUD_PLACEHOLDER`). The helper never opens or reads a file: monitor callbacks touch no file system; `draggingEntered` reads the pasteboard (and resolves a rare `file:///.file/id=` URL); the drop callback makes no pasteboard/FS call; the only file-system call is one `stat()` per path on a global queue (metadata; does not materialize a dataless file) | `testFileInfoResolverNeverOpensTheFile` (a FIFO named `.pdf` would block any open/read), `testDatalessFlagMarksACloudPlaceholder`, `testOnlineOnlyCloudFileIsRefusedEndToEnd`, `testDropReusesThePathsCapturedAtDragEnter`, `testFileInfoResolverStatsOffMain`; **needs real input** §8 step 24 |
| Finder alias files | Decision in main (`detectLinkFile` → `UNSUPPORTED_FORMAT` with the alias hint). An alias without a supported extension is "unsupported" in the wheel; one named like a supported file gets a menu and is refused after the drop | code review |
| Packages (`.app`, `.rtfd`) | OK: folder URL (trailing `/`) → folder text | `testPackagesAreFolders` |
| 1 000+ items | OK: at most 201 items read, "too many", fast | `testThousandsOfItemsReadAtMostTheLimitPlusOne` (1 500 items) |
| Paths longer than PATH_MAX | OK: accepted (main's file check decides); > 32 767 code points → unsupported; 200 maximal paths never produce an oversized line (drop refused as `invalidPayload`) | `testLongPathsWithinProtocolLimits`, `testDropEncodingAndLimits` |
| Non-UTF-8 name (`%FF` in the URL) | OK: `URL.path` gives `""` → unsupported; never sent as an empty or different path | `testNonUTF8FileURLIsUnsupportedNeverAnEmptyPath` |
| Newline / quote / backslash / percent / emoji in names | OK: one line, round-trips exactly | `testNamesPassToTheDropMessageByteExact` |
| NFD names | OK: NFD and NFC both pass byte-exact (note: `NSURL` itself writes NFD to the pasteboard; the helper never re-normalizes) | same |

### 2.3 Protocol robustness

| Case | Result | Evidence |
|---|---|---|
| Oversized lines | OK: framer discards without buffering, logged | `testFramerDropsOversizedLinesWithoutBuffering`, `testLineLimitIsExactlyMaxBytes`, smoke |
| Invalid UTF-8 | OK: rejected | `testErrorsNameTheField` |
| Duplicate keys | OK: rejected (documented divergence) | corpus, `testErrorsNameTheField` |
| Trailing commas, BOM, lone surrogate escapes, raw control bytes (NUL / UTF-16) | **fixed (D1)** | see §1 |
| Literals that underflow (`1e-400`) | Documented divergence: zod accepts (0), Foundation refuses; unreachable (`JSON.stringify` writes `0`) | corpus case pinned |
| Unknown types / fields, wrong types, out-of-range numbers, safe integers, `-0`, `1e400` | OK | corpus (159 lines, 57 valid) |
| String limits in code points | OK: every limit uses `unicodeScalars.count` (grep: no `String.count` limit); lone surrogates count one, like zod | corpus (emoji, flags, combining marks, lone surrogates) |
| stdin EOF → fast exit | OK: exit 0 in 5 ms; **fixed (D2)** when main is wedged | smoke, `testExitsWhenStdinCloses`, `testExitWatchdogEndsTheProcessWhenMainIsWedged` |
| SIGPIPE on stdout | OK: ignored → EPIPE → clean exit 0 (measured 9 ms) | process `testClosedStdoutEndsTheHelperCleanly`, `testBrokenPipeIsReportedOnce` |
| Writer thread safety | OK: 8 threads × 400 sends → 3 200 intact lines, per-thread order kept | `testConcurrentSendersProduceIntactLinesInPerThreadOrder` |
| Slow / stalled reader | OK: 3 000 sends (> 600 KB) with nobody reading return in < 1 s; everything arrives later | `testSendNeverBlocksOnAStalledReader` |
| Restart idempotency | OK: 50 × `configure` → one monitor; enable/disable toggles mid-session → one `cancelled parentRequest`; next session works | `testRepeatedConfigureAndEnableTogglesAreIdempotent` |
| Session-id uniqueness | OK: `m<pid>-<random>-<counter>`, unique across restarts | `testIdsAreSchemaValidAndUniqueAcrossRestarts`, idempotency test |

### 2.4 Memory and handles

| Case | Result | Evidence |
|---|---|---|
| 1 200 synthetic sessions (drop, Esc, release grace, neutral no-enter) through the real app, view and drop target | OK: malloc bytes in use changed by −23 KB … +256 B across six runs (≈ 0 B/session); no timer left, panel hidden | `testManySyntheticSessionsDoNotGrow` |
| `leaks --atExit` on that test | OK: 289 leaks / 18 864 B — **identical** to a trivial test (`testPanelIsCreatedHiddenWhenObservationIsEnabled`): 3 LinkServices `NSXPCConnection` cycles (`com.apple.linkd.autoShortcut`) and one XCTest weak-reference table; none from the helper | `leaks` runs below |

### 2.5 Rendering and accessibility

| Case | Result | Evidence |
|---|---|---|
| Alpha 0 outside the disc and caption pill | OK light/dark; **fixed (D4)** high contrast; now checked for every theme × caption below/above × Reduce Transparency | `testHitShapeStaysTransparentInEveryThemeAndPlacement` |
| Caption pill | OK (shown only while armed, opaque, part of the hit shape by design) | existing tests + above |
| VoiceOver label / value / announcements | OK (label "OrbitDrop", value = capsule, armed choice); **fixed (D6)** unsupported reason | `testAnnouncesTheArmedChoiceOncePerChange`, `testUnsupportedDragIsAnnouncedOnce`; spoken by VoiceOver from a background app: **needs real input** §8 step 18b |
| Increase Contrast | OK: main maps `nativeTheme.shouldUseHighContrastColors` (macOS Increase contrast) to `highContrast` and re-sends `configure` on `NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification` (`apps/desktop/src/main/app.ts`) | code review |
| Reduce Transparency | **fixed (D5)** | `testReduceTransparencyDrawsAnOpaqueDisc`; real toggle §8 step 18d |
| Reduce Motion | OK (main's value; the OS turning it on is followed until the next `configure`) | `testOSReduceMotionFollowedUntilTheNextConfigure` |

### 2.6 PoC harness and §8

| Case | Result |
|---|---|
| Harness output: pass/fail obvious? | **Improved.** Every line validated with zod; per-session rules (AwaitingPayload first, WheelActive before a drop, exactly one terminal message, nothing after it, no state `Idle`/`PotentialDrag`, none open at the end) print `!!` at once; a wheel open > 20 s is a `??` warning that does not fail the run (long drags are fine); summary ending in `RESULT: PASS/FAIL` (exit 0/1); a fixture that no longer matches the contracts is an error (exit 2) instead of silently turning zod off; a second Ctrl+C force-kills a helper that does not exit; spawn errors and `stdin` EPIPE are handled. Checked with the real helper (PASS), a canned fake helper with 5 deliberate violations (all flagged, FAIL) and a missing helper (exit 2). |
| `--guided` mode | New: per step "do / expect", Enter, automatic verdict from the messages, y/n for visual parts, final step table. Driven with canned answers (PASS / FAIL / SKIP rows). |
| §8 checklist | Steps 1–20 keep their numbers. Step 11 quotes main's current strings; 17 adds Mission Control / Stage Manager; 18 adds the VoiceOver unsupported text, the high-contrast caption outline and Reduce Transparency; new 21 (screen lock / sleep / display removal), 22 (Secure Keyboard Entry), 23 (mixed-scale displays), 24 (online-only iCloud file: refused, nothing downloaded). The guided harness covers 1–18 and 21–24 (19 = Ctrl+C at the end, 20 = Intel hardware). |

## 3. Verification (exact results)

| Command | Result |
|---|---|
| `swift build --package-path native/macos` | exit 0, no warnings |
| `swift test --package-path native/macos` | **exit 0**; `OrbitDropHelperCoreTests.xctest` 89 tests, 0 failures; `OrbitDropHelperKitTests.xctest` 69 tests, 0 failures; `OrbitDropHelperProcessTests.xctest` 9 tests, 0 failures; 167 `Test Case … passed`, 0 failed, 0 skipped, 0 warnings; all golden sections pass (hitTest 4360/4360, placement 1040/1040, coords.mac 504/504 + 150/150 via `WheelView`, selection 78/78, fileCount 68/68, …). |
| `SWIFT_UNEXPECTED_EXECUTOR_LOG_LEVEL=2 swift test --package-path native/macos` (isolation checks fatal in-process too) | **exit 0**; 89 / 69 / 9 tests, 0 failures |
| same, against HEAD's `NDJSON.swift` (new corpus) | exit 1: 10 disagreements (5 trailing-comma/BOM lines accepted, 5 lone-surrogate lines rejected) — the D1 evidence |
| `node --import tsx native/macos/scripts/gen-fixtures.mjs` | regenerated; `js-math-vectors.json` / `geometry-vectors.json` unchanged, `configure-{ko,en}.json` follow main's strings, `protocol-cases.json` 155 cases |
| `node scripts/gen-golden.mjs --check` | exit 0, `tests/fixtures/wheel-golden.json is up to date` |
| `node --import tsx native/macos/scripts/smoke-test.mjs <binary> --expect-arch arm64` (now with fatal isolation checks and a stderr check) | debug build: PASS 19/19 (zod). Pre-D11 staged binary: **FAIL 17/19** (`exits 0 on SIGTERM — signal SIGABRT`, `data race detected … HelperApp.swift:623`) — the regression is now caught. |
| `node scripts/build-native-mac.mjs --arch arm64` | **exit 0 — staged helper rebuilt** (after D11; two earlier stages of this pass are superseded): `apps/desktop/resources/helper/darwin-arm64/OrbitDropHelper` 838 304 B, sha256 `41ae8131a6688d28003fe3462be0c7ec0f55196bfbd4d935ce387b6c7743ef38`, `flags=0x10002(adhoc,runtime)`, minos 14.0, smoke 19/19 (zod), no staging file left; SIGTERM/SIGINT/SIGHUP each exit 0 with no isolation report. `darwin-x64` was **not** re-staged (still the 2026-10-21 build; packaging rebuilds both). |
| `leaks --atExit -- xctest -XCTest OrbitDropHelperKitTests.DropTargetGlueTests/testManySyntheticSessionsDoNotGrow …KitTests.xctest` | 289 leaks for 18 864 total leaked bytes (system objects only; same as the baseline run on a trivial test) |
| PoC harness, real debug helper and the re-staged helper, SIGINT after 2.5 s | `RESULT: PASS`, exit 0 (both) |
| PoC harness, canned fake helper with violations | 5 anomalies, `RESULT: FAIL`, exit 1 |
| PoC harness, missing helper path | message + exit 2 |
| Independent read-only code review of this diff (resumed after the API limit) | Verdict "request changes": one critical finding — **D11** — plus three warnings and five nits, **all fixed**: harness stuck-wheel no longer fails a long drag; the watchdog test no longer assumes a 50 ms scheduling bound; glue tests ignore SIGPIPE (an earlier test's app writing to a closed pipe could have killed the test run) and flush before replacing a pipe; raw control bytes (D1); `.dragged` order matches `poll()` (D8); `testPingAndPermissions` asserts a cache change that can fail; harness fixture/second-Ctrl+C/spawn-error handling. Its differential fuzz of the pre-scan against `JSON.parse` (~275 000 cases) found no false flags beyond the control-byte gap. |

## 4. Open items

* Everything marked **needs real input** (§8 steps 9, 17, 18b, 21–24 in particular) — the user's Finder run.
* Drag-pasteboard baseline race: the baseline `changeCount` is read in the mouse-down callback. A source that
  writes the drag pasteboard before that callback runs (at mouse-down, faster than the monitor delivery) would
  not open a wheel for that drag. Finder writes it when its drag starts after a few points of travel; other apps
  are unmeasured (§8 general).
* No-enter hide with a stalled source: if the source app's drag loop stalls > 400 ms while the pointer moves over
  the neutral wheel, the wheel is hidden as `invalidPayload` (the pointer is now polled, so this heuristic works
  without monitor events — and so can misfire for a hung source). Not observed; would show in §8 step 2.
* A drop whose JSON line would exceed 1 MiB (needs > ~5 KB average path length × 200 files) shows Copy over a
  sector but is refused at the drop (`invalidPayload`) instead of showing "unsupported" up front. Theoretical.
* `DefaultConfig.strings` (the helper's built-in snapshot/test defaults) still use the earlier wording for the
  three optional unsupported texts; production always uses main's `configure`.
* FYI from the review: Node 24.7.0's `JSON.parse` returned a wrong key for one escaped-key pattern while fuzzing
  (`{"]":null,"\\":1}` followed by `{"]":null,"\"":1}`). `gen-fixtures.mjs` takes zod's verdicts from `JSON.parse`; the
  corpus's only escaped-key case checks out, but be careful when adding escaped-key cases.

## 5. Requests

* **lead / verification.md**: the PoC row says "§8 20단계" — §8 now has 24 steps (21–24 appended; 1–20
  unchanged), and the harness has `--guided` with a per-step verdict table worth pasting into the PoC record.
* **contracts (later, as the lead planned)**: an optional `strings.unsupportedCloud` would let main localize the
  online-only text; the macOS helper would prefer it over its built-in "먼저 내려받으세요" / "Download it first"
  (one line in `HelperConfig.unsupportedText`). Not added now. Optional: if the renderer's own windows should honour
  Reduce Transparency, `wheelTokens` could take it — the helper handles the wheel locally from the OS setting.
* **windows-helper**: the same JSON-level cases are in `native/macos/Tests/OrbitDropHelperCoreTests/Fixtures/protocol-cases.json`
  (generated by `native/macos/scripts/gen-fixtures.mjs`); its parity tool already reads lone surrogates as
  U+FFFD and rejects a BOM, so both helpers agree.
