import Foundation

/// main → helper (MainToHelperSchema). Decoding is strict: unknown types,
/// unknown fields, wrong field types, out-of-range values and unknown action ids
/// are rejected exactly like the zod schemas.
public enum MainToHelperMessage: Sendable, Equatable {
  case configure(HelperConfig)
  case cancelSession(sessionId: String)
  case ping(nonce: Int64)
  case shutdown
  case queryPermissions

  public var typeName: String {
    switch self {
    case .configure: return "configure"
    case .cancelSession: return "cancelSession"
    case .ping: return "ping"
    case .shutdown: return "shutdown"
    case .queryPermissions: return "queryPermissions"
    }
  }

  public static let knownTypes: Set<String> = ["configure", "cancelSession", "ping", "shutdown", "queryPermissions"]
}

/// Decodable wrapper used with JSONDecoder; all validation happens in `init(from:)`.
struct MainToHelperEnvelope: Decodable {
  let message: MainToHelperMessage

  init(from decoder: any Decoder) throws {
    // Discriminator first (like z.discriminatedUnion), then the strict object.
    let probe: KeyedDecodingContainer<AnyKey>
    do {
      probe = try decoder.container(keyedBy: AnyKey.self)
    } catch {
      throw ProtocolError.notAnObject
    }
    guard probe.contains(AnyKey("type")) else { throw ProtocolError.missingField("type") }
    let type: String
    do {
      type = try probe.decode(String.self, forKey: AnyKey("type"))
    } catch {
      throw ProtocolError.unknownType
    }
    guard MainToHelperMessage.knownTypes.contains(type) else { throw ProtocolError.unknownType }

    switch type {
    case "configure":
      let object = try StrictObject(decoder, path: "", allowed: [
        "v", "type", "enabled", "locale", "geometry", "tokens", "reduceMotion", "highContrast", "modifiers",
        "extensions", "menus", "strings",
      ])
      try Self.checkVersion(object)
      message = .configure(try Self.decodeConfigure(object))
    case "cancelSession":
      let object = try StrictObject(decoder, path: "", allowed: ["v", "type", "sessionId"])
      try Self.checkVersion(object)
      let id = try object.string("sessionId", maxLength: 64)
      guard Validation.isOpaqueId(id) else { throw ProtocolError.invalidValue("sessionId") }
      message = .cancelSession(sessionId: id)
    case "ping":
      let object = try StrictObject(decoder, path: "", allowed: ["v", "type", "nonce"])
      try Self.checkVersion(object)
      message = .ping(nonce: try object.integer("nonce", in: 0...HelperProtocol.maxSafeInteger))
    case "shutdown":
      let object = try StrictObject(decoder, path: "", allowed: ["v", "type"])
      try Self.checkVersion(object)
      message = .shutdown
    default:  // "queryPermissions"
      let object = try StrictObject(decoder, path: "", allowed: ["v", "type"])
      try Self.checkVersion(object)
      message = .queryPermissions
    }
  }

  private static func checkVersion(_ object: StrictObject) throws {
    guard object.has("v") else { throw ProtocolError.missingField("v") }
    let v: Double
    do {
      v = try object.number("v")
    } catch {
      throw ProtocolError.unsupportedVersion
    }
    guard v == Double(HelperProtocol.version) else { throw ProtocolError.unsupportedVersion }
  }

  private static func decodeConfigure(_ object: StrictObject) throws -> HelperConfig {
    let enabled = try object.bool("enabled")
    let locale = try object.enumValue("locale", HelperLocale.self)
    let geometry = try decodeGeometry(object.object("geometry", allowed: Set(WheelGeometry.fieldRanges.map(\.name))))
    let tokens = try decodeTokens(object.object(
      "tokens",
      allowed: Set(WheelTokens.colorFields.map(\.name) + WheelTokens.numberFields.map(\.name) + ["labelWeight"])
    ))
    let reduceMotion = try object.bool("reduceMotion")
    let highContrast = try object.bool("highContrast")
    let modifiers = try object.object("modifiers", allowed: ["convert", "tools"])
    let convert = try decodeCombo(modifiers, "convert")
    let tools = try decodeCombo(modifiers, "tools")

    var extensions: [String: MenuKey] = [:]
    for (ext, raw) in try object.record("extensions") {
      guard Validation.isExtensionKey(ext) else { throw ProtocolError.invalidValue("extensions") }
      guard let key = MenuKey(rawValue: raw) else { throw ProtocolError.invalidValue("extensions.\(ext)") }
      extensions[ext] = key
    }

    let menus = try object.array("menus", maxCount: HelperProtocol.maxMenus) { decoder, path in
      let menu = try StrictObject(decoder, path: path, allowed: ["key", "convert", "tools"])
      return HelperMenu(
        key: try menu.menuKey("key"),
        convert: try decodeSectors(menu, "convert"),
        tools: try decodeSectors(menu, "tools")
      )
    }

    let strings = try object.object("strings", allowed: ["dropHint", "unsupported", "multiFileUnsupported", "fileCount"])
    return HelperConfig(
      enabled: enabled,
      locale: locale,
      geometry: geometry,
      tokens: tokens,
      reduceMotion: reduceMotion,
      highContrast: highContrast,
      convertModifiers: convert,
      toolsModifiers: tools,
      extensions: extensions,
      menus: menus,
      strings: HelperStrings(
        dropHint: try strings.string("dropHint", maxLength: 60),
        unsupported: try strings.string("unsupported", maxLength: 60),
        multiFileUnsupported: try strings.string("multiFileUnsupported", maxLength: 60),
        fileCount: try strings.string("fileCount", maxLength: 60)
      )
    )
  }

  private static func decodeGeometry(_ object: StrictObject) throws -> WheelGeometry {
    var geometry = WheelGeometry.default
    for field in WheelGeometry.fieldRanges {
      geometry[keyPath: field.keyPath] = try object.number(field.name, in: field.range)
    }
    return geometry
  }

  private static func decodeTokens(_ object: StrictObject) throws -> WheelTokens {
    var tokens = DefaultConfig.tokens(theme: .light, reduceMotion: false)
    for field in WheelTokens.colorFields {
      let hex = try object.string(field.name, maxLength: 9)
      guard let color = RGBA(hex: hex) else { throw ProtocolError.invalidValue(object.fieldPath(field.name)) }
      tokens[keyPath: field.keyPath] = color
    }
    for field in WheelTokens.numberFields {
      tokens[keyPath: field.keyPath] = try object.number(field.name, in: field.range)
    }
    tokens.labelWeight = Int(try object.integer("labelWeight", in: 100...900))
    return tokens
  }

  private static func decodeCombo(_ object: StrictObject, _ key: String) throws -> ModifierCombo {
    let keys = try object.array(key, minCount: 1, maxCount: 3) { decoder, path -> ModifierKey in
      let raw = try decodeElement(decoder, path, String.self)
      guard let modifier = ModifierKey(rawValue: raw) else { throw ProtocolError.invalidValue(path) }
      return modifier
    }
    guard Set(keys).count == keys.count else { throw ProtocolError.invalidValue(object.fieldPath(key)) }
    return ModifierCombo(keys)
  }

  private static func decodeSectors(_ menu: StrictObject, _ key: String) throws -> [WheelSector] {
    try menu.array(key, maxCount: HelperProtocol.maxSectorsPerMenu) { decoder, path in
      let sector = try StrictObject(decoder, path: path, allowed: ["actionId", "label", "icon", "enabled", "reason", "batch"])
      return WheelSector(
        actionId: try sector.enumValue("actionId", ActionId.self),
        label: try sector.string("label", minLength: 1, maxLength: 32),
        icon: try sector.nullableEnum("icon", IconId.self),
        enabled: try sector.bool("enabled"),
        reason: try sector.optionalString("reason", maxLength: 120),
        batch: try sector.bool("batch")
      )
    }
  }
}
