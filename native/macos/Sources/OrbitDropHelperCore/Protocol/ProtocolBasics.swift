import Foundation

/// Constants from packages/contracts/src/helper-protocol.ts.
public enum HelperProtocol {
  public static let version = 1
  /// Receivers reject lines longer than this many UTF-8 bytes (excluding the newline).
  public static let maxLineBytes = 1_048_576
  public static let maxFiles = 200
  /// HELPER_MAX_PATH_LENGTH. Like every zod string limit it is measured in Unicode
  /// code points (zod 4 counts a surrogate pair once), i.e. `unicodeScalars.count`.
  public static let maxPathLength = 32_767
  public static let maxSectorsPerMenu = 12
  public static let maxMenus = 32
  public static let maxFileCount = 100_000
  /// Largest integer a JS number represents exactly (zod 4 `.int()` = safe integer).
  public static let maxSafeInteger: Double = 9_007_199_254_740_991
}

/// Static facts about this helper build.
public enum HelperInfo {
  public static let version = "1.0.0"
  public static let platform = "darwin"
  #if arch(arm64)
    public static let arch = "arm64"
  #elseif arch(x86_64)
    public static let arch = "x64"
  #else
    public static let arch = "unknown"
  #endif
}

/// Why an incoming line was rejected. Descriptions name fields, never values
/// (values may contain file paths), so they are safe to log.
public enum ProtocolError: Error, Equatable, Sendable, CustomStringConvertible {
  case lineTooLong(bytes: Int)
  case invalidUTF8
  case invalidJSON
  case notAnObject
  case missingField(String)
  case unknownField(String)
  case wrongType(String)
  case outOfRange(String)
  case invalidValue(String)
  case unknownType
  case unsupportedVersion
  /// An object repeats a member name (JSON.stringify never does that).
  case duplicateKey
  /// Outgoing message would exceed HelperProtocol.maxLineBytes.
  case messageTooLarge(bytes: Int)

  public var description: String {
    switch self {
    case .lineTooLong(let bytes): return "line too long (\(bytes) bytes)"
    case .invalidUTF8: return "line is not valid UTF-8"
    case .invalidJSON: return "line is not valid JSON"
    case .notAnObject: return "message is not a JSON object"
    case .missingField(let path): return "missing field \(path)"
    case .unknownField(let path): return "unknown field \(path)"
    case .wrongType(let path): return "wrong type for \(path)"
    case .outOfRange(let path): return "value out of range for \(path)"
    case .invalidValue(let path): return "invalid value for \(path)"
    case .unknownType: return "unknown message type"
    case .unsupportedVersion: return "unsupported protocol version"
    case .duplicateKey: return "duplicate member name"
    case .messageTooLarge(let bytes): return "outgoing message too large (\(bytes) bytes)"
    }
  }
}

/// Coding key for arbitrary member names (used to detect unknown fields).
struct AnyKey: CodingKey, Hashable {
  let stringValue: String
  let intValue: Int?
  init(_ string: String) {
    stringValue = string
    intValue = nil
  }
  init?(stringValue: String) { self.init(stringValue) }
  init?(intValue: Int) {
    stringValue = String(intValue)
    self.intValue = intValue
  }
}

/// A JSON object read with zod `strictObject` semantics: unknown members are
/// rejected, optional members may be absent but never `null`, numbers must be
/// finite, string lengths are Unicode code points (zod 4's `.min()/.max()`).
struct StrictObject {
  let container: KeyedDecodingContainer<AnyKey>
  let path: String

  init(_ decoder: any Decoder, path: String, allowed: Set<String>) throws {
    self.path = path
    do {
      container = try decoder.container(keyedBy: AnyKey.self)
    } catch {
      throw path.isEmpty ? ProtocolError.notAnObject : ProtocolError.wrongType(path)
    }
    // Deterministic error for several unknown keys.
    if let unknown = container.allKeys.map(\.stringValue).filter({ !allowed.contains($0) }).sorted().first {
      throw ProtocolError.unknownField(fieldPath(unknown))
    }
  }

  func fieldPath(_ key: String) -> String {
    path.isEmpty ? key : "\(path).\(key)"
  }

  func has(_ key: String) -> Bool { container.contains(AnyKey(key)) }

  private func requirePresent(_ key: String) throws {
    guard has(key) else { throw ProtocolError.missingField(fieldPath(key)) }
  }

  private func isNull(_ key: String) throws -> Bool {
    do { return try container.decodeNil(forKey: AnyKey(key)) } catch { return false }
  }

  private func decodeValue<T: Decodable>(_ type: T.Type, _ key: String) throws -> T {
    try requirePresent(key)
    do {
      return try container.decode(T.self, forKey: AnyKey(key))
    } catch let error as ProtocolError {
      throw error
    } catch {
      throw ProtocolError.wrongType(fieldPath(key))
    }
  }

  func bool(_ key: String) throws -> Bool {
    try decodeValue(Bool.self, key)
  }

  func number(_ key: String, in range: ClosedRange<Double>? = nil) throws -> Double {
    let value = try decodeValue(Double.self, key)
    guard value.isFinite else { throw ProtocolError.wrongType(fieldPath(key)) }
    if let range, !range.contains(value) { throw ProtocolError.outOfRange(fieldPath(key)) }
    return value
  }

  /// zod `z.number().int()` (safe integer) with an optional inclusive range.
  func integer(_ key: String, in range: ClosedRange<Double>) throws -> Int64 {
    let value = try number(key)
    guard value.rounded(.towardZero) == value, value.magnitude <= HelperProtocol.maxSafeInteger else {
      throw ProtocolError.wrongType(fieldPath(key))
    }
    guard range.contains(value) else { throw ProtocolError.outOfRange(fieldPath(key)) }
    return Int64(value)
  }

  func string(_ key: String, minLength: Int = 0, maxLength: Int) throws -> String {
    let value = try decodeValue(String.self, key)
    let length = value.unicodeScalars.count
    guard length >= minLength, length <= maxLength else { throw ProtocolError.outOfRange(fieldPath(key)) }
    return value
  }

  /// zod `.optional()`: absent → nil; present must be a string (null is rejected).
  func optionalString(_ key: String, maxLength: Int) throws -> String? {
    guard has(key) else { return nil }
    if try isNull(key) { throw ProtocolError.wrongType(fieldPath(key)) }
    return try string(key, maxLength: maxLength)
  }

  /// zod `z.enum(...)` over a String raw-value type.
  func enumValue<E: RawRepresentable>(_ key: String, _ type: E.Type) throws -> E where E.RawValue == String {
    let raw = try decodeValue(String.self, key)
    guard let value = E(rawValue: raw) else { throw ProtocolError.invalidValue(fieldPath(key)) }
    return value
  }

  /// zod `z.enum(...).nullable()` — the key is required, `null` allowed.
  func nullableEnum<E: RawRepresentable>(_ key: String, _ type: E.Type) throws -> E? where E.RawValue == String {
    try requirePresent(key)
    if try isNull(key) { return nil }
    return try enumValue(key, type)
  }

  func menuKey(_ key: String) throws -> MenuKey {
    let raw = try decodeValue(String.self, key)
    guard let value = MenuKey(rawValue: raw) else { throw ProtocolError.invalidValue(fieldPath(key)) }
    return value
  }

  /// Decoder positioned on a nested value (object/array) at `key`.
  func nested(_ key: String) throws -> any Decoder {
    try requirePresent(key)
    if try isNull(key) { throw ProtocolError.wrongType(fieldPath(key)) }
    do {
      return try container.superDecoder(forKey: AnyKey(key))
    } catch {
      throw ProtocolError.wrongType(fieldPath(key))
    }
  }

  func object(_ key: String, allowed: Set<String>) throws -> StrictObject {
    try StrictObject(nested(key), path: fieldPath(key), allowed: allowed)
  }

  /// Array of elements decoded with `element`, at most `maxCount` long.
  func array<T>(_ key: String, minCount: Int = 0, maxCount: Int, element: (any Decoder, String) throws -> T) throws -> [T] {
    let elementPath = fieldPath(key)
    var unkeyed: any UnkeyedDecodingContainer
    do {
      try requirePresent(key)
      unkeyed = try container.nestedUnkeyedContainer(forKey: AnyKey(key))
    } catch let error as ProtocolError {
      throw error
    } catch {
      throw ProtocolError.wrongType(elementPath)
    }
    if let count = unkeyed.count, count > maxCount || count < minCount { throw ProtocolError.outOfRange(elementPath) }
    var result: [T] = []
    var index = 0
    while !unkeyed.isAtEnd {
      guard result.count < maxCount else { throw ProtocolError.outOfRange(elementPath) }
      let decoder: any Decoder
      do {
        decoder = try unkeyed.superDecoder()
      } catch {
        throw ProtocolError.wrongType("\(elementPath)[\(index)]")
      }
      result.append(try element(decoder, "\(elementPath)[\(index)]"))
      index += 1
    }
    guard result.count >= minCount else { throw ProtocolError.outOfRange(elementPath) }
    return result
  }

  /// zod `z.record(keySchema, valueSchema)` with string values: returns (key, rawValue) pairs.
  func record(_ key: String) throws -> [(String, String)] {
    let recordPath = fieldPath(key)
    let nestedContainer: KeyedDecodingContainer<AnyKey>
    do {
      try requirePresent(key)
      nestedContainer = try container.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey(key))
    } catch let error as ProtocolError {
      throw error
    } catch {
      throw ProtocolError.wrongType(recordPath)
    }
    var pairs: [(String, String)] = []
    for member in nestedContainer.allKeys.sorted(by: { $0.stringValue < $1.stringValue }) {
      do {
        pairs.append((member.stringValue, try nestedContainer.decode(String.self, forKey: member)))
      } catch {
        throw ProtocolError.wrongType("\(recordPath).\(member.stringValue)")
      }
    }
    return pairs
  }
}

/// Element decoder helper: a primitive array element.
func decodeElement<T: Decodable>(_ decoder: any Decoder, _ path: String, _ type: T.Type) throws -> T {
  do {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { throw ProtocolError.wrongType(path) }
    return try container.decode(T.self)
  } catch let error as ProtocolError {
    throw error
  } catch {
    throw ProtocolError.wrongType(path)
  }
}

enum Validation {
  /// `Id` from schemas.ts: ^[A-Za-z0-9_-]{1,64}$.
  static func isOpaqueId(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard (1...64).contains(bytes.count) else { return false }
    return bytes.allSatisfy { b in
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == 0x5F || b == 0x2D
    }
  }

  /// ColorHex8 from helper-protocol.ts: ^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$.
  static func isHexColor(_ value: String) -> Bool {
    RGBA(hex: value) != nil
  }

  /// Extension map key: ^\.[a-z0-9]{1,8}$.
  static func isExtensionKey(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count >= 2, bytes.count <= 9, bytes[0] == 0x2E else { return false }
    return bytes.dropFirst().allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x7A) }
  }

  /// zod string length: Unicode code points.
  static func length(_ value: String) -> Int { value.unicodeScalars.count }

  /// Truncate to at most `maxLength` code points without splitting a character.
  static func truncated(_ value: String, maxLength: Int) -> String {
    if length(value) <= maxLength { return value }
    var result = ""
    var used = 0
    for character in value {
      let scalars = character.unicodeScalars.count
      if used + scalars > maxLength { break }
      result.append(character)
      used += scalars
    }
    return result
  }
}
