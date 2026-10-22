// The helper's drag-session state machine:
//
//   Idle ──(button down + movement ≥ threshold + drag-pasteboard change)──▶ PotentialDrag
//   PotentialDrag ──(a modifier press during the drag completes a configured combo, then the
//        modifiers stay stable for modifierSettleMs)──▶ AwaitingPayload
//        neutral wheel shown at the pointer, clamped into the visible frame; center fixed for the session.
//        Modifiers held at the mouse-down are a baseline (mouseDown carries them), never a press.
//   AwaitingPayload ──(draggingEntered: items classified, menu frozen)──▶ WheelActive
//   WheelActive ──(performDrop on an enabled, armed sector, source allows Copy)──▶ `drop` sent, wheel hidden, Idle
//   any wheel state ──(Esc, drag ended elsewhere, rejected release, sleep, parent EOF, cancelSession)──▶ `cancelled`, hidden, Idle
//
// PotentialDrag is internal (never reported): ordinary drags that never show the
// wheel produce no messages at all. From AwaitingPayload on, main receives
// `state` updates and exactly one terminal message per session — `drop` or
// `cancelled`. Hover never commits; an external mouse-up only cleans up;
// releasing the modifier keeps the wheel; re-entry after exit is allowed.

public struct DragSessionController {
  /// Displays in global DIP (NSScreen.screens converted). The glue refreshes this on
  /// `configure` and on screen-parameter changes; the wheel is placed with the current value.
  public var displays: [Display]
  /// Session ids must be unique across helper processes (main's tracker relies on it).
  public var makeSessionId: () -> String

  /// Minimum pointer travel (DIP) after the mouse-down before a drag counts as movement.
  public var dragThreshold = 3.0
  /// Grace after the global mouse-up when the pointer was over an acceptable sector:
  /// performDragOperation can arrive after the monitor event.
  public var releaseGraceOverTargetMs = 600
  /// Grace after a mouse-up anywhere else.
  public var releaseGraceElsewhereMs = 150
  /// Delay before treating "exited while the pointer is still over the wheel" as the end of the drag.
  public var exitCheckMs = 150
  /// Modifiers must be stable this long after the completing press before the wheel appears (0 = at once).
  public var modifierSettleMs = 40
  /// Neutral wheel: hide it when the pointer moved over the disc but no draggingEntered arrived this long.
  public var noEnterMs = 400

  public private(set) var config: HelperConfig?

  // Mouse/modifier tracking (exists without a session).
  private var buttonDown = false
  private var pressPoint: Point?
  private var pointer: Point?
  private var moved = false
  private var dragConfirmed = false
  /// After a session ended while the button is still down (drop, Esc, cancel), don't start another one.
  private var suppressedUntilRelease = false
  private var held: Set<ModifierKey> = []
  /// A combo completed by a key press after the mouse went down (before the drag was confirmed).
  private var pendingMode: WheelMode?

  private var session: Session?

  public init(displays: [Display] = [], makeSessionId: @escaping () -> String) {
    self.displays = displays
    self.makeSessionId = makeSessionId
  }

  // MARK: Introspection (tests, AppKit glue)

  public var phase: SessionPhase { session?.phase ?? .idle }
  public var sessionId: String? { session?.id }
  public var isEnabled: Bool { config?.enabled == true }
  public var isWheelShown: Bool { phase == .awaitingPayload || phase == .wheelActive }
  /// Operation returned by the last drag-over evaluation (prepareForDragOperation uses it).
  public var lastOperation: DropOperation { session?.operation ?? .none }
  /// True while the glue should poll modifiers / buttons (button held or a session open).
  public var needsPolling: Bool { isEnabled && (buttonDown || session != nil) }
  public var placement: WheelPlacement? { session?.placement }
  /// Native panel layout of the open wheel (frame, disc center, caption strip).
  public var layout: WheelPanelLayout? { session?.layout }
  public var currentMode: WheelMode? { session?.mode }
  public var payload: Payload? { session?.payload }
  public var content: WheelContent? { session?.content }

  // MARK: Events

  public mutating func handle(_ event: SessionEvent) -> SessionOutput {
    var out = SessionOutput()
    switch event {
    case .configure(let newConfig):
      config = newConfig
      if !newConfig.enabled {
        end(.parentRequest, &out)
        resetTracking()
      }

    case .mouseDown(let point, let heldAtDown):
      guard isEnabled else { break }
      if session != nil { end(.dragEnded, &out) }  // the previous mouse-up was missed
      buttonDown = true
      pressPoint = point
      pointer = point
      moved = false
      dragConfirmed = false
      suppressedUntilRelease = false
      // Baseline, not a press: a combo already held at the mouse-down does not count.
      held = heldAtDown
      pendingMode = nil

    case .mouseDragged(let point):
      guard isEnabled else { break }
      pointer = point
      if !buttonDown {  // the mouse-down was missed (e.g. enabled mid-press)
        buttonDown = true
        pressPoint = point
      }
      if session == nil {
        if !suppressedUntilRelease, let start = pressPoint, JSMath.hypot(point.x - start.x, point.y - start.y) >= dragThreshold {
          moved = true
        }
        startPotentialDragIfReady(&out)
      } else if let s = session, s.phase == .awaitingPayload, !s.noEnterTimerStarted, let placement = s.placement {
        // The pointer travels over the neutral wheel but AppKit sends no draggingEntered:
        // the drag carries nothing we registered for. Give it noEnterMs, then hide.
        let onDisc = JSMath.hypot(point.x - placement.center.x, point.y - placement.center.y) <= placement.diameter / 2
        let travelled = JSMath.hypot(point.x - s.activation.x, point.y - s.activation.y) >= max(8, 2 * s.geometry.armDistance)
        if onDisc && travelled {
          session?.noEnterTimerStarted = true
          out.commands.append(.startTimer(.noEnter, milliseconds: noEnterMs, token: s.id))
        }
      }

    case .dragPasteboardChanged:
      guard isEnabled, buttonDown, session == nil, !suppressedUntilRelease else { break }
      dragConfirmed = true
      startPotentialDragIfReady(&out)

    case .modifiersChanged(let newHeld):
      let pressed = newHeld.subtracting(held)
      held = newHeld
      guard let cfg = config, cfg.enabled else { break }
      let matched = (session?.config ?? cfg).mode(forHeld: newHeld)
      if matched == nil {
        pendingMode = nil
        // A release during the settle window abandons the pending activation.
        if session?.phase == .potentialDrag, session?.settling == true {
          session?.settling = false
          out.commands.append(.cancelTimer(.modifierSettle))
        }
      }
      guard !pressed.isEmpty, let mode = matched else { break }
      switch session?.phase ?? .idle {
      case .idle:
        if buttonDown && !suppressedUntilRelease { pendingMode = mode }
      case .potentialDrag:
        scheduleActivation(mode, &out)
      case .awaitingPayload, .wheelActive:
        if mode != session?.mode { switchMode(to: mode, &out) }
      }

    case .draggingEntered(let items, let point, let allowsCopy):
      guard var s = session, s.phase == .awaitingPayload || s.phase == .wheelActive else { break }
      s.inside = true
      if s.exitPending != nil {
        s.exitPending = nil
        out.commands.append(.cancelTimer(.exitCheck))
      }
      if s.noEnterTimerStarted {
        out.commands.append(.cancelTimer(.noEnter))
      }
      session = s
      if s.payload == nil {
        let payload = Classifier.classify(items, extensions: s.config.extensions)
        session?.payload = payload
        session?.phase = .wheelActive
        applyContentForMode(&out)
        if case .files(_, let paths) = payload {
          out.commands.append(.resolveFileInfo(sessionId: s.id, paths: paths))
        }
      }
      out.operation = track(point, allowsCopy, &out).operation

    case .draggingUpdated(let point, let allowsCopy):
      guard session?.phase == .wheelActive else { break }
      session?.inside = true
      out.operation = track(point, allowsCopy, &out).operation

    case .draggingExited(let pointerInsideWheel, let stillDown):
      guard let s = session, s.phase == .awaitingPayload || s.phase == .wheelActive else { break }
      let reason: CancelReason = stillDown ? .escape : (s.inside ? (s.lastReject ?? .dragEnded) : .dragEnded)
      session?.inside = false
      session?.operation = .none
      session?.lastReject = nil
      setHighlight(nil, &out)
      setCapsule(defaultCapsule(), &out)
      if pointerInsideWheel {
        // The drag left without the pointer leaving: it was cancelled (Esc) or released on a rejecting spot.
        session?.exitPending = reason
        out.commands.append(.startTimer(.exitCheck, milliseconds: exitCheckMs, token: s.id))
      }

    case .performDrop(let items, let point, let allowsCopy):
      out.dropAccepted = performDrop(items: items, point: point, allowsCopy: allowsCopy, &out)

    case .draggingEnded:
      guard let s = session, s.phase == .awaitingPayload || s.phase == .wheelActive else { break }
      end(s.exitPending ?? (s.inside ? (s.lastReject ?? .dragEnded) : .dragEnded), &out)

    case .mouseUp(let point):
      pointer = point
      buttonDown = false
      suppressedUntilRelease = false
      moved = false
      dragConfirmed = false
      pendingMode = nil
      pressPoint = nil
      guard let s = session else { break }
      switch s.phase {
      case .potentialDrag:
        session = nil  // never announced: nothing to report
      case .awaitingPayload, .wheelActive:
        if !s.released {
          session?.released = true
          let overTarget = s.inside && s.operation == .copy
          out.commands.append(.startTimer(.releaseGrace, milliseconds: overTarget ? releaseGraceOverTargetMs : releaseGraceElsewhereMs, token: s.id))
        }
      case .idle:
        break
      }

    case .escape:
      guard let s = session else { break }
      if s.phase == .potentialDrag {
        session = nil
        suppressedUntilRelease = buttonDown
      } else {
        end(.escape, &out)
      }

    case .sleep:
      end(.sleep, &out)
      resetTracking()

    case .parentEOF:
      end(.parentRequest, &out)
      config?.enabled = false
      resetTracking()

    case .cancelRequest(let id):
      if session?.id == id { end(.parentRequest, &out) }

    case .fileInfo(let id, let totalBytes, let containsDirectory, let containsCloudPlaceholder):
      guard var s = session, s.id == id, case .files = s.payload else { break }
      if containsDirectory || containsCloudPlaceholder {
        // Nothing on this Mac to convert: a folder after all, or an online-only cloud file (the
        // Windows helper refuses those the same way). A folder is the more basic reason.
        s.payload = .unsupported(fileCount: s.payload?.fileCount ?? 0, reason: containsDirectory ? .folder : .cloudPlaceholder)
        s.menuCache = [:]
        session = s
        applyContentForMode(&out)
      } else {
        s.totalBytes = totalBytes
        session = s
        if s.highlight == nil || s.highlight?.style == .hover { setCapsule(defaultCapsule(), &out) }
      }

    case .timerFired(let timer, let token):
      guard let s = session, s.id == token else { break }
      switch timer {
      case .releaseGrace:
        end(s.exitPending ?? (s.inside ? (s.lastReject ?? .dragEnded) : .dragEnded), &out)
      case .exitCheck:
        if !s.inside, let reason = s.exitPending { end(reason, &out) }
      case .modifierSettle:
        guard s.phase == .potentialDrag, s.settling else { break }
        session?.settling = false
        // Use the combo held now: a second key inside the window picks the other mode directly.
        if let mode = s.config.mode(forHeld: held) { activate(mode, &out) }
      case .noEnter:
        if s.phase == .awaitingPayload { end(.invalidPayload, &out) }
      }

    case .invalidate(let reason):
      end(reason, &out)
    }
    return out
  }

  // MARK: Transitions

  private mutating func startPotentialDragIfReady(_ out: inout SessionOutput) {
    guard session == nil, buttonDown, moved, dragConfirmed, !suppressedUntilRelease, let cfg = config, cfg.enabled else { return }
    session = Session(id: makeSessionId(), config: cfg, activation: pointer ?? pressPoint ?? .zero)
    // A combo completed after the mouse-down but before the drag was confirmed activates now.
    if let mode = pendingMode, cfg.mode(forHeld: held) == mode {
      scheduleActivation(mode, &out)
    }
    pendingMode = nil
  }

  /// Show the wheel once the modifiers have been stable for `modifierSettleMs`.
  private mutating func scheduleActivation(_ mode: WheelMode, _ out: inout SessionOutput) {
    guard let s = session, s.phase == .potentialDrag else { return }
    if modifierSettleMs <= 0 {
      activate(mode, &out)
      return
    }
    session?.settling = true
    out.commands.append(.startTimer(.modifierSettle, milliseconds: modifierSettleMs, token: s.id))
  }

  private mutating func activate(_ mode: WheelMode, _ out: inout SessionOutput) {
    guard var s = session, s.phase == .potentialDrag else { return }
    let at = pointer ?? pressPoint ?? s.activation
    guard let placed = Coords.placeWheelOnDisplays(at, displays, s.config.geometry) else { return }
    var geometry = s.config.geometry
    geometry.diameter = placed.placement.diameter
    let layout = WheelPanelLayout.make(placement: placed.placement, workArea: displays[placed.displayIndex].workArea)
    s.phase = .awaitingPayload
    s.mode = mode
    s.placement = placed.placement
    s.layout = layout
    s.geometry = geometry
    s.activation = at
    s.armOrigin = at
    s.passedCenter = false
    s.announced = true
    s.content = .neutral
    let hint = CapsuleContent(text: s.config.strings.dropHint, style: .hint)
    s.capsule = hint
    session = s
    out.commands.append(.showWheel(WheelPresentation(
      placement: placed.placement, layout: layout, geometry: geometry, tokens: s.config.tokens,
      highContrast: s.config.highContrast, reduceMotion: s.config.reduceMotion, mode: mode
    )))
    out.commands.append(.setCapsule(hint))
    out.commands.append(.send(.state(StateMessage(sessionId: s.id, state: .awaitingPayload, mode: mode))))
  }

  /// A modifier press completed the other mode's combo: show that mode's (frozen) menu.
  /// Arming restarts so the sector that just appeared under the pointer cannot be dropped on immediately.
  private mutating func switchMode(to mode: WheelMode, _ out: inout SessionOutput) {
    guard var s = session else { return }
    s.mode = mode
    s.armOrigin = s.lastDragPoint ?? pointer ?? s.activation
    s.passedCenter = false
    s.operation = .none
    s.lastReject = nil
    session = s
    out.commands.append(.setMode(mode))
    setHighlight(nil, &out)
    if s.phase == .wheelActive {
      applyContentForMode(&out)
    } else {
      out.commands.append(.send(.state(StateMessage(sessionId: s.id, state: .awaitingPayload, mode: mode))))
    }
  }

  /// Show the content for the current mode (computed once per mode and session) and report WheelActive.
  private mutating func applyContentForMode(_ out: inout SessionOutput) {
    guard var s = session, let mode = s.mode, let payload = s.payload else { return }
    let content: WheelContent
    if let cached = s.menuCache[mode] {
      content = cached
    } else {
      content = Classifier.sectors(for: payload, mode: mode, config: s.config).map(WheelContent.sectors) ?? .unsupported
      s.menuCache[mode] = content
    }
    s.content = content
    s.operation = .none
    session = s
    out.commands.append(.setContent(content))
    setHighlight(nil, &out)
    setCapsule(defaultCapsule(), &out)
    out.commands.append(.send(.state(StateMessage(
      sessionId: s.id, state: .wheelActive, mode: mode, menuKey: .some(payload.menuKey), fileCount: payload.fileCount
    ))))
  }

  private struct TrackResult {
    var operation: DropOperation
    var sector: WheelSector?
  }

  /// Hit-test a drag-over point (global DIP), update arming/highlight/capsule, decide the operation.
  private mutating func track(_ point: Point, _ allowsCopy: Bool, _ out: inout SessionOutput) -> TrackResult {
    guard var s = session, let placement = s.placement else { return TrackResult(operation: .none) }
    s.lastDragPoint = point
    let list = s.content.sectors
    let hit = WheelMath.hitTest(dx: point.x - placement.center.x, dy: point.y - placement.center.y, sectorCount: list.count, diameter: placement.diameter, s.geometry)
    if hit == .center { s.passedCenter = true }
    let armed = WheelMath.isArmed(activation: s.armOrigin, pointer: point, passedCenter: s.passedCenter, s.geometry)

    var highlight: SectorHighlight?
    var capsule: CapsuleContent?
    var operation = DropOperation.none
    var reject: CancelReason?
    var chosen: WheelSector?
    switch s.content {
    case .neutral:
      break
    case .unsupported:
      reject = .invalidPayload
    case .sectors:
      switch hit {
      case .center:
        break
      case .outside:
        reject = .outsideRing
      case .sector(let index):
        let sector = list[index]
        if !armed {
          highlight = SectorHighlight(index: index, style: .hover)
        } else if !sector.enabled {
          highlight = SectorHighlight(index: index, style: .rejected)
          capsule = CapsuleContent(text: Self.nonEmpty(sector.reason) ?? s.config.strings.unsupported, style: .reject)
          reject = .disabledSector
        } else if !allowsCopy {
          // The source forbids Copy (e.g. Command forces Move): never accept as anything else.
          highlight = SectorHighlight(index: index, style: .rejected)
          capsule = CapsuleContent(text: s.config.strings.unsupported, style: .reject)
          reject = .invalidPayload
        } else {
          highlight = SectorHighlight(index: index, style: .active)
          capsule = CapsuleContent(text: sector.label, style: .action)
          operation = .copy
          chosen = sector
        }
      }
    }
    s.operation = operation
    s.lastReject = reject
    session = s
    setHighlight(highlight, &out)
    setCapsule(capsule ?? defaultCapsule(), &out)
    return TrackResult(operation: operation, sector: chosen)
  }

  private mutating func performDrop(items: [DragItem]?, point: Point, allowsCopy: Bool, _ out: inout SessionOutput) -> Bool {
    guard let s = session, s.phase == .wheelActive, let mode = s.mode else { return false }
    // The drop callback re-reads the pasteboard; it must describe the same files the menu was built for.
    if let items, Classifier.classify(items, extensions: s.config.extensions) != s.payload {
      end(.invalidPayload, &out)
      return false
    }
    session?.inside = true
    let result = track(point, allowsCopy, &out)
    guard result.operation == .copy, let sector = result.sector, case .files(_, let paths)? = session?.payload else {
      end(session?.lastReject ?? .dragEnded, &out)
      return false
    }
    let drop = DropMessage(sessionId: s.id, actionId: sector.actionId, mode: mode, files: paths)
    guard let length = NDJSON.encodedLength(.drop(drop)), length <= HelperProtocol.maxLineBytes else {
      end(.invalidPayload, &out)
      return false
    }
    out.commands.append(.send(.drop(drop)))
    close(&out)
    return true
  }

  /// Terminal: report `cancelled` (if main knew about the session) and hide.
  private mutating func end(_ reason: CancelReason, _ out: inout SessionOutput) {
    guard let s = session else { return }
    if s.announced {
      out.commands.append(.send(.cancelled(sessionId: s.id, reason: reason)))
    }
    close(&out)
  }

  private mutating func close(_ out: inout SessionOutput) {
    guard let s = session else { return }
    if s.phase == .awaitingPayload || s.phase == .wheelActive {
      out.commands.append(.hide(animated: !s.config.reduceMotion))
    }
    for timer in SessionTimer.allCases { out.commands.append(.cancelTimer(timer)) }
    session = nil
    moved = false
    dragConfirmed = false
    pendingMode = nil
    if buttonDown { suppressedUntilRelease = true }
  }

  private mutating func resetTracking() {
    buttonDown = false
    pressPoint = nil
    moved = false
    dragConfirmed = false
    suppressedUntilRelease = false
    pendingMode = nil
  }

  // MARK: View state

  private func defaultCapsule() -> CapsuleContent {
    guard let s = session else { return CapsuleContent(text: "", style: .hint) }
    switch s.content {
    case .neutral:
      return CapsuleContent(text: s.config.strings.dropHint, style: .hint)
    case .unsupported:
      // Folder / non-file data / virtual item get their specific text when main provided one, an
      // online-only cloud file the built-in one; a supported payload with nothing to offer in this
      // mode (PDF in tools) uses the generic text.
      return CapsuleContent(text: s.config.unsupportedText(s.payload?.unsupportedReason), style: .reject)
    case .sectors:
      guard case .files(let key, let paths)? = s.payload else { return CapsuleContent(text: s.config.strings.dropHint, style: .hint) }
      if paths.count > 1 { return CapsuleContent(text: s.config.strings.fileCountText(paths.count), style: .info) }
      if let bytes = s.totalBytes { return CapsuleContent(text: ByteFormat.short(bytes), style: .info) }
      return CapsuleContent(text: key.inputLabel ?? "", style: .info)
    }
  }

  private mutating func setHighlight(_ highlight: SectorHighlight?, _ out: inout SessionOutput) {
    guard session != nil, session?.highlight != highlight else { return }
    session?.highlight = highlight
    out.commands.append(.setHighlight(highlight))
  }

  private mutating func setCapsule(_ capsule: CapsuleContent, _ out: inout SessionOutput) {
    guard session != nil, session?.capsule != capsule else { return }
    session?.capsule = capsule
    out.commands.append(.setCapsule(capsule))
  }

  private static func nonEmpty(_ text: String?) -> String? {
    guard let text, !text.isEmpty else { return nil }
    return text
  }
}

/// Per-session state. Configuration is snapshotted when the drag is confirmed, so
/// a `configure` arriving mid-drag never changes the wheel under the pointer.
private struct Session {
  let id: String
  let config: HelperConfig
  var phase: SessionPhase = .potentialDrag
  var mode: WheelMode?
  var placement: WheelPlacement?
  var layout: WheelPanelLayout?
  /// A combo was completed; waiting for `modifierSettle` before activating.
  var settling = false
  var noEnterTimerStarted = false
  var geometry: WheelGeometry
  var activation: Point
  var armOrigin: Point
  var passedCenter = false
  var payload: Payload?
  var menuCache: [WheelMode: WheelContent] = [:]
  var content: WheelContent = .neutral
  var inside = false
  var lastDragPoint: Point?
  var operation: DropOperation = .none
  var lastReject: CancelReason?
  var released = false
  var exitPending: CancelReason?
  var totalBytes: Int64?
  var announced = false
  var highlight: SectorHighlight?
  var capsule: CapsuleContent?

  init(id: String, config: HelperConfig, activation: Point) {
    self.id = id
    self.config = config
    self.geometry = config.geometry
    self.activation = activation
    self.armOrigin = activation
  }
}
