import AppKit
import CoreGraphics
import OrbitDropHelperCore

/// Global mouse button events the observer listens to.
public enum GlobalMouseEvent: Sendable, Equatable {
  case down, dragged, up
}

/// Everything the observer reads from the system, injectable so tests can replay
/// the exact event sequences AppKit produces (no synthesized input, no real monitor).
@MainActor
public protocol DragInputSource: AnyObject {
  /// Currently held shift/alt/control/command (`NSEvent.modifierFlags`).
  var heldModifiers: Set<ModifierKey> { get }
  /// Left button state from the hardware (`NSEvent.pressedMouseButtons`).
  var leftButtonDown: Bool { get }
  /// `NSPasteboard(name: .drag).changeCount` — never its contents.
  var dragPasteboardChangeCount: Int { get }
  /// Pointer in global DIP.
  var pointer: Point { get }
  /// Escape key state; only queried when Input Monitoring was already granted.
  var escapeKeyDown: Bool { get }
  /// Installs the global left-mouse monitor; false if AppKit refused.
  func installMouseMonitor(_ handler: @escaping @MainActor (GlobalMouseEvent) -> Void) -> Bool
  func removeMouseMonitor()
  /// Starts/stops the 60 Hz poll (only runs while the button is down or a session is open).
  func startTicks(_ tick: @escaping @MainActor () -> Void)
  func stopTicks()
}

/// The real source: NSEvent global monitor (mouse events only — they need no Accessibility
/// or Input Monitoring permission; no key events are monitored), polled modifier flags and
/// button state, and the drag pasteboard's change count.
@MainActor
public final class SystemDragInputSource: DragInputSource {
  private var monitor: Any?
  private var timer: Timer?

  public init() {}

  public var heldModifiers: Set<ModifierKey> { SystemInfo.modifiers(NSEvent.modifierFlags) }
  public var leftButtonDown: Bool { (NSEvent.pressedMouseButtons & 1) != 0 }
  public var dragPasteboardChangeCount: Int { NSPasteboard(name: .drag).changeCount }
  public var pointer: Point { SystemInfo.pointer }
  public var escapeKeyDown: Bool { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(53)) }

  public func installMouseMonitor(_ handler: @escaping @MainActor (GlobalMouseEvent) -> Void) -> Bool {
    if monitor != nil { return true }
    monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { event in
      let kind: GlobalMouseEvent
      switch event.type {
      case .leftMouseDown: kind = .down
      case .leftMouseDragged: kind = .dragged
      case .leftMouseUp: kind = .up
      default: return
      }
      MainActor.assumeIsolated { handler(kind) }
    }
    return monitor != nil
  }

  public func removeMouseMonitor() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
  }

  public func startTicks(_ tick: @escaping @MainActor () -> Void) {
    guard timer == nil else { return }
    let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { _ in MainActor.assumeIsolated { tick() } }
    t.tolerance = 0.004
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  public func stopTicks() {
    timer?.invalidate()
    timer = nil
  }

  /// Probe used for `ready.globalDrag.available`: install and remove a monitor.
  public static func canInstallMonitor() -> Bool {
    guard let probe = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown], handler: { _ in }) else { return false }
    NSEvent.removeMonitor(probe)
    return true
  }
}

/// Turns the input source into SessionEvents. Callbacks only update state and return:
/// no file access, no blocking I/O, no TCC queries (the Escape permission is a cached
/// value the app refreshes off the event path).
@MainActor
final class GlobalDragObserver {
  var onEvent: ((SessionEvent) -> Void)?
  /// Whether polling must continue after the button is released (a session/wheel is open).
  var sessionNeedsPolling: () -> Bool = { false }
  var wheelVisible: () -> Bool = { false }
  /// Cached Input Monitoring status (CGPreflightListenEventAccess, refreshed by the app).
  var escapePollingAllowed = false

  let source: DragInputSource
  private(set) var isRunning = false
  private var polling = false
  private var buttonDown = false
  private var dragBaseline = 0
  private var dragConfirmed = false
  private var lastModifiers: Set<ModifierKey> = []
  /// Last pointer reported with mouseDown/mouseDragged (the poll reports changes too).
  private var lastPointer: Point?
  private var escapeDown = false

  init(source: DragInputSource) {
    self.source = source
  }

  /// Installs the global monitor. Returns false if AppKit refused (reported to main).
  func start() -> Bool {
    if isRunning { return true }
    isRunning = source.installMouseMonitor { [weak self] event in self?.handle(event) }
    return isRunning
  }

  func stop() {
    source.removeMouseMonitor()
    stopPolling()
    isRunning = false
    buttonDown = false
    dragConfirmed = false
  }

  func handle(_ event: GlobalMouseEvent) {
    switch event {
    case .down:
      buttonDown = true
      dragBaseline = source.dragPasteboardChangeCount
      dragConfirmed = false
      escapeDown = false
      // The modifiers held right now travel with the mouse-down as a baseline, atomically:
      // a combo that was already held cannot be mistaken for a press during the drag.
      let held = source.heldModifiers
      lastModifiers = held
      let point = source.pointer
      lastPointer = point
      emit(.mouseDown(point, held: held))
      startPolling()
    case .dragged:
      if !buttonDown {
        buttonDown = true
        dragBaseline = source.dragPasteboardChangeCount
        startPolling()
      }
      // Same order as `poll()`: the pointer first (the travel the pasteboard check needs, and the
      // controller learns the button is down even if it missed the mouse-down), then the pasteboard,
      // then the modifiers — a combo completed by this event opens the wheel here.
      let point = source.pointer
      lastPointer = point
      emit(.mouseDragged(point))
      checkDragPasteboard()
      emitModifiers()
    case .up:
      if buttonDown {
        buttonDown = false
        emit(.mouseUp(source.pointer))
      }
    }
  }

  private func checkDragPasteboard() {
    guard buttonDown, !dragConfirmed else { return }
    if source.dragPasteboardChangeCount != dragBaseline {
      dragConfirmed = true
      emit(.dragPasteboardChanged)
    }
  }

  private func emitModifiers() {
    let held = source.heldModifiers
    if held != lastModifiers {
      lastModifiers = held
      emit(.modifiersChanged(held))
    }
  }

  private func startPolling() {
    guard !polling else { return }
    polling = true
    source.startTicks { [weak self] in self?.poll() }
  }

  private func stopPolling() {
    guard polling else { return }
    polling = false
    source.stopTicks()
  }

  /// One 60 Hz tick (public for tests driving a fake source).
  func poll() {
    if buttonDown && source.leftButtonDown {
      // The pointer is polled as well, so neither the start of a session (≥ 3 pt of travel) nor
      // where the wheel opens depends on the global monitor seeing the dragged events of
      // another app's drag loop. Reported first: the pasteboard check needs the travel, and a
      // combo completed in this tick opens the wheel at the current pointer.
      let point = source.pointer
      if point != lastPointer {
        lastPointer = point
        emit(.mouseDragged(point))
      }
    }
    checkDragPasteboard()
    emitModifiers()
    if buttonDown && !source.leftButtonDown {
      // The monitor can miss the mouse-up of another app's drag loop; the hardware state cannot lie.
      buttonDown = false
      emit(.mouseUp(source.pointer))
    }
    if escapePollingAllowed && wheelVisible() {
      let down = source.escapeKeyDown
      if down && !escapeDown { emit(.escape) }
      escapeDown = down
    }
    if !buttonDown && !sessionNeedsPolling() { stopPolling() }
  }

  private func emit(_ event: SessionEvent) {
    onEvent?(event)
  }
}
