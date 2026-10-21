import Foundation

/// Outline of one wheel sector: an annular wedge whose straight edges are offset
/// by half the gap (so the gap between neighbours has a constant width) and whose
/// four corners are rounded with circles tangent to both the edge and the arc.
///
/// Coordinates are relative to the wheel center in DIP, y down; angles are
/// radians, increasing clockwise on screen (the same convention as hit-testing).
public enum PathElement: Sendable, Equatable {
  case move(Point)
  case line(Point)
  /// Arc around `center` from `start` to `end` (radians). `increasing` = angles grow (clockwise on screen).
  case arc(center: Point, radius: Double, start: Double, end: Double, increasing: Bool)
  case close
}

public struct SectorOutline: Sendable, Equatable {
  public var elements: [PathElement]
  /// True for the single-sector case drawn as a full ring (even-odd fill of two circles).
  public var isFullRing: Bool
  /// Corner radius actually used after clamping.
  public var cornerRadius: Double
}

public enum SectorShape {
  public static func outline(
    index: Int, count: Int, innerRadius ri: Double, outerRadius ro: Double, gap: Double, cornerRadius requested: Double, startAngleDeg: Double
  ) -> SectorOutline {
    precondition(count >= 1 && index >= 0 && index < count)
    if count == 1 {
      return SectorOutline(elements: [
        .move(Point(x: ro, y: 0)), .arc(center: .zero, radius: ro, start: 0, end: 2 * .pi, increasing: true), .close,
        .move(Point(x: ri, y: 0)), .arc(center: .zero, radius: ri, start: 0, end: 2 * .pi, increasing: true), .close,
      ], isFullRing: true, cornerRadius: 0)
    }
    let span = 2 * Double.pi / Double(count)
    let mid = (startAngleDeg * .pi / 180) + Double(index) * span
    let alpha = mid - span / 2  // counter-clockwise edge
    let beta = mid + span / 2  // clockwise edge
    // Half gap, kept small enough that both edge lines cross the inner circle well
    // apart (extreme gap/inner-radius/sector-count combinations get a narrower gap).
    let d = min(max(gap / 2, 0), ri * sin(span / 2 * 0.8))
    let rc = clampedCornerRadius(requested, ri: ri, ro: ro, d: d, halfSpan: span / 2)

    func polar(_ r: Double, _ a: Double) -> Point { Point(x: r * cos(a), y: r * sin(a)) }
    func sub(_ p: Point, _ q: Point) -> Point { Point(x: p.x - q.x, y: p.y - q.y) }
    func add(_ p: Point, _ q: Point, _ s: Double) -> Point { Point(x: p.x + q.x * s, y: p.y + q.y * s) }
    func angle(_ p: Point) -> Double { atan2(p.y, p.x) }

    // Unit normals of the two radial edge lines, pointing into the sector.
    let nA = Point(x: -sin(alpha), y: cos(alpha))  // towards increasing angle
    let nB = Point(x: sin(beta), y: -cos(beta))  // towards decreasing angle

    let phiOuter = asin(min(1, (d + rc) / (ro - rc)))
    let phiInner = asin(min(1, (d + rc) / (ri + rc)))
    let cOuterA = polar(ro - rc, alpha + phiOuter)
    let cOuterB = polar(ro - rc, beta - phiOuter)
    let cInnerA = polar(ri + rc, alpha + phiInner)
    let cInnerB = polar(ri + rc, beta - phiInner)

    let edgeOuterA = add(cOuterA, nA, -rc)  // tangent point on the edge line
    let edgeOuterB = add(cOuterB, nB, -rc)
    let edgeInnerA = add(cInnerA, nA, -rc)
    let edgeInnerB = add(cInnerB, nB, -rc)
    let arcOuterA = angle(cOuterA)  // tangent point on the outer circle (same direction as the corner center)
    let arcOuterB = angle(cOuterB)
    let arcInnerA = angle(cInnerA)
    let arcInnerB = angle(cInnerB)

    var elements: [PathElement] = [.move(edgeInnerA), .line(edgeOuterA)]
    if rc > 0 { elements.append(shortArc(center: cOuterA, radius: rc, from: angle(sub(edgeOuterA, cOuterA)), to: angle(sub(polar(ro, arcOuterA), cOuterA)))) }
    elements.append(.arc(center: .zero, radius: ro, start: arcOuterA, end: unwrap(arcOuterB, after: arcOuterA), increasing: true))
    if rc > 0 { elements.append(shortArc(center: cOuterB, radius: rc, from: angle(sub(polar(ro, arcOuterB), cOuterB)), to: angle(sub(edgeOuterB, cOuterB)))) }
    elements.append(.line(edgeInnerB))
    if rc > 0 { elements.append(shortArc(center: cInnerB, radius: rc, from: angle(sub(edgeInnerB, cInnerB)), to: angle(sub(polar(ri, arcInnerB), cInnerB)))) }
    elements.append(.arc(center: .zero, radius: ri, start: unwrap(arcInnerB, after: arcInnerA), end: arcInnerA, increasing: false))
    if rc > 0 { elements.append(shortArc(center: cInnerA, radius: rc, from: angle(sub(polar(ri, arcInnerA), cInnerA)), to: angle(sub(edgeInnerA, cInnerA)))) }
    elements.append(.close)
    return SectorOutline(elements: elements, isFullRing: false, cornerRadius: rc)
  }

  /// Largest corner radius ≤ requested that fits: radial room, and the corner
  /// tangent points of both edges must not cross on the inner or outer arc.
  static func clampedCornerRadius(_ requested: Double, ri: Double, ro: Double, d: Double, halfSpan: Double) -> Double {
    func fits(_ rc: Double) -> Bool {
      guard rc >= 0, rc <= (ro - ri) / 2 - 0.5 else { return false }
      guard d + rc < ro - rc, d + rc < ri + rc else { return false }
      return asin((d + rc) / (ri + rc)) <= halfSpan - 1e-6 && asin((d + rc) / (ro - rc)) <= halfSpan - 1e-6
    }
    var rc = max(0, requested)
    if fits(rc) { return rc }
    var lo = 0.0
    var hi = rc
    if !fits(lo) { return 0 }
    for _ in 0..<40 {
      let m = (lo + hi) / 2
      if fits(m) { lo = m } else { hi = m }
    }
    rc = lo
    return rc
  }

  /// Arc between two angles around a corner circle, the short way (< π).
  static func shortArc(center: Point, radius: Double, from a: Double, to b: Double) -> PathElement {
    var delta = (b - a).truncatingRemainder(dividingBy: 2 * .pi)
    if delta > .pi { delta -= 2 * .pi }
    if delta < -.pi { delta += 2 * .pi }
    return .arc(center: center, radius: radius, start: a, end: a + delta, increasing: delta >= 0)
  }

  /// `b` shifted by multiples of 2π so that it lies in (a, a + 2π].
  static func unwrap(_ b: Double, after a: Double) -> Double {
    var value = b
    while value <= a { value += 2 * .pi }
    while value > a + 2 * .pi { value -= 2 * .pi }
    return value
  }

  /// Anchor for a sector's label: the middle of the band along the sector's center angle.
  public static func labelAnchor(index: Int, count: Int, innerRadius ri: Double, outerRadius ro: Double, startAngleDeg: Double) -> Point {
    let span = 2 * Double.pi / Double(max(count, 1))
    let mid = (startAngleDeg * .pi / 180) + Double(index) * span
    let r = count == 1 ? (ri + ro) / 2 : (ri + ro) / 2 + (ro - ri) * 0.02
    if count == 1 { return Point(x: 0, y: -r) }
    return Point(x: r * cos(mid), y: r * sin(mid))
  }

  /// Width available for a label at the anchor (chord of the band minus the gap and padding).
  public static func labelWidth(count: Int, innerRadius ri: Double, outerRadius ro: Double, gap: Double) -> Double {
    if count <= 1 { return (ro - ri) * 2.2 }
    let span = 2 * Double.pi / Double(count)
    let rm = (ri + ro) / 2
    let chord = span >= .pi ? (ro - ri) * 2 : 2 * rm * sin(span / 2)
    return max(24, min(chord - gap - 10, (ro - ri) * 1.6))
  }
}
