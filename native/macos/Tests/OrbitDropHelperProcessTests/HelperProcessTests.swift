import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

/// Launches the built OrbitDropHelper executable and talks to it over stdio, like
/// Electron main does. No window may appear and nothing is synthesized.
final class HelperProcessTests: XCTestCase {
  /// The executable next to the test bundle (…/.build/<config>/OrbitDropHelper), or ORBITDROP_HELPER_PATH.
  static var helperURL: URL {
    if let override = ProcessInfo.processInfo.environment["ORBITDROP_HELPER_PATH"] { return URL(fileURLWithPath: override) }
    return Bundle(for: HelperProcessTests.self).bundleURL.deletingLastPathComponent().appendingPathComponent("OrbitDropHelper")
  }

  final class Helper: @unchecked Sendable {
    let process = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    let stderr = Pipe()
    private let lock = NSLock()
    private var buffer = Data()
    private(set) var lines: [String] = []

    init(arguments: [String] = []) throws {
      process.executableURL = HelperProcessTests.helperURL
      process.arguments = arguments
      process.standardInput = stdin
      process.standardOutput = stdout
      process.standardError = stderr
      stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
        let chunk = handle.availableData
        guard let self, !chunk.isEmpty else { return }
        self.lock.lock()
        self.buffer.append(chunk)
        while let newline = self.buffer.firstIndex(of: 0x0A) {
          self.lines.append(String(decoding: self.buffer[self.buffer.startIndex..<newline], as: UTF8.self))
          self.buffer.removeSubrange(self.buffer.startIndex...newline)
        }
        self.lock.unlock()
      }
      try process.run()
    }

    var messages: [[String: Any]] {
      lock.lock()
      defer { lock.unlock() }
      return lines.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }

    var rawLines: [String] {
      lock.lock()
      defer { lock.unlock() }
      return lines
    }

    func send(_ object: [String: Any]) {
      var data = try! JSONSerialization.data(withJSONObject: object)
      data.append(0x0A)
      stdin.fileHandleForWriting.write(data)
    }

    func sendRaw(_ text: String) {
      stdin.fileHandleForWriting.write(Data((text + "\n").utf8))
    }

    @discardableResult
    func waitFor(_ timeout: TimeInterval = 5, _ predicate: ([String: Any]) -> Bool) -> [String: Any]? {
      let deadline = Date().addingTimeInterval(timeout)
      while Date() < deadline {
        if let hit = messages.first(where: predicate) { return hit }
        Thread.sleep(forTimeInterval: 0.01)
      }
      return nil
    }

    func waitExit(_ timeout: TimeInterval = 5) -> Int32? {
      let deadline = Date().addingTimeInterval(timeout)
      while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
      if process.isRunning {
        process.terminate()
        return nil
      }
      return process.terminationStatus
    }

    /// Windows owned by the helper that are on screen right now.
    func onScreenWindowCount() -> Int {
      guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return 0 }
      return list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == process.processIdentifier }.count
    }
  }

  override func setUpWithError() throws {
    guard FileManager.default.isExecutableFile(atPath: Self.helperURL.path) else {
      XCTFail("helper executable not found at \(Self.helperURL.path) — run `swift build` first")
      throw XCTSkip("no helper binary")
    }
  }

  func configure(enabled: Bool = false) -> [String: Any] {
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("OrbitDropHelperCoreTests/Fixtures/configure-en.json")
    var message = try! JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as! [String: Any]
    message["enabled"] = enabled
    return message
  }

  func testReadyConfigurePingPermissionsAndStop() throws {
    let helper = try Helper()
    let ready = try XCTUnwrap(helper.waitFor { $0["type"] as? String == "ready" }, "no ready within 5 s")
    XCTAssertEqual(ready["v"] as? Int, 1)
    XCTAssertEqual(ready["platform"] as? String, "darwin")
    XCTAssertEqual(ready["pid"] as? Int32, helper.process.processIdentifier)
    #if arch(arm64)
      XCTAssertEqual(ready["arch"] as? String, "arm64")
    #else
      XCTAssertEqual(ready["arch"] as? String, "x64")
    #endif
    XCTAssertEqual((ready["globalDrag"] as? [String: Any])?["available"] as? Bool, true)

    helper.send(configure())
    helper.send(["v": 1, "type": "ping", "nonce": 41])
    XCTAssertNotNil(helper.waitFor { $0["type"] as? String == "pong" && $0["nonce"] as? Int == 41 })
    helper.send(["v": 1, "type": "queryPermissions"])
    let permissions = try XCTUnwrap(helper.waitFor { $0["type"] as? String == "permissions" })
    let items = try XCTUnwrap(permissions["items"] as? [[String: Any]])
    XCTAssertEqual(Set(items.compactMap { $0["name"] as? String }), ["accessibility", "inputMonitoring"])
    XCTAssertTrue(items.allSatisfy { $0["required"] as? Bool == false }, "no permission is required")

    // Invalid input is ignored and logged; the helper keeps working.
    helper.sendRaw("{\"v\":1,\"type\":\"configure\",\"enabled\":\"yes\"}")
    helper.sendRaw("not json")
    helper.send(["v": 1, "type": "ping", "nonce": 42])
    XCTAssertNotNil(helper.waitFor { $0["type"] as? String == "pong" && $0["nonce"] as? Int == 42 })
    let warnings = helper.messages.filter { $0["type"] as? String == "log" && $0["level"] as? String == "warn" }
    XCTAssertGreaterThanOrEqual(warnings.count, 2)
    for w in warnings { XCTAssertFalse((w["message"] as? String ?? "").contains("/Users/"), "logs never contain paths") }

    XCTAssertEqual(helper.onScreenWindowCount(), 0, "no window appears without a real drag")
    helper.send(["v": 1, "type": ["shut", "down"].joined()])
    XCTAssertEqual(helper.waitExit(), 0)
    XCTAssertTrue(helper.rawLines.allSatisfy { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) != nil }, "stdout carries only JSON lines")
    XCTAssertFalse(helper.messages.contains { ["state", "drop", "cancelled"].contains($0["type"] as? String ?? "") })
  }

  func testExitsWhenStdinCloses() throws {
    let helper = try Helper()
    XCTAssertNotNil(helper.waitFor { $0["type"] as? String == "ready" })
    helper.send(configure())
    helper.send(["v": 1, "type": "ping", "nonce": 1])
    XCTAssertNotNil(helper.waitFor { $0["type"] as? String == "pong" })
    try helper.stdin.fileHandleForWriting.close()
    XCTAssertEqual(helper.waitExit(), 0, "parent gone → clean exit")
  }

  func testEnabledObservationNeedsNoPrompt() throws {
    // Installs the passive global mouse monitor for a moment. Nothing is shown unless the user
    // happens to perform a real file drag with Shift during this second.
    let helper = try Helper()
    XCTAssertNotNil(helper.waitFor { $0["type"] as? String == "ready" })
    helper.send(configure(enabled: true))
    helper.send(["v": 1, "type": "ping", "nonce": 5])
    XCTAssertNotNil(helper.waitFor { $0["type"] as? String == "pong" })
    XCTAssertFalse(helper.messages.contains { $0["type"] as? String == "error" }, "global monitor installed")
    try helper.stdin.fileHandleForWriting.close()
    XCTAssertEqual(helper.waitExit(), 0)
  }

  func testVersionAndUnknownArguments() throws {
    let version = try Helper(arguments: ["--version"])
    XCTAssertEqual(version.waitExit(), 0)
    let bad = try Helper(arguments: ["--frobnicate"])
    XCTAssertEqual(bad.waitExit(), 2)
  }

  // MARK: CLI modes

  func run(_ arguments: [String]) throws -> (status: Int32, stdout: String) {
    let process = Process()
    process.executableURL = Self.helperURL
    process.arguments = arguments
    let out = Pipe()
    process.standardOutput = out
    process.standardError = Pipe()
    try process.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: data, as: UTF8.self))
  }

  func temporaryDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbitdrop-helper-process-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    return dir
  }

  func imageSize(_ url: URL) -> (Int, Int, String?)? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    return (image.width, image.height, CGImageSourceGetType(source) as String?)
  }

  func testImageIOHeicEncodeDecodeThroughTheCLI() throws {
    let probe = try run(["imageio", "--probe"])
    XCTAssertEqual(probe.status, 0)
    let probed = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(probe.stdout.utf8)) as? [String: [String]])
    guard probed["encode"]?.contains("heic") == true else { throw XCTSkip("no HEVC encoder on this Mac") }

    let dir = try temporaryDirectory()
    let png = dir.appendingPathComponent("in.png")
    let ctx = CGContext(data: nil, width: 120, height: 80, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(srgbRed: 0.2, green: 0.6, blue: 0.3, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: 120, height: 80))
    let destination = CGImageDestinationCreateWithURL(png as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, ctx.makeImage()!, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))

    let heic = dir.appendingPathComponent("out.heic")
    let encode = try run(["imageio", "--encode", "heic", "--quality", "0.7", png.path, "--out", heic.path])
    XCTAssertEqual(encode.status, 0, encode.stdout)
    XCTAssertTrue(encode.stdout.contains("\"ok\":true"))
    let encoded = try XCTUnwrap(imageSize(heic))
    XCTAssertEqual(encoded.0, 120)
    XCTAssertEqual(encoded.1, 80)
    XCTAssertEqual(encoded.2, "public.heic")

    let decodedURL = dir.appendingPathComponent("back.png")
    let decode = try run(["imageio", "--decode", heic.path, "--out", decodedURL.path])
    XCTAssertEqual(decode.status, 0, decode.stdout)
    let decoded = try XCTUnwrap(imageSize(decodedURL))
    XCTAssertEqual(decoded.0, 120)
    XCTAssertEqual(decoded.2, "public.png")

    let missing = try run(["imageio", "--decode", dir.appendingPathComponent("nope.heic").path, "--out", decodedURL.path])
    XCTAssertEqual(missing.status, 1)
    XCTAssertTrue(missing.stdout.contains("\"ok\":false"))
    let usage = try run(["imageio", "--encode", "heic", png.path, "--out", heic.path])
    XCTAssertEqual(usage.status, 2, "quality is required")
  }

  /// The four behaviours packages/processors (codecs/imageio.ts) relies on — keep them stable:
  /// 1. the probe JSON is the last stdout line, 2. exit code 0 means success,
  /// 3. --decode writes upright pixels with no orientation tag, 4. --quality takes 0…1.
  func testImageIOContractUsedByProcessors() throws {
    // 1 + 2: probe.
    let probe = try run(["imageio", "--probe"])
    XCTAssertEqual(probe.status, 0)
    let lastLine = try XCTUnwrap(probe.stdout.split(separator: "\n").last.map(String.init))
    let probed = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(lastLine.utf8)) as? [String: Any])
    XCTAssertEqual(Set(probed.keys), ["decode", "encode"])
    XCTAssertNotNil(probed["decode"] as? [String])
    XCTAssertNotNil(probed["encode"] as? [String])

    // 3: a 40×20 JPEG stored with EXIF orientation 6 decodes to an upright 20×40 PNG without an orientation tag.
    let dir = try temporaryDirectory()
    let jpeg = dir.appendingPathComponent("rotated.jpg")
    let ctx = CGContext(data: nil, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
    ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 20, y: 0, width: 20, height: 20))
    let destination = CGImageDestinationCreateWithURL(jpeg as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, ctx.makeImage()!, [kCGImagePropertyOrientation: 6] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    let png = dir.appendingPathComponent("upright.png")
    let decode = try run(["imageio", "--decode", jpeg.path, "--out", png.path])
    XCTAssertEqual(decode.status, 0)
    let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data((decode.stdout.split(separator: "\n").last ?? "").utf8)) as? [String: Any])
    XCTAssertEqual(result["ok"] as? Bool, true)
    XCTAssertEqual(result["width"] as? Int, 20)
    XCTAssertEqual(result["height"] as? Int, 40)
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(png as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    XCTAssertEqual(image.width, 20)
    XCTAssertEqual(image.height, 40)
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
    XCTAssertNil(properties[kCGImagePropertyOrientation], "no orientation tag in the decoded PNG")

    // 4: quality is a 0…1 fraction; percentages are refused as a usage error.
    guard (probed["encode"] as? [String])?.contains("heic") == true else { return }
    let heic = dir.appendingPathComponent("q.heic")
    XCTAssertEqual(try run(["imageio", "--encode", "heic", "--quality", "0", png.path, "--out", heic.path]).status, 0)
    XCTAssertEqual(try run(["imageio", "--encode", "heic", "--quality", "1", png.path, "--out", heic.path]).status, 0)
    XCTAssertEqual(try run(["imageio", "--encode", "heic", "--quality", "0.7", png.path, "--out", heic.path]).status, 0)
    let percent = try run(["imageio", "--encode", "heic", "--quality", "70", png.path, "--out", heic.path])
    XCTAssertEqual(percent.status, 2, "70 is not a 0…1 quality")
    XCTAssertTrue(percent.stdout.contains("\"ok\":false"))
    XCTAssertNotEqual(try run(["imageio", "--decode", dir.appendingPathComponent("missing.heic").path, "--out", png.path]).status, 0, "failure is never exit 0")
  }

  func testSnapshotCLI() throws {
    let dir = try temporaryDirectory()
    let out = dir.appendingPathComponent("wheel.png")
    let result = try run(["--render-snapshot", out.path, "--menu", "image/jpeg", "--mode", "tools", "--highlight", "5", "--scale", "2", "--locale", "ko"])
    XCTAssertEqual(result.status, 0)
    let size = try XCTUnwrap(imageSize(out))
    XCTAssertEqual(size.0, 816, "(360 disc + 2·24 shadow margin) · 2")
    XCTAssertEqual(size.1, 880, "(360 disc + 6 gap + 26 caption strip + 2·24 margin) · 2")
    XCTAssertEqual(try run(["--render-snapshot", out.path, "--menu", "image/svg", "--mode", "tools"]).status, 2)
  }
}
