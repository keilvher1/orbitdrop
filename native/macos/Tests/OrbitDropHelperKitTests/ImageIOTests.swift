import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import OrbitDropHelperKit

/// ImageIOTool.probe() runs an encode/decode round trip per format; on GitHub's macOS runner (a VM
/// without HEVC hardware) that takes seconds, and a probe that never returned would stall every
/// later test. So it runs once on its own thread with a deadline, while this (main) thread keeps
/// its run loop going — the encoders may hand work to the main queue: with the main thread blocked
/// in a semaphore wait the probe missed a 30 s deadline on the runner, where the same probe in the
/// helper CLI finished in seconds. When it does not finish, the tests that need it are skipped
/// with that reason (the product bounds the same probe: `imageio --probe` gets 3 s, then HEIC is
/// "not available").
enum BoundedProbe {
  static let seconds: Double = 60

  final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var value: ImageIOTool.Probe?
    private var done = false

    func finish(_ probe: ImageIOTool.Probe) {
      lock.lock()
      value = probe
      done = true
      lock.unlock()
    }

    var result: (done: Bool, probe: ImageIOTool.Probe?) {
      lock.lock()
      defer { lock.unlock() }
      return (done, value)
    }
  }

  static let result: ImageIOTool.Probe? = {
    let box = Box()
    Thread.detachNewThread { box.finish(ImageIOTool.probe()) }
    let deadline = Date().addingTimeInterval(seconds)
    while !box.result.done && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    return box.result.probe
  }()

  static func probeOrSkip() throws -> ImageIOTool.Probe {
    guard let probe = result else {
      throw XCTSkip("ImageIOTool.probe() did not finish within \(Int(seconds)) s: this Mac's ImageIO encoder round trip does not finish (seen on GitHub's macOS runner VMs)")
    }
    return probe
  }
}

/// ImageIO codec mode: real encode/decode round trips, re-reading the outputs.
final class ImageIOTests: XCTestCase {
  /// 64×48 image: left half red, right half blue.
  func makeImage(width: Int = 64, height: Int = 48) -> CGImage {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
    ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
    return ctx.makeImage()!
  }

  func encoded(_ image: CGImage, uti: String, properties: [CFString: Any] = [:]) -> Data {
    let data = NSMutableData()
    let destination = CGImageDestinationCreateWithData(data, uti as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
  }

  func decode(_ data: Data) -> CGImage {
    let source = CGImageSourceCreateWithData(data as CFData, nil)!
    return CGImageSourceCreateImageAtIndex(source, 0, nil)!
  }

  func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (Int, Int, Int) {
    var bytes = [UInt8](repeating: 0, count: 4)
    let ctx = CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    // Draw so that image pixel (x, y) (top-left origin) lands on the single output pixel.
    ctx.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
    return (Int(bytes[0]), Int(bytes[1]), Int(bytes[2]))
  }

  func testProbeShape() throws {
    let probe = try BoundedProbe.probeOrSkip()
    XCTAssertTrue(probe.decode.contains("heic"), "macOS always decodes HEIC")
    XCTAssertTrue(probe.decode.contains("jpeg") && probe.decode.contains("png"))
    XCTAssertTrue(probe.encode.contains("jpeg") && probe.encode.contains("png"))
    let json = try! JSONSerialization.jsonObject(with: Data(probe.json.utf8)) as! [String: [String]]
    XCTAssertEqual(Set(json.keys), ["decode", "encode"])
    let known = Set(ImageIOTool.formats.map(\.name))
    XCTAssertTrue(Set(probe.decode).isSubset(of: known) && Set(probe.encode).isSubset(of: known))
  }

  func testHeicRoundTrip() throws {
    guard try BoundedProbe.probeOrSkip().encode.contains("heic") else { throw XCTSkip("no HEVC encoder on this Mac") }
    let png = encoded(makeImage(), uti: UTType.png.identifier)
    let heic = try ImageIOTool.encode(png, format: "heic", quality: 0.9)
    XCTAssertEqual(heic.width, 64)
    XCTAssertEqual(heic.height, 48)
    let source = CGImageSourceCreateWithData(heic.data as CFData, nil)!
    XCTAssertEqual(CGImageSourceGetType(source) as String?, "public.heic")
    let back = try ImageIOTool.decodeToPNG(heic.data)
    XCTAssertEqual(back.width, 64)
    XCTAssertEqual(back.height, 48)
    let image = decode(back.data)
    let left = pixel(image, 8, 24)
    let right = pixel(image, 56, 24)
    XCTAssertGreaterThan(left.0, 200, "left stays red: \(left)")
    XCTAssertLessThan(left.2, 60)
    XCTAssertGreaterThan(right.2, 200, "right stays blue: \(right)")
    XCTAssertLessThan(right.0, 60)
    XCTAssertEqual(CGImageSourceGetType(CGImageSourceCreateWithData(back.data as CFData, nil)!) as String?, "public.png")
  }

  func testQualityAffectsSize() throws {
    guard try BoundedProbe.probeOrSkip().encode.contains("heic") else { throw XCTSkip("no HEVC encoder on this Mac") }
    // A noisy image so quality matters.
    let ctx = CGContext(data: nil, width: 256, height: 256, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    var seed: UInt32 = 7
    for y in 0..<64 {
      for x in 0..<64 {
        seed = seed &* 1_664_525 &+ 1_013_904_223
        ctx.setFillColor(CGColor(srgbRed: Double(seed & 0xFF) / 255, green: Double((seed >> 8) & 0xFF) / 255, blue: Double((seed >> 16) & 0xFF) / 255, alpha: 1))
        ctx.fill(CGRect(x: x * 4, y: y * 4, width: 4, height: 4))
      }
    }
    let png = encoded(ctx.makeImage()!, uti: UTType.png.identifier)
    let low = try ImageIOTool.encode(png, format: "heic", quality: 0.1)
    let high = try ImageIOTool.encode(png, format: "heic", quality: 1.0)
    XCTAssertLessThan(low.data.count, high.data.count)
  }

  func testDecodeAppliesExifOrientation() throws {
    // 40×20 pixels stored with orientation 6 (rotate 90° clockwise to display) → upright 20×40.
    let jpeg = encoded(makeImage(width: 40, height: 20), uti: UTType.jpeg.identifier, properties: [kCGImagePropertyOrientation: 6])
    let upright = try ImageIOTool.decodeToPNG(jpeg)
    XCTAssertEqual(upright.width, 20)
    XCTAssertEqual(upright.height, 40)
    let image = decode(upright.data)
    // Rotating 90° CW moves the left (red) half to the top.
    XCTAssertGreaterThan(pixel(image, 10, 5).0, 180)
    XCTAssertGreaterThan(pixel(image, 10, 35).2, 180)
    let props = CGImageSourceCopyPropertiesAtIndex(CGImageSourceCreateWithData(upright.data as CFData, nil)!, 0, nil) as? [CFString: Any]
    XCTAssertTrue((props?[kCGImagePropertyOrientation] as? Int ?? 1) == 1, "no orientation left in the PNG")
    let raw = try ImageIOTool.decodeToPNG(jpeg, applyOrientation: false)
    XCTAssertEqual(raw.width, 40)
    XCTAssertEqual(raw.height, 20)
  }

  func testLimitsAndGarbage() {
    let png = encoded(makeImage(), uti: UTType.png.identifier)
    XCTAssertThrowsError(try ImageIOTool.decodeToPNG(png, maxPixels: 100)) { error in
      XCTAssertTrue("\(error)".hasPrefix("IMAGE_TOO_LARGE"), "\(error)")
    }
    XCTAssertThrowsError(try ImageIOTool.decodeToPNG(Data("not an image".utf8))) { error in
      XCTAssertTrue("\(error)".hasPrefix("DECODE_FAILED"), "\(error)")
    }
    XCTAssertThrowsError(try ImageIOTool.encode(png, format: "svg", quality: 0.5))
    XCTAssertThrowsError(try ImageIOTool.encode(Data([1, 2, 3]), format: "png", quality: 0.5))
  }

  func testCommandSplitsCodes() {
    let (code, message) = ImageIOCommand.split(.failed("DECODE_FAILED: not an image"))
    XCTAssertEqual(code, "DECODE_FAILED")
    XCTAssertEqual(message, "not an image")
    XCTAssertEqual(ImageIOCommand.split(.usage("bad")).0, "USAGE")
    XCTAssertEqual(ImageIOCommand.jsonString("a\"b\n"), "\"a\\\"b\\n\"")
  }
}
