import AppKit
import Darwin
import Foundation
import OrbitDropHelperCore

/// Session ids: `m<pid>-<random>-<counter>` — unique across helper processes (even when the OS
/// reuses a pid), as main's DragSessionTracker requires, and within ^[A-Za-z0-9_-]{1,64}$.
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
    /// Exit the process on stop / EOF (false in tests).
    public var exitProcess = true
    /// Install the global mouse monitor when enabled (false in tests that inject events with
    /// `simulateObserved`; tests that drive the real observer pass a fake `inputSource` instead).
    public var observeGlobally = true
    /// Where mouse/modifier/pasteboard state comes from (nil = the real system source).
    public var inputSource: DragInputSource?
    /// OS "Reduce motion" (read when NSWorkspace posts accessibilityDisplayOptionsDidChange).
    public var reduceMotionProvider: @MainActor () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    /// Input Monitoring status (TCC). Queried off the main thread and cached, never in an event callback.
    public var inputMonitoringProvider: @Sendable () -> Bool = { SystemInfo.inputMonitoringGranted }
    /// Posts a VoiceOver announcement (nil = NSAccessibility announcement when VoiceOver runs).
    public var announcer: (@MainActor (String) -> Void)?
    public init() {}
  }

  public static let debugLogging = ProcessInfo.processInfo.environment["ORBITDROP_HELPER_DEBUG"] == "1"
  /// How often the cached Input Monitoring status is refreshed while observing.
  static let permissionRefreshInterval: TimeInterval = 60

  private let options: Options
  private var writer: StdoutWriter!
  private var reader: StdinReader?
  private var controller: DragSessionController
  private let observer: GlobalDragObserver
  private var panel: WheelPanel?
  private(set) var wheelView: WheelView?
  private var timers: [SessionTimer: Timer] = [:]
  private var appearTimer: Timer?
  private var permissionTimer: Timer?
  private var visibilityGeneration = 0
  private var terminating = false
  private var activity: NSObjectProtocol?
  private var signalSources: [DispatchSourceSignal] = []
  private var notificationTokens: [(NotificationCenter, NSObjectProtocol)] = []
  private var lastAnnouncement: String?
  /// Cached TCC status; drives Escape polling.
  private var inputMonitoringGranted = false {
    didSet { observer.escapePollingAllowed = inputMonitoringGranted }
  }
  /// Set when the OS turns Reduce Motion on after main's last `configure`; cleared by the next one.
  private(set) var osReduceMotionOverride = false

  public init(options: Options = Options()) {
    self.options = options
    let ids = SessionIdGenerator()
    controller = DragSessionController(makeSessionId: { ids.next() })
    observer = GlobalDragObserver(source: options.inputSource ?? SystemDragInputSource())
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
    controller.displays = SystemInfo.displays()
    refreshPermissionCache()
    if options.readStdin {
      let reader = StdinReader(
        onLine: { [weak self] line in DispatchQueue.main.async { MainActor.assumeIsolated { self?.handleLine(line) } } },
        onOversized: { [weak self] bytes in DispatchQueue.main.async { MainActor.assumeIsolated { self?.log(.warn, "ignored line longer than \(HelperProtocol.maxLineBytes) bytes (\(bytes) bytes)") } } },
        onEOF: { [weak self] in DispatchQueue.main.async { MainActor.assumeIsolated { self?.terminate(reason: "stdin closed") } } }
      )
      self.reader = reader
      reader.start()
    }
    let available = SystemDragInputSource.canInstallMonitor()
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
      osReduceMotionOverride = false  // main's value wins again until the OS changes it
      apply(controller.handle(.configure(config)))
      setObserving(config.enabled)
      refreshPermissionCache()
      warnAboutModifiers(config)
      debug("configured (enabled=\(config.enabled), menus=\(config.menus.count), extensions=\(config.extensions.count))")
    case .cancelSession(let id):
      apply(controller.handle(.cancelRequest(sessionId: id)))
    case .ping(let nonce):
      writer.send(.pong(nonce: nonce))
    case .shutdown:
      terminate(reason: "stop requested")
    case .queryPermissions:
      let items = SystemInfo.permissions()
      inputMonitoringGranted = items.first { $0.name == .inputMonitoring }?.granted ?? false
      writer.send(.permissions(items))
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
      // Create the (hidden) panel and register its drag types now, not during the first drag.
      _ = ensurePanel()
      guard options.observeGlobally, !observer.isRunning else { return }
      if observer.start() {
        beginActivity()
        startPermissionRefresh()
      } else {
        writer.send(.error(code: "GLOBAL_MONITOR_UNAVAILABLE", message: "NSEvent global mouse monitor could not be installed", fatal: false))
      }
    } else {
      observer.stop()
      endActivity()
      permissionTimer?.invalidate()
      permissionTimer = nil
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

  /// TCC is asked off the main thread and only rarely (start, configure, every 60 s while
  /// observing) — never from a mouse/drag callback.
  private func refreshPermissionCache() {
    let provider = options.inputMonitoringProvider
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let granted = provider()
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.inputMonitoringGranted = granted } }
    }
  }

  private func startPermissionRefresh() {
    guard permissionTimer == nil else { return }
    let timer = Timer(timeInterval: Self.permissionRefreshInterval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.refreshPermissionCache() }
    }
    timer.tolerance = 5
    RunLoop.main.add(timer, forMode: .common)
    permissionTimer = timer
  }

  // MARK: Observer → controller

  func handleObserved(_ event: SessionEvent) {
    guard !terminating else { return }
    apply(controller.handle(event))
  }

  /// Test hook: feed an event as if it came from the global observer.
  public func simulateObserved(_ event: SessionEvent) {
    handleObserved(event)
  }

  public var sessionPhase: SessionPhase { controller.phase }
  /// Test hooks.
  var observerForTests: GlobalDragObserver { observer }
  var cachedInputMonitoringGranted: Bool { inputMonitoringGranted }
  public private(set) var lastShowAnimated = false
  public private(set) var lastHideAnimated = false

  // MARK: Commands

  private func apply(_ output: SessionOutput) {
    let captionBefore = wheelView?.model?.caption != nil
    for command in output.commands { execute(command) }
    if let panel, panel.isVisible || !options.presentWindows, (wheelView?.model?.caption != nil) != captionBefore {
      // The caption pill changes the alpha shape: redraw now and let the window server recompute its shadow.
      wheelView?.display()
      panel.invalidateShadow()
    }
    announceIfNeeded()
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

  /// Test hook: fire a pending session timer now.
  func fireTimerForTests(_ kind: SessionTimer) -> Bool {
    guard let timer = timers[kind] else { return false }
    timer.fire()
    return true
  }

  // MARK: Accessibility

  /// Announces the armed choice to VoiceOver once per change (not on every drag-over update).
  private func announceIfNeeded() {
    let text = wheelView?.model?.announcement
    guard text != lastAnnouncement else { return }
    lastAnnouncement = text
    guard let text else { return }
    if let announcer = options.announcer {
      announcer(text)
    } else if NSWorkspace.shared.isVoiceOverEnabled {
      let element: Any = wheelView ?? NSApp as Any
      NSAccessibility.post(element: element, notification: .announcementRequested, userInfo: [
        .announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue,
      ])
    }
  }

  // MARK: Panel

  private func ensurePanel() -> (WheelPanel, WheelView) {
    if let panel, let wheelView { return (panel, wheelView) }
    let panel = WheelPanel()
    let view = WheelView(frame: NSRect(x: 0, y: 0, width: 360, height: 392))
    view.host = self
    panel.contentView = view
    self.panel = panel
    self.wheelView = view
    return (panel, view)
  }

  /// Test hook: the panel exists (created hidden when observation was enabled).
  var panelForTests: NSPanel? { panel }

  private var reduceMotionNow: Bool { osReduceMotionOverride }

  private func show(_ presentation: WheelPresentation) {
    let (panel, view) = ensurePanel()
    visibilityGeneration += 1
    appearTimer?.invalidate()
    appearTimer = nil
    let frame = Coords.globalRectToAppKit(presentation.layout.frame, primaryFrame: SystemInfo.primaryFrame)
    panel.setFrame(SystemInfo.nsRect(frame), display: false)
    view.frame = NSRect(x: 0, y: 0, width: frame.width, height: frame.height)
    view.model = WheelViewModel(presentation: presentation, capsule: CapsuleContent(text: "", style: .hint))
    view.appear = 1
    let animate = !(presentation.reduceMotion || reduceMotionNow) && presentation.tokens.appearMs > 0
    lastShowAnimated = animate
    // A zero-duration animator set replaces a fade-out still running from the previous drop.
    // The fade starts at 0.2, never 0, so the panel is a drag destination from its first frame.
    let startAlpha: CGFloat = animate ? 0.2 : 1
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0
      panel.animator().alphaValue = startAlpha
    }
    panel.alphaValue = startAlpha
    view.display()  // draw now so the window server shadow follows the disc
    panel.invalidateShadow()
    if options.presentWindows { panel.orderFrontRegardless() }
    if animate { runAppear(from: startAlpha, duration: presentation.tokens.appearMs / 1000) }
  }

  private func runAppear(from startAlpha: CGFloat, duration: Double) {
    let start = CACurrentMediaTime()
    let generation = visibilityGeneration
    let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] t in
      let done = MainActor.assumeIsolated { () -> Bool in
        guard let self, self.visibilityGeneration == generation, let panel = self.panel else { return true }
        let progress = min(1, (CACurrentMediaTime() - start) / max(duration, 0.001))
        let eased = 1 - pow(1 - progress, 3)
        panel.alphaValue = startAlpha + (1 - startAlpha) * CGFloat(eased)
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
    let animate = animated && !reduceMotionNow
    lastHideAnimated = animate
    let duration = animate ? (wheelView?.model?.presentation.tokens.disappearMs ?? 0) / 1000 : 0
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
    lastAnnouncement = nil
  }

  /// Test hook: the model currently drawn (nil when hidden).
  public var currentModel: WheelViewModel? { wheelView?.model }

  /// Test hook: the drop-target view (exists once observation was enabled).
  public var dropTargetView: NSView? { wheelView }

  /// Test hook: wait until queued output was written.
  @discardableResult
  public func flushOutput(timeout: TimeInterval = 2) -> Bool { writer.flush(timeout: timeout) }

  // MARK: WheelDropHost

  private func global(_ local: CGPoint) -> Point {
    let point = Point(x: Double(local.x), y: Double(local.y))
    return controller.layout?.global(point) ?? point
  }

  func wheelNeedsPayload() -> Bool {
    controller.payload == nil
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

  func wheelPerformDrop(local: CGPoint, allowsCopy: Bool) -> Bool {
    let output = controller.handle(.performDrop(items: nil, point: global(local), sourceAllowsCopy: allowsCopy))
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
    let motion = workspace.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.accessibilityDisplayOptionsChanged() }
    }
    notificationTokens.append((workspace, motion))
    let token = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.screensChanged() }
    }
    notificationTokens.append((NotificationCenter.default, token))
  }

  /// The OS Reduce Motion setting changed. If it is on now, follow it until main sends the next
  /// `configure` (main's resolved value — which honours an explicit "on" — wins again then).
  func accessibilityDisplayOptionsChanged() {
    osReduceMotionOverride = options.reduceMotionProvider()
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
