// Line-by-line port of packages/core/src/geometry.ts (and the display lookup
// from packages/core/src/coords.ts it depends on). Space: global DIP, top-left
// origin, y down; angles in degrees, positive = clockwise on screen. All
// arithmetic is IEEE-754 double precision; Math.hypot/Math.atan2 use the
// bit-exact ports in JSMath.

/// Result of hit-testing a point relative to the wheel center (WheelHit).
public enum WheelHit: Sendable, Equatable, Hashable, CustomStringConvertible {
  case center
  case outside
  case sector(Int)

  public var description: String {
    switch self {
    case .center: return "center"
    case .outside: return "outside"
    case .sector(let i): return "sector(\(i))"
    }
  }
}

/// Hit result with the index as the reference computes it (a JS number).
public enum RawWheelHit: Sendable, Equatable, CustomStringConvertible {
  case center
  case outside
  case sector(Double)

  public var description: String {
    switch self {
    case .center: return "center"
    case .outside: return "outside"
    case .sector(let i): return "sector(\(i))"
    }
  }
}

/// WheelPlacement.
public struct WheelPlacement: Sendable, Equatable {
  /// Wheel center in global DIP.
  public var center: Point
  /// Diameter actually used (may shrink on a tiny work area).
  public var diameter: Double
  /// Native window frame (disc + margin) in global DIP.
  public var windowFrame: Rect
  /// True when the center had to move away from the activation point.
  public var shifted: Bool

  public init(center: Point, diameter: Double, windowFrame: Rect, shifted: Bool) {
    self.center = center
    self.diameter = diameter
    self.windowFrame = windowFrame
    self.shifted = shifted
  }
}

public enum WheelMath {
  /// Normalise an angle to [0, 360) (may round to 360 for tiny negative inputs; callers clamp).
  public static func normalizeDeg(_ deg: Double) -> Double {
    let r = JSMath.remainder(deg, 360)
    return r < 0 ? r + 360 : r
  }

  public static func outerRadius(_ diameter: Double) -> Double {
    diameter / 2
  }

  public static func innerRadius(_ diameter: Double, _ g: WheelGeometry = .default) -> Double {
    (diameter / 2) * g.innerRadiusRatio
  }

  /// Outer radius of the sector shapes (inside the thin ring). Drawing only: hit-testing uses outerRadius.
  public static func sectorOuterRadius(_ diameter: Double, _ g: WheelGeometry = .default) -> Double {
    diameter / 2 - g.ringInset
  }

  /// Angular span of one sector in degrees.
  public static func sectorSpan(_ sectorCount: Double) -> Double {
    360 / sectorCount
  }

  /// Center angle (degrees) of sector `index`.
  public static func sectorCenterDeg(_ index: Double, _ sectorCount: Double, _ g: WheelGeometry = .default) -> Double {
    g.startAngleDeg + index * sectorSpan(sectorCount)
  }

  /// Angle (degrees) where sector `index` begins (its counter-clockwise edge).
  public static func sectorStartDeg(_ index: Double, _ sectorCount: Double, _ g: WheelGeometry = .default) -> Double {
    let span = sectorSpan(sectorCount)
    return g.startAngleDeg + index * span - span / 2
  }

  /// Hit-test a point given relative to the wheel center (dx, dy in DIP, y down),
  /// exactly as the TypeScript reference including its corner cases (fractional,
  /// infinite or NaN sector counts yield the same — possibly non-integral — index JS does).
  ///  - non-finite input → outside
  ///  - r <= innerRadius → center (dead zone, never selects)
  ///  - r > diameter / 2 → outside
  ///  - sectorCount < 1  → outside
  ///  - otherwise        → sector by angle over the full wedge; sector i covers
  ///                       [start + i·span − span/2, start + i·span + span/2).
  public static func hitTestRaw(dx: Double, dy: Double, sectorCount: Double, diameter: Double, _ g: WheelGeometry = .default) -> RawWheelHit {
    let r = JSMath.hypot(dx, dy)
    if !r.isFinite { return .outside }
    if r <= innerRadius(diameter, g) { return .center }
    if r > outerRadius(diameter) { return .outside }
    let count = JSMath.trunc(sectorCount)
    if !(count >= 1) { return .outside }
    let angle = (JSMath.atan2(dy, dx) * 180) / JSMath.pi
    let span = sectorSpan(count)
    let rel = normalizeDeg(angle - g.startAngleDeg + span / 2)
    let index = JSMath.min(count - 1, JSMath.floor(rel / span))
    return .sector(index)
  }

  /// Hit-test for a real menu (0…HelperProtocol.maxSectors sectors). The index is always in 0..<sectorCount.
  public static func hitTest(dx: Double, dy: Double, sectorCount: Int, diameter: Double, _ g: WheelGeometry = .default) -> WheelHit {
    let count = max(0, min(sectorCount, 1 << 20))
    switch hitTestRaw(dx: dx, dy: dy, sectorCount: Double(count), diameter: diameter, g) {
    case .center: return .center
    case .outside: return .outside
    case .sector(let index):
      // index = min(count − 1, floor(rel / span)) with rel in [0, 360] is finite and >= 0 here.
      guard index.isFinite, index >= 0 else { return .outside }
      return .sector(min(count - 1, Int(index)))
    }
  }

  /// Hit-test a pointer given in global DIP against a placed wheel.
  public static func hitTestPlaced(pointer: Point, center: Point, diameter: Double, sectorCount: Int, _ g: WheelGeometry = .default) -> WheelHit {
    hitTest(dx: pointer.x - center.x, dy: pointer.y - center.y, sectorCount: sectorCount, diameter: diameter, g)
  }

  /// Place the wheel near the activation point, fully inside `workArea`.
  ///  1. smallest = min(g.minDiameter, g.diameter);
  ///     diameter = max(smallest, min(g.diameter, min(workArea.w, workArea.h) − 2·edgePadding)).
  ///  2. per axis: lo = start + R + edgePadding, hi = start + length − R − edgePadding;
  ///     center = clamp(activation, lo, hi), or start + length / 2 when lo > hi or the
  ///     activation coordinate is not finite.
  ///  3. windowFrame = square of side diameter + 2·windowMargin centered on center.
  ///  4. shifted = center differs from the activation point on either axis.
  public static func placeWheel(activation: Point, workArea: Rect, _ g: WheelGeometry = .default) -> WheelPlacement {
    let available = JSMath.min(workArea.width, workArea.height) - 2 * g.edgePadding
    let smallest = JSMath.min(g.minDiameter, g.diameter)
    let diameter = JSMath.max(smallest, JSMath.min(g.diameter, available))
    let radius = diameter / 2
    func clampAxis(_ value: Double, _ start: Double, _ length: Double) -> Double {
      let lo = start + radius + g.edgePadding
      let hi = start + length - radius - g.edgePadding
      if lo > hi || !value.isFinite { return start + length / 2 }
      return JSMath.min(hi, JSMath.max(lo, value))
    }
    let center = Point(x: clampAxis(activation.x, workArea.x, workArea.width), y: clampAxis(activation.y, workArea.y, workArea.height))
    let half = radius + g.windowMargin
    return WheelPlacement(
      center: center,
      diameter: diameter,
      windowFrame: Rect(x: center.x - half, y: center.y - half, width: half * 2, height: half * 2),
      shifted: center.x != activation.x || center.y != activation.y
    )
  }

  /// Sector arming: selectable only once the pointer moved at least `armDistance`
  /// from the activation point, or passed through the dead zone. Non-finite → false.
  public static func isArmed(activation: Point, pointer: Point, passedCenter: Bool, _ g: WheelGeometry = .default) -> Bool {
    if passedCenter { return true }
    let distance = JSMath.hypot(pointer.x - activation.x, pointer.y - activation.y)
    return distance.isFinite && distance >= g.armDistance
  }
}

/// Port of the display/rect helpers from packages/core/src/coords.ts that the helper needs.
public enum Coords {
  /// Half-open containment: r.x <= p.x < r.x + r.width (same for y). Empty rects contain nothing.
  public static func rectContainsPoint(_ r: Rect, _ p: Point) -> Bool {
    p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
  }

  /// Euclidean distance from p to the closed rectangle (0 inside or on an edge).
  public static func distanceToRect(_ r: Rect, _ p: Point) -> Double {
    let dx = p.x < r.x ? r.x - p.x : (p.x > r.x + r.width ? p.x - (r.x + r.width) : 0)
    let dy = p.y < r.y ? r.y - p.y : (p.y > r.y + r.height ? p.y - (r.y + r.height) : 0)
    return JSMath.hypot(dx, dy)
  }

  /// Index of the display whose bounds contain the point (half-open, first match),
  /// otherwise the nearest one (ties → lower index); -1 for an empty list.
  public static func displayIndexAtPoint(_ point: Point, _ bounds: [Rect]) -> Int {
    for (i, r) in bounds.enumerated() where rectContainsPoint(r, point) { return i }
    var best = -1
    var bestDistance = Double.infinity
    for (i, r) in bounds.enumerated() {
      let distance = distanceToRect(r, point)
      if distance < bestDistance {
        bestDistance = distance
        best = i
      }
    }
    return best
  }

  /// `displayIndexForPoint` from geometry.ts (same rule).
  public static func displayIndexForPoint(_ point: Point, _ displays: [Rect]) -> Int {
    displayIndexAtPoint(point, displays)
  }

  /// floor(x + 0.5) — rounds halves towards +∞ (never use `.rounded()` where the reference uses this).
  public static func roundHalfUp(_ x: Double) -> Double {
    JSMath.floor(x + 0.5)
  }

  public static func rectCenter(_ r: Rect) -> Point {
    Point(x: r.x + r.width / 2, y: r.y + r.height / 2)
  }

  public static func rectCenteredAt(_ center: Point, width: Double, height: Double) -> Rect {
    Rect(x: center.x - width / 2, y: center.y - height / 2, width: width, height: height)
  }

  /// Move (never resize) `rect` inside `area`; on an axis where it is larger it is centered instead.
  public static func clampRectIntoArea(_ rect: Rect, _ area: Rect) -> Rect {
    func axis(_ start: Double, _ length: Double, _ areaStart: Double, _ areaLength: Double) -> Double {
      if length > areaLength { return areaStart + (areaLength - length) / 2 }
      return JSMath.min(JSMath.max(start, areaStart), areaStart + areaLength - length)
    }
    return Rect(x: axis(rect.x, rect.width, area.x, area.width), y: axis(rect.y, rect.height, area.y, area.height), width: rect.width, height: rect.height)
  }

  /// Shrink `rect` to at most the area's size (keeping its center), then clamp it into the area.
  public static func fitRectIntoArea(_ rect: Rect, _ area: Rect) -> Rect {
    let width = JSMath.max(0, JSMath.min(rect.width, area.width))
    let height = JSMath.max(0, JSMath.min(rect.height, area.height))
    return clampRectIntoArea(rectCenteredAt(rectCenter(rect), width: width, height: height), area)
  }

  /// Values closer than this to an integer snap to it when computing enclosing pixel rectangles.
  public static let pixelSnapEpsilon = 1e-6

  public enum PixelRounding: Sendable { case none, nearest, enclosing }

  /// `roundRect` from coords.ts: 'nearest' rounds each edge with roundHalfUp; 'enclosing'
  /// floors left/top and ceils right/bottom after snapping values within 1e-6 of an integer.
  public static func roundRect(_ r: Rect, _ mode: PixelRounding) -> Rect {
    let left = r.x
    let top = r.y
    let right = r.x + r.width
    let bottom = r.y + r.height
    switch mode {
    case .none:
      return r
    case .nearest:
      let x = roundHalfUp(left)
      let y = roundHalfUp(top)
      return Rect(x: x, y: y, width: roundHalfUp(right) - x, height: roundHalfUp(bottom) - y)
    case .enclosing:
      let x = JSMath.floor(left + pixelSnapEpsilon)
      let y = JSMath.floor(top + pixelSnapEpsilon)
      return Rect(x: x, y: y, width: (right - pixelSnapEpsilon).rounded(.up) - x, height: (bottom - pixelSnapEpsilon).rounded(.up) - y)
    }
  }

  // MARK: macOS (AppKit) conversions

  /// AppKit global point (bottom-left origin of the primary screen, y up) → OrbitDrop global DIP.
  public static func appKitPointToGlobal(_ p: Point, primaryFrame: Rect) -> Point {
    Point(x: p.x - primaryFrame.x, y: primaryFrame.y + primaryFrame.height - p.y)
  }

  public static func globalPointToAppKit(_ p: Point, primaryFrame: Rect) -> Point {
    Point(x: p.x + primaryFrame.x, y: primaryFrame.y + primaryFrame.height - p.y)
  }

  /// AppKit rect (origin = bottom-left corner) → global DIP rect (origin = top-left corner).
  public static func appKitRectToGlobal(_ r: Rect, primaryFrame: Rect) -> Rect {
    Rect(x: r.x - primaryFrame.x, y: primaryFrame.y + primaryFrame.height - (r.y + r.height), width: r.width, height: r.height)
  }

  public static func globalRectToAppKit(_ r: Rect, primaryFrame: Rect) -> Rect {
    Rect(x: r.x + primaryFrame.x, y: primaryFrame.y + primaryFrame.height - (r.y + r.height), width: r.width, height: r.height)
  }

  /// Display model from NSScreen.screens (AppKit coordinates). screens[0] must be the
  /// primary screen (menu bar, frame origin (0, 0)), as AppKit orders them.
  public static func displaysFromAppKitScreens(_ screens: [AppKitScreen]) -> [Display] {
    guard let primary = screens.first else { return [] }
    return screens.enumerated().map { index, screen in
      Display(
        id: screen.id ?? "screen-\(index)",
        bounds: appKitRectToGlobal(screen.frame, primaryFrame: primary.frame),
        workArea: appKitRectToGlobal(screen.visibleFrame, primaryFrame: primary.frame),
        scaleFactor: screen.backingScaleFactor.isFinite && screen.backingScaleFactor > 0 ? screen.backingScaleFactor : 1,
        primary: index == 0
      )
    }
  }

  /// Pick the display for the activation point (containing, else nearest) and place
  /// the wheel in its work area (`placeWheelOnDisplays`). Nil when there are no displays.
  public static func placeWheelOnDisplays(_ activation: Point, _ displays: [Display], _ g: WheelGeometry = .default) -> (displayIndex: Int, placement: WheelPlacement)? {
    let index = displayIndexAtPoint(activation, displays.map(\.bounds))
    guard index >= 0 else { return nil }
    return (index, WheelMath.placeWheel(activation: activation, workArea: displays[index].workArea, g))
  }
}

/// One NSScreen as the helper reads it (AppKit global coordinates, points).
public struct AppKitScreen: Sendable, Equatable {
  public var id: String?
  public var frame: Rect
  public var visibleFrame: Rect
  public var backingScaleFactor: Double

  public init(id: String? = nil, frame: Rect, visibleFrame: Rect, backingScaleFactor: Double) {
    self.id = id
    self.frame = frame
    self.visibleFrame = visibleFrame
    self.backingScaleFactor = backingScaleFactor
  }
}

/// A display in global DIP (`Display` in coords.ts).
public struct Display: Sendable, Equatable {
  public var id: String
  public var bounds: Rect
  public var workArea: Rect
  public var scaleFactor: Double
  public var primary: Bool

  public init(id: String, bounds: Rect, workArea: Rect, scaleFactor: Double, primary: Bool) {
    self.id = id
    self.bounds = bounds
    self.workArea = workArea
    self.scaleFactor = scaleFactor
    self.primary = primary
  }
}
