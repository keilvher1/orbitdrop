import AppKit
import OrbitDropHelperCore

/// IconId → SF Symbol (all available on macOS 14). Generic glyphs chosen for meaning,
/// not copied from any other product.
public enum SymbolIcons {
  public static func symbolName(for icon: IconId) -> String {
    switch icon {
    case .compress: return "arrow.down.right.and.arrow.up.left"
    case .metadata: return "tag"
    case .edit: return "slider.horizontal.3"
    case .annotate: return "pencil.tip.crop.circle"
    case .background: return "photo.artframe"
    case .crop: return "crop"
    case .redact: return "eye.slash"
    }
  }

  /// Tinted symbol image, or nil when the symbol is missing (the label is drawn alone then).
  public static func image(for icon: IconId, pointSize: Double, weight: NSFont.Weight, color: RGBA) -> NSImage? {
    guard let base = NSImage(systemSymbolName: symbolName(for: icon), accessibilityDescription: nil) else { return nil }
    let tint = NSColor(srgbRed: color.r, green: color.g, blue: color.b, alpha: color.a)
    let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
      .applying(NSImage.SymbolConfiguration(paletteColors: [tint]))
    return base.withSymbolConfiguration(config)
  }
}
