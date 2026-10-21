import AppKit
import XCTest

@testable import OrbitDropHelperCore
@testable import OrbitDropHelperKit

/// Renders wheels offscreen and checks real pixels (no window, no screen).
final class RenderingTests: XCTestCase {
  struct Bitmap {
    let width: Int
    let height: Int
    let data: [UInt8]  // premultiplied RGBA, sRGB

    init(_ image: CGImage) {
      width = image.width
      height = image.height
      var bytes = [UInt8](repeating: 0, count: width * height * 4)
      let ctx = CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      data = bytes
    }

    /// Pixel at (x, y) in top-left image coordinates (points × scale already applied by the caller).
    func rgba(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int, a: Int) {
      let i = (y * width + x) * 4
      return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2]), Int(data[i + 3]))
    }

    func darkPixels(inRect rect: CGRect) -> Int {
      var count = 0
      for y in Int(rect.minY)..<Int(rect.maxY) {
        for x in Int(rect.minX)..<Int(rect.maxX) {
          let p = rgba(x, y)
          if p.a > 200 && (p.r + p.g + p.b) / 3 < 110 { count += 1 }
        }
      }
      return count
    }
  }

  func render(_ args: [String], scale: Double = 1) throws -> (Bitmap, WheelViewModel) {
    let model = try SnapshotCommand.makeModel(["--render-snapshot", "/dev/null"] + args)
    let image = try XCTUnwrap(Snapshot.render(model, scale: scale))
    return (Bitmap(image), model)
  }

  /// Expected premultiplied composite of `top` over `bottom` (straight-alpha colors).
  func over(_ top: RGBA, _ bottom: RGBA) -> (Int, Int, Int, Int) {
    func pm(_ c: RGBA) -> (Double, Double, Double, Double) { (c.r * c.a, c.g * c.a, c.b * c.a, c.a) }
    let t = pm(top)
    let b = pm(bottom)
    let k = 1 - t.3
    return (Int(((t.0 + b.0 * k) * 255).rounded()), Int(((t.1 + b.1 * k) * 255).rounded()), Int(((t.2 + b.2 * k) * 255).rounded()), Int(((t.3 + b.3 * k) * 255).rounded()))
  }

  func assertColor(_ p: (r: Int, g: Int, b: Int, a: Int), _ e: (Int, Int, Int, Int), tolerance: Int = 3, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
    let ok = abs(p.r - e.0) <= tolerance && abs(p.g - e.1) <= tolerance && abs(p.b - e.2) <= tolerance && abs(p.a - e.3) <= tolerance
    XCTAssertTrue(ok, "\(message): got \(p), expected \(e)", file: file, line: line)
  }

  func testPdfConvertWheelPixels() throws {
    let (bmp, model) = try render(["--menu", "pdf", "--mode", "convert", "--highlight", "1", "--locale", "en"])
    let t = model.presentation.tokens
    XCTAssertEqual(bmp.width, 408)
    XCTAssertEqual(model.capsule, CapsuleContent(text: "JPG", style: .action))
    // Transparent margin outside the disc.
    XCTAssertEqual(bmp.rgba(3, 3).a, 0)
    XCTAssertEqual(bmp.rgba(204, 2).a, 0)
    // Active sector (JPG, to the right): opaque accent from the tokens. Sample between the label and the edge.
    let mid = (WheelMath.innerRadius(360) + WheelMath.sectorOuterRadius(360)) / 2
    assertColor(bmp.rgba(204 + Int(mid) + 40, 204), over(t.sectorActive, RGBA(r: 0, g: 0, b: 0, a: 0)), "active sector fill")
    // Enabled, not highlighted sector (DOCX, top) over the translucent disc.
    assertColor(bmp.rgba(204 - 50, 204 - Int(mid)), over(t.sector, t.wheelDisc), "idle sector fill")
    // Dead zone between the capsule and the sectors shows the disc only.
    assertColor(bmp.rgba(204, 204 - 52), over(t.wheelDisc, RGBA(r: 0, g: 0, b: 0, a: 0)), "disc in the dead zone")
    // Capsule (left part, away from the text).
    assertColor(bmp.rgba(204 - 44, 204), over(t.capsule, t.wheelDisc), "capsule fill")
    // White label on the active sector, dark labels on the others.
    XCTAssertGreaterThan(bmp.darkPixels(inRect: CGRect(x: 204 - 40, y: 204 - Int(mid) - 12, width: 80, height: 24)), 20, "DOCX label drawn")
    var whitePixels = 0
    for y in (204 - 10)...(204 + 10) {
      for x in (204 + Int(mid) - 25)...(204 + Int(mid) + 25) {
        let p = bmp.rgba(x, y)
        if p.r > 240 && p.g > 240 && p.b > 240 { whitePixels += 1 }
      }
    }
    XCTAssertGreaterThan(whitePixels, 20, "white JPG label on the orange sector")
    // Gap between DOCX and JPG sectors (on the -45° boundary) is not sector-colored.
    let gx = 204 + Int(mid * cos(-.pi / 4))
    let gy = 204 + Int(mid * sin(-.pi / 4))
    assertColor(bmp.rgba(gx, gy), over(t.wheelDisc, RGBA(r: 0, g: 0, b: 0, a: 0)), tolerance: 6, "constant-width gap shows the disc")
  }

  func testDisabledSectorAndRejectedHighlight() throws {
    let (plain, model) = try render(["--menu", "image/jpeg", "--mode", "convert", "--locale", "en"])
    let t = model.presentation.tokens
    XCTAssertEqual(model.content.sectors.map(\.label), ["PNG", "WEBP", "HEIC", "TIFF", "AVIF", "BMP", "PDF", "DOCX"])
    // HEIC (index 2 of 8) points right; sample near its outer part, away from the label.
    let ro = WheelMath.sectorOuterRadius(360)
    assertColor(plain.rgba(204 + Int(ro) - 12, 204), over(t.sectorDisabled, t.wheelDisc), "disabled sector fill")

    let (rejected, rejectedModel) = try render(["--menu", "image/jpeg", "--mode", "convert", "--locale", "en", "--highlight", "2"])
    XCTAssertEqual(rejectedModel.highlight, SectorHighlight(index: 2, style: .rejected))
    XCTAssertEqual(rejectedModel.capsule, CapsuleContent(text: "No HEIC encoder in this build", style: .reject))
    assertColor(rejected.rgba(204 + Int(ro) - 30, 204 + 20), over(t.capsuleReject, t.wheelDisc), "rejected highlight fill")
  }

  func testToolsWheelDrawsIconsAndLabels() throws {
    let (bmp, model) = try render(["--menu", "image/png", "--mode", "tools", "--locale", "ko", "--size", "1234567"])
    XCTAssertEqual(model.capsule, CapsuleContent(text: "1.2 MB", style: .info))
    XCTAssertEqual(model.content.sectors.first?.label, "압축")
    let mid = (WheelMath.innerRadius(360) + WheelMath.sectorOuterRadius(360)) / 2
    // Icon above the label: dark pixels both above and below the anchor of sector 0 (top).
    let anchorY = 204 - Int(mid)
    XCTAssertGreaterThan(bmp.darkPixels(inRect: CGRect(x: 204 - 20, y: anchorY - 24, width: 40, height: 20)), 10, "icon drawn above the label")
    XCTAssertGreaterThan(bmp.darkPixels(inRect: CGRect(x: 204 - 40, y: anchorY + 2, width: 80, height: 18)), 10, "Korean label drawn")
  }

  func testThemesAndHighContrast() throws {
    let (dark, darkModel) = try render(["--menu", "pdf", "--mode", "convert", "--theme", "dark", "--locale", "en"])
    let mid = (WheelMath.innerRadius(360) + WheelMath.sectorOuterRadius(360)) / 2
    assertColor(dark.rgba(204 - 50, 204 - Int(mid)), over(darkModel.presentation.tokens.sector, darkModel.presentation.tokens.wheelDisc), "dark sector")

    let (hc, hcModel) = try render(["--menu", "pdf", "--mode", "convert", "--theme", "highContrast", "--locale", "en", "--highlight", "1"])
    XCTAssertTrue(hcModel.presentation.highContrast)
    assertColor(hc.rgba(204 - 50, 204 - Int(mid)), (255, 255, 255, 255), "opaque white sectors")
    assertColor(hc.rgba(204 + Int(mid) + 40, 204), (0xB3, 0x30, 0x00, 0xFF), "high-contrast active sector")
    // Thick black outer ring at radius 180 − 1.
    assertColor(hc.rgba(204, 24 + 1), (0, 0, 0, 255), tolerance: 40, "black ring")
  }

  func testNeutralAndUnsupportedStates() throws {
    let (neutral, model) = try render(["--menu", "pdf", "--mode", "convert", "--state", "neutral", "--locale", "en"])
    XCTAssertEqual(model.content, .neutral)
    XCTAssertEqual(model.capsule, CapsuleContent(text: "Drop here", style: .hint))
    let mid = (WheelMath.innerRadius(360) + WheelMath.sectorOuterRadius(360)) / 2
    let t = model.presentation.tokens
    assertColor(neutral.rgba(204, 204 - Int(mid)), over(t.sector.withAlpha(t.sector.a * 0.55), t.wheelDisc), "neutral band")

    let unsupported = try SnapshotCommand.makeModel(["--render-snapshot", "/dev/null", "--menu", "pdf", "--mode", "tools", "--locale", "en"])
    XCTAssertEqual(unsupported.content, .unsupported)
    XCTAssertEqual(unsupported.capsule.style, .reject)
  }

  func testRetinaScaleAndDiameter() throws {
    let (bmp, _) = try render(["--menu", "pdf", "--mode", "convert", "--diameter", "320"], scale: 2)
    XCTAssertEqual(bmp.width, Int((320 + 48) * 2))
    XCTAssertEqual(bmp.rgba(2, 2).a, 0)
    XCTAssertGreaterThan(bmp.rgba(bmp.width / 2, bmp.height / 2).a, 200, "capsule at the center")
  }

  func testLongReasonsWrapInsideTheDeadZone() {
    let t = DefaultConfig.tokens(theme: .light, reduceMotion: false)
    let g = WheelGeometry.default
    let ri = WheelMath.innerRadius(360, g)
    let reason = String(repeating: "Encoder unavailable in this build ", count: 4).prefix(120)
    let layout = CapsuleLayout.make(text: String(reason), style: .reject, g: g, t: t, innerRadius: ri)
    XCTAssertLessThanOrEqual(layout.lines.count, 3)
    XCTAssertLessThanOrEqual(layout.width, max(g.capsuleWidth, ri * 2 * 0.9) + 0.5)
    XCTAssertLessThanOrEqual(layout.height, ri * 2 * 0.72 + 0.5)
    let short = CapsuleLayout.make(text: "JPG", style: .action, g: g, t: t, innerRadius: ri)
    XCTAssertEqual(short.lines.count, 1)
    XCTAssertEqual(short.width, g.capsuleWidth)
    XCTAssertEqual(short.height, g.capsuleHeight)
    XCTAssertEqual(short.cornerRadius, g.capsuleHeight / 2, "pill shape")
  }

  func testSectorOutlineGeometry() {
    // Every outline point lies within the band and the straight edges keep half the gap from the boundary ray.
    for count in [2, 3, 4, 7, 8, 12] {
      for index in 0..<count {
        let outline = SectorShape.outline(index: index, count: count, innerRadius: 64.8, outerRadius: 172, gap: 6, cornerRadius: 14, startAngleDeg: -90)
        XCTAssertGreaterThan(outline.cornerRadius, 0)
        for element in outline.elements {
          if case .line(let p) = element {
            let r = (p.x * p.x + p.y * p.y).squareRoot()
            XCTAssertGreaterThanOrEqual(r, 64.8 - 1e-6)
            XCTAssertLessThanOrEqual(r, 172 + 1e-6)
            let span = 2 * Double.pi / Double(count)
            let alpha = -Double.pi / 2 + Double(index) * span - span / 2
            let beta = alpha + span
            let dA = abs(-sin(alpha) * p.x + cos(alpha) * p.y)
            let dB = abs(-sin(beta) * p.x + cos(beta) * p.y)
            XCTAssertEqual(min(dA, dB), 3, accuracy: 1e-6, "edge offset by half the gap (n=\(count), i=\(index))")
          }
        }
      }
    }
    XCTAssertTrue(SectorShape.outline(index: 0, count: 1, innerRadius: 60, outerRadius: 170, gap: 6, cornerRadius: 14, startAngleDeg: -90).isFullRing)
    // 12 thin sectors at the minimum diameter still get (smaller) rounded corners.
    let tight = SectorShape.outline(index: 0, count: 12, innerRadius: 0.15 * 100, outerRadius: 100 - 40, gap: 24, cornerRadius: 40, startAngleDeg: 0)
    XCTAssertLessThan(tight.cornerRadius, 40)
  }

  /// WCAG contrast of every text/fill pairing the renderer uses, after compositing over the disc.
  func testLabelContrastAcrossThemes() {
    func flatten(_ c: RGBA, over b: RGBA) -> RGBA {
      let a = c.a + b.a * (1 - c.a)
      guard a > 0 else { return RGBA(r: 0, g: 0, b: 0, a: 0) }
      return RGBA(r: (c.r * c.a + b.r * b.a * (1 - c.a)) / a, g: (c.g * c.a + b.g * b.a * (1 - c.a)) / a, b: (c.b * c.a + b.b * b.a * (1 - c.a)) / a, a: a)
    }
    func luminance(_ c: RGBA) -> Double {
      func lin(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
      return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
    }
    func contrast(_ text: RGBA, on fill: RGBA, disc: RGBA) -> Double {
      // Assume a mid-grey desktop behind the translucent disc.
      let desktop = RGBA(r: 0.5, g: 0.5, b: 0.5)
      let bg = flatten(fill, over: flatten(disc, over: desktop))
      let fg = flatten(text, over: bg)
      let (l1, l2) = (luminance(fg), luminance(bg))
      return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }
    for theme in ThemeName.allCases {
      let t = DefaultConfig.tokens(theme: theme, reduceMotion: false)
      let pairs: [(String, RGBA, RGBA, Double)] = [
        ("label", t.sectorText, t.sector, 4.5),
        ("hover label", t.sectorText, t.sectorHover, 4.5),
        ("active label", t.sectorActiveText, t.sectorActive, 3.0),  // large bold text
        ("rejected label", t.capsuleText.withAlpha(t.capsuleText.a * 0.85), t.capsuleReject, 3.0),
        ("capsule", t.capsuleText, t.capsule, 4.5),
        ("reject capsule", t.capsuleText, t.capsuleReject, 4.5),
        ("disabled label", t.sectorDisabledText, t.sectorDisabled, 1.8),  // intentionally muted
      ]
      for (name, text, fill, minimum) in pairs {
        let ratio = contrast(text, on: fill, disc: t.wheelDisc)
        XCTAssertGreaterThanOrEqual(ratio, minimum, "\(theme) \(name): contrast \(String(format: "%.2f", ratio))")
      }
    }
  }

  func testRejectedLabelIsLegibleInHighContrast() throws {
    // CROP (index 5 of 7) is not batch-capable: with 3 files it is disabled; hovering it shows the rejected style.
    let (bmp, model) = try render(["--menu", "image/png", "--mode", "tools", "--theme", "highContrast", "--files", "3", "--highlight", "5", "--locale", "en"])
    XCTAssertEqual(model.highlight, SectorHighlight(index: 5, style: .rejected))
    let anchor = SectorShape.labelAnchor(index: 5, count: 7, innerRadius: WheelMath.innerRadius(360), outerRadius: WheelMath.sectorOuterRadius(360), startAngleDeg: -90)
    var light = 0
    for y in (204 + Int(anchor.y) - 4)...(204 + Int(anchor.y) + 16) {
      for x in (204 + Int(anchor.x) - 30)...(204 + Int(anchor.x) + 30) {
        let p = bmp.rgba(x, y)
        if p.r > 200 && p.g > 200 && p.b > 200 { light += 1 }
      }
    }
    XCTAssertGreaterThan(light, 15, "white CROP label on the dark rejected fill")
  }

  /// #16: the secondary hint sits in the strip below the disc, only while a sector is armed.
  func testSnapshotShowsTheCaptionBelowTheDisc() throws {
    let (bmp, model) = try render(["--menu", "pdf", "--mode", "convert", "--highlight", "1", "--locale", "en"])
    XCTAssertEqual(bmp.height, 440, "24 margin + 360 disc + 6 gap + 26 caption + 24 margin")
    XCTAssertEqual(model.caption, CapsuleContent(text: "JPG", style: .action))
    let t = model.presentation.tokens
    // Left part of the pill (the "JPG" glyphs are centered at x = 204).
    assertColor(bmp.rgba(180, 24 + 366 + 13), over(t.capsule.withAlpha(1), RGBA(r: 0, g: 0, b: 0, a: 0)), "caption pill")
    var dark = 0
    for x in 190...218 where bmp.rgba(x, 24 + 366 + 13).r < 120 { dark += 1 }
    XCTAssertGreaterThan(dark, 2, "caption text drawn")
    let (plain, plainModel) = try render(["--menu", "pdf", "--mode", "convert", "--locale", "en"])
    XCTAssertNil(plainModel.caption, "nothing armed: no caption")
    XCTAssertLessThan(plain.rgba(180, 24 + 366 + 13).a, 60, "only the painted disc shadow")
  }

  func testSymbolsExistForEveryIcon() {
    for icon in IconId.allCases {
      XCTAssertNotNil(SymbolIcons.image(for: icon, pointSize: 20, weight: .bold, color: RGBA(r: 0, g: 0, b: 0)), "\(icon) → \(SymbolIcons.symbolName(for: icon))")
    }
  }
}
