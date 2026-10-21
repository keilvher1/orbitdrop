import XCTest

@testable import OrbitDropHelperCore

/// Bit-exact comparison with vectors generated from packages/core/src/geometry.ts
/// and coords.ts by scripts/gen-fixtures.mjs.
final class GeometryVectorTests: XCTestCase {
  private var root: [String: Any] = [:]
  private var geometries: [WheelGeometry] = []

  override func setUpWithError() throws {
    root = try TestPaths.json(TestPaths.fixture("geometry-vectors.json")) as! [String: Any]
    geometries = (root["geometries"] as! [[String: String]]).map(Self.geometry)
  }

  static func geometry(_ o: [String: String]) -> WheelGeometry {
    var g = WheelGeometry.default
    for field in WheelGeometry.fieldRanges { g[keyPath: field.keyPath] = double(fromBits: o[field.name]!) }
    return g
  }

  static func point(_ o: [String: String]) -> Point { Point(x: double(fromBits: o["x"]!), y: double(fromBits: o["y"]!)) }
  static func rect(_ o: [String: String]) -> Rect {
    Rect(x: double(fromBits: o["x"]!), y: double(fromBits: o["y"]!), width: double(fromBits: o["width"]!), height: double(fromBits: o["height"]!))
  }

  func testHitTests() {
    let rows = root["hitTests"] as! [[Any]]
    XCTAssertGreaterThan(rows.count, 1000)
    var failures: [String] = []
    for row in rows {
      let g = geometries[row[0] as! Int]
      let dx = double(fromBits: row[1] as! String)
      let dy = double(fromBits: row[2] as! String)
      let count = double(fromBits: row[3] as! String)
      let diameter = double(fromBits: row[4] as! String)
      let zone = row[5] as! String
      let got = WheelMath.hitTestRaw(dx: dx, dy: dy, sectorCount: count, diameter: diameter, g)
      let expected: RawWheelHit
      switch zone {
      case "center": expected = .center
      case "outside": expected = .outside
      default: expected = .sector(double(fromBits: row[6] as! String))
      }
      if got != expected { failures.append("hit(\(dx), \(dy), n=\(count), d=\(diameter)) = \(got), expected \(expected)") }

      // The Int API used by the controller agrees wherever the count is a real menu size.
      if count == count.rounded(), count >= 0, count <= 12 {
        let safe = WheelMath.hitTest(dx: dx, dy: dy, sectorCount: Int(count), diameter: diameter, g)
        switch (safe, expected) {
        case (.center, .center), (.outside, .outside): break
        case (.sector(let a), .sector(let b)) where Double(a) == b: break
        default: failures.append("safe hit(\(dx), \(dy), n=\(count)) = \(safe), expected \(expected)")
        }
      }
    }
    XCTAssertEqual(failures.count, 0, failures.prefix(8).joined(separator: "\n"))
  }

  func testPlacements() {
    let rows = root["placements"] as! [[String: Any]]
    XCTAssertGreaterThan(rows.count, 100)
    for row in rows {
      let g = geometries[row["g"] as! Int]
      let activation = Self.point(row["activation"] as! [String: String])
      let workArea = Self.rect(row["workArea"] as! [String: String])
      let p = WheelMath.placeWheel(activation: activation, workArea: workArea, g)
      let center = Self.point(row["center"] as! [String: String])
      let frame = Self.rect(row["windowFrame"] as! [String: String])
      XCTAssertEqual(bits(p.center.x), bits(center.x), "center.x for \(activation) in \(workArea)")
      XCTAssertEqual(bits(p.center.y), bits(center.y), "center.y for \(activation) in \(workArea)")
      XCTAssertEqual(bits(p.diameter), row["diameter"] as! String)
      XCTAssertEqual(p.windowFrame.x.bitPattern, frame.x.bitPattern)
      XCTAssertEqual(p.windowFrame.y.bitPattern, frame.y.bitPattern)
      XCTAssertEqual(p.windowFrame.width.bitPattern, frame.width.bitPattern)
      XCTAssertEqual(p.windowFrame.height.bitPattern, frame.height.bitPattern)
      XCTAssertEqual(p.shifted, row["shifted"] as! Bool)
    }
  }

  func testArming() {
    for row in root["arming"] as! [[String: Any]] {
      let g = geometries[row["g"] as! Int]
      let got = WheelMath.isArmed(
        activation: Self.point(row["activation"] as! [String: String]),
        pointer: Self.point(row["pointer"] as! [String: String]),
        passedCenter: row["passedCenter"] as! Bool, g
      )
      XCTAssertEqual(got, row["armed"] as! Bool, "\(row)")
    }
  }

  func testDisplayLookup() {
    let sets = (root["displaySets"] as! [[[String: String]]]).map { $0.map(Self.rect) }
    for row in root["displays"] as! [[String: Any]] {
      let set = sets[row["set"] as! Int]
      let point = Self.point(row["point"] as! [String: String])
      XCTAssertEqual(Coords.displayIndexForPoint(point, set), row["index"] as! Int, "\(point) in \(set)")
    }
  }

  func testAppKitConversions() {
    for row in root["conversions"] as! [[String: Any]] {
      let primary = Self.rect(row["primary"] as! [String: String])
      if row["kind"] as! String == "point" {
        let input = Self.point(row["input"] as! [String: String])
        XCTAssertEqual(Coords.appKitPointToGlobal(input, primaryFrame: primary), Self.point(row["toGlobal"] as! [String: String]))
        XCTAssertEqual(Coords.globalPointToAppKit(input, primaryFrame: primary), Self.point(row["toAppKit"] as! [String: String]))
      } else {
        let input = Self.rect(row["input"] as! [String: String])
        XCTAssertEqual(Coords.appKitRectToGlobal(input, primaryFrame: primary), Self.rect(row["toGlobal"] as! [String: String]))
        XCTAssertEqual(Coords.globalRectToAppKit(input, primaryFrame: primary), Self.rect(row["toAppKit"] as! [String: String]))
      }
    }
  }
}
