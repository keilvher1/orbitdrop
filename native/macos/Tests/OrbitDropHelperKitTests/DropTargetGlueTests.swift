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

@MainActor
final class DropTargetGlueTests: XCTestCase {
  var readFD: Int32 = -1
  var app: HelperApp!
  var pasteboard: NSPasteboard!
  var output = ""

  override func setUp() async throws {
    var fds: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&fds), 0)
    readFD = fds[0]
    _ = fcntl(readFD, F_SETFL, fcntl(readFD, F_GETFL) | O_NONBLOCK)
    var options = HelperApp.Options()
    options.outputFD = fds[1]
    options.readStdin = false
    options.presentWindows = false
    options.exitProcess = false
    options.observeGlobally = false
    app = HelperApp(options: options)
    app.start()
    pasteboard = NSPasteboard(name: NSPasteboard.Name("com.orbitdrop.helper.glue.\(UUID().uuidString)"))
    pasteboard.clearContents()
  }

  override func tearDown() async throws {
    pasteboard.releaseGlobally()
    close(readFD)
  }

  /// All messages written so far (drains the pipe).
  func messages() -> [[String: Any]] {
    app.flushOutput()
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(readFD, &buffer, buffer.count)
      if n <= 0 { break }
      output += String(decoding: buffer[0..<n], as: UTF8.self)
    }
    return output.split(separator: "\n").map { try! JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
  }

  func spin(_ seconds: TimeInterval = 0.05) {
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
  }

  /// Starts a drag near the main screen's center and presses Shift: the wheel "appears" (offscreen).
  func openWheel(modifiers: Set<ModifierKey> = [.shift]) throws -> (WheelView, NSWindow, WheelPlacement) {
    app.handle(.configure(DefaultConfig.config(locale: .en)))
    let display = try XCTUnwrap(SystemInfo.displays().first)
    let start = Point(x: display.workArea.x + display.workArea.width / 2, y: display.workArea.y + display.workArea.height / 2)
    app.simulateObserved(.mouseDown(start))
    app.simulateObserved(.modifiersChanged([]))
    app.simulateObserved(.mouseDragged(Point(x: start.x + 8, y: start.y)))
    app.simulateObserved(.dragPasteboardChanged)
    app.simulateObserved(.modifiersChanged(modifiers))
    XCTAssertEqual(app.sessionPhase, .awaitingPayload)
    let view = try XCTUnwrap(app.dropTargetView as? WheelView)
    let window = try XCTUnwrap(view.window)
    XCTAssertFalse(window.isVisible, "tests never put the panel on screen")
    XCTAssertFalse(window.canBecomeKey)
    XCTAssertFalse(window.canBecomeMain)
    XCTAssertTrue(window.styleMask.contains(.nonactivatingPanel))
    let placement = try XCTUnwrap(app.currentModel?.presentation.placement)
    XCTAssertEqual(placement.center.x, start.x + 8, accuracy: 1e-9, "centered on the pointer")
    return (view, window, placement)
  }

  /// Window-base location (y up) for a point given relative to the wheel center (y down).
  func location(_ view: WheelView, dx: Double, dy: Double) -> NSPoint {
    NSPoint(x: view.bounds.midX + dx, y: view.bounds.height - (view.bounds.midY + dy))
  }

  func testDropOnJpgSectorSendsExactlyOneCopyDrop() throws {
    let (view, window, _) = try openWheel()
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
    XCTAssertEqual(drop["mode"] as? String, "convert")
    XCTAssertEqual(drop["dropEffect"] as? String, "copy")
    XCTAssertEqual(drop["sessionId"] as? String, all[1]["sessionId"] as? String)
    XCTAssertEqual(all[2]["menuKey"] as? String, "pdf")
  }

  func testSourceWithoutCopyIsRejected() throws {
    let (view, window, _) = try openWheel()
    pasteboard.writeObjects([URL(fileURLWithPath: "/tmp/a.pdf") as NSURL])
    let moveOnly = FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .move, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(moveOnly), [])
    XCTAssertEqual(view.draggingUpdated(moveOnly), [])
    XCTAssertFalse(view.prepareForDragOperation(moveOnly))
    XCTAssertFalse(view.performDragOperation(moveOnly))
    spin()
    let types = messages().map { $0["type"] as! String }
    XCTAssertFalse(types.contains("drop"))
    XCTAssertEqual(messages().last?["reason"] as? String, "invalidPayload")
  }

  func testTextDragShowsUnsupported() throws {
    let (view, window, _) = try openWheel()
    pasteboard.setString("hello", forType: .string)
    let info = FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: -120), mask: .every, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(info), [])
    XCTAssertEqual(app.currentModel?.content, .unsupported)
    let state = messages().last!
    XCTAssertEqual(state["state"] as? String, "WheelActive")
    XCTAssertTrue(state["menuKey"] is NSNull)
    XCTAssertFalse(view.performDragOperation(info))
  }

  func testToolsComboAndExitReentry() throws {
    let (view, window, _) = try openWheel(modifiers: [.alt, .shift])
    pasteboard.writeObjects([URL(fileURLWithPath: "/tmp/photo.png") as NSURL])
    let enter = FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: 0), mask: [.copy, .generic], pasteboard: pasteboard)
    _ = view.draggingEntered(enter)
    XCTAssertEqual(app.currentModel?.content.sectors.first?.actionId, .toolCompress)
    XCTAssertEqual(app.currentModel?.presentation.mode, .tools)
    // Leaving the wheel (pointer outside) keeps it; re-entering works.
    app.wheelDraggingExited(pointerInsideDisc: false, buttonDown: true)
    XCTAssertNotNil(app.currentModel)
    let back = FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: -125), mask: [.copy, .generic], pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(back), .copy)
    XCTAssertTrue(view.performDragOperation(back))
    spin()
    let drop = messages().last!
    XCTAssertEqual(drop["type"] as? String, "drop")
    XCTAssertEqual(drop["actionId"] as? String, "tool.compress")
    XCTAssertEqual(drop["mode"] as? String, "tools")
  }

  func testCancelSessionFromMainHidesTheWheel() throws {
    _ = try openWheel()
    let id = try XCTUnwrap(messages().last?["sessionId"] as? String)
    app.handle(.cancelSession(sessionId: id))
    spin()
    XCTAssertNil(app.currentModel)
    let last = messages().last!
    XCTAssertEqual(last["type"] as? String, "cancelled")
    XCTAssertEqual(last["reason"] as? String, "parentRequest")
  }

  func testPingAndPermissions() {
    app.handle(.ping(nonce: 99))
    app.handle(.queryPermissions)
    let all = messages()
    XCTAssertEqual(all.first?["type"] as? String, "ready")
    XCTAssertEqual(all.first?["arch"] as? String, HelperInfo.arch)
    XCTAssertEqual(all[1]["nonce"] as? Int, 99)
    let items = all[2]["items"] as! [[String: Any]]
    XCTAssertEqual(items.compactMap { $0["required"] as? Bool }, [false, false])
  }
}
