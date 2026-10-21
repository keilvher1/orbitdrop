// Closed vocabularies mirrored from packages/contracts (actions.ts, formats.ts,
// menus.ts, schemas.ts, helper-protocol.ts). ContractDriftTests re-reads the
// TypeScript sources and fails when these lists drift apart.

/// `ActionId` from packages/contracts/src/actions.ts (CONVERT_TARGETS then TOOL_NAMES).
public enum ActionId: String, CaseIterable, Sendable, Codable, Hashable {
  case convertJpeg = "convert.jpeg"
  case convertPng = "convert.png"
  case convertWebp = "convert.webp"
  case convertHeic = "convert.heic"
  case convertTiff = "convert.tiff"
  case convertAvif = "convert.avif"
  case convertBmp = "convert.bmp"
  case convertPdf = "convert.pdf"
  case convertDocx = "convert.docx"
  case convertTxt = "convert.txt"
  case toolCompress = "tool.compress"
  case toolMetadata = "tool.metadata"
  case toolEdit = "tool.edit"
  case toolAnnotate = "tool.annotate"
  case toolAddBackground = "tool.addBackground"
  case toolCrop = "tool.crop"
  case toolRedact = "tool.redact"
}

/// `IconId` (ICON_IDS) — macOS maps these to SF Symbols.
public enum IconId: String, CaseIterable, Sendable, Codable, Hashable {
  case compress, metadata, edit, annotate, background, crop, redact
}

/// `ImageFormat` (IMAGE_FORMATS), in contract order.
public enum ImageFormat: String, CaseIterable, Sendable, Codable, Hashable {
  case jpeg, png, webp, gif, tiff, avif, heic, bmp

  /// Short label used on sectors/capsules ("JPG" for jpeg), FORMAT_INFO[...].label.
  public var label: String {
    switch self {
    case .jpeg: return "JPG"
    case .png: return "PNG"
    case .webp: return "WEBP"
    case .gif: return "GIF"
    case .tiff: return "TIFF"
    case .avif: return "AVIF"
    case .heic: return "HEIC"
    case .bmp: return "BMP"
    }
  }
}

/// `MenuKey` (MENU_KEYS): 'pdf', 'image/<fmt>' for every image format, 'images', 'mixed'.
public enum MenuKey: Hashable, Sendable, CaseIterable, Codable {
  case pdf
  case image(ImageFormat)
  case images
  case mixed

  public static let allCases: [MenuKey] = [.pdf] + ImageFormat.allCases.map { .image($0) } + [.images, .mixed]

  public init?(rawValue: String) {
    switch rawValue {
    case "pdf": self = .pdf
    case "images": self = .images
    case "mixed": self = .mixed
    default:
      guard rawValue.hasPrefix("image/"), let format = ImageFormat(rawValue: String(rawValue.dropFirst("image/".count))) else {
        return nil
      }
      self = .image(format)
    }
  }

  public var rawValue: String {
    switch self {
    case .pdf: return "pdf"
    case .image(let format): return "image/\(format.rawValue)"
    case .images: return "images"
    case .mixed: return "mixed"
    }
  }

  /// True for keys an extension map entry may name (one file of one type).
  public var isSingleFileKey: Bool {
    switch self {
    case .pdf, .image: return true
    case .images, .mixed: return false
    }
  }

  /// Label of the input type, e.g. "PDF" or "JPG" (nil for multi-type keys).
  public var inputLabel: String? {
    switch self {
    case .pdf: return "PDF"
    case .image(let format): return format.label
    case .images, .mixed: return nil
    }
  }

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    guard let key = MenuKey(rawValue: value) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "unknown menu key"))
    }
    self = key
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

/// `WheelMode` (WHEEL_MODES).
public enum WheelMode: String, CaseIterable, Sendable, Codable, Hashable {
  case convert, tools
}

/// `Locale` (LOCALES). Korean is the default UI language.
public enum HelperLocale: String, CaseIterable, Sendable, Codable, Hashable {
  case ko, en
}

/// `ModifierKey` (ModifierKeySchema). 'alt' is Option on macOS.
public enum ModifierKey: String, CaseIterable, Sendable, Codable, Hashable, Comparable {
  case shift, alt, control, command

  public static func < (lhs: ModifierKey, rhs: ModifierKey) -> Bool {
    allCases.firstIndex(of: lhs)! < allCases.firstIndex(of: rhs)!
  }
}

/// HELPER_CANCEL_REASONS.
public enum CancelReason: String, CaseIterable, Sendable, Codable, Hashable {
  case escape, dragEnded, invalidPayload, outsideRing, disabledSector, parentRequest, sleep, permissionLost, error
}

/// HELPER_SESSION_STATES.
public enum SessionStateName: String, CaseIterable, Sendable, Codable, Hashable {
  case potentialDrag = "PotentialDrag"
  case awaitingPayload = "AwaitingPayload"
  case wheelActive = "WheelActive"
  case idle = "Idle"
}

public enum LogLevel: String, CaseIterable, Sendable, Codable, Hashable {
  case debug, info, warn, error
}

public enum PermissionName: String, CaseIterable, Sendable, Codable, Hashable {
  case accessibility, inputMonitoring
}
