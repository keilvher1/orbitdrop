// Events, commands and the view model of the drag session. The controller is a
// pure state machine: AppKit glue feeds it events and executes its commands, so
// every rule (arming, exactly-once drop, Copy-only, re-entry, cleanup) is unit
// tested without real drags or windows.

public enum SessionPhase: String, Sendable, Equatable {
  case idle, potentialDrag, awaitingPayload, wheelActive
}

public enum DropOperation: Sendable, Equatable {
  case none
  case copy
}

public enum SessionTimer: String, Sendable, Hashable, CaseIterable {
  /// After the global mouse-up: the drop callback may still arrive (it races the monitor event).
  case releaseGrace
  /// After draggingExited while the pointer is still over the wheel: the drag ended (Esc, rejected release).
  case exitCheck
  /// A combo was completed during a drag: wait until the modifiers are stable before showing the wheel
  /// (Shift then Option pressed 10 ms apart opens tools directly, without a convert flash).
  case modifierSettle
  /// The neutral wheel is up and the pointer moved over it, but no draggingEntered came: the drag
  /// carries nothing the wheel can receive (e.g. a window-tab drag) — hide it.
  case noEnter
}

public enum SessionEvent: Sendable, Equatable {
  case configure(HelperConfig)
  /// Global left mouse button pressed (point in global DIP) with the modifiers held at that
  /// moment. `held` is a baseline, not a press: a combo already held at the mouse-down never
  /// opens the wheel (only a press during the drag does).
  case mouseDown(Point, held: Set<ModifierKey> = [])
  case mouseDragged(Point)
  /// Global mouse-up (monitor event or the pressed-buttons poll). Only ever cleans up.
  case mouseUp(Point)
  /// Currently held modifiers (exact set of shift/alt/control/command).
  case modifiersChanged(Set<ModifierKey>)
  /// NSPasteboard(name: .drag).changeCount moved since the mouse-down: a real OS drag began.
  case dragPasteboardChanged
  case draggingEntered(items: [DragItem], point: Point, sourceAllowsCopy: Bool)
  case draggingUpdated(point: Point, sourceAllowsCopy: Bool)
  /// `pointerInsideWheel`: the pointer is still over the disc (→ the drag ended over us).
  case draggingExited(pointerInsideWheel: Bool, buttonDown: Bool)
  /// performDragOperation. `items` are re-read from the pasteboard (nil = reuse the entered payload).
  case performDrop(items: [DragItem]?, point: Point, sourceAllowsCopy: Bool)
  case draggingEnded
  /// Escape observed (only when permitted; see GlobalDragObserver).
  case escape
  /// System sleep / screens asleep / session switched away.
  case sleep
  /// stdin reached EOF or stdout broke: main is gone.
  case parentEOF
  case cancelRequest(sessionId: String)
  /// Off-main stat() result for the payload (size for the capsule, directory check).
  case fileInfo(sessionId: String, totalBytes: Int64?, containsDirectory: Bool)
  case timerFired(SessionTimer, token: String)
  /// The app had to abandon the session (screen configuration changed under the wheel, internal error).
  case invalidate(CancelReason)
}

public enum SectorHighlightStyle: String, Sendable, Equatable {
  /// Armed, enabled, Copy allowed: dropping here commits (orange).
  case active
  /// Armed but not acceptable (disabled sector, or the source forbids Copy).
  case rejected
  /// Pointer over a sector before arming (no commit possible yet).
  case hover
}

public struct SectorHighlight: Sendable, Equatable {
  public var index: Int
  public var style: SectorHighlightStyle
  public init(index: Int, style: SectorHighlightStyle) {
    self.index = index
    self.style = style
  }
}

public enum CapsuleStyle: String, Sendable, Equatable {
  /// Neutral "drop here" hint.
  case hint
  /// File count / size / input type.
  case info
  /// The hovered action's label.
  case action
  /// Why the hovered target cannot be used.
  case reject
}

public struct CapsuleContent: Sendable, Equatable {
  public var text: String
  public var style: CapsuleStyle
  public init(text: String, style: CapsuleStyle) {
    self.text = text
    self.style = style
  }
}

public enum WheelContent: Sendable, Equatable {
  /// AwaitingPayload: the drag has not entered yet, nothing is known about the payload.
  case neutral
  /// WheelActive with the (frozen) menu of the current mode.
  case sectors([WheelSector])
  /// WheelActive but nothing can be offered (unsupported payload or empty menu for this mode).
  case unsupported

  public var sectors: [WheelSector] {
    if case .sectors(let s) = self { return s }
    return []
  }
}

/// Everything the renderer needs that is fixed when the wheel appears.
public struct WheelPresentation: Sendable, Equatable {
  public var placement: WheelPlacement
  /// The native panel: disc bounding box + caption strip (see WheelPanelLayout).
  public var layout: WheelPanelLayout
  /// Session geometry with `diameter` = the placed diameter.
  public var geometry: WheelGeometry
  public var tokens: WheelTokens
  public var highContrast: Bool
  public var reduceMotion: Bool
  public var mode: WheelMode

  public init(placement: WheelPlacement, layout: WheelPanelLayout? = nil, geometry: WheelGeometry, tokens: WheelTokens, highContrast: Bool, reduceMotion: Bool, mode: WheelMode) {
    self.placement = placement
    self.layout = layout ?? WheelPanelLayout.make(placement: placement, workArea: nil)
    self.geometry = geometry
    self.tokens = tokens
    self.highContrast = highContrast
    self.reduceMotion = reduceMotion
    self.mode = mode
  }
}

public enum SessionCommand: Sendable, Equatable {
  /// Order the (single) wheel panel front at the placement, neutral content.
  case showWheel(WheelPresentation)
  case setMode(WheelMode)
  case setContent(WheelContent)
  case setHighlight(SectorHighlight?)
  case setCapsule(CapsuleContent)
  case send(HelperToMainMessage)
  /// Hide the wheel. After a drop the app defers this to the next run-loop turn.
  case hide(animated: Bool)
  case startTimer(SessionTimer, milliseconds: Int, token: String)
  case cancelTimer(SessionTimer)
  /// stat() the paths off the main thread and report `.fileInfo`.
  case resolveFileInfo(sessionId: String, paths: [String])
}

public struct SessionOutput: Sendable, Equatable {
  public var commands: [SessionCommand] = []
  /// Operation to return from draggingEntered/draggingUpdated.
  public var operation: DropOperation = .none
  /// Result for performDragOperation.
  public var dropAccepted = false

  public init() {}

  public var sentMessages: [HelperToMainMessage] {
    commands.compactMap { if case .send(let m) = $0 { return m } else { return nil } }
  }
}

/// What the wheel currently shows; the app reduces commands into it and the renderer draws it.
public struct WheelViewModel: Sendable, Equatable {
  public var presentation: WheelPresentation
  public var content: WheelContent
  public var highlight: SectorHighlight?
  public var capsule: CapsuleContent

  public init(presentation: WheelPresentation, content: WheelContent = .neutral, highlight: SectorHighlight? = nil, capsule: CapsuleContent) {
    self.presentation = presentation
    self.content = content
    self.highlight = highlight
    self.capsule = capsule
  }

  /// The secondary hint drawn outside the ring (below or above the disc): the current choice
  /// — the armed sector's label, or why it cannot be used — so it stays readable when the drag
  /// image covers the sector and the capsule. Nil when nothing is selected or there is no room.
  public var caption: CapsuleContent? {
    guard presentation.layout.captionRect != nil, let highlight, highlight.style != .hover, !capsule.text.isEmpty else { return nil }
    return capsule
  }

  /// Text VoiceOver should announce for the current state (the armed choice), nil otherwise.
  public var announcement: String? {
    guard let highlight, highlight.style != .hover, !capsule.text.isEmpty else { return nil }
    let sectors = content.sectors
    guard sectors.indices.contains(highlight.index) else { return capsule.text }
    let label = sectors[highlight.index].label
    return highlight.style == .active ? label : (label == capsule.text ? label : "\(label): \(capsule.text)")
  }

  /// Applies a visual command; returns true when something visible changed.
  @discardableResult
  public mutating func apply(_ command: SessionCommand) -> Bool {
    let before = self
    switch command {
    case .setMode(let mode): presentation.mode = mode
    case .setContent(let content): self.content = content
    case .setHighlight(let highlight): self.highlight = highlight
    case .setCapsule(let capsule): self.capsule = capsule
    case .showWheel(let presentation):
      self.presentation = presentation
      content = .neutral
      highlight = nil
    default: break
    }
    return before != self
  }
}
