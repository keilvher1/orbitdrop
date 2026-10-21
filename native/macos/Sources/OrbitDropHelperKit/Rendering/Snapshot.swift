import AppKit
import CoreGraphics
import ImageIO
import OrbitDropHelperCore
import UniformTypeIdentifiers

/// Offscreen rendering of the wheel to a bitmap / PNG (no window, no screen).
public enum Snapshot {
  public enum Backdrop: String, Sendable {
    /// Transparent background (what the panel composites over the desktop).
    case none
    /// A warm gradient standing in for a desktop wallpaper (documentation screenshots).
    case desktop
  }

  /// Renders `model` at `scale` pixels per point: the panel content (disc + caption strip)
  /// centered in a `margin`-point border that shows the painted stand-in for the window
  /// server's shadow. `margin: 0, shadow: false` gives exactly the live panel's pixels.
  public static func render(_ model: WheelViewModel, scale: Double = 2, backdrop: Backdrop = .none, margin: Double? = nil, shadow: Bool = true) -> CGImage? {
    let panel = model.presentation.layout.frame
    let border = margin ?? model.presentation.geometry.windowMargin
    let size = CGSize(width: panel.width + 2 * border, height: panel.height + 2 * border)
    let width = Int((size.width * scale).rounded(.up))
    let height = Int((size.height * scale).rounded(.up))
    guard width > 0, height > 0,
      let ctx = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: WheelRenderer.srgb,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else { return nil }
    // y-down user space in points, like a flipped NSView.
    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: scale, y: -scale)
    if backdrop == .desktop { drawDesktop(ctx, size: size) }
    ctx.translateBy(x: border, y: border)
    WheelRenderer.draw(model, in: ctx, size: CGSize(width: panel.width, height: panel.height), drawShadow: shadow)
    return ctx.makeImage()
  }

  public static func writePNG(_ image: CGImage, to url: URL, scale: Double) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      throw HelperCLIError.io("cannot create \(url.lastPathComponent)")
    }
    let dpi = 72 * scale
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw HelperCLIError.io("cannot write \(url.lastPathComponent)") }
  }

  static func drawDesktop(_ ctx: CGContext, size: CGSize) {
    let colors = [
      CGColor(srgbRed: 0.98, green: 0.42, blue: 0.30, alpha: 1), CGColor(srgbRed: 0.97, green: 0.62, blue: 0.27, alpha: 1),
      CGColor(srgbRed: 0.93, green: 0.45, blue: 0.62, alpha: 1),
    ] as CFArray
    guard let gradient = CGGradient(colorsSpace: WheelRenderer.srgb, colors: colors, locations: [0, 0.55, 1]) else { return }
    ctx.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  }
}

public enum HelperCLIError: Error, CustomStringConvertible {
  case usage(String)
  case io(String)
  case unsupported(String)
  case failed(String)

  public var description: String {
    switch self {
    case .usage(let m), .io(let m), .unsupported(let m), .failed(let m): return m
    }
  }

  public var exitCode: Int32 {
    switch self {
    case .usage: return 2
    case .unsupported: return 3
    case .io, .failed: return 1
    }
  }

  public var code: String {
    switch self {
    case .usage: return "USAGE"
    case .io: return "IO_ERROR"
    case .unsupported: return "UNSUPPORTED"
    case .failed: return "FAILED"
    }
  }
}

/// Tiny argument reader: `--name value` pairs, flags and positionals, no abbreviations.
public struct CLIArguments {
  public private(set) var values: [String: String] = [:]
  public private(set) var flags: Set<String> = []
  public private(set) var positionals: [String] = []

  public init(_ args: [String], valued: Set<String>, flags known: Set<String>) throws {
    var i = 0
    while i < args.count {
      let a = args[i]
      if valued.contains(a) {
        guard i + 1 < args.count else { throw HelperCLIError.usage("\(a) needs a value") }
        values[a] = args[i + 1]
        i += 2
      } else if known.contains(a) {
        flags.insert(a)
        i += 1
      } else if a.hasPrefix("--") {
        throw HelperCLIError.usage("unknown option \(a)")
      } else {
        positionals.append(a)
        i += 1
      }
    }
  }

  public func double(_ name: String, in range: ClosedRange<Double>) throws -> Double? {
    guard let raw = values[name] else { return nil }
    guard let v = Double(raw), v.isFinite, range.contains(v) else { throw HelperCLIError.usage("\(name) must be a number in \(range.lowerBound)…\(range.upperBound)") }
    return v
  }

  public func int(_ name: String, in range: ClosedRange<Int>) throws -> Int? {
    guard let raw = values[name] else { return nil }
    guard let v = Int(raw), range.contains(v) else { throw HelperCLIError.usage("\(name) must be an integer in \(range.lowerBound)…\(range.upperBound)") }
    return v
  }
}
