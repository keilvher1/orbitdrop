import XCTest

@testable import OrbitDropHelperCore

/// Drives DragSessionController with abstract events, the way the AppKit glue
/// does, and checks the commands/messages it produces.
final class SessionControllerTests: XCTestCase {
  // Single 1512×982 display, menu bar 25 pt.
  static let mainDisplay = Display(id: "main", bounds: Rect(x: 0, y: 0, width: 1512, height: 982), workArea: Rect(x: 0, y: 25, width: 1512, height: 957), scaleFactor: 2, primary: true)

  struct Harness {
    var controller: DragSessionController
    var log: [SessionCommand] = []
    var view: WheelViewModel?
    var timers: [SessionTimer: (ms: Int, token: String)] = [:]

    /// `settleMs` 0 shows the wheel on the completing press (the 40 ms settle has its own tests).
    init(config: HelperConfig = DefaultConfig.config(locale: .en), displays: [Display] = [SessionControllerTests.mainDisplay], settleMs: Int = 0) {
      let counter = Counter()
      controller = DragSessionController(displays: displays, makeSessionId: { counter.next() })
      controller.modifierSettleMs = settleMs
      _ = controller.handle(.configure(config))
    }

    @discardableResult
    mutating func send(_ event: SessionEvent) -> SessionOutput {
      let out = controller.handle(event)
      log += out.commands
      for command in out.commands {
        switch command {
        case .showWheel(let p):
          view = WheelViewModel(presentation: p, capsule: CapsuleContent(text: "", style: .hint))
        case .hide:
          view = nil
        case .startTimer(let t, let ms, let token):
          timers[t] = (ms, token)
        case .cancelTimer(let t):
          timers[t] = nil
        default:
          view?.apply(command)
        }
      }
      return out
    }

    var messages: [HelperToMainMessage] {
      log.compactMap { if case .send(let m) = $0 { return m } else { return nil } }
    }

    var drops: [DropMessage] {
      messages.compactMap { if case .drop(let d) = $0 { return d } else { return nil } }
    }

    var cancels: [CancelReason] {
      messages.compactMap { if case .cancelled(_, let r) = $0 { return r } else { return nil } }
    }

    var states: [StateMessage] {
      messages.compactMap { if case .state(let s) = $0 { return s } else { return nil } }
    }

    var hides: Int { log.filter { if case .hide = $0 { return true } else { return false } }.count }

    /// Mouse down on a file, move past the threshold, the drag pasteboard changes.
    mutating func beginDrag(at p: Point = Point(x: 690, y: 500), to q: Point = Point(x: 700, y: 500)) {
      send(.mouseDown(p))
      send(.modifiersChanged([]))
      send(.mouseDragged(q))
      send(.dragPasteboardChanged)
    }

    mutating func fire(_ timer: SessionTimer) {
      guard let pending = timers[timer] else { return XCTFail("timer \(timer) not running") }
      timers[timer] = nil
      send(.timerFired(timer, token: pending.token))
    }
  }

  let pdf: [DragItem] = [.file(path: "/Users/me/Desktop/Page 001.pdf", isDirectory: false)]
  let png: [DragItem] = [.file(path: "/Users/me/Desktop/photo.png", isDirectory: false)]
  let center = Point(x: 700, y: 500)
  func at(_ dx: Double, _ dy: Double) -> Point { Point(x: 700 + dx, y: 500 + dy) }

  // MARK: Happy path

  func testPdfToJpgDropIsSentExactlyOnce() {
    var h = Harness()
    h.beginDrag()
    XCTAssertEqual(h.controller.phase, .potentialDrag)
    XCTAssertTrue(h.messages.isEmpty, "PotentialDrag is never reported")

    h.send(.modifiersChanged([.shift]))
    XCTAssertEqual(h.controller.phase, .awaitingPayload)
    XCTAssertEqual(h.view?.presentation.placement.center, center, "wheel centered on the pointer")
    XCTAssertEqual(h.view?.capsule, CapsuleContent(text: "Drop here", style: .hint))
    XCTAssertEqual(h.states.last, StateMessage(sessionId: "s1", state: .awaitingPayload, mode: .convert))

    let enter = h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    XCTAssertEqual(enter.operation, .none, "dead zone never selects")
    XCTAssertEqual(h.controller.phase, .wheelActive)
    XCTAssertEqual(h.states.last, StateMessage(sessionId: "s1", state: .wheelActive, mode: .convert, menuKey: .some(.pdf), fileCount: 1))
    XCTAssertEqual(h.view?.content.sectors.map(\.label), ["DOCX", "JPG", "PNG", "TXT"])
    XCTAssertEqual(h.view?.capsule, CapsuleContent(text: "PDF", style: .info))
    XCTAssertTrue(h.log.contains(.resolveFileInfo(sessionId: "s1", paths: ["/Users/me/Desktop/Page 001.pdf"])))

    let over = h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true))
    XCTAssertEqual(over.operation, .copy)
    XCTAssertEqual(h.view?.highlight, SectorHighlight(index: 1, style: .active))
    XCTAssertEqual(h.view?.capsule, CapsuleContent(text: "JPG", style: .action))

    let drop = h.send(.performDrop(items: pdf, point: at(121, 1), sourceAllowsCopy: true))
    XCTAssertTrue(drop.dropAccepted)
    XCTAssertEqual(h.drops, [DropMessage(sessionId: "s1", actionId: .convertJpeg, mode: .convert, files: ["/Users/me/Desktop/Page 001.pdf"])])
    XCTAssertNil(h.view, "wheel hidden after the drop")
    XCTAssertEqual(h.controller.phase, .idle)

    // Late or duplicate callbacks never produce a second drop or a cancel.
    XCTAssertFalse(h.send(.performDrop(items: pdf, point: at(120, 0), sourceAllowsCopy: true)).dropAccepted)
    h.send(.draggingEnded)
    h.send(.mouseUp(at(120, 0)))
    XCTAssertEqual(h.drops.count, 1)
    XCTAssertEqual(h.cancels, [])
    XCTAssertEqual(h.hides, 1)
  }

  func testOrdinaryDragsProduceNoMessages() {
    var h = Harness()
    h.beginDrag()
    h.send(.mouseDragged(at(200, 0)))
    h.send(.mouseUp(at(200, 0)))
    XCTAssertEqual(h.controller.phase, .idle)
    XCTAssertTrue(h.log.isEmpty)
  }

  func testShiftWithoutARealDragDoesNothing() {
    // Text selection / window move: button + movement + Shift, but the drag pasteboard never changes.
    var h = Harness()
    h.send(.mouseDown(at(-10, 0)))
    h.send(.mouseDragged(center))
    h.send(.modifiersChanged([.shift]))
    h.send(.mouseDragged(at(50, 0)))
    XCTAssertEqual(h.controller.phase, .idle)
    XCTAssertTrue(h.log.isEmpty)
  }

  func testComboHeldBeforeTheMouseDownDoesNotOpenTheWheel() {
    // The observer's real sequence: the mouse-down carries the modifiers held at that moment
    // (e.g. Shift-click to extend a Finder selection), then movement, then the pasteboard change.
    var h = Harness()
    h.send(.mouseDown(at(-10, 0), held: [.shift]))
    h.send(.mouseDragged(center))
    h.send(.dragPasteboardChanged)
    h.send(.modifiersChanged([.shift]))  // a poll reporting the unchanged set is not a press
    XCTAssertEqual(h.controller.phase, .potentialDrag)
    XCTAssertNil(h.view)
    // Pressing the combo again during the drag opens it.
    h.send(.modifiersChanged([]))
    h.send(.modifiersChanged([.shift]))
    XCTAssertEqual(h.controller.phase, .awaitingPayload)
  }

  func testComboPressedRightAfterMouseDownOpensOnceTheDragIsConfirmed() {
    var h = Harness()
    h.send(.mouseDown(at(-10, 0)))
    h.send(.modifiersChanged([]))
    h.send(.modifiersChanged([.shift]))  // pressed before the drag pasteboard changed
    h.send(.mouseDragged(center))
    XCTAssertNil(h.view)
    h.send(.dragPasteboardChanged)
    XCTAssertEqual(h.controller.phase, .awaitingPayload)
    XCTAssertEqual(h.controller.currentMode, .convert)
  }

  func testToolsComboAndOptionAddedLater() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.alt]))
    XCTAssertEqual(h.controller.phase, .potentialDrag, "Option alone is no combo")
    h.send(.modifiersChanged([.alt, .shift]))
    XCTAssertEqual(h.controller.currentMode, .tools)
    h.send(.draggingEntered(items: png, point: center, sourceAllowsCopy: true))
    XCTAssertEqual(h.view?.content.sectors.map(\.label), ["COMPRESS", "METADATA", "EDIT", "ANNOTATE", "ADD BG", "CROP", "REDACT"])
  }

  // MARK: Arming, dead zone, outside

  func testDeadZoneAndOutsideNeverSelect() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    XCTAssertEqual(h.send(.draggingUpdated(point: at(0, -60), sourceAllowsCopy: true)).operation, .none)
    XCTAssertNil(h.view?.highlight)
    // Window corner: inside the panel but outside the ring.
    XCTAssertEqual(h.send(.draggingUpdated(point: at(195, -195), sourceAllowsCopy: true)).operation, .none)
    XCTAssertNil(h.view?.highlight)
    XCTAssertFalse(h.send(.performDrop(items: pdf, point: at(195, -195), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertEqual(h.cancels, [.outsideRing])
    XCTAssertTrue(h.drops.isEmpty)
    XCTAssertNil(h.view)
  }

  func testShiftedWheelRequiresArmingBeforeASectorIsSelectable() {
    var h = Harness()
    // Near the left edge: the center is clamped to x = 0 + 180 + 8 = 188, so the pointer starts over a sector.
    h.beginDrag(at: Point(x: 90, y: 500), to: Point(x: 100, y: 500))
    h.send(.modifiersChanged([.shift]))
    let placement = h.view!.presentation.placement
    XCTAssertEqual(placement.center, Point(x: 188, y: 500))
    XCTAssertTrue(placement.shifted)

    let enter = h.send(.draggingEntered(items: pdf, point: Point(x: 100, y: 500), sourceAllowsCopy: true))
    XCTAssertEqual(enter.operation, .none, "not armed yet")
    XCTAssertEqual(h.view?.highlight, SectorHighlight(index: 3, style: .hover))
    XCTAssertFalse(h.send(.performDrop(items: pdf, point: Point(x: 103, y: 500), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertEqual(h.cancels, [.dragEnded])
    XCTAssertTrue(h.drops.isEmpty)
  }

  func testArmingAfterMovingArmDistance() {
    var h = Harness()
    h.beginDrag(at: Point(x: 90, y: 500), to: Point(x: 100, y: 500))
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: Point(x: 100, y: 500), sourceAllowsCopy: true))
    XCTAssertEqual(h.send(.draggingUpdated(point: Point(x: 104, y: 500), sourceAllowsCopy: true)).operation, .none)
    XCTAssertEqual(h.send(.draggingUpdated(point: Point(x: 106, y: 500), sourceAllowsCopy: true)).operation, .copy)
    XCTAssertEqual(h.view?.highlight, SectorHighlight(index: 3, style: .active))
    XCTAssertEqual(h.view?.capsule.text, "TXT")
    XCTAssertTrue(h.send(.performDrop(items: nil, point: Point(x: 106, y: 500), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertEqual(h.drops.first?.actionId, .convertTxt)
  }

  func testPassingThroughTheDeadZoneArms() {
    var h = Harness()
    h.beginDrag(at: Point(x: 90, y: 500), to: Point(x: 100, y: 500))
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: Point(x: 188, y: 500), sourceAllowsCopy: true))  // center
    // Back to a point within armDistance of the activation point: armed because it passed the center.
    XCTAssertEqual(h.send(.draggingUpdated(point: Point(x: 101, y: 500), sourceAllowsCopy: true)).operation, .copy)
  }

  // MARK: Rejections

  func testDisabledSectorIsHighlightedDifferentlyAndRejected() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: png, point: center, sourceAllowsCopy: true))
    let labels = h.view!.content.sectors.map(\.label)
    XCTAssertEqual(labels, ["JPG", "WEBP", "HEIC", "TIFF", "AVIF", "BMP", "PDF", "DOCX"])
    // Sector 2 (HEIC) of 8 is centered at -90 + 90 = 0°: straight right.
    let op = h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true)).operation
    XCTAssertEqual(op, .none)
    XCTAssertEqual(h.view?.highlight, SectorHighlight(index: 2, style: .rejected))
    XCTAssertEqual(h.view?.capsule, CapsuleContent(text: "No HEIC encoder in this build", style: .reject))
    XCTAssertFalse(h.send(.performDrop(items: png, point: at(120, 0), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertEqual(h.cancels, [.disabledSector])
    XCTAssertTrue(h.drops.isEmpty)
  }

  func testSourceWithoutCopyIsRejectedNeverMoved() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: false))
    XCTAssertEqual(h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: false)).operation, .none)
    XCTAssertEqual(h.view?.highlight?.style, .rejected)
    XCTAssertEqual(h.view?.capsule.style, .reject)
    // The mask changes back (e.g. Command released): copy is accepted again.
    XCTAssertEqual(h.send(.draggingUpdated(point: at(120, 2), sourceAllowsCopy: true)).operation, .copy)
    XCTAssertFalse(h.send(.performDrop(items: pdf, point: at(120, 2), sourceAllowsCopy: false)).dropAccepted)
    XCTAssertEqual(h.cancels, [.invalidPayload])
    XCTAssertTrue(h.drops.isEmpty)
  }

  func testNonFileDragShowsUnsupportedAndNeverDrops() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: [.nonFile], point: center, sourceAllowsCopy: true))
    XCTAssertEqual(h.view?.content, .unsupported)
    XCTAssertEqual(h.view?.capsule, CapsuleContent(text: "Not a file", style: .reject), "strings.unsupportedNonFile")
    XCTAssertEqual(h.states.last, StateMessage(sessionId: "s1", state: .wheelActive, mode: .convert, menuKey: .some(nil), fileCount: 0))
    for p in [at(120, 0), at(0, 120), center] {
      XCTAssertEqual(h.send(.draggingUpdated(point: p, sourceAllowsCopy: true)).operation, .none)
    }
    XCTAssertFalse(h.send(.performDrop(items: [.nonFile], point: at(120, 0), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertEqual(h.cancels, [.invalidPayload])
  }

  func testPdfInToolsModeHasNothingToOffer() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.alt, .shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    XCTAssertEqual(h.view?.content, .unsupported)
    XCTAssertEqual(h.states.last?.menuKey, .some(.pdf))
    XCTAssertEqual(h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true)).operation, .none)
  }

  func testNoDropWithoutDragEnter() {
    var h = Harness()
    XCTAssertFalse(h.send(.performDrop(items: pdf, point: center, sourceAllowsCopy: true)).dropAccepted)
    h.beginDrag()
    XCTAssertFalse(h.send(.performDrop(items: pdf, point: center, sourceAllowsCopy: true)).dropAccepted)
    h.send(.modifiersChanged([.shift]))
    XCTAssertFalse(h.send(.performDrop(items: pdf, point: at(120, 0), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertTrue(h.drops.isEmpty)
  }

  func testPayloadChangedAtDropIsRejected() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true))
    XCTAssertFalse(h.send(.performDrop(items: png, point: at(120, 0), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertEqual(h.cancels, [.invalidPayload])
  }

  // MARK: Exit / re-entry / modifiers

  func testExitKeepsTheWheelAndReEntryWorks() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true))
    h.send(.draggingExited(pointerInsideWheel: false, buttonDown: true))
    XCTAssertNotNil(h.view, "wheel stays after leaving")
    XCTAssertNil(h.view?.highlight)
    XCTAssertEqual(h.view?.capsule.text, "PDF")
    XCTAssertNil(h.timers[.exitCheck])
    let statesBefore = h.states.count
    h.send(.draggingEntered(items: pdf, point: at(0, 130), sourceAllowsCopy: true))
    XCTAssertEqual(h.states.count, statesBefore, "payload and menu stay frozen on re-entry")
    XCTAssertEqual(h.view?.highlight, SectorHighlight(index: 2, style: .active))
    XCTAssertTrue(h.send(.performDrop(items: pdf, point: at(0, 130), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertEqual(h.drops.first?.actionId, .convertPng)
    XCTAssertEqual(h.cancels, [])
  }

  func testReleasingTheModifierKeepsTheWheel() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    h.send(.modifiersChanged([]))
    XCTAssertNotNil(h.view)
    XCTAssertEqual(h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true)).operation, .copy)
    XCTAssertTrue(h.send(.performDrop(items: pdf, point: at(120, 0), sourceAllowsCopy: true)).dropAccepted)
  }

  func testPressingTheOtherComboSwitchesModeButReleasingDoesNot() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: png, point: center, sourceAllowsCopy: true))
    let centerBefore = h.view!.presentation.placement
    XCTAssertEqual(h.send(.draggingUpdated(point: at(0, -120), sourceAllowsCopy: true)).operation, .copy)  // JPG

    h.send(.modifiersChanged([.alt, .shift]))  // Option pressed
    XCTAssertEqual(h.controller.currentMode, .tools)
    XCTAssertEqual(h.view?.presentation.mode, .tools)
    XCTAssertEqual(h.view?.content.sectors.first?.actionId, .toolCompress)
    XCTAssertEqual(h.view?.presentation.placement, centerBefore, "center never moves")
    XCTAssertEqual(h.states.last?.mode, .tools)
    // Same pointer position: arming restarted, so COMPRESS (now under the pointer) is not selectable yet.
    XCTAssertEqual(h.send(.draggingUpdated(point: at(0, -120), sourceAllowsCopy: true)).operation, .none)
    XCTAssertEqual(h.send(.draggingUpdated(point: at(0, -128), sourceAllowsCopy: true)).operation, .copy)

    h.send(.modifiersChanged([.shift]))  // Option released first
    h.send(.modifiersChanged([]))
    XCTAssertEqual(h.controller.currentMode, .tools, "releasing keys never changes the mode")
    XCTAssertTrue(h.send(.performDrop(items: png, point: at(0, -128), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertEqual(h.drops.first, DropMessage(sessionId: "s1", actionId: .toolCompress, mode: .tools, files: ["/Users/me/Desktop/photo.png"]))
  }

  // MARK: Cleanup paths

  func testExternalMouseUpOnlyCleansUp() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    h.send(.draggingExited(pointerInsideWheel: false, buttonDown: true))
    h.send(.mouseUp(at(600, 0)))
    XCTAssertEqual(h.timers[.releaseGrace]?.ms, 150)
    XCTAssertNotNil(h.view, "nothing hidden before the grace period")
    h.fire(.releaseGrace)
    XCTAssertEqual(h.cancels, [.dragEnded])
    XCTAssertNil(h.view)
    XCTAssertTrue(h.drops.isEmpty)
  }

  func testDropArrivingAfterTheGlobalMouseUpIsStillAccepted() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true))
    h.send(.mouseUp(at(120, 0)))  // the monitor event raced ahead of performDragOperation
    XCTAssertEqual(h.timers[.releaseGrace]?.ms, 600)
    let staleToken = h.timers[.releaseGrace]!.token
    XCTAssertTrue(h.send(.performDrop(items: pdf, point: at(120, 0), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertNil(h.timers[.releaseGrace], "timer cancelled by the drop")
    h.send(.timerFired(.releaseGrace, token: staleToken))
    XCTAssertEqual(h.drops.count, 1)
    XCTAssertEqual(h.cancels, [])
  }

  func testExitWhileThePointerIsStillOverTheWheelEndsTheSession() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    h.send(.draggingExited(pointerInsideWheel: true, buttonDown: true))  // Esc pressed in the source app
    XCTAssertNotNil(h.timers[.exitCheck])
    h.fire(.exitCheck)
    XCTAssertEqual(h.cancels, [.escape])
    XCTAssertNil(h.view)
    // The button is still down: no new session until it is released.
    h.send(.mouseDragged(at(20, 0)))
    h.send(.dragPasteboardChanged)
    h.send(.modifiersChanged([]))
    h.send(.modifiersChanged([.shift]))
    XCTAssertEqual(h.controller.phase, .idle)
  }

  func testExitThenQuickReEntryCancelsTheExitCheck() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    h.send(.draggingExited(pointerInsideWheel: true, buttonDown: true))
    h.send(.draggingEntered(items: pdf, point: at(120, 0), sourceAllowsCopy: true))
    XCTAssertNil(h.timers[.exitCheck])
    XCTAssertEqual(h.cancels, [])
  }

  func testRejectedReleaseOverADisabledSectorReportsTheReason() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: png, point: center, sourceAllowsCopy: true))
    h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true))  // HEIC (disabled)
    // AppKit does not call performDragOperation for operation none; it sends draggingExited.
    h.send(.draggingExited(pointerInsideWheel: true, buttonDown: false))
    h.send(.mouseUp(at(120, 0)))
    h.fire(.exitCheck)
    XCTAssertEqual(h.cancels, [.disabledSector])
  }

  func testEscapeSleepParentEOFAndCancelSession() {
    for (event, reason) in [(SessionEvent.escape, CancelReason.escape), (.sleep, .sleep), (.parentEOF, .parentRequest), (.cancelRequest(sessionId: "s1"), .parentRequest), (.invalidate(.error), .error)] {
      var h = Harness()
      h.beginDrag()
      h.send(.modifiersChanged([.shift]))
      h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
      h.send(.cancelRequest(sessionId: "other"))
      XCTAssertEqual(h.cancels, [], "cancelSession for another id is ignored")
      h.send(event)
      XCTAssertEqual(h.cancels, [reason], "\(event)")
      XCTAssertNil(h.view)
      XCTAssertEqual(h.controller.phase, .idle)
      XCTAssertFalse(h.send(.performDrop(items: pdf, point: at(120, 0), sourceAllowsCopy: true)).dropAccepted)
    }
  }

  func testParentEOFStopsObservation() {
    var h = Harness()
    h.send(.parentEOF)
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    XCTAssertEqual(h.controller.phase, .idle)
    XCTAssertFalse(h.controller.isEnabled)
  }

  func testDisableMidSessionCancels() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    var off = DefaultConfig.config(locale: .en)
    off.enabled = false
    h.send(.configure(off))
    XCTAssertEqual(h.cancels, [.parentRequest])
    XCTAssertNil(h.view)
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    XCTAssertEqual(h.controller.phase, .idle)
  }

  func testConfigureMidSessionDoesNotChangeTheWheelButAppliesNextTime() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    var changed = DefaultConfig.config(locale: .ko)
    changed.geometry.diameter = 320
    h.send(.configure(changed))
    h.send(.draggingEntered(items: png, point: center, sourceAllowsCopy: true))
    XCTAssertEqual(h.view?.presentation.placement.diameter, 360)
    XCTAssertEqual(h.view?.content.sectors.first?.label, "JPG")
    XCTAssertEqual(h.view?.capsule.text, "PNG")
    h.send(.escape)
    h.send(.mouseUp(center))
    h.beginDrag()
    h.send(.modifiersChanged([.alt, .shift]))
    h.send(.draggingEntered(items: png, point: center, sourceAllowsCopy: true))
    XCTAssertEqual(h.view?.presentation.placement.diameter, 320)
    XCTAssertEqual(h.view?.content.sectors.first?.label, "압축")
    XCTAssertEqual(h.states.last?.sessionId, "s2", "new session id")
  }

  // MARK: Capsule / payload details

  func testMultiFileCapsuleAndBatchRules() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.alt, .shift]))
    h.send(.draggingEntered(items: png + [.file(path: "/Users/me/b.png", isDirectory: false)], point: center, sourceAllowsCopy: true))
    XCTAssertEqual(h.view?.capsule, CapsuleContent(text: "2 files", style: .info))
    XCTAssertEqual(h.states.last?.fileCount, 2)
    // EDIT (index 2 of 7, centered at -90 + 2·51.43 = 12.86°) is not batch-capable.
    let edit = at(120 * cos(12.857 * .pi / 180), 120 * sin(12.857 * .pi / 180))
    XCTAssertEqual(h.send(.draggingUpdated(point: edit, sourceAllowsCopy: true)).operation, .none)
    XCTAssertEqual(h.view?.capsule, CapsuleContent(text: "One file at a time", style: .reject))
    XCTAssertEqual(h.send(.draggingUpdated(point: at(0, -120), sourceAllowsCopy: true)).operation, .copy, "COMPRESS is batch-capable")
    XCTAssertTrue(h.send(.performDrop(items: nil, point: at(0, -120), sourceAllowsCopy: true)).dropAccepted)
    XCTAssertEqual(h.drops.first?.files.count, 2)
  }

  func testFileInfoUpdatesTheCapsuleOrMarksFoldersUnsupported() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
    h.send(.fileInfo(sessionId: "old", totalBytes: 5, containsDirectory: false))
    XCTAssertEqual(h.view?.capsule.text, "PDF")
    h.send(.fileInfo(sessionId: "s1", totalBytes: 1_234_567, containsDirectory: false))
    XCTAssertEqual(h.view?.capsule, CapsuleContent(text: "1.2 MB", style: .info))

    var g = Harness()
    g.beginDrag()
    g.send(.modifiersChanged([.shift]))
    g.send(.draggingEntered(items: [.file(path: "/Users/me/Bundle.pdf", isDirectory: false)], point: center, sourceAllowsCopy: true))
    g.send(.fileInfo(sessionId: "s1", totalBytes: nil, containsDirectory: true))
    XCTAssertEqual(g.view?.content, .unsupported)
    XCTAssertEqual(g.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true)).operation, .none)
  }

  func testPlacementUsesTheDisplayUnderThePointer() {
    let secondary = Display(id: "left", bounds: Rect(x: -1920, y: -100, width: 1920, height: 1080), workArea: Rect(x: -1920, y: -100, width: 1920, height: 1050), scaleFactor: 1, primary: false)
    var h = Harness(displays: [Self.mainDisplay, secondary])
    h.beginDrag(at: Point(x: -15, y: 960), to: Point(x: -5, y: 960))
    h.send(.modifiersChanged([.shift]))
    let placement = h.view!.presentation.placement
    // Clamped into the secondary work area: x ≤ 0 − 180 − 8, y ≤ 950 − 188.
    XCTAssertEqual(placement.center, Point(x: -188, y: 762))
    XCTAssertEqual(placement.windowFrame, Rect(x: -392, y: 558, width: 408, height: 408))
  }

  func testSessionIdsAreFreshPerSession() {
    var h = Harness()
    for expected in ["s1", "s2", "s3"] {
      h.beginDrag()
      h.send(.modifiersChanged([.shift]))
      XCTAssertEqual(h.states.last?.sessionId, expected)
      h.send(.draggingEntered(items: pdf, point: center, sourceAllowsCopy: true))
      h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true))
      XCTAssertTrue(h.send(.performDrop(items: pdf, point: at(120, 0), sourceAllowsCopy: true)).dropAccepted)
      h.send(.mouseUp(at(120, 0)))
      h.send(.modifiersChanged([]))
    }
    XCTAssertEqual(h.drops.map(\.sessionId), ["s1", "s2", "s3"])
  }

  func testMissedMouseUpIsRecoveredOnTheNextMouseDown() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.mouseDown(center))
    XCTAssertEqual(h.cancels, [.dragEnded])
    XCTAssertNil(h.view)
  }

  /// Seeded random event sequences (any order, including nonsense) must keep the protocol
  /// invariants main relies on.
  func testRandomEventSequencesKeepProtocolInvariants() {
    var seed: UInt64 = 0x5EED_0F_0B17
    func next() -> UInt64 {
      seed ^= seed << 13
      seed ^= seed >> 7
      seed ^= seed << 17
      return seed
    }
    func pick<T>(_ options: [T]) -> T { options[Int(next() % UInt64(options.count))] }
    func randomPoint() -> Point { Point(x: 700 + Double(Int(next() % 500)) - 250, y: 500 + Double(Int(next() % 500)) - 250) }
    let itemSets: [[DragItem]] = [pdf, png, png + [.file(path: "/b.png", isDirectory: false)], [.nonFile], [.promise], [.file(path: "/d.pdf", isDirectory: true)], pdf + png]
    let modifierSets: [Set<ModifierKey>] = [[], [.shift], [.alt, .shift], [.alt], [.command, .shift], [.control]]

    for _ in 0..<1500 {
      var h = Harness(settleMs: 40)
      var lastOpWasCopyAllowed = true
      for _ in 0..<70 {
        let event: SessionEvent
        switch next() % 20 {
        case 0: event = .mouseDown(randomPoint())
        case 1, 2: event = .mouseDragged(randomPoint())
        case 3: event = .mouseUp(randomPoint())
        case 4, 5: event = .modifiersChanged(pick(modifierSets))
        case 6: event = .dragPasteboardChanged
        case 7: event = .draggingEntered(items: pick(itemSets), point: randomPoint(), sourceAllowsCopy: next() % 4 != 0)
        case 8, 9: event = .draggingUpdated(point: randomPoint(), sourceAllowsCopy: next() % 4 != 0)
        case 10: event = .draggingExited(pointerInsideWheel: next() % 2 == 0, buttonDown: next() % 2 == 0)
        case 11, 12: event = .performDrop(items: next() % 3 == 0 ? nil : pick(itemSets), point: randomPoint(), sourceAllowsCopy: next() % 4 != 0)
        case 13: event = .draggingEnded
        case 14: event = pick([.escape, .sleep, .invalidate(.error)])
        case 15: event = .cancelRequest(sessionId: h.controller.sessionId ?? "x")
        case 16: event = .fileInfo(sessionId: h.controller.sessionId ?? "x", totalBytes: Int64(next() % 5_000_000), containsDirectory: next() % 10 == 0)
        case 17:
          if let (timer, pending) = h.timers.first { event = .timerFired(timer, token: next() % 4 == 0 ? "stale" : pending.token) } else { event = .draggingEnded }
        case 18:
          var cfg = DefaultConfig.config(locale: pick([.ko, .en]))
          cfg.enabled = next() % 6 != 0
          event = .configure(cfg)
        default: event = .modifiersChanged([.shift])
        }
        let before = h.messages.count
        let out = h.send(event)
        let emitted = Array(h.messages[before...])
        let drops = emitted.filter { if case .drop = $0 { return true } else { return false } }
        XCTAssertEqual(out.dropAccepted, !drops.isEmpty, "dropAccepted iff a drop was sent (\(event))")
        XCTAssertLessThanOrEqual(drops.count, 1)
        switch event {
        case .draggingEntered(_, _, let allowsCopy), .draggingUpdated(_, let allowsCopy), .performDrop(_, _, let allowsCopy):
          lastOpWasCopyAllowed = allowsCopy
          if out.operation == .copy { XCTAssertTrue(allowsCopy, "Copy only when the source allows it") }
          if out.dropAccepted { XCTAssertTrue(lastOpWasCopyAllowed) }
        default:
          XCTAssertEqual(out.operation, .none)
          XCTAssertFalse(out.dropAccepted)
        }
      }
      h.send(.sleep)  // every open session must end now
      XCTAssertFalse(h.controller.isWheelShown)

      // Stream invariants per session id.
      var seenActive: Set<String> = []
      var ended: Set<String> = []
      var announced: Set<String> = []
      for message in h.messages {
        switch message {
        case .state(let s):
          XCTAssertNotEqual(s.state, .idle, "the helper ends sessions with drop/cancelled, never Idle")
          XCTAssertNotEqual(s.state, .potentialDrag, "PotentialDrag is internal")
          XCTAssertFalse(ended.contains(s.sessionId), "no state after the terminal message")
          if s.state == .awaitingPayload { announced.insert(s.sessionId) }
          XCTAssertTrue(announced.contains(s.sessionId), "AwaitingPayload comes first")
          if s.state == .wheelActive { seenActive.insert(s.sessionId) }
        case .drop(let d):
          XCTAssertTrue(seenActive.contains(d.sessionId), "drop only after WheelActive")
          XCTAssertFalse(ended.contains(d.sessionId), "exactly one terminal message")
          XCTAssertFalse(d.files.isEmpty)
          ended.insert(d.sessionId)
        case .cancelled(let id, _):
          XCTAssertTrue(announced.contains(id), "cancelled only for announced sessions")
          XCTAssertFalse(ended.contains(id), "exactly one terminal message")
          ended.insert(id)
        default:
          XCTFail("controller emitted \(message.typeName)")
        }
      }
      XCTAssertEqual(ended, announced, "every announced session ended exactly once")
    }
  }

  // MARK: Unsupported texts, settle, no-enter, layout

  func testUnsupportedDragsUseTheSpecificStrings() {
    for (items, expected) in [([DragItem.file(path: "/Users/me/Folder", isDirectory: true)], "Folders aren't supported"), ([.promise], "Not a file on disk"), ([.nonFile], "Not a file"), ([.file(path: "/a/notes.txt", isDirectory: false)], "Not supported")] {
      var h = Harness()
      h.beginDrag()
      h.send(.modifiersChanged([.shift]))
      h.send(.draggingEntered(items: items, point: center, sourceAllowsCopy: true))
      XCTAssertEqual(h.view?.capsule, CapsuleContent(text: expected, style: .reject), "\(items)")
    }
    // A folder found only by the off-main stat (no trailing slash) switches to the folder text.
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: [.file(path: "/Users/me/Bundle.pdf", isDirectory: false)], point: center, sourceAllowsCopy: true))
    h.send(.fileInfo(sessionId: "s1", totalBytes: nil, containsDirectory: true))
    XCTAssertEqual(h.view?.capsule.text, "Folders aren't supported")
    // Without the optional strings (older main), everything falls back to `unsupported`.
    var old = DefaultConfig.config(locale: .en)
    old.strings = HelperStrings(dropHint: "Drop here", unsupported: "Not supported", multiFileUnsupported: "One", fileCount: "{n} files")
    var g = Harness(config: old)
    g.beginDrag()
    g.send(.modifiersChanged([.shift]))
    g.send(.draggingEntered(items: [.promise], point: center, sourceAllowsCopy: true))
    XCTAssertEqual(g.view?.capsule.text, "Not supported")
  }

  func testModifiersMustSettleBeforeTheWheelAppears() {
    // Shift then Option 10 ms later: tools directly, no convert flash.
    var h = Harness(settleMs: 40)
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    XCTAssertEqual(h.controller.phase, .potentialDrag)
    XCTAssertEqual(h.timers[.modifierSettle]?.ms, 40)
    XCTAssertNil(h.view)
    h.send(.modifiersChanged([.alt, .shift]))
    h.fire(.modifierSettle)
    XCTAssertEqual(h.controller.currentMode, .tools)
    XCTAssertEqual(h.states.map(\.mode), [.tools], "one AwaitingPayload, already in tools mode")

    // Released inside the window: nothing appears.
    var r = Harness(settleMs: 40)
    r.beginDrag()
    r.send(.modifiersChanged([.shift]))
    r.send(.modifiersChanged([]))
    XCTAssertNil(r.timers[.modifierSettle], "pending activation abandoned")
    XCTAssertEqual(r.controller.phase, .potentialDrag)
    XCTAssertTrue(r.messages.isEmpty)

    // Stable Shift: convert after the settle.
    var c = Harness(settleMs: 40)
    c.beginDrag()
    c.send(.modifiersChanged([.shift]))
    c.fire(.modifierSettle)
    XCTAssertEqual(c.controller.phase, .awaitingPayload)
    XCTAssertEqual(c.controller.currentMode, .convert)
  }

  func testNeutralWheelWithoutDragEnterIsHidden() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.mouseDragged(at(3, 0)))
    XCTAssertNil(h.timers[.noEnter], "a few points of travel are not enough")
    h.send(.mouseDragged(at(60, 20)))
    XCTAssertEqual(h.timers[.noEnter]?.ms, 400)
    h.fire(.noEnter)
    XCTAssertEqual(h.cancels, [.invalidPayload])
    XCTAssertNil(h.view)

    // A drag-enter in time cancels it.
    var g = Harness()
    g.beginDrag()
    g.send(.modifiersChanged([.shift]))
    g.send(.mouseDragged(at(60, 20)))
    g.send(.draggingEntered(items: pdf, point: at(60, 20), sourceAllowsCopy: true))
    XCTAssertNil(g.timers[.noEnter])
    XCTAssertEqual(g.controller.phase, .wheelActive)
    // Travel outside the disc never arms it.
    var o = Harness()
    o.beginDrag()
    o.send(.modifiersChanged([.shift]))
    o.send(.mouseDragged(at(400, 0)))
    XCTAssertNil(o.timers[.noEnter])
  }

  func testPanelLayoutKeepsTheCaptionOnScreen() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    let layout = h.view!.presentation.layout
    XCTAssertEqual(layout.captionPlacement, .below)
    XCTAssertEqual(layout.frame, Rect(x: 520, y: 320, width: 360, height: 392), "disc bounding square + 6 pt gap + 26 pt caption")
    XCTAssertEqual(layout.discCenter, Point(x: 180, y: 180))
    XCTAssertEqual(h.controller.layout?.global(Point(x: 180, y: 180)), center)
    // Pushed against the bottom of the work area: the caption goes above the disc.
    var b = Harness()
    b.beginDrag(at: Point(x: 690, y: 975), to: Point(x: 700, y: 978))
    b.send(.modifiersChanged([.shift]))
    let bottom = b.view!.presentation.layout
    XCTAssertEqual(b.view!.presentation.placement.center.y, 982 - 188)
    XCTAssertEqual(bottom.captionPlacement, .above)
    XCTAssertEqual(bottom.discCenter, Point(x: 180, y: 212))
    XCTAssertEqual(bottom.frame.maxY, 982 - 8, "the panel ends with the disc")
    // Too small for either side: no caption, the capsule alone shows the choice.
    let tiny = WheelPanelLayout.make(placement: WheelMath.placeWheel(activation: Point(x: 100, y: 100), workArea: Rect(x: 0, y: 0, width: 400, height: 260)), workArea: Rect(x: 0, y: 0, width: 400, height: 260))
    XCTAssertEqual(tiny.captionPlacement, .none)
    XCTAssertNil(tiny.captionRect)
  }

  func testCaptionAndAnnouncementFollowTheArmedChoice() {
    var h = Harness()
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.draggingEntered(items: png, point: center, sourceAllowsCopy: true))
    XCTAssertNil(h.view?.caption)
    XCTAssertNil(h.view?.announcement)
    h.send(.draggingUpdated(point: at(0, -120), sourceAllowsCopy: true))
    XCTAssertEqual(h.view?.caption, CapsuleContent(text: "JPG", style: .action))
    XCTAssertEqual(h.view?.announcement, "JPG")
    h.send(.draggingUpdated(point: at(120, 0), sourceAllowsCopy: true))  // HEIC, disabled
    XCTAssertEqual(h.view?.caption, CapsuleContent(text: "No HEIC encoder in this build", style: .reject))
    XCTAssertEqual(h.view?.announcement, "HEIC: No HEIC encoder in this build")
    h.send(.draggingUpdated(point: center, sourceAllowsCopy: true))
    XCTAssertNil(h.view?.caption)
  }

  func testReduceMotionHidesWithoutAnimation() {
    var h = Harness(config: DefaultConfig.config(locale: .en, reduceMotion: true))
    h.beginDrag()
    h.send(.modifiersChanged([.shift]))
    h.send(.escape)
    XCTAssertTrue(h.log.contains(.hide(animated: false)))
    XCTAssertEqual(h.view, nil)
  }
}
