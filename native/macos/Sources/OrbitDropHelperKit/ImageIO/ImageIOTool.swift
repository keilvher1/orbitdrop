import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// ImageIO bridge used by the processors for formats sharp cannot handle on macOS
/// (P2 HEIC). Decoding applies the EXIF/HEIF orientation to the pixels and writes
/// an upright PNG without orientation metadata; encoding writes no metadata.
public enum ImageIOTool {
  /// OrbitDrop image format → UTIs ImageIO uses (first = the one used for encoding).
  public static let formats: [(name: String, utis: [String])] = [
    ("jpeg", ["public.jpeg"]),
    ("png", ["public.png"]),
    ("webp", ["org.webmproject.webp"]),
    ("gif", ["com.compuserve.gif"]),
    ("tiff", ["public.tiff"]),
    ("avif", ["public.avif"]),
    ("heic", ["public.heic", "public.heif"]),
    ("bmp", ["com.microsoft.bmp"]),
  ]

  /// sharp's default limitInputPixels (0x3FFF²); processors may pass their own limit.
  public static let defaultMaxPixels = 268_402_689

  public struct Probe: Sendable, Equatable {
    public var decode: [String]
    public var encode: [String]
    public var json: String {
      func list(_ a: [String]) -> String { "[" + a.map { "\"\($0)\"" }.joined(separator: ",") + "]" }
      return "{\"decode\":\(list(decode)),\"encode\":\(list(encode))}"
    }
  }

  /// Decode support from CGImageSourceCopyTypeIdentifiers; encode support from
  /// CGImageDestinationCopyTypeIdentifiers, confirmed by a real in-memory encode +
  /// decode of a small image (a listed HEVC encoder can still fail on some Macs).
  public static func probe() -> Probe {
    let readable = Set((CGImageSourceCopyTypeIdentifiers() as? [String]) ?? [])
    let writable = Set((CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? [])
    var decode: [String] = []
    var encode: [String] = []
    for format in formats {
      if format.utis.contains(where: readable.contains) { decode.append(format.name) }
      if writable.contains(format.utis[0]), roundTripWorks(uti: format.utis[0]) { encode.append(format.name) }
    }
    return Probe(decode: decode, encode: encode)
  }

  static func roundTripWorks(uti: String) -> Bool {
    guard let image = testImage(width: 16, height: 16) else { return false }
    guard let data = try? encode(image: image, uti: uti, quality: 0.8), !data.isEmpty,
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return false }
    return decoded.width == 16 && decoded.height == 16
  }

  static func testImage(width: Int, height: Int) -> CGImage? {
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(srgbRed: 0.95, green: 0.33, blue: 0.17, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.setFillColor(CGColor(srgbRed: 0.1, green: 0.4, blue: 0.9, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 2))
    return ctx.makeImage()
  }

  public struct Result: Sendable {
    public var data: Data
    public var width: Int
    public var height: Int
  }

  public static func uti(forFormat name: String) -> String? {
    formats.first { $0.name == name }?.utis.first
  }

  /// Decode `data` (any ImageIO-readable format; the primary image of HEIF containers) to PNG.
  public static func decodeToPNG(_ data: Data, applyOrientation: Bool = true, maxPixels: Int = defaultMaxPixels) throws -> Result {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) > 0
    else { throw HelperCLIError.failed("DECODE_FAILED: not an image ImageIO can read") }
    let index = CGImageSourceGetPrimaryImageIndex(source)
    let properties = (CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]) ?? [:]
    let width = (properties[kCGImagePropertyPixelWidth] as? Int) ?? 0
    let height = (properties[kCGImagePropertyPixelHeight] as? Int) ?? 0
    guard width > 0, height > 0 else { throw HelperCLIError.failed("DECODE_FAILED: image has no size") }
    guard width.multipliedReportingOverflow(by: height).partialValue <= maxPixels, width <= 65_535, height <= 65_535 else {
      throw HelperCLIError.failed("IMAGE_TOO_LARGE: \(width)×\(height) exceeds the pixel limit")
    }
    let image: CGImage?
    if applyOrientation {
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: max(width, height),
        kCGImageSourceShouldCacheImmediately: true,
      ]
      image = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary)
    } else {
      image = CGImageSourceCreateImageAtIndex(source, index, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }
    guard let image else { throw HelperCLIError.failed("DECODE_FAILED: ImageIO could not decode the image") }
    let png = try encode(image: image, uti: UTType.png.identifier, quality: nil)
    return Result(data: png, width: image.width, height: image.height)
  }

  /// Encode `data` (normally an upright PNG from the processors) to `format`.
  public static func encode(_ data: Data, format: String, quality: Double, maxPixels: Int = defaultMaxPixels) throws -> Result {
    guard let uti = uti(forFormat: format) else { throw HelperCLIError.usage("unknown format \(format)") }
    let writable = Set((CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? [])
    guard writable.contains(uti) else { throw HelperCLIError.unsupported("ENCODER_UNAVAILABLE: ImageIO cannot write \(format) on this Mac") }
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) > 0
    else { throw HelperCLIError.failed("DECODE_FAILED: input is not an image") }
    let properties = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]) ?? [:]
    let width = (properties[kCGImagePropertyPixelWidth] as? Int) ?? 0
    let height = (properties[kCGImagePropertyPixelHeight] as? Int) ?? 0
    guard width > 0, height > 0, width.multipliedReportingOverflow(by: height).partialValue <= maxPixels else {
      throw HelperCLIError.failed("IMAGE_TOO_LARGE: input exceeds the pixel limit")
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else {
      throw HelperCLIError.failed("DECODE_FAILED: input could not be decoded")
    }
    let out = try encode(image: image, uti: uti, quality: quality)
    return Result(data: out, width: image.width, height: image.height)
  }

  static func encode(image: CGImage, uti: String, quality: Double?) throws -> Data {
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output as CFMutableData, uti as CFString, 1, nil) else {
      throw HelperCLIError.unsupported("ENCODER_UNAVAILABLE: cannot create a \(uti) encoder")
    }
    var options: [CFString: Any] = [:]
    if let quality { options[kCGImageDestinationLossyCompressionQuality] = min(max(quality, 0), 1) }
    CGImageDestinationAddImage(destination, image, options as CFDictionary)
    guard CGImageDestinationFinalize(destination), output.length > 0 else {
      throw HelperCLIError.failed("ENCODE_FAILED: ImageIO could not encode \(uti)")
    }
    return output as Data
  }
}
