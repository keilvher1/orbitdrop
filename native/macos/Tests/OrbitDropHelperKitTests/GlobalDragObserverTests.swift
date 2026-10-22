import AppKit
import XCTest

@testable import OrbitDropHelperCore
@testable import OrbitDropHelperKit

/// Scriptable stand-in for NSEvent/NSPasteboard state: tests replay the exact order in
/// which AppKit delivers things (monitor callbacks, 60 Hz ticks) without any real input.
@MainActor
final class FakeDragInputSource: DragInputSource {
  var heldModifiers: Set<ModifierKey> = []
  var leftButtonDown = false
  private var changeCount = 100
  /// Counts reads: the observer must stop asking once the drag is confirmed.
  var dragPasteboardChangeCount: Int {
    changeCountReads += 1
    return changeCount
  }
  var pointer = Point(x: 700, y: 500)
  var escapeKeyDown = false
  private(set) var monitor: (@MainActor (GlobalMouseEvent) -> Void)?
  private(set) var tick: (@MainActor () -> Void)?
  private(set) var changeCountReads = 0
  private(set) var installs = 0

  func installMouseMonitor(_ handler: @escaping @MainActor (GlobalMouseEvent) -> Void) -> Bool {
    installs += 1
    monitor = handler
    return true
  }

  func removeMouseMonitor() { monitor = nil }
  func startTicks(_ tick: @escaping @MainActor () -> Void) { self.tick = tick }
  func stopTicks() { tick = nil }
  var isTicking: Bool { tick != nil }

  // Scripted user actions.
  func pressButton(at p: Point) {
    pointer = p
    leftButtonDown = true
    monitor?(.down)
  }

  /// `deliverEvent: false` models a dragged event that never reaches the global monitor.
  func drag(to p: Point, startsOSDrag: Bool = false, deliverEvent: Bool = true) {
    pointer = p
    if startsOSDrag { changeCount += 1 }
    if deliverEvent { monitor?(.dragged) }
  }

  func releaseButton(deliverEvent: Bool = true) {
    leftButtonDown = false
    if deliverEvent { monitor?(.up) }
  }

  func runTick() { tick?() }
}

@MainActor
final class GlobalDragObserverTests: XCTestCase {
  var source: FakeDragInputSource!
  var observer: GlobalDragObserver!
  var events: [SessionEvent] = []
  var controller: DragSessionController!
  var outputs: [SessionOutput] = []

  override func setUp() async throws {
    source = FakeDragInputSource()
    observer = GlobalDragObserver(source: source)
    controller = DragSessionController(displays: SystemInfoTestDisplays.single, makeSessionId: { "s1" })
    controller.modifierSettleMs = 0
    _ = controller.handle(.configure(DefaultConfig.config(locale: .en)))
    observer.onEvent = { [unowned self] event in
      events.append(event)
      outputs.append(controller.handle(event))
    }
    observer.sessionNeedsPolling = { [unowned self] in controller.needsPolling }
    observer.wheelVisible = { [unowned self] in controller.isWheelShown }
    XCTAssertTrue(observer.start())
  }

  func testMouseDownCarriesTheHeldModifiersAsABaseline() {
    source.heldModifiers = [.shift]  // Shift held before clicking (e.g. extending a Finder selection)
    source.pressButton(at: Point(x: 690, y: 500))
    XCTAssertEqual(events, [.mouseDown(Point(x: 690, y: 500), held: [.shift])], "one atomic event, no forced modifier update after it")
    source.drag(to: Point(x: 700, y: 500), startsOSDrag: true)
    source.runTick()
    XCTAssertEqual(controller.phase, .potentialDrag)
    XCTAssertFalse(controller.isWheelShown, "a combo held before the mouse-down never opens the wheel")
    // Release and press Shift again during the drag: now it opens.
    source.heldModifiers = []
    source.runTick()
    source.heldModifiers = [.shift]
    source.runTick()
    XCTAssertEqual(controller.phase, .awaitingPayload)
  }

  func testShiftPressedAfterMouseDownOpensOnceTheDragIsConfirmed() {
    source.pressButton(at: Point(x: 690, y: 500))
    source.heldModifiers = [.shift]
    source.runTick()  // the 60 Hz poll sees the press before the OS drag started
    XCTAssertEqual(events.last, .modifiersChanged([.shift]))
    XCTAssertEqual(controller.phase, .idle)
    source.drag(to: Point(x: 700, y: 500), startsOSDrag: true)
    XCTAssertEqual(controller.phase, .awaitingPayload)
    XCTAssertEqual(controller.currentMode, .convert)
  }

  func testDragWithoutPasteboardChangeNeverStartsASession() {
    // Text selection or a window move: movement + Shift, but no OS drag.
    source.pressButton(at: Point(x: 600, y: 500))
    source.drag(to: Point(x: 650, y: 500))
    source.heldModifiers = [.shift]
    source.runTick()
    source.drag(to: Point(x: 700, y: 500))
    XCTAssertEqual(controller.phase, .idle)
    XCTAssertFalse(events.contains(.dragPasteboardChanged))
  }

  func testMissedMouseUpIsRecoveredFromTheButtonStateAndPollingStops() {
    source.pressButton(at: Point(x: 690, y: 500))
    source.drag(to: Point(x: 700, y: 500), startsOSDrag: true)
    XCTAssertTrue(source.isTicking, "polls while the button is down")
    source.releaseButton(deliverEvent: false)  // another app's drag loop swallowed the mouse-up
    source.runTick()
    XCTAssertEqual(events.last, .mouseUp(Point(x: 700, y: 500)))
    XCTAssertFalse(source.isTicking, "no session open: polling stops")
  }

  func testPollingContinuesWhileTheWheelIsOpenAfterRelease() {
    source.pressButton(at: Point(x: 690, y: 500))
    source.drag(to: Point(x: 700, y: 500), startsOSDrag: true)
    source.heldModifiers = [.shift]
    source.runTick()
    XCTAssertTrue(controller.isWheelShown)
    source.releaseButton()
    source.runTick()
    XCTAssertTrue(source.isTicking, "release grace still running: keep polling")
  }

  func testEscapeIsPolledOnlyWhenPermittedAndWhileTheWheelIsVisible() {
    source.pressButton(at: Point(x: 690, y: 500))
    source.drag(to: Point(x: 700, y: 500), startsOSDrag: true)
    source.heldModifiers = [.shift]
    source.runTick()
    XCTAssertTrue(controller.isWheelShown)
    source.escapeKeyDown = true
    source.runTick()
    XCTAssertFalse(events.contains(.escape), "Input Monitoring not granted: Escape is not read")
    observer.escapePollingAllowed = true
    source.runTick()
    XCTAssertEqual(events.filter { $0 == .escape }.count, 1)
    source.runTick()
    XCTAssertEqual(events.filter { $0 == .escape }.count, 1, "edge-triggered")
    XCTAssertFalse(controller.isWheelShown)
  }

  /// Hardening: if another app's drag loop kept the dragged events from the global monitor, the
  /// 60 Hz poll still reports the pointer — the session starts and the wheel opens at the current
  /// pointer, not at the mouse-down point.
  func testPointerIsPolledWhenTheMonitorMissesDraggedEvents() {
    source.pressButton(at: Point(x: 690, y: 500))
    source.drag(to: Point(x: 702, y: 500), startsOSDrag: true, deliverEvent: false)
    source.runTick()
    XCTAssertEqual(Array(events.suffix(2)), [.mouseDragged(Point(x: 702, y: 500)), .dragPasteboardChanged], "travel first, then the pasteboard check")
    XCTAssertEqual(controller.phase, .potentialDrag)
    source.drag(to: Point(x: 760, y: 530), deliverEvent: false)
    source.heldModifiers = [.shift]
    source.runTick()
    XCTAssertEqual(controller.phase, .awaitingPayload)
    XCTAssertEqual(controller.placement?.center, Point(x: 760, y: 530), "centered on the current pointer")
    let count = events.count
    source.runTick()
    XCTAssertEqual(events.count, count, "an unchanged pointer is not reported again")
    source.releaseButton(deliverEvent: false)
    source.drag(to: Point(x: 800, y: 530), deliverEvent: false)
    source.runTick()
    XCTAssertEqual(events.last, .mouseUp(Point(x: 800, y: 530)), "no pointer report once the button is up")
  }

  func testChangeCountIsNotReadAfterTheDragIsConfirmed() {
    // The source protocol exposes no drag contents at all; and once the OS drag is confirmed
    // the observer stops asking the pasteboard server.
    source.pressButton(at: Point(x: 690, y: 500))
    source.drag(to: Point(x: 700, y: 500), startsOSDrag: true)
    let readsAtConfirmation = source.changeCountReads
    for x in stride(from: 710.0, through: 800, by: 10) { source.drag(to: Point(x: x, y: 500)) }
    for _ in 0..<5 { source.runTick() }
    XCTAssertEqual(source.changeCountReads, readsAtConfirmation)
    XCTAssertEqual(events.filter { $0 == .dragPasteboardChanged }.count, 1)
  }
}

/// Displays used by the observer tests (a single 1512×982 screen, menu bar 25 pt).
enum SystemInfoTestDisplays {
  static let single = [Display(id: "main", bounds: Rect(x: 0, y: 0, width: 1512, height: 982), workArea: Rect(x: 0, y: 25, width: 1512, height: 957), scaleFactor: 2, primary: true)]
}
