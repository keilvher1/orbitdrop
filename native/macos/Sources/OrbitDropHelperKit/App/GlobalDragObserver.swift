import AppKit
import CoreGraphics
import OrbitDropHelperCore

/// Observes other apps' drags without any privacy permission:
///  - `NSEvent.addGlobalMonitorForEvents` for left mouse down/dragged/up only
///    (mouse events need no Accessibility/Input Monitoring; no key events are monitored),
///  - `NSEvent.modifierFlags`, polled at 60 Hz only while the button is down or a session is open,
///  - `NSPasteboard(name: .drag).changeCount` to confirm that a real OS drag began
///    (its contents are never read here),
///  - `NSEvent.pressedMouseButtons` as a fallback for a missed mouse-up.
/// The Escape key is polled only when Input Monitoring was already granted by the
/// user (CGPreflightListenEventAccess, never requested). Callbacks only update state
/// and return; no file access, no blocking I/O.
@MainActor
final class GlobalDragObserver {
  var onEvent: ((SessionEvent) -> Void)?
  /// Whether polling must continue after the button is released (a session/wheel is open).
  var sessionNeedsPolling: () -> Bool = { false }
  var wheelVisible: () -> Bool = { false }

  private var monitor: Any?
  private var timer: Timer?
  private var buttonDown = false
  private var dragBaseline = 0
  private var dragConfirmed = false
  private var lastModifiers: Set<ModifierKey> = []
  private var escapeDown = false
  private var escapePollingAllowed = false

  var isRunning: Bool { monitor != nil }

  /// Installs the global monitor. Returns false if AppKit refused (reported to main).
  func start() -> Bool {
    if monitor != nil { return true }
    monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] event in
      let type = event.type
      MainActor.assumeIsolated { self?.handle(type) }
    }
    return monitor != nil
  }

  func stop() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    stopPolling()
    buttonDown = false
    dragConfirmed = false
  }

  /// Probe used for `ready.globalDrag.available`: install and remove a monitor.
  static func canInstallMonitor() -> Bool {
    guard let probe = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown], handler: { _ in }) else { return false }
    NSEvent.removeMonitor(probe)
    return true
  }

  private func handle(_ type: NSEvent.EventType) {
    switch type {
    case .leftMouseDown:
      buttonDown = true
      dragBaseline = NSPasteboard(name: .drag).changeCount
      dragConfirmed = false
      escapePollingAllowed = SystemInfo.inputMonitoringGranted
      emit(.mouseDown(SystemInfo.pointer))
      emitModifiers(force: true)
      startPolling()
    case .leftMouseDragged:
      if !buttonDown {
        buttonDown = true
        dragBaseline = NSPasteboard(name: .drag).changeCount
        startPolling()
      }
      checkDragPasteboard()
      emitModifiers()
      emit(.mouseDragged(SystemInfo.pointer))
    case .leftMouseUp:
      if buttonDown {
        buttonDown = false
        emit(.mouseUp(SystemInfo.pointer))
      }
    default:
      break
    }
  }

  private func checkDragPasteboard() {
    guard buttonDown, !dragConfirmed else { return }
    if NSPasteboard(name: .drag).changeCount != dragBaseline {
      dragConfirmed = true
      emit(.dragPasteboardChanged)
    }
  }

  private func emitModifiers(force: Bool = false) {
    let held = SystemInfo.modifiers(NSEvent.modifierFlags)
    if force || held != lastModifiers {
      lastModifiers = held
      emit(.modifiersChanged(held))
    }
  }

  private func startPolling() {
    guard timer == nil else { return }
    let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
    t.tolerance = 0.004
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  private func stopPolling() {
    timer?.invalidate()
    timer = nil
  }

  private func poll() {
    emitModifiers()
    checkDragPasteboard()
    if buttonDown && (NSEvent.pressedMouseButtons & 1) == 0 {
      // The monitor can miss the mouse-up of another app's drag loop; the hardware state cannot lie.
      buttonDown = false
      emit(.mouseUp(SystemInfo.pointer))
    }
    if escapePollingAllowed && wheelVisible() {
      let down = CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(53))
      if down && !escapeDown { emit(.escape) }
      escapeDown = down
    }
    if !buttonDown && !sessionNeedsPolling() { stopPolling() }
  }

  private func emit(_ event: SessionEvent) {
    onEvent?(event)
  }
}
