import AppKit
import OrbitDropHelperCore

/// The single wheel window: borderless, transparent, non-activating, above normal
/// windows, on every Space and over full-screen apps. It never becomes key or main,
/// so showing it during another app's drag never steals focus or ends the drag.
///
/// Hit shape: the panel is only the disc's bounding square plus the caption strip
/// (WheelPanelLayout), the view leaves every pixel outside the disc and the caption
/// pill at alpha 0, and `ignoresMouseEvents` is deliberately never assigned. In that
/// default state the window server passes events — and drag destination lookup —
/// through fully transparent pixels of a non-opaque window (assigning it `false`
/// would make the whole rectangle opaque to drags). The shadow is the window
/// server's (`hasShadow`), drawn outside the window and never hit-testable.
final class WheelPanel: NSPanel {
  init() {
    // defer: false — created (hidden) when observation starts, not in the middle of the first drag.
    super.init(contentRect: NSRect(x: 0, y: 0, width: 360, height: 392), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = .popUpMenu
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
    hidesOnDeactivate = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = true  // follows the alpha shape; recomputed with invalidateShadow() after redraws
    isReleasedWhenClosed = false
    animationBehavior = .none
    becomesKeyOnlyIfNeeded = true
    worksWhenModal = true
    isMovable = false
    isExcludedFromWindowsMenu = true
    title = "OrbitDrop"
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/// Receives the drag callbacks of the wheel view (implemented by HelperApp).
@MainActor
protocol WheelDropHost: AnyObject {
  /// True until the session has classified its payload: only then is the pasteboard read.
  func wheelNeedsPayload() -> Bool
  func wheelDraggingEntered(items: [DragItem], local: CGPoint, allowsCopy: Bool) -> NSDragOperation
  func wheelDraggingUpdated(local: CGPoint, allowsCopy: Bool) -> NSDragOperation
  func wheelDraggingExited(pointerInsideDisc: Bool, buttonDown: Bool)
  func wheelPrepareForDragOperation() -> Bool
  /// Drop with the payload captured at drag-enter (no second pasteboard read or path resolution).
  func wheelPerformDrop(local: CGPoint, allowsCopy: Bool) -> Bool
  func wheelDraggingEnded()
}

/// Draws the wheel and is the NSDraggingDestination — visual and drop target are
/// the same view in the same window, so they can never disagree.
final class WheelView: NSView {
  weak var host: WheelDropHost?

  var model: WheelViewModel? {
    didSet {
      guard model != oldValue else { return }
      needsDisplay = true
      setAccessibilityValue(model?.capsule.text)
    }
  }

  /// Appear animation progress (0…1).
  var appear: CGFloat = 1 {
    didSet { if appear != oldValue { needsDisplay = true } }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layerContentsRedrawPolicy = .onSetNeedsDisplay
    registerForDraggedTypes(PasteboardReader.registeredTypes)
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    setAccessibilityLabel("OrbitDrop")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not used") }

  override var isFlipped: Bool { true }
  override var isOpaque: Bool { false }

  override func draw(_ dirtyRect: NSRect) {
    guard let model, let ctx = NSGraphicsContext.current?.cgContext else { return }
    WheelRenderer.draw(model, in: ctx, size: bounds.size, appear: appear)
  }

  // MARK: NSDraggingDestination

  override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
    guard let host else { return [] }
    sender.animatesToDestination = false
    // The only pasteboard read of a session: paths become owned Strings here and are reused
    // for the drop. Re-entries after an exit do not read again.
    let items = host.wheelNeedsPayload() ? PasteboardReader.items(sender.draggingPasteboard) : []
    let operation = host.wheelDraggingEntered(items: items, local: localPoint(sender), allowsCopy: sender.draggingSourceOperationMask.contains(.copy))
    return operation
  }

  override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
    host?.wheelDraggingUpdated(local: localPoint(sender), allowsCopy: sender.draggingSourceOperationMask.contains(.copy)) ?? []
  }

  override func draggingExited(_ sender: (any NSDraggingInfo)?) {
    host?.wheelDraggingExited(pointerInsideDisc: pointerInsideDisc(), buttonDown: (NSEvent.pressedMouseButtons & 1) != 0)
  }

  override func prepareForDragOperation(_ sender: any NSDraggingInfo) -> Bool {
    host?.wheelPrepareForDragOperation() ?? false
  }

  override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
    guard let host else { return false }
    // No pasteboard or file-system access here: the paths were copied out at drag-enter.
    return host.wheelPerformDrop(local: localPoint(sender), allowsCopy: sender.draggingSourceOperationMask.contains(.copy))
  }

  override func concludeDragOperation(_ sender: (any NSDraggingInfo)?) {}

  override func draggingEnded(_ sender: any NSDraggingInfo) {
    host?.wheelDraggingEnded()
  }

  // wantsPeriodicDraggingUpdates keeps its default (true): AppKit re-sends draggingUpdated while the
  // pointer rests, so a modifier-driven mode switch or arming change is re-evaluated without movement.

  /// Dragging location in this (flipped) view's coordinates: y down, origin top-left of the panel.
  func localPoint(_ sender: any NSDraggingInfo) -> CGPoint {
    convert(sender.draggingLocation, from: nil)
  }

  /// Whether the pointer is over the disc right now (distinguishes "dragged out" from "drag ended over us").
  func pointerInsideDisc() -> Bool {
    guard let window, let model else { return false }
    let inWindow = window.convertPoint(fromScreen: NSEvent.mouseLocation)
    let local = convert(inWindow, from: nil)
    return model.presentation.layout.isOnDisc(Point(x: Double(local.x), y: Double(local.y)), diameter: model.presentation.placement.diameter)
  }
}
