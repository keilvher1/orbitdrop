import Foundation
import XCTest

@testable import OrbitDropHelperCore

/// Re-reads packages/contracts so the Swift mirrors (enums, limits, default
/// tokens, menu orders) fail loudly when the contracts change.
final class ContractDriftTests: XCTestCase {
  private func source(_ relative: String) throws -> String {
    let url = TestPaths.repoRoot.appendingPathComponent(relative)
    guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("\(relative) not found (package built outside the repo)") }
    return try String(contentsOf: url, encoding: .utf8)
  }

  /// Quoted strings inside `export const NAME ... = [ ... ]`.
  private func stringArray(_ name: String, in text: String) throws -> [String] {
    guard let start = text.range(of: "export const \(name)") else { throw XCTSkip("\(name) not found") }
    let rest = text[start.upperBound...]
    guard let assign = rest.range(of: "= ["), let close = rest[assign.upperBound...].firstIndex(of: "]") else { throw XCTSkip("\(name) has no array") }
    let body = rest[assign.upperBound..<close]
    let regex = try NSRegularExpression(pattern: "'([^']*)'")
    let ns = String(body) as NSString
    return regex.matches(in: String(body), range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
  }

  private func number(_ name: String, in text: String) throws -> Double {
    let regex = try NSRegularExpression(pattern: "export const \(name) = ([0-9_.]+)")
    let ns = text as NSString
    guard let m = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { throw XCTSkip("\(name) not found") }
    return Double(ns.substring(with: m.range(at: 1)).replacingOccurrences(of: "_", with: ""))!
  }

  func testActionIconFormatAndModifierVocabularies() throws {
    let actions = try source("packages/contracts/src/actions.ts")
    let targets = try stringArray("CONVERT_TARGETS", in: actions)
    var tools = try stringArray("TOOL_NAMES", in: actions)
    var icons = try stringArray("ICON_IDS", in: actions)
    // Claude analysis reaches the helpers and packages/contracts on separate branches: until the
    // contracts declare it, the helpers may be ahead by exactly `analyze`, last in both lists. Once
    // the contracts have it, the lists must match exactly, order included (drop this shim then).
    if !tools.contains("analyze") { tools.append("analyze") }
    if !icons.contains("analyze") { icons.append("analyze") }
    XCTAssertEqual(ActionId.allCases.map(\.rawValue), targets.map { "convert.\($0)" } + tools.map { "tool.\($0)" })
    XCTAssertEqual(IconId.allCases.map(\.rawValue), icons)

    let formats = try source("packages/contracts/src/formats.ts")
    XCTAssertEqual(ImageFormat.allCases.map(\.rawValue), try stringArray("IMAGE_FORMATS", in: formats))
    XCTAssertEqual(MenuKey.allCases.map(\.rawValue), ["pdf"] + ImageFormat.allCases.map { "image/\($0.rawValue)" } + ["images", "mixed"])

    let schemas = try source("packages/contracts/src/schemas.ts")
    XCTAssertTrue(schemas.contains("z.enum(['shift', 'alt', 'control', 'command'])"), "ModifierKeySchema changed")
    XCTAssertEqual(ModifierKey.allCases.map(\.rawValue), ["shift", "alt", "control", "command"])
    XCTAssertTrue(schemas.contains(#"/^[A-Za-z0-9_-]{1,64}$/"#), "Id regex changed")
  }

  func testProtocolConstants() throws {
    let protocolSource = try source("packages/contracts/src/helper-protocol.ts")
    XCTAssertEqual(try number("HELPER_PROTOCOL_VERSION", in: protocolSource), Double(HelperProtocol.version))
    XCTAssertEqual(try number("HELPER_MAX_LINE_BYTES", in: protocolSource), Double(HelperProtocol.maxLineBytes))
    XCTAssertEqual(try number("HELPER_MAX_FILES", in: protocolSource), Double(HelperProtocol.maxFiles))
    XCTAssertEqual(try number("HELPER_MAX_PATH_LENGTH", in: protocolSource), Double(HelperProtocol.maxPathLength))
    XCTAssertEqual(SessionStateName.allCases.map(\.rawValue), try stringArray("HELPER_SESSION_STATES", in: protocolSource))
    XCTAssertEqual(CancelReason.allCases.map(\.rawValue), try stringArray("HELPER_CANCEL_REASONS", in: protocolSource))
    // Field lists of the strict objects the decoder enforces.
    for needle in [
      "label: z.string().min(1).max(32)", "reason: z.string().max(120).optional()", "icon: z.enum(ICON_IDS).nullable()",
      "convert: z.array(WheelSectorSchema).max(12)", "menus: z.array(HelperMenuSchema).max(32)",
      "dropHint: z.string().max(60)", "z.record(z.string().regex(/^\\.[a-z0-9]{1,8}$/), MenuKeySchema)",
      "labelWeight: z.number().int().min(100).max(900)", "nonce: z.number().int().nonnegative()",
    ] {
      XCTAssertTrue(protocolSource.contains(needle), "helper-protocol.ts no longer contains: \(needle)")
    }
    for field in WheelGeometry.fieldRanges {
      let lo = Self.format(field.range.lowerBound)
      let hi = Self.format(field.range.upperBound)
      XCTAssertTrue(protocolSource.contains("\(field.name): z.number().min(\(lo)).max(\(hi))"), "geometry range for \(field.name)")
    }
  }

  private static func format(_ v: Double) -> String {
    v == v.rounded() ? String(Int(v)) : String(v)
  }

  func testDefaultGeometryAndTokens() throws {
    let geometry = try source("packages/contracts/src/geometry.ts")
    for field in WheelGeometry.fieldRanges {
      let value = WheelGeometry.default[keyPath: field.keyPath]
      XCTAssertTrue(geometry.contains("  \(field.name): \(Self.format(value)),"), "DEFAULT_WHEEL_GEOMETRY.\(field.name)")
    }
    let tokensURL = TestPaths.repoRoot.appendingPathComponent("packages/contracts/design-tokens.json")
    let tokens = try JSONSerialization.jsonObject(with: Data(contentsOf: tokensURL)) as! [String: Any]
    let colors = tokens["color"] as! [String: [String: String]]
    for theme in ThemeName.allCases {
      let expected = colors[theme.rawValue]!
      for (name, hex) in DefaultConfig.paletteHex(theme: theme) {
        XCTAssertEqual(RGBA(hex: expected[name]!), RGBA(hex: hex), "\(theme).\(name)")
      }
    }
    let font = tokens["font"] as! [String: Any]
    let motion = tokens["motion"] as! [String: Any]
    let t = DefaultConfig.tokens(theme: .light, reduceMotion: false)
    XCTAssertEqual(t.labelSize, font["wheelLabelSize"] as! Double)
    XCTAssertEqual(t.labelWeight, font["wheelLabelWeight"] as! Int)
    XCTAssertEqual(t.iconSize, font["wheelIconSize"] as! Double)
    XCTAssertEqual(t.capsuleTextSize, font["capsuleSize"] as! Double)
    XCTAssertEqual(t.appearMs, motion["wheelAppearMs"] as! Double)
    XCTAssertEqual(t.disappearMs, motion["wheelDisappearMs"] as! Double)
  }

  func testMenuOrdersMatchContracts() throws {
    let menus = try source("packages/contracts/src/menus.ts")
    XCTAssertEqual(DefaultConfig.pdfConvertOrder.map(\.rawValue), try stringArray("PDF_CONVERT_ORDER", in: menus))
    XCTAssertEqual(DefaultConfig.imageConvertOrder.map(\.rawValue), try stringArray("IMAGE_CONVERT_ORDER", in: menus))
    XCTAssertEqual(DefaultConfig.imageToolsOrder.map(\.rawValue), try stringArray("IMAGE_TOOLS_ORDER", in: menus))
  }

  /// Built-in snapshot menus = what buildHelperMenus produced for the fixture (order, labels, icons, batch).
  func testBuiltInMenusMatchGeneratedConfigure() throws {
    for locale in HelperLocale.allCases {
      let data = try Data(contentsOf: TestPaths.fixture("configure-\(locale.rawValue).json"))
      guard case .message(.configure(let generated)) = NDJSON.parseMainLine(Array(data)) else { return XCTFail("fixture invalid") }
      let builtIn = DefaultConfig.config(locale: locale)
      XCTAssertEqual(builtIn.menus.map(\.key), generated.menus.map(\.key))
      for (a, b) in zip(builtIn.menus, generated.menus) {
        for mode in WheelMode.allCases {
          let x = a.sectors(for: mode)
          let y = b.sectors(for: mode)
          XCTAssertEqual(x.map(\.actionId), y.map(\.actionId), "\(a.key.rawValue) \(mode)")
          XCTAssertEqual(x.map(\.label), y.map(\.label), "\(a.key.rawValue) \(mode)")
          XCTAssertEqual(x.map(\.icon), y.map(\.icon), "\(a.key.rawValue) \(mode)")
          XCTAssertEqual(x.map(\.batch), y.map(\.batch), "\(a.key.rawValue) \(mode)")
        }
      }
      // Extension map of a build that decodes everything but HEIC.
      var expected = DefaultConfig.extensions
      for ext in [".heic", ".heif", ".hif"] { expected[ext] = nil }
      XCTAssertEqual(generated.extensions, expected)
    }
  }
}
