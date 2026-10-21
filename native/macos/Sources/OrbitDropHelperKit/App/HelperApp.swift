import AppKit
import Darwin
import Foundation
import OrbitDropHelperCore

/// Session ids: `m<pid>-<counter>-<random>` — unique across helper processes, as
/// main's DragSessionTracker requires, and within ^[A-Za-z0-9_-]{1,64}$.
final class SessionIdGenerator: @unchecked Sendable {
  private let lock = NSLock()
  private var counter = 0
  private let prefix: String

  init(pid: Int32 = ProcessInfo.processInfo.processIdentifier) {
    let random = String(UInt32.random(in: 0...UInt32.max), radix: 36)
    prefix = "m\(pid)-\(random)"
  }

  func next() -> String {
    lock.lock()
    defer { lock.unlock() }
    counter += 1
    return "\(prefix)-\(counter)"
  }
}

/// The running helper: stdio protocol ⇄ DragSessionController ⇄ AppKit (observer,
/// wheel panel, drop target, timers, system notifications).
@MainActor
public final class HelperApp: NSObject, NSApplicationDelegate, WheelDropHost {
  public struct Options {
    /// File descriptor for NDJSON output (stdout in production, a pipe in tests).
    public var outputFD: Int32 = STDOUT_FILENO
    /// Start the stdin reader (false in tests, which inject lines directly).
    public var readStdin = true
    /// Order the panel front when a wheel is shown (false in tests: nothing appears on screen).
    public var presentWindows = true
    /// Exit the process on shutdown / EOF (false in tests).
    public var exitProcess = true
    /// Install the global mouse monitor when enabled (false in tests, which inject events
    /// with `simulateObserved` so real clicks on the machine cannot interfere).
    public var observeGlobally = true
    public init() {}
  }

  public static let debugLogging = ProcessInfo.processInfo.environment["ORBITDROP_HELPER_DEBUG"] == "1"

  private let options: Options
  private var writer: StdoutWriter!
  private var reader: StdinReader?
  private var controller: DragSessionController
  private let observer = GlobalDragObserver()
  private var panel: WheelPanel?
  private(set) var wheelView: WheelView?
  private var timers: [SessionTimer: Timer] = [:]
  private var appearTimer: Timer?
  private var visibilityGeneration = 0
  private var terminating = false
  private var activity: NSObjectProtocol?
  private var signalSources: [DispatchSourceSignal] = []
  private var notificationTokens: [(NotificationCenter, NSObjectProtocol)] = []

  public init(options: Options = Options()) {
    self.options = options
    let ids = SessionIdGenerator()
    controller = DragSessionController(makeSessionId: { ids.next() })
    super.init()
    writer = StdoutWriter(fd: options.outputFD) { [weak self] in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.terminate(reason: "stdout closed") } }
    }
    observer.onEvent = { [weak self] event in self?.handleObserved(event) }
    observer.sessionNeedsPolling = { [weak self] in self?.controller.needsPolling ?? false }
    observer.wheelVisible = { [weak self] in self?.controller.isWheelShown ?? false }
  }

  // MARK: Lifecycle

  public func applicationDidFinishLaunching(_ notification: Notification) {
    start()
  }

  /// Starts I/O and announces `ready` (called by applicationDidFinishLaunching; tests call it directly).
  public func start() {
    installNotifications()
    installSignalHandlers()
    if options.readStdin {
      let reader = StdinReader(
        onLine: { [weak self] line in DispatchQueue.main.async { MainActor.assumeIsolated { self?.handleLine(line) } } },
        onOversized: { [weak self] bytes in DispatchQueue.main.async { MainActor.assumeIsolated { self?.log(.warn, "ignored line longer than \(HelperProtocol.maxLineBytes) bytes (\(bytes) bytes)") } } },
        onEOF: { [weak self] in DispatchQueue.main.async { MainActor.assumeIsolated { self?.terminate(reason: "stdin closed") } } }
      )
      self.reader = reader
      reader.start()
    }
    let available = GlobalDragObserver.canInstallMonitor()
    writer.send(.ready(ReadyMessage(
      helperVersion: HelperInfo.version, platform: HelperInfo.platform, arch: HelperInfo.arch, osVersion: SystemInfo.osVersion,
      pid: Int64(ProcessInfo.processInfo.processIdentifier), globalDragAvailable: available,
      globalDragReason: available ? nil : "NSEvent global mouse monitor could not be installed (no window server session?)"
    )))
    if SystemInfo.isTranslated { log(.info, "x64 helper running under Rosetta 2") }
  }

  /// Hide everything, tell main about an open session, flush stdout and exit.
  public func terminate(reason: String) {
    guard !terminating else { return }
    terminating = true
    debug("terminating: \(reason)")
    apply(controller.handle(.parentEOF))
    observer.stop()
    hideNow()
    endActivity()
    writer.flush(timeout: 1.5)
    if options.exitProcess { exit(0) }
  }

  // MARK: Protocol input

  func handleLine(_ line: ParsedLine) {
    switch line {
    case .message(let message): handle(message)
    case .blank: break
    case .invalid(let error): log(.warn, "ignored invalid line: \(error)")
    }
  }

  public func handle(_ message: MainToHelperMessage) {
    guard !terminating else { return }
    switch message {
    case .configure(let config):
      controller.displays = SystemInfo.displays()
      apply(controller.handle(.configure(config)))
      setObserving(config.enabled)
      warnAboutModifiers(config)
      debug("configured (enabled=\(config.enabled), menus=\(config.menus.count), extensions=\(config.extensions.count))")
    case .cancelSession(let id):
      apply(controller.handle(.cancelRequest(sessionId: id)))
    case .ping(let nonce):
      writer.send(.pong(nonce: nonce))
    case .shutdown:
      terminate(reason: "shutdown requested")
    case .queryPermissions:
      writer.send(.permissions(SystemInfo.permissions()))
    }
  }

  private func warnAboutModifiers(_ config: HelperConfig) {
    for (name, combo) in [("convert", config.convertModifiers), ("tools", config.toolsModifiers)] where combo.keys.contains(.control) || combo.keys.contains(.command) {
      log(.warn, "\(name) modifiers include Control/Command: AppKit turns these into Link/Generic drag operations, so drops cannot be accepted as Copy")
    }
    if config.convertModifiers == config.toolsModifiers {
      log(.warn, "convert and tools modifiers are identical; the tools wheel cannot be opened")
    }
  }

  private func setObserving(_ enabled: Bool) {
    if enabled {
      guard options.observeGlobally, !observer.isRunning else { return }
      if observer.start() {
        beginActivity()
      } else {
        writer.send(.error(code: "GLOBAL_MONITOR_UNAVAILABLE", message: "NSEvent global mouse monitor could not be installed", fatal: false))
      }
    } else {
      observer.stop()
      endActivity()
    }
  }

  /// Keeps App Nap from throttling the 60 Hz poll during drags (idle system sleep stays allowed).
  private func beginActivity() {
    guard activity == nil else { return }
    activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "OrbitDrop drag wheel observation")
  }

  private func endActivity() {
    if let activity { ProcessInfo.processInfo.endActivity(activity) }
    activity = nil
  }

  // MARK: Observer → controller

  func handleObserved(_ event: SessionEvent) {
    guard !terminating else { return }
    if case .mouseDown = event { controller.displays = SystemInfo.displays() }
    apply(controller.handle(event))
  }

  /// Test hook: feed an event as if it came from the global observer.
  public func simulateObserved(_ event: SessionEvent) {
    handleObserved(event)
  }

  public var sessionPhase: SessionPhase { controller.phase }

  // MARK: Commands

  private func apply(_ output: SessionOutput) {
    for command in output.commands { execute(command) }
  }

  private func execute(_ command: SessionCommand) {
    switch command {
    case .showWheel(let presentation):
      show(presentation)
    case .setMode, .setContent, .setHighlight, .setCapsule:
      if var model = wheelView?.model, model.apply(command) { wheelView?.model = model }
    case .send(let message):
      writer.send(message)
    case .hide(let animated):
      // After a drop this runs on the next run-loop turn, after performDragOperation returned.
      let generation = visibilityGeneration
      DispatchQueue.main.async { [weak self] in
        MainActor.assumeIsolated {
          guard let self, self.visibilityGeneration == generation else { return }
          self.hide(animated: animated)
        }
      }
    case .startTimer(let timer, let milliseconds, let token):
      startTimer(timer, milliseconds: milliseconds, token: token)
    case .cancelTimer(let timer):
      timers[timer]?.invalidate()
      timers[timer] = nil
    case .resolveFileInfo(let sessionId, let paths):
      FileInfoResolver.resolve(paths: paths) { [weak self] total, directory in
        DispatchQueue.main.async {
          MainActor.assumeIsolated { self?.apply(self?.controller.handle(.fileInfo(sessionId: sessionId, totalBytes: total, containsDirectory: directory)) ?? SessionOutput()) }
        }
      }
    }
  }

  private func startTimer(_ kind: SessionTimer, milliseconds: Int, token: String) {
    timers[kind]?.invalidate()
    let timer = Timer(timeInterval: Double(milliseconds) / 1000, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.timers[kind] = nil
        self.apply(self.controller.handle(.timerFired(kind, token: token)))
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    timers[kind] = timer
  }

  // MARK: Panel

  private func ensurePanel() -> (WheelPanel, WheelView) {
    if let panel, let wheelView { return (panel, wheelView) }
    let panel = WheelPanel()
    let view = WheelView(frame: NSRect(x: 0, y: 0, width: 408, height: 408))
    view.host = self
    panel.contentView = view
    self.panel = panel
    self.wheelView = view
    return (panel, view)
  }

  private func show(_ presentation: WheelPresentation) {
    let (panel, view) = ensurePanel()
    visibilityGeneration += 1
    appearTimer?.invalidate()
    appearTimer = nil
    let frame = Coords.globalRectToAppKit(presentation.placement.windowFrame, primaryFrame: SystemInfo.primaryFrame)
    panel.setFrame(SystemInfo.nsRect(frame), display: false)
    view.frame = NSRect(x: 0, y: 0, width: frame.width, height: frame.height)
    view.model = WheelViewModel(presentation: presentation, capsule: CapsuleContent(text: "", style: .hint))
    let animate = !presentation.reduceMotion && presentation.tokens.appearMs > 0
    view.appear = animate ? 0 : 1
    // A zero-duration animator set replaces a fade-out still running from the previous drop.
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0
      panel.animator().alphaValue = animate ? 0 : 1
    }
    panel.alphaValue = animate ? 0 : 1
    if options.presentWindows { panel.orderFrontRegardless() }
    if animate { runAppear(duration: presentation.tokens.appearMs / 1000) }
  }

  private func runAppear(duration: Double) {
    let start = CACurrentMediaTime()
    let generation = visibilityGeneration
    let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] t in
      let done = MainActor.assumeIsolated { () -> Bool in
        guard let self, self.visibilityGeneration == generation, let panel = self.panel else { return true }
        let progress = min(1, (CACurrentMediaTime() - start) / max(duration, 0.001))
        let eased = 1 - pow(1 - progress, 3)
        panel.alphaValue = CGFloat(eased)
        self.wheelView?.appear = CGFloat(eased)
        if progress >= 1 { self.appearTimer = nil }
        return progress >= 1
      }
      if done { t.invalidate() }
    }
    RunLoop.main.add(timer, forMode: .common)
    appearTimer = timer
  }

  private func hide(animated: Bool) {
    guard let panel else { return }
    visibilityGeneration += 1
    appearTimer?.invalidate()
    appearTimer = nil
    let duration = animated ? (wheelView?.model?.presentation.tokens.disappearMs ?? 0) / 1000 : 0
    guard panel.isVisible, duration > 0, options.presentWindows else {
      hideNow()
      return
    }
    let generation = visibilityGeneration
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = duration
      panel.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.visibilityGeneration == generation else { return }
        self.hideNow()
      }
    })
  }

  private func hideNow() {
    panel?.orderOut(nil)
    panel?.alphaValue = 1
    wheelView?.model = nil
  }

  /// Test hook: the model currently drawn (nil when hidden).
  public var currentModel: WheelViewModel? { wheelView?.model }

  /// Test hook: the drop-target view (exists once a wheel was shown).
  public var dropTargetView: NSView? { wheelView }

  /// Test hook: wait until queued output was written.
  @discardableResult
  public func flushOutput(timeout: TimeInterval = 2) -> Bool { writer.flush(timeout: timeout) }

  // MARK: WheelDropHost

  private func global(_ local: CGPoint) -> Point {
    let origin = controller.placement?.windowFrame ?? Rect(x: 0, y: 0, width: 0, height: 0)
    return Point(x: origin.x + Double(local.x), y: origin.y + Double(local.y))
  }

  func wheelDraggingEntered(items: [DragItem], local: CGPoint, allowsCopy: Bool) -> NSDragOperation {
    let output = controller.handle(.draggingEntered(items: items, point: global(local), sourceAllowsCopy: allowsCopy))
    apply(output)
    return output.operation == .copy ? .copy : []
  }

  func wheelDraggingUpdated(local: CGPoint, allowsCopy: Bool) -> NSDragOperation {
    let output = controller.handle(.draggingUpdated(point: global(local), sourceAllowsCopy: allowsCopy))
    apply(output)
    return output.operation == .copy ? .copy : []
  }

  func wheelDraggingExited(pointerInsideDisc: Bool, buttonDown: Bool) {
    apply(controller.handle(.draggingExited(pointerInsideWheel: pointerInsideDisc, buttonDown: buttonDown)))
  }

  func wheelPrepareForDragOperation() -> Bool {
    controller.lastOperation == .copy
  }

  func wheelPerformDrop(items: [DragItem], local: CGPoint, allowsCopy: Bool) -> Bool {
    let output = controller.handle(.performDrop(items: items, point: global(local), sourceAllowsCopy: allowsCopy))
    apply(output)
    return output.dropAccepted
  }

  func wheelDraggingEnded() {
    apply(controller.handle(.draggingEnded))
  }

  // MARK: System events

  private func installNotifications() {
    let workspace = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
      let token = workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.handleObserved(.sleep) }
      }
      notificationTokens.append((workspace, token))
    }
    let token = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.screensChanged() }
    }
    notificationTokens.append((NotificationCenter.default, token))
  }

  private func screensChanged() {
    controller.displays = SystemInfo.displays()
    guard controller.isWheelShown, let panel else { return }
    let center = NSPoint(x: panel.frame.midX, y: panel.frame.midY)
    if !NSScreen.screens.contains(where: { $0.frame.contains(center) }) {
      // The display under the wheel went away: never leave a stranded window.
      apply(controller.handle(.invalidate(.error)))
    }
  }

  private func installSignalHandlers() {
    guard options.exitProcess else { return }
    for sig in [SIGTERM, SIGINT, SIGHUP] {
      signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.terminate(reason: "signal \(sig)") } }
      source.resume()
      signalSources.append(source)
    }
  }

  // MARK: Logging (never paths or file contents)

  func log(_ level: LogLevel, _ message: String) {
    writer.send(.log(level: level, message: message))
  }

  func debug(_ message: String) {
    if Self.debugLogging { log(.debug, message) }
  }
}

/// Entry point for the default (stdio) mode.
@MainActor
public enum HelperMain {
  private static var delegate: HelperApp?

  public static func run() -> Never {
    signal(SIGPIPE, SIG_IGN)  // a closed stdout must surface as EPIPE, not kill the process
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)  // no Dock icon, no menu bar, never activates
    let helper = HelperApp()
    delegate = helper
    app.delegate = helper
    app.run()
    exit(0)
  }
}
