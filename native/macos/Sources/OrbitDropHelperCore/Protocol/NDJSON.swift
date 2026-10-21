import Foundation

/// Splits a byte stream into "\n"-terminated lines with a hard per-line limit.
/// A line longer than `maxLineBytes` (excluding the newline) is dropped as a
/// whole — bytes are discarded up to the next newline, never buffered — and
/// reported as `.oversized`, so a runaway writer cannot exhaust memory.
public struct LineFramer: Sendable {
  public enum Event: Sendable, Equatable {
    case line([UInt8])
    case oversized(bytes: Int)
  }

  public let maxLineBytes: Int
  private var buffer: [UInt8] = []
  private var discarding = false
  private var discardedBytes = 0

  public init(maxLineBytes: Int = HelperProtocol.maxLineBytes) {
    self.maxLineBytes = maxLineBytes
  }

  /// Feed bytes; returns the complete lines (without "\n") found so far.
  public mutating func push<C: Collection>(_ bytes: C) -> [Event] where C.Element == UInt8 {
    var events: [Event] = []
    var chunk = bytes[...]
    while !chunk.isEmpty {
      if let newline = chunk.firstIndex(of: 0x0A) {
        let part = chunk[chunk.startIndex..<newline]
        if discarding {
          events.append(.oversized(bytes: discardedBytes + part.count))
          discarding = false
          discardedBytes = 0
        } else if buffer.count + part.count > maxLineBytes {
          events.append(.oversized(bytes: buffer.count + part.count))
          buffer.removeAll(keepingCapacity: false)
        } else {
          buffer.append(contentsOf: part)
          events.append(.line(buffer))
          buffer.removeAll(keepingCapacity: true)
        }
        chunk = chunk[chunk.index(after: newline)...]
      } else {
        if discarding {
          discardedBytes += chunk.count
        } else if buffer.count + chunk.count > maxLineBytes {
          discarding = true
          discardedBytes = buffer.count + chunk.count
          buffer.removeAll(keepingCapacity: false)
        } else {
          buffer.append(contentsOf: chunk)
        }
        break
      }
    }
    return events
  }

  /// End of stream: an unterminated final line is still delivered.
  public mutating func finish() -> [Event] {
    defer {
      buffer.removeAll()
      discarding = false
      discardedBytes = 0
    }
    if discarding { return [.oversized(bytes: discardedBytes)] }
    return buffer.isEmpty ? [] : [.line(buffer)]
  }
}

public enum ParsedLine: Sendable, Equatable {
  case message(MainToHelperMessage)
  /// Empty or whitespace-only line: ignored silently.
  case blank
  case invalid(ProtocolError)
}

public enum NDJSON {
  /// Parse one line (without its newline) from main.
  public static func parseMainLine(_ bytes: [UInt8]) -> ParsedLine {
    if bytes.count > HelperProtocol.maxLineBytes { return .invalid(.lineTooLong(bytes: bytes.count)) }
    if bytes.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D || $0 == 0x0A }) { return .blank }
    guard String(bytes: bytes, encoding: .utf8) != nil else { return .invalid(.invalidUTF8) }
    // JSON.parse (main) keeps the last of duplicated keys, Foundation keeps the first.
    // JSON.stringify never produces duplicates, so such a line is malformed: reject it
    // instead of guessing which value main meant.
    if JSONKeyScanner.hasDuplicateKeys(bytes) { return .invalid(.duplicateKey) }
    do {
      let envelope = try JSONDecoder().decode(MainToHelperEnvelope.self, from: Data(bytes))
      return .message(envelope.message)
    } catch let error as ProtocolError {
      return .invalid(error)
    } catch {
      return .invalid(.invalidJSON)
    }
  }

  public static func parseMainLine(_ text: String) -> ParsedLine {
    parseMainLine(Array(text.utf8))
  }

  /// Encode one message as a single line terminated by "\n".
  /// Throws when the message violates the schema or exceeds the line limit.
  public static func encodeLine(_ message: HelperToMainMessage) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    var data = try encoder.encode(message)
    if data.count > HelperProtocol.maxLineBytes { throw ProtocolError.messageTooLarge(bytes: data.count) }
    data.append(0x0A)
    return data
  }

  /// Byte length the encoded line would have (without the newline), or nil if it cannot be encoded.
  public static func encodedLength(_ message: HelperToMainMessage) -> Int? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try? encoder.encode(message).count
  }
}

/// Finds objects that repeat a member name (after unescaping, so "a" and "\u0061"
/// collide). Only meaningful for valid JSON; invalid JSON is rejected by the decoder anyway.
enum JSONKeyScanner {
  static func hasDuplicateKeys(_ bytes: [UInt8]) -> Bool {
    var frames: [(isObject: Bool, keys: Set<String>, expectKey: Bool)] = []
    var i = 0
    let n = bytes.count
    while i < n {
      let b = bytes[i]
      switch b {
      case UInt8(ascii: "{"):
        frames.append((true, [], true))
        i += 1
      case UInt8(ascii: "["):
        frames.append((false, [], false))
        i += 1
      case UInt8(ascii: "}"), UInt8(ascii: "]"):
        if !frames.isEmpty { frames.removeLast() }
        i += 1
      case UInt8(ascii: ","):
        if let last = frames.indices.last, frames[last].isObject { frames[last].expectKey = true }
        i += 1
      case UInt8(ascii: "\""):
        guard let (string, next) = readString(bytes, from: i) else { return false }
        if let last = frames.indices.last, frames[last].isObject, frames[last].expectKey {
          if frames[last].keys.contains(string) { return true }
          frames[last].keys.insert(string)
          frames[last].expectKey = false
        }
        i = next
      default:
        i += 1
      }
    }
    return false
  }

  /// Decodes the JSON string starting at `start` (a quote); returns the value and the index after the closing quote.
  private static func readString(_ bytes: [UInt8], from start: Int) -> (String, Int)? {
    var scalars = String.UnicodeScalarView()
    var raw: [UInt8] = []
    var i = start + 1
    func flushRaw() {
      if !raw.isEmpty {
        scalars.append(contentsOf: String(decoding: raw, as: UTF8.self).unicodeScalars)
        raw.removeAll()
      }
    }
    func hex4(_ at: Int) -> UInt32? {
      guard at + 4 <= bytes.count else { return nil }
      var value: UInt32 = 0
      for k in at..<at + 4 {
        let c = bytes[k]
        let digit: UInt32
        switch c {
        case 0x30...0x39: digit = UInt32(c - 0x30)
        case 0x41...0x46: digit = UInt32(c - 0x41 + 10)
        case 0x61...0x66: digit = UInt32(c - 0x61 + 10)
        default: return nil
        }
        value = value * 16 + digit
      }
      return value
    }
    while i < bytes.count {
      let c = bytes[i]
      if c == UInt8(ascii: "\"") {
        flushRaw()
        return (String(scalars), i + 1)
      }
      if c == UInt8(ascii: "\\"), i + 1 < bytes.count {
        flushRaw()
        let e = bytes[i + 1]
        switch e {
        case UInt8(ascii: "u"):
          guard var code = hex4(i + 2) else { return nil }
          i += 6
          if (0xD800...0xDBFF).contains(code), i + 1 < bytes.count, bytes[i] == UInt8(ascii: "\\"), bytes[i + 1] == UInt8(ascii: "u"),
            let low = hex4(i + 2), (0xDC00...0xDFFF).contains(low)
          {
            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
            i += 6
          }
          scalars.append(Unicode.Scalar(code) ?? "\u{FFFD}")
          continue
        case UInt8(ascii: "n"): scalars.append("\n")
        case UInt8(ascii: "t"): scalars.append("\t")
        case UInt8(ascii: "r"): scalars.append("\r")
        case UInt8(ascii: "b"): scalars.append("\u{08}")
        case UInt8(ascii: "f"): scalars.append("\u{0C}")
        default: scalars.append(Unicode.Scalar(e))
        }
        i += 2
        continue
      }
      raw.append(c)
      i += 1
    }
    return nil
  }
}
