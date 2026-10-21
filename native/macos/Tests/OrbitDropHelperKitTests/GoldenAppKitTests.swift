import AppKit
import XCTest

@testable import OrbitDropHelperCore
@testable import OrbitDropHelperKit

/// coords.mac golden pointers through the real AppKit conversion chain the drop
/// target uses: AppKit screen point → window base point of the panel (y up) →
/// WheelView.convert (flipped view, y down) → global DIP (WheelPanelLayout.global,
/// as HelperApp does) → hit-test.
@MainActor
final class GoldenAppKitTests: XCTestCase {
  static let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

  func testMacGoldenPointersThroughAFlippedWheelView() throws {
    let url = ProcessInfo.processInfo.environment["ORBITDROP_GOLDEN"].map { URL(fileURLWithPath: $0) } ?? Self.repoRoot.appendingPathComponent("tests/fixtures/wheel-golden.json")
    guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("no golden vectors") }
    let golden = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    func num(_ v: Any?) -> Double { (v as! NSNumber).doubleValue }
    func point(_ v: Any?) -> Point { let o = v as! [String: Any]; return Point(x: num(o["x"]), y: num(o["y"])) }
    func rect(_ v: Any?) -> Rect { let o = v as! [String: Any]; return Rect(x: num(o["x"]), y: num(o["y"]), width: num(o["width"]), height: num(o["height"])) }
    var geometry = WheelGeometry.default
    let g = golden["geometry"] as! [String: Any]
    for field in WheelGeometry.fieldRanges { geometry[keyPath: field.keyPath] = num(g[field.name]) }

    var checked = 0
    var failures: [String] = []
    for layout in (golden["coords"] as! [String: Any])["mac"] as! [[String: Any]] {
      let screens = (layout["screens"] as! [[String: Any]]).map { AppKitScreen(frame: rect($0["frame"]), visibleFrame: rect($0["visibleFrame"]), backingScaleFactor: num($0["backingScaleFactor"])) }
      let primary = screens[0].frame
      let displays = Coords.displaysFromAppKitScreens(screens)
      for wheel in layout["wheel"] as! [[String: Any]] {
        var gw = geometry
        gw.diameter = num(wheel["diameter"])
        let activation = Coords.appKitPointToGlobal(point(wheel["activationAppKit"]), primaryFrame: primary)
        let placed = try XCTUnwrap(Coords.placeWheelOnDisplays(activation, displays, gw))
        let placement = placed.placement
        // The production panel: disc bounding square + caption strip (WheelPanelLayout), not windowFrame.
        let panelLayout = WheelPanelLayout.make(placement: placement, workArea: displays[placed.displayIndex].workArea)
        let frameAppKit = Coords.globalRectToAppKit(panelLayout.frame, primaryFrame: primary)
        // The panel is never ordered on screen; conversion only needs the view hierarchy.
        let window = NSWindow(contentRect: NSRect(x: frameAppKit.x, y: frameAppKit.y, width: frameAppKit.width, height: frameAppKit.height), styleMask: .borderless, backing: .buffered, defer: true)
        let view = WheelView(frame: NSRect(x: 0, y: 0, width: frameAppKit.width, height: frameAppKit.height))
        window.contentView = view
        for pointer in wheel["pointers"] as! [[String: Any]] {
          let appKit = point(pointer["appKit"])
          let windowPoint = NSPoint(x: appKit.x - frameAppKit.x, y: appKit.y - frameAppKit.y)
          let local = view.convert(windowPoint, from: nil)
          let global = panelLayout.global(Point(x: Double(local.x), y: Double(local.y)))
          let hit = WheelMath.hitTest(dx: global.x - placement.center.x, dy: global.y - placement.center.y, sectorCount: Int(num(pointer["sectorCount"])), diameter: placement.diameter, gw)
          let expected: WheelHit
          switch pointer["zone"] as! String {
          case "center": expected = .center
          case "outside": expected = .outside
          default: expected = .sector(Int(num(pointer["index"])))
          }
          checked += 1
          if hit != expected { failures.append("\(layout["name"]!): \(appKit) → \(hit), expected \(expected)") }
        }
      }
    }
    print("GOLDEN coords.mac pointers via flipped WheelView: \(checked - failures.count)/\(checked) passed")
    XCTAssertEqual(checked, 150)
    XCTAssertEqual(failures, [])
  }
}
