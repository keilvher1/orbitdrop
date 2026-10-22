import XCTest

@testable import OrbitDropHelperCore

final class ProtocolTests: XCTestCase {
  // MARK: zod parity

  struct Corpus: Decodable {
    struct Case: Decodable {
      let name: String
      let line: String
      let valid: Bool
    }
    let cases: [Case]
  }

  /// Every line in protocol-cases.json carries zod's verdict; the Swift decoder must agree.
  func testDecoderAgreesWithZodOnEveryCase() throws {
    // JSONDecoder, not JSONSerialization: the latter drops a leading U+FEFF from string values,
    // which would silently turn the byte-order-mark case into a plain line.
    let cases = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: TestPaths.fixture("protocol-cases.json"))).cases
    XCTAssertGreaterThan(cases.count, 150)
    XCTAssertTrue(cases.contains { $0.name == "byte order mark" && $0.line.utf8.starts(with: [0xEF, 0xBB, 0xBF]) }, "the BOM survived reading the corpus")
    var disagreements: [String] = []
    for c in cases {
      let name = c.name
      let line = c.line
      let zodValid = c.valid
      let parsed = NDJSON.parseMainLine(line)
      let swiftValid: Bool
      switch parsed {
      case .message: swiftValid = true
      case .blank: swiftValid = false
      case .invalid: swiftValid = false
      }
      if name.hasPrefix("duplicate key") {
        // Intentional, safer divergence: JSON.parse keeps the last duplicate, Foundation the first;
        // JSON.stringify never emits duplicates, so the helper rejects such lines outright.
        XCTAssertEqual(parsed, .invalid(.duplicateKey), name)
        continue
      }
      if name.hasPrefix("number underflow") {
        // Documented divergence: JSON.parse reads 1e-400 as 0, Foundation refuses a literal that
        // underflows. JSON.stringify never writes one (it writes 0), so main cannot send it.
        XCTAssertEqual(parsed, .invalid(.wrongType("nonce")), name)
        continue
      }
      if swiftValid != zodValid { disagreements.append("\(name): zod \(zodValid), swift \(parsed)") }
    }
    XCTAssertEqual(disagreements, [], disagreements.joined(separator: "\n"))
  }

  func testGeneratedConfigureDecodesCompletely() throws {
    for locale in ["ko", "en"] {
      let data = try Data(contentsOf: TestPaths.fixture("configure-\(locale).json"))
      guard case .message(.configure(let config)) = NDJSON.parseMainLine(Array(data)) else {
        return XCTFail("configure-\(locale) rejected: \(NDJSON.parseMainLine(Array(data)))")
      }
      let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      XCTAssertEqual(config.locale.rawValue, locale)
      XCTAssertEqual(config.enabled, true)
      XCTAssertEqual(config.geometry, .default)
      XCTAssertEqual(config.convertModifiers, ModifierCombo([.shift]))
      XCTAssertEqual(config.toolsModifiers, ModifierCombo([.alt, .shift]))
      XCTAssertEqual(config.menus.count, (raw["menus"] as! [Any]).count)
      XCTAssertEqual(config.extensions.count, (raw["extensions"] as! [String: Any]).count)
      XCTAssertEqual(config.extensions[".pdf"], .pdf)
      XCTAssertEqual(config.extensions[".jpeg"], .image(.jpeg))
      XCTAssertEqual(config.tokens.sectorActive, RGBA(hex: "#D4441C"))
      XCTAssertEqual(config.tokens.labelWeight, 700)
      // Optional specific unsupported texts (helper-protocol.ts, 88a209b).
      XCTAssertFalse((config.strings.unsupportedFolder ?? "").isEmpty)
      XCTAssertFalse((config.strings.unsupportedNonFile ?? "").isEmpty)
      XCTAssertFalse((config.strings.unsupportedVirtual ?? "").isEmpty)
      // Reference order from the recording, as built by buildHelperMenus.
      XCTAssertEqual(config.menu(for: .pdf)?.convert.map(\.actionId), [.convertDocx, .convertJpeg, .convertPng, .convertTxt])
      XCTAssertEqual(config.menu(for: .image(.jpeg))?.convert.map(\.label), ["PNG", "WEBP", "HEIC", "TIFF", "AVIF", "BMP", "PDF", "DOCX"])
      XCTAssertEqual(config.menu(for: .image(.jpeg))?.tools.map(\.actionId), DefaultConfig.imageToolsOrder)
      XCTAssertEqual(config.menu(for: .pdf)?.tools, [])
      // HEIC has no encoder in the probe used for the fixture: disabled with a reason.
      let heic = config.menu(for: .image(.png))!.convert.first { $0.actionId == .convertHeic }!
      XCTAssertFalse(heic.enabled)
      XCTAssertFalse((heic.reason ?? "").isEmpty)
    }
  }

  // MARK: specific rejections (field paths are reported, values never)

  func testErrorsNameTheField() {
    let base = #"{"v":1,"type":"ping","nonce":1}"#
    XCTAssertEqual(NDJSON.parseMainLine(base), .message(.ping(nonce: 1)))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"ping","nonce":1,"x":2}"#), .invalid(.unknownField("x")))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"ping"}"#), .invalid(.missingField("nonce")))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"ping","nonce":"1"}"#), .invalid(.wrongType("nonce")))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"ping","nonce":-1}"#), .invalid(.outOfRange("nonce")))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":2,"type":"ping","nonce":1}"#), .invalid(.unsupportedVersion))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"wat"}"#), .invalid(.unknownType))
    XCTAssertEqual(NDJSON.parseMainLine(#"[1]"#), .invalid(.notAnObject))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"#), .invalid(.invalidJSON))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"cancelSession","sessionId":"a b"}"#), .invalid(.invalidValue("sessionId")))
    XCTAssertEqual(NDJSON.parseMainLine("   "), .blank)
    XCTAssertEqual(NDJSON.parseMainLine([0x7B, 0xFF, 0x7D]), .invalid(.invalidUTF8))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"ping","nonce":1,"\u006eonce":2}"#), .invalid(.duplicateKey))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"cancelSession","sessionId":"a\"b,\"sessionId"}"#), .invalid(.invalidValue("sessionId")), "quotes inside values are not keys")
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"queryPermissions","x":[{"a":1},{"a":2}]}"#), .invalid(.unknownField("x")), "same key in sibling objects is fine")

    let errors: [ProtocolError] = [.unknownField("geometry.extra"), .wrongType("menus[0].convert[1].label")]
    for e in errors { XCTAssertFalse(e.description.contains("/"), "descriptions never contain paths") }
  }

  /// Hardening: Foundation accepts trailing commas and a byte-order mark (JSON.parse does not)
  /// and refuses lone surrogate escapes (JSON.parse keeps them; zod counts each as one code point).
  func testJSONParseParityForCommasBOMAndLoneSurrogates() throws {
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"ping","nonce":1,}"#), .invalid(.invalidJSON))
    XCTAssertEqual(NDJSON.parseMainLine("{\"v\":1,\"type\":\"ping\",\"nonce\":1 ,\t\r }"), .invalid(.invalidJSON))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"ping","nonce":1 }"#), .message(.ping(nonce: 1)), "whitespace alone is fine")
    XCTAssertEqual(NDJSON.parseMainLine([0xEF, 0xBB, 0xBF] + Array(#"{"v":1,"type":"shutdown"}"#.utf8)), .invalid(.invalidJSON))
    XCTAssertEqual(NDJSON.parseMainLine(#"{"v":1,"type":"cancelSession","sessionId":"a,}b,]"}"#), .invalid(.invalidValue("sessionId")), "commas inside strings are not syntax")

    let esc = { (hex: String) in "\\" + "u" + hex }
    let fixture = try String(contentsOf: TestPaths.fixture("configure-en.json"), encoding: .utf8)
    let dropHint = try NSRegularExpression(pattern: #""dropHint":"[^"]*""#)
    func line(dropHint raw: String) -> String {
      dropHint.stringByReplacingMatches(in: fixture, range: NSRange(fixture.startIndex..., in: fixture), withTemplate: NSRegularExpression.escapedTemplate(for: "\"dropHint\":\"\(raw)\""))
    }
    func scalars(dropHint raw: String) -> [UInt32]? {
      guard case .message(.configure(let config)) = NDJSON.parseMainLine(line(dropHint: raw)) else { return nil }
      return config.strings.dropHint.unicodeScalars.map(\.value)
    }
    XCTAssertEqual(scalars(dropHint: "a" + esc("d800") + "b"), [0x61, 0xFFFD, 0x62], "lone high surrogate")
    XCTAssertEqual(scalars(dropHint: esc("dc00") + esc("d800")), [0xFFFD, 0xFFFD], "reversed halves")
    XCTAssertEqual(scalars(dropHint: esc("dbff") + "A"), [0xFFFD, 0x41])
    XCTAssertEqual(scalars(dropHint: "x" + esc("d83d")), [0x78, 0xFFFD], "dangling at the end")
    XCTAssertEqual(scalars(dropHint: esc("d83d") + esc("de00")), [0x1F600], "a real pair stays one character")
    XCTAssertEqual(scalars(dropHint: esc("0041")), [0x41])
    // zod counts a lone surrogate as one code point: 60 fit dropHint's limit, 61 do not.
    XCTAssertEqual(scalars(dropHint: String(repeating: esc("d800"), count: 60))?.count, 60)
    XCTAssertEqual(NDJSON.parseMainLine(line(dropHint: String(repeating: esc("dfff"), count: 61))), .invalid(.outOfRange("strings.dropHint")))

    let scan = JSONKeyScanner.scan(Array(("{\"a\":\"x" + esc("d800") + "\",\"b\":\"" + esc("d83d") + esc("de00") + esc("dc01") + "\"}").utf8))
    XCTAssertEqual(scan.loneSurrogateEscapes, [7, 32], "offsets of the backslashes of the lone escapes only")
    XCTAssertFalse(scan.duplicateKey)
    XCTAssertFalse(scan.trailingComma)
  }

  func testUnknownActionIdIsRejectedWithItsPath() throws {
    var config = try String(contentsOf: TestPaths.fixture("configure-en.json"), encoding: .utf8)
    config = config.replacingOccurrences(of: "\"convert.docx\"", with: "\"convert.rtf\"")
    guard case .invalid(let error) = NDJSON.parseMainLine(config) else { return XCTFail("accepted unknown action id") }
    XCTAssertEqual(error, .invalidValue("menus[0].convert[0].actionId"))
  }

  func testLineLimitIsExactlyMaxBytes() {
    // {"v":1,"type":"ping","nonce":1,"p":"xxxx…"} padded to exactly the limit → only rejected for the unknown field.
    let prefix = #"{"v":1,"type":"ping","nonce":1,"p":""#
    let suffix = #""}"#
    let pad = String(repeating: "x", count: HelperProtocol.maxLineBytes - prefix.utf8.count - suffix.utf8.count)
    let exact = prefix + pad + suffix
    XCTAssertEqual(exact.utf8.count, HelperProtocol.maxLineBytes)
    XCTAssertEqual(NDJSON.parseMainLine(exact), .invalid(.unknownField("p")))
    XCTAssertEqual(NDJSON.parseMainLine(exact + " "), .invalid(.lineTooLong(bytes: HelperProtocol.maxLineBytes + 1)))
  }

  // MARK: framing

  func testFramerSplitsLinesAcrossChunks() {
    var framer = LineFramer(maxLineBytes: 16)
    XCTAssertEqual(framer.push(Array("ab".utf8)), [])
    XCTAssertEqual(framer.push(Array("c\nde\n\nf".utf8)), [.line(Array("abc".utf8)), .line(Array("de".utf8)), .line([])])
    XCTAssertEqual(framer.finish(), [.line(Array("f".utf8))])
    XCTAssertEqual(framer.finish(), [])
  }

  func testFramerDropsOversizedLinesWithoutBuffering() {
    var framer = LineFramer(maxLineBytes: 8)
    XCTAssertEqual(framer.push(Array("12345678\n".utf8)), [.line(Array("12345678".utf8))], "exactly max is fine")
    XCTAssertEqual(framer.push(Array("123456789".utf8)), [], "over the limit starts discarding")
    XCTAssertEqual(framer.push(Array(repeating: UInt8(ascii: "x"), count: 10_000)), [])
    XCTAssertEqual(framer.push(Array("tail\nok\n".utf8)), [.oversized(bytes: 9 + 10_000 + 4), .line(Array("ok".utf8))])
    XCTAssertEqual(framer.push(Array("123456789\n".utf8)), [.oversized(bytes: 9)])
    XCTAssertEqual(framer.push(Array("1234".utf8)), [])
    XCTAssertEqual(framer.push(Array("56789\n".utf8)), [.oversized(bytes: 9)])
  }

  func testFramerHandlesByteAtATimeUTF8() {
    var framer = LineFramer()
    var events: [LineFramer.Event] = []
    for byte in Array("{\"a\":\"한글\"}\n".utf8) { events += framer.push([byte]) }
    XCTAssertEqual(events, [.line(Array("{\"a\":\"한글\"}".utf8))])
  }

  // MARK: outgoing messages

  func testReadyEncoding() throws {
    let ready = HelperToMainMessage.ready(ReadyMessage(helperVersion: "0.1.0", platform: "darwin", arch: "arm64", osVersion: "26.6.0", pid: 4242, globalDragAvailable: true))
    let o = try ready.jsonObject()
    XCTAssertEqual(o["v"] as? Int, 1)
    XCTAssertEqual(o["type"] as? String, "ready")
    XCTAssertEqual(o["pid"] as? Int, 4242)
    XCTAssertEqual((o["globalDrag"] as? [String: Any])?["available"] as? Bool, true)
    XCTAssertNil((o["globalDrag"] as? [String: Any])?["reason"], "optional reason omitted, not null")
    XCTAssertThrowsError(try NDJSON.encodeLine(.ready(ReadyMessage(helperVersion: "x", platform: "linux", arch: "arm64", osVersion: "", pid: 1, globalDragAvailable: false))))
  }

  func testStateEncodingDistinguishesOmittedAndNullMenuKey() throws {
    let neutral = try HelperToMainMessage.state(StateMessage(sessionId: "s1", state: .awaitingPayload, mode: .convert)).jsonObject()
    XCTAssertEqual(neutral["state"] as? String, "AwaitingPayload")
    XCTAssertEqual(neutral["mode"] as? String, "convert")
    XCTAssertFalse(neutral.keys.contains("menuKey"))
    let unsupported = try HelperToMainMessage.state(StateMessage(sessionId: "s1", state: .wheelActive, mode: .tools, menuKey: .some(nil), fileCount: 0)).jsonObject()
    XCTAssertTrue(unsupported["menuKey"] is NSNull)
    let pdf = try HelperToMainMessage.state(StateMessage(sessionId: "s1", state: .wheelActive, mode: .convert, menuKey: .some(.pdf), fileCount: 1)).jsonObject()
    XCTAssertEqual(pdf["menuKey"] as? String, "pdf")
    XCTAssertEqual(pdf["fileCount"] as? Int, 1)
  }

  func testDropEncodingAndLimits() throws {
    let path = "/Users/me/문서/Page 001 😀 \"quoted\" \\ back.pdf"
    let o = try HelperToMainMessage.drop(DropMessage(sessionId: "m1-2-ab", actionId: .convertJpeg, mode: .convert, files: [path])).jsonObject()
    XCTAssertEqual(o["files"] as? [String], [path], "paths survive JSON escaping exactly")
    XCTAssertEqual(o["dropEffect"] as? String, "copy")
    XCTAssertEqual(o["actionId"] as? String, "convert.jpeg")
    let line = try NDJSON.encodeLine(.drop(DropMessage(sessionId: "m1", actionId: .convertJpeg, mode: .convert, files: [path])))
    XCTAssertFalse(line.dropLast().contains(0x0A), "exactly one newline, at the end")

    XCTAssertThrowsError(try NDJSON.encodeLine(.drop(DropMessage(sessionId: "m1", actionId: .convertJpeg, mode: .convert, files: []))))
    XCTAssertThrowsError(try NDJSON.encodeLine(.drop(DropMessage(sessionId: "m1", actionId: .convertJpeg, mode: .convert, files: Array(repeating: "/a.pdf", count: 201)))))
    XCTAssertThrowsError(try NDJSON.encodeLine(.drop(DropMessage(sessionId: "bad id", actionId: .convertJpeg, mode: .convert, files: ["/a.pdf"]))))
    XCTAssertThrowsError(try NDJSON.encodeLine(.drop(DropMessage(sessionId: "m1", actionId: .convertJpeg, mode: .convert, files: [""]))))
    // 200 paths of 6000 code points (escaped) exceed the 1 MiB line limit.
    let long = "/" + String(repeating: "a", count: 5999)
    XCTAssertThrowsError(try NDJSON.encodeLine(.drop(DropMessage(sessionId: "m1", actionId: .convertJpeg, mode: .convert, files: Array(repeating: long, count: 200))))) { error in
      guard case ProtocolError.messageTooLarge = error else { return XCTFail("\(error)") }
    }
  }

  func testLogAndErrorAreTruncatedToSchemaLimits() throws {
    let log = try HelperToMainMessage.log(level: .warn, message: String(repeating: "가", count: 5000)).jsonObject()
    XCTAssertEqual((log["message"] as! String).unicodeScalars.count, 2000)
    let emoji = try HelperToMainMessage.log(level: .info, message: String(repeating: "😀", count: 2001)).jsonObject()
    XCTAssertEqual((emoji["message"] as! String).unicodeScalars.count, 2000)
    let error = try HelperToMainMessage.error(code: String(repeating: "E", count: 100), message: "m", fatal: true).jsonObject()
    XCTAssertEqual((error["code"] as! String).count, 64)
    XCTAssertEqual(error["fatal"] as? Bool, true)
  }

  func testPongPermissionsCancelled() throws {
    XCTAssertEqual(try HelperToMainMessage.pong(nonce: 9_007_199_254_740_991).jsonObject()["nonce"] as? Int, 9_007_199_254_740_991)
    XCTAssertThrowsError(try NDJSON.encodeLine(.pong(nonce: -1)))
    let perms = try HelperToMainMessage.permissions([
      PermissionItem(name: .accessibility, required: false, granted: false),
      PermissionItem(name: .inputMonitoring, required: false, granted: true),
    ]).jsonObject()
    let items = perms["items"] as! [[String: Any]]
    XCTAssertEqual(items.map { $0["name"] as! String }, ["accessibility", "inputMonitoring"])
    let cancelled = try HelperToMainMessage.cancelled(sessionId: "s1", reason: .disabledSector).jsonObject()
    XCTAssertEqual(cancelled["reason"] as? String, "disabledSector")
  }
}
