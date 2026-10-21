// Frame of the native wheel window. Unlike placeWheel's `windowFrame` (disc +
// `windowMargin` on every side, kept for golden parity), the macOS panel is only as
// large as the disc's bounding square plus a caption strip, and everything outside
// the disc and the caption pill is fully transparent. AppKit passes mouse events —
// and drags — through fully transparent areas of a non-opaque window whose
// `ignoresMouseEvents` was never set explicitly, so a release beside the ring
// reaches whatever is underneath (Finder's normal drop) instead of becoming our
// cancel. The soft shadow is the window server's (`hasShadow`), which is never
// hit-testable. See docs/workstreams/macos-helper.md §3 "Hit shape".

public enum CaptionPlacement: String, Sendable, Equatable {
  /// Strip under the disc (default).
  case below
  /// Strip above the disc (no room below, e.g. wheel pushed against the bottom edge).
  case above
  /// No room on either side: the capsule alone shows the choice.
  case none
}

public struct WheelPanelLayout: Sendable, Equatable {
  /// Panel frame in global DIP (top-left origin, y down).
  public var frame: Rect
  /// Disc center in panel-local coordinates (y down).
  public var discCenter: Point
  /// Strip reserved for the secondary caption, panel-local; nil when `placement == .none`.
  public var captionRect: Rect?
  public var captionPlacement: CaptionPlacement

  public init(frame: Rect, discCenter: Point, captionRect: Rect?, captionPlacement: CaptionPlacement) {
    self.frame = frame
    self.discCenter = discCenter
    self.captionRect = captionRect
    self.captionPlacement = captionPlacement
  }

  public static let captionHeight = 26.0
  public static let captionGap = 6.0

  /// Lays the panel out around a placed wheel, keeping the caption inside `workArea`.
  public static func make(placement: WheelPlacement, workArea: Rect?, captionHeight: Double = captionHeight, gap: Double = captionGap) -> WheelPanelLayout {
    let r = placement.diameter / 2
    let c = placement.center
    let strip = gap + captionHeight
    let fitsBelow = workArea.map { c.y + r + strip <= $0.y + $0.height } ?? true
    let fitsAbove = workArea.map { c.y - r - strip >= $0.y } ?? true
    if fitsBelow {
      return WheelPanelLayout(
        frame: Rect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r + strip),
        discCenter: Point(x: r, y: r),
        captionRect: Rect(x: 0, y: 2 * r + gap, width: 2 * r, height: captionHeight),
        captionPlacement: .below
      )
    }
    if fitsAbove {
      return WheelPanelLayout(
        frame: Rect(x: c.x - r, y: c.y - r - strip, width: 2 * r, height: 2 * r + strip),
        discCenter: Point(x: r, y: strip + r),
        captionRect: Rect(x: 0, y: 0, width: 2 * r, height: captionHeight),
        captionPlacement: .above
      )
    }
    return WheelPanelLayout(frame: Rect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r), discCenter: Point(x: r, y: r), captionRect: nil, captionPlacement: .none)
  }

  /// Global DIP point of a panel-local point.
  public func global(_ local: Point) -> Point {
    Point(x: frame.x + local.x, y: frame.y + local.y)
  }

  /// Panel-local point → is it on the disc (r <= diameter / 2)?
  public func isOnDisc(_ local: Point, diameter: Double) -> Bool {
    JSMath.hypot(local.x - discCenter.x, local.y - discCenter.y) <= diameter / 2
  }
}
