import AppKit
import Darwin
import XCTest

@testable import OrbitDropHelperCore
@testable import OrbitDropHelperKit

/// Thread-safe call recorder for closures the helper runs off the main thread.
final class CallRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var calls: [Bool] = []  // Thread.isMainThread per call

  func record() {
    lock.lock()
    calls.append(Thread.isMainThread)
    lock.unlock()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return calls.count
  }

  var anyOnMain: Bool {
    lock.lock()
    defer { lock.unlock() }
    return calls.contains(true)
  }
}

/// Second, adversarial pass over the AppKit glue (docs/workstreams/hardening-macos.md).
extension DropTargetGlueTests {
  // MARK: System events

  /// The screen lock only arrives as a distributed notification; it must end an open session like
  /// sleep does. A uniquely named notification stands in for com.apple.screenIsLocked (posting
  /// the real one would reach every app on this Mac).
  func testScreenLockEndsTheSession() throws {
    let name = "com.orbitdrop.helper.tests.lock.\(UUID().uuidString)"
    app = makeApp { $0.screenLockNotifications = [name] }
    _ = try openWheel()
    XCTAssertNotNil(app.currentModel)
    DistributedNotificationCenter.default().postNotificationName(Notification.Name(name), object: nil, userInfo: nil, deliverImmediately: true)
    for _ in 0..<100 where app.sessionPhase != .idle { spin(0.02) }
    spin()
    XCTAssertEqual(app.sessionPhase, .idle)
    XCTAssertNil(app.currentModel, "no wheel left on screen")
    let ended = messages()
    XCTAssertEqual(ended.last?["reason"] as? String, "sleep")
    // Main also cancels open sessions on lock/sleep: its late cancelSession for the ended id is a no-op.
    let id = try XCTUnwrap(ended.last?["sessionId"] as? String)
    app.handle(.cancelSession(sessionId: id))
    spin()
    XCTAssertEqual(messages().count, ended.count, "exactly one terminal message per session")
    XCTAssertEqual(HelperApp.Options().screenLockNotifications, ["com.apple.screenIsLocked"], "production observes the real name")
  }

  func testWorkspaceSleepAndUserSwitchEndTheSession() throws {
    for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
      app = makeApp()
      _ = try openWheel()
      // Posted to the helper's own NSWorkspace center only (an in-process center, not system-wide).
      NSWorkspace.shared.notificationCenter.post(name: name, object: NSWorkspace.shared)
      spin()
      XCTAssertNil(app.currentModel, "\(name.rawValue)")
      XCTAssertEqual(messages().last?["reason"] as? String, "sleep", "\(name.rawValue)")
    }
  }

  /// A screen-parameter change that leaves the wheel on no display (unplugged, mirrored away)
  /// ends the session: no stranded window. A change that keeps it on screen leaves it alone.
  func testDisplayRemovalUnderTheWheelEndsTheSession() throws {
    var screens: [NSRect] = NSScreen.screens.map(\.frame)
    app = makeApp { $0.screenFramesProvider = { screens } }
    _ = try openWheel()
    NotificationCenter.default.post(name: NSApplication.didChangeScreenParametersNotification, object: NSApp)
    spin()
    XCTAssertNotNil(app.currentModel, "still on a screen: unchanged")
    screens = []
    NotificationCenter.default.post(name: NSApplication.didChangeScreenParametersNotification, object: NSApp)
    spin()
    XCTAssertNil(app.currentModel)
    XCTAssertEqual(app.sessionPhase, .idle)
    XCTAssertEqual(messages().last?["reason"] as? String, "error")
  }

  /// stdin reaches EOF while the AppKit thread is wedged (simulated by blocking the test's main
  /// thread): the watchdog still ends the process, and the graceful path runs once main is free.
  func testExitWatchdogEndsTheProcessWhenMainIsWedged() throws {
    var fds: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&fds), 0)
    let forced = CallRecorder()
    app = makeApp {
      $0.readStdin = true
      $0.inputFD = fds[0]
      $0.forceExit = { forced.record() }
      $0.forceExitDeadline = 0.2
    }
    _ = try openWheel()
    close(fds[1])  // main is gone
    Thread.sleep(forTimeInterval: 0.6)  // the AppKit thread cannot run the graceful exit meanwhile
    XCTAssertEqual(forced.count, 1, "forced exit after the deadline")
    XCTAssertFalse(forced.anyOnMain)
    spin(0.1)
    XCTAssertEqual(app.sessionPhase, .idle, "graceful path ran once main was free")
    XCTAssertNil(app.currentModel)
    XCTAssertEqual(messages().last?["reason"] as? String, "parentRequest")
    close(fds[0])
  }

  func testExitWatchdogArmsOnceAndOnlyFiresAfterItsDeadline() {
    let fired = CallRecorder()
    let deadline: TimeInterval = 1
    let watchdog = ExitWatchdog(deadline: deadline, exitNow: { fired.record() })
    XCTAssertFalse(watchdog.isArmed)
    let armed = Date()
    DispatchQueue.concurrentPerform(iterations: 8) { _ in watchdog.arm() }
    XCTAssertTrue(watchdog.isArmed)
    Thread.sleep(forTimeInterval: 0.1)
    let count = fired.count
    if Date().timeIntervalSince(armed) < deadline * 0.9 {  // a stalled machine proves nothing here
      XCTAssertEqual(count, 0, "not before the deadline")
    }
    for _ in 0..<60 where fired.count == 0 { Thread.sleep(forTimeInterval: 0.05) }
    Thread.sleep(forTimeInterval: 0.2)
    XCTAssertEqual(fired.count, 1, "exactly once")
    XCTAssertFalse(fired.anyOnMain)
    XCTAssertNil(HelperApp(options: { var o = HelperApp.Options(); o.exitProcess = false; return o }()).watchdog, "tests that do not exit get no watchdog")
  }

  // MARK: Protocol robustness

  /// Main re-sends `configure` on every settings change and may toggle `enabled`: the monitor is
  /// installed once per enable, an open session ends exactly once, and the next drag works.
  func testRepeatedConfigureAndEnableTogglesAreIdempotent() throws {
    let source = FakeDragInputSource()
    app = makeApp(observeWith: source)
    let config = DefaultConfig.config(locale: .en)
    for _ in 0..<50 { app.handle(.configure(config)) }
    XCTAssertEqual(source.installs, 1, "one global monitor however often configure arrives")
    let (_, _) = try openWheel(config: config)
    var off = config
    off.enabled = false
    for _ in 0..<3 {
      app.handle(.configure(off))
      app.handle(.configure(config))
    }
    spin()
    XCTAssertEqual(source.installs, 4, "re-installed after each disable")
    XCTAssertNil(app.currentModel)
    let all = messages()
    let terminal = all.filter { ["drop", "cancelled"].contains($0["type"] as? String) }
    XCTAssertEqual(terminal.count, 1, "the open session ended once")
    XCTAssertEqual(terminal.first?["reason"] as? String, "parentRequest")
    // A new session gets a new id and still drops.
    let (view, window) = try openWheel(config: config)
    pasteboard.writeObjects([URL(fileURLWithPath: "/tmp/a.pdf") as NSURL])
    let over = FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .every, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingEntered(over), .copy)
    XCTAssertTrue(view.performDragOperation(over))
    spin()
    let ids = Set(messages().compactMap { $0["sessionId"] as? String })
    XCTAssertEqual(ids.count, 2)
  }

  // MARK: Accessibility and hit shape

  /// VoiceOver hears why a drag cannot be used (folder, text, file promise…), once per session —
  /// before, only an armed sector was announced, so an unsupported drag was silent.
  func testUnsupportedDragIsAnnouncedOnce() throws {
    let (view, window) = try openWheel()
    pasteboard.writeObjects([URL(fileURLWithPath: "/Users/someone/Pictures", isDirectory: true) as NSURL])
    for dx in [0.0, 120, 0, -120] {
      _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: dx, dy: 0), mask: .every, pasteboard: pasteboard))
    }
    XCTAssertEqual(announcements, ["Folders aren't supported"])
    app.simulateObserved(.escape)
    spin()
    XCTAssertNil(app.currentModel)
  }

  /// Parity with the Windows helper: an online-only iCloud / File Provider file is refused from its
  /// attributes alone (the background stat saw SF_DATALESS) — built-in text, no Copy, no drop.
  func testOnlineOnlyCloudFileIsRefusedEndToEnd() throws {
    let resolved = CallRecorder()
    app = makeApp {
      $0.fileInfoResolver = { _, completion in
        resolved.record()
        DispatchQueue.global().async { completion(FileInfoResolver.Info(totalBytes: 2_000_000, containsDirectory: false, containsCloudPlaceholder: true)) }
      }
    }
    let (view, window) = try openWheel(config: DefaultConfig.config(locale: .en))
    pasteboard.writeObjects([URL(fileURLWithPath: "/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/Page 001.pdf") as NSURL])
    _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: 0), mask: .every, pasteboard: pasteboard))
    for _ in 0..<50 where app.currentModel?.content != .unsupported { spin(0.02) }
    XCTAssertEqual(resolved.count, 1, "one stat pass per session, after the drag-enter (the stat itself runs off main: testFileInfoResolverStatsOffMain)")
    XCTAssertEqual(app.currentModel?.capsule, CapsuleContent(text: "Download it first", style: .reject))
    XCTAssertEqual(announcements.last, "Download it first")
    let over = FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .every, pasteboard: pasteboard)
    XCTAssertEqual(view.draggingUpdated(over), [], "no Copy over any sector")
    XCTAssertFalse(view.prepareForDragOperation(over))
    XCTAssertFalse(view.performDragOperation(over))
    spin()
    let types = messages().map { $0["type"] as? String }
    XCTAssertFalse(types.contains("drop"))
    XCTAssertEqual(messages().last?["reason"] as? String, "invalidPayload")
  }

  /// Reduce Transparency: the disc is opaque (same palette), pixels outside the disc stay alpha 0.
  func testReduceTransparencyDrawsAnOpaqueDisc() throws {
    func deadZoneAndCorner(reduce: Bool) throws -> (Double, Double, Double) {
      app = makeApp { $0.reduceTransparencyProvider = { reduce } }
      let (view, _) = try openWheel()
      let model = try XCTUnwrap(app.currentModel)
      let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
      view.cacheDisplay(in: view.bounds, to: rep)
      let scale = Double(rep.pixelsWide) / Double(view.bounds.width)
      let c = model.presentation.layout.discCenter
      // Between the capsule and the sector band (the dead zone shows only the disc).
      let ri = WheelMath.innerRadius(model.presentation.placement.diameter, model.presentation.geometry)
      let deadZone = rep.colorAt(x: Int((c.x) * scale), y: Int((c.y - ri + 6) * scale))?.alphaComponent ?? -1
      let corner = rep.colorAt(x: 2, y: 2)?.alphaComponent ?? -1
      return (Double(deadZone), Double(corner), model.presentation.tokens.wheelDisc.a)
    }
    let translucent = try deadZoneAndCorner(reduce: false)
    XCTAssertLessThan(translucent.0, 0.9, "default: translucent disc")
    let opaque = try deadZoneAndCorner(reduce: true)
    XCTAssertEqual(opaque.2, 1, "wheelDisc drawn opaque")
    XCTAssertGreaterThan(opaque.0, 0.99, "dead zone is opaque")
    XCTAssertEqual(opaque.1, 0, "outside the disc stays transparent")
    XCTAssertEqual(translucent.1, 0)
  }

  /// #11 extended: every theme, both caption placements, and Reduce Transparency keep each pixel
  /// outside the disc and the caption pill at alpha 0 (a drop there reaches the window below).
  func testHitShapeStaysTransparentInEveryThemeAndPlacement() throws {
    for theme in ThemeName.allCases {
      for nearBottom in [false, true] {
        for reduce in [false, true] where theme == .light || !reduce {
          app = makeApp { $0.reduceTransparencyProvider = { reduce } }
          let config = DefaultConfig.config(locale: .en, theme: theme)
          let (view, window) = try openWheel(config: config, nearBottom: nearBottom)
          pasteboard.clearContents()
          pasteboard.writeObjects([URL(fileURLWithPath: "/tmp/a.png") as NSURL])
          // HEIC (disabled, straight right) shows the widest caption: the refusal reason.
          _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .every, pasteboard: pasteboard))
          let label = "\(theme), \(nearBottom ? "caption above" : "caption below")\(reduce ? ", reduce transparency" : "")"
          let model = try XCTUnwrap(app.currentModel, label)
          let layout = model.presentation.layout
          XCTAssertEqual(layout.captionPlacement, nearBottom ? .above : .below, label)
          let captionRect = try XCTUnwrap(layout.captionRect, label)
          XCTAssertNotNil(model.caption, label)
          let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
          view.cacheDisplay(in: view.bounds, to: rep)
          let scale = Double(rep.pixelsWide) / Double(view.bounds.width)
          let radius = model.presentation.placement.diameter / 2
          var outside = 0
          var pill = 0
          for py in 0..<rep.pixelsHigh {
            for px in 0..<rep.pixelsWide {
              let x = (Double(px) + 0.5) / scale
              let y = (Double(py) + 0.5) / scale
              let alpha = rep.colorAt(x: px, y: py)?.alphaComponent ?? 0
              let r = ((x - layout.discCenter.x) * (x - layout.discCenter.x) + (y - layout.discCenter.y) * (y - layout.discCenter.y)).squareRoot()
              if r <= radius + 1.5 { continue }
              if y >= captionRect.y && y <= captionRect.maxY {
                if alpha > 0.5 { pill += 1 }
                continue
              }
              if alpha > 0 { outside += 1 }
            }
          }
          XCTAssertEqual(outside, 0, "\(label): pixels outside disc ∪ caption strip must stay transparent")
          XCTAssertGreaterThan(pill, 100, "\(label): caption pill drawn")
        }
      }
    }
  }

  // MARK: Memory

  /// Many complete synthetic sessions (drop, Esc, release grace, neutral no-enter) through the real
  /// app, view and drop target: malloc's bytes in use must not grow with the session count.
  func testManySyntheticSessionsDoNotGrow() throws {
    let config = DefaultConfig.config(locale: .en)
    app.handle(.configure(config))
    pasteboard.writeObjects([URL(fileURLWithPath: "/Users/someone/Desktop/Page 001.pdf") as NSURL])
    let display = try XCTUnwrap(SystemInfo.displays().first)
    let start = Point(x: display.workArea.x + display.workArea.width / 2, y: display.workArea.y + display.workArea.height / 2 - 100)
    var drained = [UInt8](repeating: 0, count: 65536)
    func drain() {
      app.flushOutput()
      while read(output.readFD, &drained, drained.count) > 0 {}
    }
    func session(_ i: Int) throws {
      try autoreleasepool {
        app.simulateObserved(.mouseDown(start, held: []))
        app.simulateObserved(.mouseDragged(Point(x: start.x + 8, y: start.y)))
        app.simulateObserved(.dragPasteboardChanged)
        app.simulateObserved(.modifiersChanged([.shift]))
        XCTAssertTrue(app.fireTimerForTests(.modifierSettle))
        let view = try XCTUnwrap(app.dropTargetView as? WheelView)
        let window = try XCTUnwrap(view.window)
        switch i % 4 {
        case 0:  // drop on JPG
          let over = FakeDraggingInfo(window: window, location: location(view, dx: 120, dy: 0), mask: .every, pasteboard: pasteboard)
          _ = view.draggingEntered(over)
          _ = view.draggingUpdated(over)
          XCTAssertTrue(view.performDragOperation(over))
        case 1:  // Esc
          _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: 0), mask: .every, pasteboard: pasteboard))
          app.simulateObserved(.escape)
        case 2:  // released elsewhere: release grace
          _ = view.draggingEntered(FakeDraggingInfo(window: window, location: location(view, dx: 0, dy: 120), mask: .every, pasteboard: pasteboard))
          app.wheelDraggingExited(pointerInsideDisc: false, buttonDown: true)
          app.simulateObserved(.mouseUp(Point(x: start.x + 600, y: start.y)))
          XCTAssertTrue(app.fireTimerForTests(.releaseGrace))
        default:  // neutral wheel, nothing ever entered
          app.simulateObserved(.mouseDragged(Point(x: start.x + 60, y: start.y + 20)))
          XCTAssertTrue(app.fireTimerForTests(.noEnter))
        }
        app.simulateObserved(.mouseUp(start))
        app.simulateObserved(.modifiersChanged([]))
        RunLoop.main.run(mode: .default, before: Date())  // the deferred hide
        XCTAssertEqual(app.sessionPhase, .idle)
      }
      if i % 50 == 0 { drain() }
    }
    func bytesInUse() -> Int {
      var stats = malloc_statistics_t()
      malloc_zone_statistics(nil, &stats)
      return stats.size_in_use
    }
    for i in 0..<200 { try session(i) }
    drain()
    spin(0.05)
    let before = bytesInUse()
    for i in 0..<1200 { try session(i) }
    drain()
    spin(0.05)
    let growth = bytesInUse() - before
    print("MEMORY 1200 synthetic sessions: malloc size_in_use grew by \(growth) bytes (\(growth / 1200) B/session)")
    XCTAssertLessThan(growth, 1_200_000, "≤ 1 KB per session (noise), i.e. no per-session leak")
    XCTAssertNil(app.currentModel)
    XCTAssertFalse(app.panelForTests?.isVisible ?? true)
    XCTAssertEqual(app.pendingTimerCountForTests, 0, "no timer left behind")
  }

  /// Opens the wheel in the middle of the main display, or pushed against the bottom of its work
  /// area (the caption strip then sits above the disc).
  func openWheel(config: HelperConfig, nearBottom: Bool) throws -> (WheelView, NSWindow) {
    guard nearBottom else { return try openWheel(config: config) }
    app.handle(.configure(config))
    let display = try XCTUnwrap(SystemInfo.displays().first)
    let start = Point(x: display.workArea.x + display.workArea.width / 2, y: display.workArea.maxY - 20)
    app.simulateObserved(.mouseDown(start, held: []))
    app.simulateObserved(.mouseDragged(Point(x: start.x + 8, y: start.y)))
    app.simulateObserved(.dragPasteboardChanged)
    app.simulateObserved(.modifiersChanged([.shift]))
    XCTAssertTrue(app.fireTimerForTests(.modifierSettle))
    let view = try XCTUnwrap(app.dropTargetView as? WheelView)
    return (view, try XCTUnwrap(view.window))
  }
}

/// stdout writer: concurrent senders, a stalled reader, a vanished reader.
final class StdioTransportTests: XCTestCase {
  func testConcurrentSendersProduceIntactLinesInPerThreadOrder() throws {
    var fds: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&fds), 0)
    let writer = StdoutWriter(fd: fds[1]) {}
    let threads = 8
    let perThread = 400
    let collected = DispatchQueue(label: "collect")
    nonisolated(unsafe) var data = Data()
    let done = DispatchSemaphore(value: 0)
    let readFD = fds[0]
    Thread.detachNewThread {
      var buffer = [UInt8](repeating: 0, count: 65536)
      while true {
        let n = read(readFD, &buffer, buffer.count)
        if n <= 0 { break }
        collected.sync { data.append(contentsOf: buffer[0..<n]) }
      }
      done.signal()
    }
    DispatchQueue.concurrentPerform(iterations: threads) { t in
      for i in 0..<perThread {
        writer.send(.log(level: .info, message: "t\(t) #\(i) 한글 😀 \"q\" \\ \n"))
      }
    }
    XCTAssertTrue(writer.flush(timeout: 5))
    close(fds[1])
    XCTAssertEqual(done.wait(timeout: .now() + 5), .success)
    close(fds[0])
    let lines = collected.sync { data }.split(separator: 0x0A)
    XCTAssertEqual(lines.count, threads * perThread, "one line per message, none torn or merged")
    struct Log: Decodable { let v: Int; let type: String; let level: String; let message: String }
    var next = [Int](repeating: 0, count: threads)
    for line in lines {
      let log = try JSONDecoder().decode(Log.self, from: Data(line))
      let parts = log.message.split(separator: " ")
      let t = Int(parts[0].dropFirst())!
      let i = Int(parts[1].dropFirst())!
      XCTAssertEqual(i, next[t], "per-thread order kept")
      next[t] = i + 1
      XCTAssertTrue(log.message.hasSuffix("한글 😀 \"q\" \\ \n"))
    }
  }

  /// A reader that stops reading must never block the sender (the AppKit thread in production).
  func testSendNeverBlocksOnAStalledReader() throws {
    var fds: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&fds), 0)
    let writer = StdoutWriter(fd: fds[1]) {}
    let started = Date()
    for i in 0..<3000 { writer.send(.log(level: .debug, message: "line \(i) " + String(repeating: "x", count: 200))) }
    XCTAssertLessThan(Date().timeIntervalSince(started), 1.0, "3000 sends (> 600 KB) with nobody reading")
    XCTAssertFalse(writer.flush(timeout: 0.2), "the pipe is full: the writer queue waits, not the caller")
    var total = 0
    var buffer = [UInt8](repeating: 0, count: 65536)
    _ = fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK)
    let deadline = Date().addingTimeInterval(10)
    while total < 3000 && Date() < deadline {
      let n = read(fds[0], &buffer, buffer.count)
      if n > 0 { total += buffer[0..<n].filter { $0 == 0x0A }.count } else { usleep(1000) }
    }
    XCTAssertEqual(total, 3000, "every line arrives once the reader resumes")
    close(fds[0])
    close(fds[1])
  }

  /// EPIPE (main closed its end) is reported once and later sends are dropped, never retried.
  func testBrokenPipeIsReportedOnce() throws {
    var fds: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&fds), 0)
    let reports = CallRecorder()
    signal(SIGPIPE, SIG_IGN)  // as HelperMain.run does
    let writer = StdoutWriter(fd: fds[1]) { reports.record() }
    close(fds[0])
    for _ in 0..<5 { writer.send(.pong(nonce: 1)) }
    XCTAssertTrue(writer.flush(timeout: 2))
    XCTAssertEqual(reports.count, 1)
    XCTAssertTrue(writer.isBroken)
    close(fds[1])
  }
}
