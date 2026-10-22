import AppKit
import Darwin
import XCTest

@testable import OrbitDropHelperCore
@testable import OrbitDropHelperKit

/// A stand-in for AppKit's dragging session object, so the real WheelView
/// NSDraggingDestination methods can be called without a real drag.
final class FakeDraggingInfo: NSObject, NSDraggingInfo {
  weak var window: NSWindow?
  var draggingSourceOperationMask: NSDragOperation
  var draggingLocation: NSPoint
  let pasteboard: NSPasteboard

  init(window: NSWindow?, location: NSPoint, mask: NSDragOperation, pasteboard: NSPasteboard) {
    self.window = window
    draggingLocation = location
    draggingSourceOperationMask = mask
    self.pasteboard = pasteboard
  }

  var draggingDestinationWindow: NSWindow? { window }
  var draggedImageLocation: NSPoint { draggingLocation }
  var draggedImage: NSImage? { nil }
  var draggingPasteboard: NSPasteboard { pasteboard }
  var draggingSource: Any? { nil }
  var draggingSequenceNumber: Int { 1 }
  func slideDraggedImage(to screenPoint: NSPoint) {}
  var draggingFormation: NSDraggingFormation = .default
  var animatesToDestination = true
  var numberOfValidItemsForDrop = 0
  func enumerateDraggingItems(
    options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass],
    searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void
  ) {}
  var springLoadingHighlight: NSSpringLoadingHighlight { .none }
  func resetSpringLoading() {}
}

/// Reads the helper's NDJSON output from a pipe.
final class OutputPipe {
  let readFD: Int32
  let writeFD: Int32
  private var text = ""

  init() {
    var fds: [Int32] = [0, 0]
    precondition(pipe(&fds) == 0)
    readFD = fds[0]
    writeFD = fds[1]
    _ = fcntl(readFD, F_SETFL, fcntl(readFD, F_GETFL) | O_NONBLOCK)
  }

  func messages() -> [[String: Any]] {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(readFD, &buffer, buffer.count)
      if n <= 0 { break }
      text += String(decoding: buffer[0..<n], as: UTF8.self)
    }
    return text.split(separator: "\n").map { try! JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
  }

  deinit { close(readFD) }
}

@MainActor
final class DropTargetGlueTests: XCTestCase {
  var output: OutputPipe!
  var app: HelperApp!
  var pasteboard: NSPasteboard!
  var announcements: [String] = []
  var osReduceMotion = false
  nonisolated(unsafe) static var permissionQueriedOnMain: Bool?
  nonisolated(unsafe) static var permissionsReplyBuiltOnMain: Bool?

  func makeApp(observeWith source: DragInputSource? = nil, customize: (inout HelperApp.Options) -> Void = { _ in }) -> HelperApp {
    output = OutputPipe()
    var options = HelperApp.Options()
    options.outputFD = output.writeFD
    options.readStdin = false
    options.presentWindows = false
    options.exitProcess = false
    options.observeGlobally = source != nil
    options.inputSource = source
    options.announcer = { [unowned self] text in announcements.append(text) }
    options.reduceMotionProvider = { [unowned self] in osReduceMotion }
    options.inputMonitoringProvider = {
      DropTargetGlueTests.permissionQueriedOnMain = Thread.isMainThread
      return true
    }
    options.permissionsProvider = {
      DropTargetGlueTests.permissionsReplyBuiltOnMain = Thread.isMainThread
      return [PermissionItem(name: .accessibility, required: false, granted: false), PermissionItem(name: .inputMonitoring, required: false, granted: true)]
    }
    options.reduceTransparencyProvider = { false }
    customize(&options)
    let app = HelperApp(options: options)
    app.start()
    return app
  }

  override func setUp() async throws {
    app = makeApp()
    pasteboard = NSPasteboard(name: NSPasteboard.Name("com.orbitdrop.helper.glue.\(UUID().uuidString)"))
    pasteboard.clearContents()
  }

  override func tearDown() async throws {
    pasteboard.releaseGlobally()
  }

  func messages() -> [[String: Any]] {
    app.flushOutput()
    return output.messages()
  }

  func spin(_ seconds: TimeInterval = 0.05) {
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
  }

  /// Starts a drag near the main screen's center and presses the combo: the wheel "appears" (never on screen).
  func openWheel(modifiers: Set<ModifierKey> = [.shift], config: HelperConfig = DefaultConfig.config(locale: .en)) throws -> (WheelView, NSWindow) {
    app.handle(.configure(config))
    let display = try XCTUnwrap(SystemInfo.displays().first)
    let start = Point(x: display.workArea.x + display.workArea.width / 2, y: display.workArea.y + display.workArea.height / 2 - 100)
    app.simulateObserved(.mouseDown(start, held: []))
    app.simulateObserved(.mouseDragged(Point(x: start.x + 8, y: start.y)))
    app.simulateObserved(.dragPasteboardChanged)
    app.simulateObserved(.modifiersChanged(modifiers))
    XCTAssertEqual(app.sessionPhase, .potentialDrag, "waits for the modifiers to settle")
    XCTAssertTrue(app.fireTimerForTests(.modifierSettle))
    XCTAssertEqual(app.sessionPhase, .awaitingPayload)
    let view = try XCTUnwrap(app.dropTargetView as? WheelView)
    let window = try XCTUnwrap(view.window)
    XCTAssertFalse(window.isVisible, "tests never put the panel on screen")
    let model = try XCTUnwrap(app.currentModel)
    XCTAssertEqual(model.presentation.placement.center.x, start.x + 8, accuracy: 1e-9, "centered on the pointer")
    XCTAssertEqual(Double(view.bounds.width), model.presentation.layout.frame.width)
    XCTAssertEqual(Double(view.bounds.height), model.presentation.layout.frame.height)
    return (view, window)
  }

  /// Window-base location (y up) for a point given relative to the disc center (y down).
  func location(_ view: WheelView, dx: Double, dy: Double) -> NSPoint {
    let disc = app.currentModel!.presentation.layout.discCenter
    return NSPoint(x: disc.x + dx, y: Double(view.bounds.height) - (disc.y + dy))
  }

  // MARK: Drops

  func testDropOnJpgSectorSendsExactlyOneCopyDrop() throws {
    let (view, window) = try openWheel()
    let path = "/Users/someone/Desktop/Page 001.pdf"
    pasteboard.writeObjects([URL(fileURLWithPath: path) as NSURL])
    let atCenter = FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: 0), mask: .every, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(atCenter), [], "dead zone")
    XCTAssertFalse(atCenter.animatesToDestination)
    XCTAssertEqual(app.currentModel?.content.sectors.map(\.label), ["DOCX", "JPG", "PNG", "TXT"])

    let overJpg = FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .every, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingUpdated(overJpg), .copy, "Copy, never Move")
    XCTAssertEqual(app.currentModel?.highlight, SectorHighlight(index: 1, style: .active))
    XCTAssertEqual(app.currentModel?.capsule.text, "JPG")
    XCTAssertEqual(app.currentModel?.caption?.text, "JPG", "secondary hint below the disc")
    XCTAssertTrue(view.prepareForDragOperation(overJpg))
    XCTAssertTrue(view.performDragOperation(overJpg))
    XCTAssertFalse(view.performDragOperation(overJpg), "a second drop for the same session is refused")
    spin()
    XCTAssertNil(app.currentModel, "hidden on the next run-loop turn")

    let all = messages()
    XCTAssertEqual(all.map { $0["type"] as! String }, ["ready", "state", "state", "drop"])
    let drop = all[3]
    XCTAssertEqual(drop["files"] as? [String], [path])
    XCTAssertEqual(drop["actionId"] as? String, "convert.jpeg")
    XCTAssertEqual(drop["dropEffect"] as? String, "copy")
    XCTAssertEqual(drop["sessionId"] as? String, all[1]["sessionId"] as? String)
  }

  /// #15: the pasteboard is read once at drag-enter; re-entry and the drop reuse those paths.
  func testDropReusesThePathsCapturedAtDragEnter() throws {
    let (view, window) = try openWheel()
    let path = "/Users/someone/Desktop/a.pdf"
    pasteboard.writeObjects([URL(fileURLWithPath: path) as NSURL])
    _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: 0), mask: .every, pasteboard: pasteboard))
    app.wheelDraggingExited(pointerInsideDisc: false, buttonDown: true)
    // If anything read the pasteboard again it would now see text (unsupported) and refuse the drop.
    pasteboard.clearContents()
    pasteboard.setString("changed", forType: .string)
    XCTAssertFalse(app.wheelNeedsPayload())
    let back = FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .every, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(back), .copy)
    XCTAssertTrue(view.performDragOperation(back))
    spin()
    XCTAssertEqual(messages().last?["files"] as? [String], [path])
  }

  func testSourceWithoutCopyIsRejected() throws {
    let (view, window) = try openWheel()
    pasteboard.writeObjects([URL(fileURLWithPath: "/tmp/a.pdf") as NSURL])
    let moveOnly = FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .move, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(moveOnly), [])
    XCTAssertEqual(view.draggingUpdated(moveOnly), [])
    XCTAssertFalse(view.prepareForDragOperation(moveOnly))
    XCTAssertFalse(view.performDragOperation(moveOnly))
    spin()
    XCTAssertFalse(messages().map { $0["type"] as! String }.contains("drop"))
    XCTAssertEqual(messages().last?["reason"] as? String, "invalidPayload")
  }

  /// #8: specific unsupported texts (and the fallback) through the real drop target.
  func testUnsupportedDragsShowSpecificTexts() throws {
    let (view, window) = try openWheel()
    pasteboard.setString("hello", forType: .string)
    let info = FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: -120), mask: .every, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(info), [])
    XCTAssertEqual(app.currentModel?.content, .unsupported)
    XCTAssertEqual(app.currentModel?.capsule, CapsuleContent(text: "Not a file", style: .reject))
    XCTAssertTrue(messages().last?["menuKey"] is NSNull)
    XCTAssertFalse(view.performDragOperation(info))
  }

  func testFolderDragShowsTheFolderText() throws {
    let (view, window) = try openWheel()
    pasteboard.writeObjects([URL(fileURLWithPath: "/Users/someone/Pictures", isDirectory: true) as NSURL])
    _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: 0), mask: .every, pasteboard: pasteboard))
    XCTAssertEqual(app.currentModel?.capsule.text, "Folders aren't supported")
  }

  func testToolsComboAndExitReentry() throws {
    let (view, window) = try openWheel(modifiers: [.alt, .shift])
    pasteboard.writeObjects([URL(fileURLWithPath: "/tmp/photo.png") as NSURL])
    _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: 0), mask: [.copy, .generic], pasteboard: pasteboard))
    XCTAssertEqual(app.currentModel?.content.sectors.first?.actionId, .toolCompress)
    app.wheelDraggingExited(pointerInsideDisc: false, buttonDown: true)
    XCTAssertNotNil(app.currentModel)
    let back = FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: -125), mask: [.copy, .generic], pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(back), .copy)
    XCTAssertTrue(view.performDragOperation(back))
    spin()
    XCTAssertEqual(messages().last?["actionId"] as? String, "tool.compress")
  }

  func testCancelSessionFromMainHidesTheWheel() throws {
    _ = try openWheel()
    let id = try XCTUnwrap(messages().last?["sessionId"] as? String)
    app.handle(.cancelSession(sessionId: id))
    spin()
    XCTAssertNil(app.currentModel)
    XCTAssertEqual(messages().last?["reason"] as? String, "parentRequest")
  }

  // MARK: Panel lifecycle and hit shape

  /// #17: the panel (and its drag registration) exists, hidden, as soon as observation is enabled.
  func testPanelIsCreatedHiddenWhenObservationIsEnabled() throws {
    XCTAssertNil(app.panelForTests, "nothing before configure")
    app.handle(.configure(DefaultConfig.config(locale: .en)))
    let panel = try XCTUnwrap(app.panelForTests)
    XCTAssertFalse(panel.isVisible)
    let view = try XCTUnwrap(app.dropTargetView)
    XCTAssertTrue(view.registeredDraggedTypes.contains(.fileURL))
    XCTAssertTrue(panel.styleMask.contains(.nonactivatingPanel))
    XCTAssertFalse(panel.canBecomeKey)
    XCTAssertFalse(panel.canBecomeMain)
    XCTAssertFalse(panel.isOpaque)
    XCTAssertEqual(panel.backgroundColor, .clear)
    XCTAssertTrue(panel.hasShadow, "window-server shadow: never hit-testable")
    // Hardening: shown on the active Space and above full-screen apps, hidden by Mission Control,
    // never in the window cycle, never hidden when another app is active.
    XCTAssertTrue(panel.collectionBehavior.isSuperset(of: [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]))
    XCTAssertFalse(panel.collectionBehavior.contains(.moveToActiveSpace), "exclusive with canJoinAllSpaces")
    XCTAssertGreaterThanOrEqual(panel.level.rawValue, NSWindow.Level.popUpMenu.rawValue)
    XCTAssertFalse(panel.hidesOnDeactivate)
    XCTAssertTrue(panel.isFloatingPanel)
    XCTAssertFalse(panel.isVisible)
    var off = DefaultConfig.config(locale: .en)
    off.enabled = false
    app.handle(.configure(off))
    XCTAssertFalse(panel.isVisible)
  }

  /// #11: the live view paints nothing outside the disc and the caption pill, so those
  /// pixels stay alpha 0 and drags there pass through to the window underneath.
  func testLivePanelIsTransparentOutsideTheDiscAndCaption() throws {
    let (view, window) = try openWheel()
    pasteboard.writeObjects([URL(fileURLWithPath: "/tmp/a.pdf") as NSURL])
    _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .every, pasteboard: pasteboard))
    _ = view.draggingUpdated(FakeDraggingInfo(window: window, location: location(view, dx: 121, dy: 0), mask: .every, pasteboard: pasteboard))
    let model = try XCTUnwrap(app.currentModel)
    XCTAssertNotNil(model.caption)
    let layout = model.presentation.layout
    let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
    view.cacheDisplay(in: view.bounds, to: rep)
    let scale = Double(rep.pixelsWide) / Double(view.bounds.width)
    let radius = model.presentation.placement.diameter / 2
    let captionRect = try XCTUnwrap(layout.captionRect)
    var opaqueOutside = 0
    var captionPixels = 0
    var transparentStrip = 0
    for py in 0..<rep.pixelsHigh {
      for px in 0..<rep.pixelsWide {
        let x = (Double(px) + 0.5) / scale
        let y = (Double(py) + 0.5) / scale
        let alpha = rep.colorAt(x: px, y: py)?.alphaComponent ?? 0
        let r = ((x - layout.discCenter.x) * (x - layout.discCenter.x) + (y - layout.discCenter.y) * (y - layout.discCenter.y)).squareRoot()
        let inCaptionStrip = y >= captionRect.y && y <= captionRect.maxY
        if r <= radius + 1.5 { continue }  // disc (+ antialiased edge)
        if inCaptionStrip {
          if alpha > 0.5 { captionPixels += 1 } else if alpha == 0 { transparentStrip += 1 }
          continue
        }
        if alpha > 0 { opaqueOutside += 1 }
      }
    }
    XCTAssertEqual(opaqueOutside, 0, "corners of the disc's square and the gap above the caption are fully transparent")
    XCTAssertGreaterThan(captionPixels, 100, "the caption pill is drawn (and is part of the hit shape by design)")
    XCTAssertGreaterThan(transparentStrip, captionPixels / 4, "the strip beside the pill stays transparent")
  }

  // MARK: Accessibility and motion

  /// #16: VoiceOver hears the armed choice once per change.
  func testAnnouncesTheArmedChoiceOncePerChange() throws {
    let (view, window) = try openWheel(config: DefaultConfig.config(locale: .en))
    pasteboard.writeObjects([URL(fileURLWithPath: "/tmp/photo.png") as NSURL])
    _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: 0), mask: .every, pasteboard: pasteboard))
    for dy in [-120.0, -121, -122] {
      _ = view.draggingUpdated(FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: dy), mask: .every, pasteboard: pasteboard))
    }
    _ = view.draggingUpdated(FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .every, pasteboard: pasteboard))
    XCTAssertEqual(announcements, ["JPG", "HEIC: No HEIC encoder in this build"])
  }

  /// #18: the OS turning Reduce Motion on overrides main's `reduceMotion: false` until the next configure.
  func testOSReduceMotionFollowedUntilTheNextConfigure() throws {
    _ = try openWheel()
    XCTAssertTrue(app.lastShowAnimated, "main said reduceMotion: false")
    app.handle(.cancelSession(sessionId: messages().last?["sessionId"] as? String ?? ""))
    spin()
    osReduceMotion = true
    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: NSWorkspace.shared)
    spin()
    XCTAssertTrue(app.osReduceMotionOverride)
    // Next drag without a new configure: no animation.
    let display = try XCTUnwrap(SystemInfo.displays().first)
    let start = Point(x: display.workArea.x + 300, y: display.workArea.y + 300)
    app.simulateObserved(.mouseUp(start))
    app.simulateObserved(.mouseDown(start, held: []))
    app.simulateObserved(.mouseDragged(Point(x: start.x + 8, y: start.y)))
    app.simulateObserved(.dragPasteboardChanged)
    app.simulateObserved(.modifiersChanged([.shift]))
    XCTAssertTrue(app.fireTimerForTests(.modifierSettle))
    XCTAssertFalse(app.lastShowAnimated)
    app.simulateObserved(.escape)
    spin()
    XCTAssertFalse(app.lastHideAnimated)
    // A new configure from main wins again.
    app.handle(.configure(DefaultConfig.config(locale: .en)))
    XCTAssertFalse(app.osReduceMotionOverride)
  }

  /// #15: Input Monitoring is asked off the main thread and cached (not per mouse-down).
  func testPermissionStatusIsCachedOffTheMainThread() throws {
    DropTargetGlueTests.permissionQueriedOnMain = nil
    app = makeApp()
    for _ in 0..<20 where !app.cachedInputMonitoringGranted { spin(0.02) }
    XCTAssertEqual(DropTargetGlueTests.permissionQueriedOnMain, false)
    XCTAssertTrue(app.cachedInputMonitoringGranted)
    XCTAssertTrue(app.observerForTests.escapePollingAllowed)
  }

  func testPingAndPermissions() throws {
    DropTargetGlueTests.permissionsReplyBuiltOnMain = nil
    app.handle(.ping(nonce: 99))
    app.handle(.queryPermissions)
    var all = messages()
    for _ in 0..<100 where !all.contains(where: { $0["type"] as? String == "permissions" }) {
      spin(0.02)
      all = messages()
    }
    XCTAssertEqual(all.map { $0["type"] as? String }, ["ready", "pong", "permissions"])
    XCTAssertEqual(all[1]["nonce"] as? Int, 99)
    let items = try XCTUnwrap(all.last?["items"] as? [[String: Any]])
    XCTAssertEqual(items.compactMap { $0["required"] as? Bool }, [false, false])
    // Hardening: the TCC reads behind the reply never run on the AppKit thread (drag callbacks).
    XCTAssertEqual(DropTargetGlueTests.permissionsReplyBuiltOnMain, false)
    XCTAssertTrue(app.cachedInputMonitoringGranted, "the reply refreshes the cached Escape permission")
  }

  // MARK: The real observer, end to end

  /// #12 end to end: fake system input → real GlobalDragObserver → controller → (hidden) panel.
  func testRealObserverPathWithAComboHeldBeforeTheMouseDown() throws {
    let source = FakeDragInputSource()
    app = makeApp(observeWith: source)
    app.handle(.configure(DefaultConfig.config(locale: .en)))
    XCTAssertNotNil(source.monitor, "monitor installed through the injected source")
    let display = try XCTUnwrap(SystemInfo.displays().first)
    let start = Point(x: display.workArea.x + display.workArea.width / 2, y: display.workArea.y + display.workArea.height / 2 - 100)
    source.heldModifiers = [.shift]
    source.pressButton(at: start)
    source.drag(to: Point(x: start.x + 10, y: start.y), startsOSDrag: true)
    source.runTick()
    XCTAssertFalse(app.fireTimerForTests(.modifierSettle), "Shift held before the click is no press")
    XCTAssertEqual(app.sessionPhase, .potentialDrag)
    source.heldModifiers = []
    source.runTick()
    source.heldModifiers = [.shift]
    source.runTick()
    XCTAssertTrue(app.fireTimerForTests(.modifierSettle))
    XCTAssertEqual(app.sessionPhase, .awaitingPayload)
    let view = try XCTUnwrap(app.dropTargetView as? WheelView)
    pasteboard.writeObjects([URL(fileURLWithPath: "/Users/someone/Page 001.pdf") as NSURL])
    let over = FakeDraggingInfo(window: view.window, location: location(view, dx: 120, dy: 0), mask: .every, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(over), .copy, "armed: 120 pt from the activation point")
    XCTAssertTrue(view.performDragOperation(over))
    source.releaseButton()
    spin()
    let types = messages().map { $0["type"] as! String }
    XCTAssertEqual(types.filter { $0 == "drop" }.count, 1)
    XCTAssertFalse(types.contains("cancelled"))
  }
}
