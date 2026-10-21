// Configuration model received from main in the `configure` message
// (HelperConfigureSchema in packages/contracts/src/helper-protocol.ts).
import Foundation

/// A point in OrbitDrop global DIP space (top-left origin, y down) unless noted.
public struct Point: Sendable, Equatable, Hashable, Codable, CustomStringConvertible {
  public var x: Double
  public var y: Double
  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
  public static let zero = Point(x: 0, y: 0)
  public var description: String { "(\(x), \(y))" }
}

public struct Size: Sendable, Equatable, Hashable, Codable {
  public var width: Double
  public var height: Double
  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }
}

/// Rectangle with origin at its top-left corner in DIP space (or bottom-left in AppKit space).
public struct Rect: Sendable, Equatable, Hashable, Codable, CustomStringConvertible {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double
  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
  public var maxX: Double { x + width }
  public var maxY: Double { y + height }
  public var center: Point { Point(x: x + width / 2, y: y + height / 2) }
  public var description: String { "{\(x), \(y), \(width)×\(height)}" }
}

/// `WheelGeometry` (packages/contracts/src/geometry.ts).
public struct WheelGeometry: Sendable, Equatable, Codable {
  public var diameter: Double
  public var minDiameter: Double
  public var ringWidth: Double
  public var ringInset: Double
  public var innerRadiusRatio: Double
  public var sectorGap: Double
  public var sectorCornerRadius: Double
  public var capsuleWidth: Double
  public var capsuleHeight: Double
  public var startAngleDeg: Double
  public var windowMargin: Double
  public var edgePadding: Double
  public var armDistance: Double

  public init(
    diameter: Double, minDiameter: Double, ringWidth: Double, ringInset: Double, innerRadiusRatio: Double,
    sectorGap: Double, sectorCornerRadius: Double, capsuleWidth: Double, capsuleHeight: Double,
    startAngleDeg: Double, windowMargin: Double, edgePadding: Double, armDistance: Double
  ) {
    self.diameter = diameter
    self.minDiameter = minDiameter
    self.ringWidth = ringWidth
    self.ringInset = ringInset
    self.innerRadiusRatio = innerRadiusRatio
    self.sectorGap = sectorGap
    self.sectorCornerRadius = sectorCornerRadius
    self.capsuleWidth = capsuleWidth
    self.capsuleHeight = capsuleHeight
    self.startAngleDeg = startAngleDeg
    self.windowMargin = windowMargin
    self.edgePadding = edgePadding
    self.armDistance = armDistance
  }

  /// DEFAULT_WHEEL_GEOMETRY.
  public static let `default` = WheelGeometry(
    diameter: 360, minDiameter: 240, ringWidth: 1.5, ringInset: 8, innerRadiusRatio: 0.36, sectorGap: 6,
    sectorCornerRadius: 14, capsuleWidth: 104, capsuleHeight: 46, startAngleDeg: -90, windowMargin: 24,
    edgePadding: 8, armDistance: 6
  )

  /// Field names and inclusive ranges from WheelGeometrySchema, in declaration order.
  public static let fieldRanges: [(name: String, range: ClosedRange<Double>, keyPath: WritableKeyPath<WheelGeometry, Double> & Sendable)] = [
    ("diameter", 200...600, \.diameter),
    ("minDiameter", 160...600, \.minDiameter),
    ("ringWidth", 0...8, \.ringWidth),
    ("ringInset", 0...40, \.ringInset),
    ("innerRadiusRatio", 0.15...0.6, \.innerRadiusRatio),
    ("sectorGap", 0...24, \.sectorGap),
    ("sectorCornerRadius", 0...40, \.sectorCornerRadius),
    ("capsuleWidth", 40...200, \.capsuleWidth),
    ("capsuleHeight", 20...100, \.capsuleHeight),
    ("startAngleDeg", -360...360, \.startAngleDeg),
    ("windowMargin", 0...80, \.windowMargin),
    ("edgePadding", 0...80, \.edgePadding),
    ("armDistance", 0...40, \.armDistance),
  ]
}

/// sRGB color with straight (non-premultiplied) alpha, components 0…1.
public struct RGBA: Sendable, Equatable, Hashable {
  public var r: Double
  public var g: Double
  public var b: Double
  public var a: Double
  public init(r: Double, g: Double, b: Double, a: Double = 1) {
    self.r = r
    self.g = g
    self.b = b
    self.a = a
  }

  /// Parses `#RRGGBB` or `#RRGGBBAA` (the ColorHex8 schema).
  public init?(hex: String) {
    let utf8 = Array(hex.utf8)
    guard utf8.count == 7 || utf8.count == 9, utf8[0] == UInt8(ascii: "#") else { return nil }
    var bytes: [Double] = []
    var index = 1
    while index < utf8.count {
      guard let hi = RGBA.hexValue(utf8[index]), let lo = RGBA.hexValue(utf8[index + 1]) else { return nil }
      bytes.append(Double(hi * 16 + lo) / 255)
      index += 2
    }
    self.init(r: bytes[0], g: bytes[1], b: bytes[2], a: bytes.count == 4 ? bytes[3] : 1)
  }

  private static func hexValue(_ c: UInt8) -> Int? {
    switch c {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): return Int(c - UInt8(ascii: "0"))
    case UInt8(ascii: "a")...UInt8(ascii: "f"): return Int(c - UInt8(ascii: "a")) + 10
    case UInt8(ascii: "A")...UInt8(ascii: "F"): return Int(c - UInt8(ascii: "A")) + 10
    default: return nil
    }
  }

  public func withAlpha(_ alpha: Double) -> RGBA { RGBA(r: r, g: g, b: b, a: alpha) }

  /// Mix towards `other` by `t` (0 = self, 1 = other), including alpha.
  public func mixed(with other: RGBA, _ t: Double) -> RGBA {
    RGBA(r: r + (other.r - r) * t, g: g + (other.g - g) * t, b: b + (other.b - b) * t, a: a + (other.a - a) * t)
  }
}

/// `WheelTokens` (WheelTokensSchema): colors plus type/motion values.
public struct WheelTokens: Sendable, Equatable {
  public var wheelDisc: RGBA
  public var wheelRing: RGBA
  public var wheelShadow: RGBA
  public var sector: RGBA
  public var sectorHover: RGBA
  public var sectorText: RGBA
  public var sectorIcon: RGBA
  public var sectorDisabled: RGBA
  public var sectorDisabledText: RGBA
  public var sectorActive: RGBA
  public var sectorActiveText: RGBA
  public var capsule: RGBA
  public var capsuleText: RGBA
  public var capsuleReject: RGBA
  public var labelSize: Double
  public var labelWeight: Int
  public var iconSize: Double
  public var capsuleTextSize: Double
  public var appearMs: Double
  public var disappearMs: Double

  public static let colorFields: [(name: String, keyPath: WritableKeyPath<WheelTokens, RGBA> & Sendable)] = [
    ("wheelDisc", \.wheelDisc), ("wheelRing", \.wheelRing), ("wheelShadow", \.wheelShadow), ("sector", \.sector),
    ("sectorHover", \.sectorHover), ("sectorText", \.sectorText), ("sectorIcon", \.sectorIcon),
    ("sectorDisabled", \.sectorDisabled), ("sectorDisabledText", \.sectorDisabledText),
    ("sectorActive", \.sectorActive), ("sectorActiveText", \.sectorActiveText), ("capsule", \.capsule),
    ("capsuleText", \.capsuleText), ("capsuleReject", \.capsuleReject),
  ]

  public static let numberFields: [(name: String, range: ClosedRange<Double>, keyPath: WritableKeyPath<WheelTokens, Double> & Sendable)] = [
    ("labelSize", 8...32, \.labelSize), ("iconSize", 8...48, \.iconSize), ("capsuleTextSize", 8...32, \.capsuleTextSize),
    ("appearMs", 0...1000, \.appearMs), ("disappearMs", 0...1000, \.disappearMs),
  ]

  public init(
    wheelDisc: RGBA, wheelRing: RGBA, wheelShadow: RGBA, sector: RGBA, sectorHover: RGBA, sectorText: RGBA,
    sectorIcon: RGBA, sectorDisabled: RGBA, sectorDisabledText: RGBA, sectorActive: RGBA, sectorActiveText: RGBA,
    capsule: RGBA, capsuleText: RGBA, capsuleReject: RGBA, labelSize: Double, labelWeight: Int, iconSize: Double,
    capsuleTextSize: Double, appearMs: Double, disappearMs: Double
  ) {
    self.wheelDisc = wheelDisc
    self.wheelRing = wheelRing
    self.wheelShadow = wheelShadow
    self.sector = sector
    self.sectorHover = sectorHover
    self.sectorText = sectorText
    self.sectorIcon = sectorIcon
    self.sectorDisabled = sectorDisabled
    self.sectorDisabledText = sectorDisabledText
    self.sectorActive = sectorActive
    self.sectorActiveText = sectorActiveText
    self.capsule = capsule
    self.capsuleText = capsuleText
    self.capsuleReject = capsuleReject
    self.labelSize = labelSize
    self.labelWeight = labelWeight
    self.iconSize = iconSize
    self.capsuleTextSize = capsuleTextSize
    self.appearMs = appearMs
    self.disappearMs = disappearMs
  }
}

/// One slice of the wheel (WheelSectorSchema / WheelSector in menus.ts).
public struct WheelSector: Sendable, Equatable {
  public var actionId: ActionId
  public var label: String
  public var icon: IconId?
  public var enabled: Bool
  public var reason: String?
  public var batch: Bool

  public init(actionId: ActionId, label: String, icon: IconId?, enabled: Bool, reason: String? = nil, batch: Bool) {
    self.actionId = actionId
    self.label = label
    self.icon = icon
    self.enabled = enabled
    self.reason = reason
    self.batch = batch
  }
}

/// HelperMenuSchema: the convert and tools sectors for one menu key.
public struct HelperMenu: Sendable, Equatable {
  public var key: MenuKey
  public var convert: [WheelSector]
  public var tools: [WheelSector]

  public init(key: MenuKey, convert: [WheelSector], tools: [WheelSector]) {
    self.key = key
    self.convert = convert
    self.tools = tools
  }

  public func sectors(for mode: WheelMode) -> [WheelSector] {
    mode == .convert ? convert : tools
  }
}

/// Why a drag cannot be accepted (selects the specific `strings.unsupported*` text).
public enum UnsupportedReason: String, Sendable, Equatable, CaseIterable {
  /// A folder (or package) among the items.
  case folder
  /// Text, web URLs, image data… — no file at all.
  case nonFile
  /// Items without a file on disk yet: file promises (Photos, Mail attachments, …).
  case virtual
  /// Files of a type this build cannot read, relative/over-long paths.
  case unknownType
  /// More than HelperProtocol.maxFiles items.
  case tooMany
}

/// `configure.strings`.
public struct HelperStrings: Sendable, Equatable {
  public var dropHint: String
  public var unsupported: String
  public var multiFileUnsupported: String
  public var fileCount: String
  /// Optional specific texts (helper-protocol.ts); `unsupported` is used when absent.
  public var unsupportedFolder: String?
  public var unsupportedNonFile: String?
  public var unsupportedVirtual: String?

  public init(
    dropHint: String, unsupported: String, multiFileUnsupported: String, fileCount: String,
    unsupportedFolder: String? = nil, unsupportedNonFile: String? = nil, unsupportedVirtual: String? = nil
  ) {
    self.dropHint = dropHint
    self.unsupported = unsupported
    self.multiFileUnsupported = multiFileUnsupported
    self.fileCount = fileCount
    self.unsupportedFolder = unsupportedFolder
    self.unsupportedNonFile = unsupportedNonFile
    self.unsupportedVirtual = unsupportedVirtual
  }

  /// Center text for an unsupported drag: the specific string when main sent one, else `unsupported`.
  public func unsupportedText(_ reason: UnsupportedReason?) -> String {
    let specific: String?
    switch reason {
    case .folder?: specific = unsupportedFolder
    case .nonFile?: specific = unsupportedNonFile
    case .virtual?: specific = unsupportedVirtual
    case .unknownType?, .tooMany?, nil: specific = nil
    }
    if let specific, !specific.isEmpty { return specific }
    return unsupported
  }

  /// "{n} files" with every `{n}` replaced by the count.
  public func fileCountText(_ count: Int) -> String {
    fileCount.replacingOccurrences(of: "{n}", with: String(count))
  }
}

/// A modifier combination ('alt' = Option). Order does not matter; duplicates are rejected by the decoder.
public struct ModifierCombo: Sendable, Equatable, Hashable {
  public var keys: Set<ModifierKey>
  public init(_ keys: Set<ModifierKey>) { self.keys = keys }
  public init(_ keys: [ModifierKey]) { self.keys = Set(keys) }

  /// Exact match against the currently held modifiers (other flags such as Caps Lock are not part of the set).
  public func matches(_ held: Set<ModifierKey>) -> Bool { held == keys }

  public var sortedKeys: [ModifierKey] { keys.sorted() }
}

/// The whole `configure` message.
public struct HelperConfig: Sendable, Equatable {
  public var enabled: Bool
  public var locale: HelperLocale
  public var geometry: WheelGeometry
  public var tokens: WheelTokens
  public var reduceMotion: Bool
  public var highContrast: Bool
  public var convertModifiers: ModifierCombo
  public var toolsModifiers: ModifierCombo
  /// Lower-case extension including the dot → single-file menu key.
  public var extensions: [String: MenuKey]
  /// Menus in the order received; `menu(for:)` returns the first entry for a key.
  public var menus: [HelperMenu]
  public var strings: HelperStrings

  public init(
    enabled: Bool, locale: HelperLocale, geometry: WheelGeometry, tokens: WheelTokens, reduceMotion: Bool,
    highContrast: Bool, convertModifiers: ModifierCombo, toolsModifiers: ModifierCombo,
    extensions: [String: MenuKey], menus: [HelperMenu], strings: HelperStrings
  ) {
    self.enabled = enabled
    self.locale = locale
    self.geometry = geometry
    self.tokens = tokens
    self.reduceMotion = reduceMotion
    self.highContrast = highContrast
    self.convertModifiers = convertModifiers
    self.toolsModifiers = toolsModifiers
    self.extensions = extensions
    self.menus = menus
    self.strings = strings
  }

  public func menu(for key: MenuKey) -> HelperMenu? {
    menus.first { $0.key == key }
  }

  /// The wheel mode whose combo exactly equals the held modifiers (convert wins if both are equal).
  public func mode(forHeld held: Set<ModifierKey>) -> WheelMode? {
    if convertModifiers.matches(held) { return .convert }
    if toolsModifiers.matches(held) { return .tools }
    return nil
  }
}
