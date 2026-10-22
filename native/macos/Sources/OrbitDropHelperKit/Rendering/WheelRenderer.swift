import AppKit
import CoreGraphics
import CoreText
import OrbitDropHelperCore

/// Draws the wheel for a `WheelViewModel` into a CoreGraphics context whose user
/// space is y-down with the origin at the top-left of the wheel panel (a flipped
/// NSView, or a bitmap context with a flip transform). The same code renders the
/// live panel and `--render-snapshot`, so screenshots show exactly what users see.
///
/// Hit shape: the live panel paints nothing outside the disc and the caption pill
/// (alpha stays 0 there), so drags pass through to the window underneath. Its shadow
/// comes from the window server (`hasShadow`); `drawShadow` paints an equivalent one
/// only for offscreen snapshots, which have no window server.
public enum WheelRenderer {
  /// - Parameters:
  ///   - size: panel content size in points (`presentation.layout.frame`).
  ///   - appear: 0…1 appear progress (scales 0.92 → 1 about the disc center; snapshots/tests).
  ///   - drawShadow: paint the soft shadow outside the disc (snapshots only).
  public static func draw(_ model: WheelViewModel, in ctx: CGContext, size: CGSize, appear: CGFloat = 1, drawShadow: Bool = false) {
    let p = model.presentation
    let g = p.geometry
    let t = p.tokens
    let hc = p.highContrast
    let diameter = p.placement.diameter
    let radius = diameter / 2
    let ri = WheelMath.innerRadius(diameter, g)
    let ro = WheelMath.sectorOuterRadius(diameter, g)
    let center = CGPoint(x: p.layout.discCenter.x, y: p.layout.discCenter.y)

    ctx.saveGState()
    defer { ctx.restoreGState() }
    // NSImage/NSAttributedString drawing (SF Symbols) needs a current NSGraphicsContext.
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    defer { NSGraphicsContext.restoreGraphicsState() }

    ctx.setShouldAntialias(true)
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high
    let deviceScale = deviceScaleFactor(ctx)

    // Secondary hint outside the ring (panel-local coordinates).
    if let caption = model.caption, let rect = p.layout.captionRect {
      drawCaption(ctx, caption, in: CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height), t: t, highContrast: hc, shadow: drawShadow ? deviceScale : nil)
    }

    ctx.translateBy(x: center.x, y: center.y)
    let scale = 0.92 + 0.08 * min(max(appear, 0), 1)
    if scale != 1 { ctx.scaleBy(x: scale, y: scale) }

    // Snapshot-only soft shadow, outside the disc so it never shows through the translucent
    // disc (offsets are in device space, y up: negative = down). The live panel uses hasShadow.
    let discRect = CGRect(x: -radius, y: -radius, width: diameter, height: diameter)
    if drawShadow && t.wheelShadow.a > 0 && !hc {
      ctx.saveGState()
      let outside = CGMutablePath()
      outside.addRect(CGRect(x: -size.width, y: -size.height, width: size.width * 2, height: size.height * 2))
      outside.addEllipse(in: discRect)
      ctx.addPath(outside)
      ctx.clip(using: .evenOdd)
      let blur = min(g.windowMargin * 0.75, 18)
      ctx.setShadow(offset: CGSize(width: 0, height: -min(6, g.windowMargin * 0.25) * deviceScale), blur: blur * deviceScale, color: cg(t.wheelShadow))
      ctx.setFillColor(CGColor(gray: 0, alpha: 1))
      ctx.fillEllipse(in: discRect)
      ctx.restoreGState()
    }
    // Invisible floor (alpha 1/255): the whole disc — gaps and dead zone included — stays in the
    // window's hit shape even if a theme made the disc token transparent.
    ctx.setFillColor(CGColor(gray: 0, alpha: 1.0 / 255.0))
    ctx.fillEllipse(in: discRect)
    ctx.setFillColor(cg(t.wheelDisc))
    ctx.fillEllipse(in: discRect)

    // Sector band.
    switch model.content {
    case .neutral:
      fillBand(ctx, ri: ri, ro: ro, color: t.sector.withAlpha(t.sector.a * 0.55))
    case .unsupported:
      fillBand(ctx, ri: ri, ro: ro, color: t.sectorDisabled)
    case .sectors(let sectors):
      drawSectors(ctx, sectors, model.highlight, g: g, t: t, ri: ri, ro: ro, highContrast: hc)
    }

    // Thin outer ring.
    let ringWidth = hc ? max(2, g.ringWidth) : g.ringWidth
    if ringWidth > 0 {
      ctx.setStrokeColor(cg(t.wheelRing))
      ctx.setLineWidth(ringWidth)
      let r = radius - ringWidth / 2
      ctx.strokeEllipse(in: CGRect(x: -r, y: -r, width: r * 2, height: r * 2))
    }

    drawCapsule(ctx, model.capsule, g: g, t: t, innerRadius: ri, highContrast: hc)
  }

  // MARK: Sectors

  static func drawSectors(_ ctx: CGContext, _ sectors: [WheelSector], _ highlight: SectorHighlight?, g: WheelGeometry, t: WheelTokens, ri: Double, ro: Double, highContrast hc: Bool) {
    let count = sectors.count
    guard count > 0 else { return }
    for (index, sector) in sectors.enumerated() {
      let outline = SectorShape.outline(index: index, count: count, innerRadius: ri, outerRadius: ro, gap: g.sectorGap, cornerRadius: g.sectorCornerRadius, startAngleDeg: g.startAngleDeg)
      let path = cgPath(outline)
      let style = highlight?.index == index ? highlight?.style : nil
      let fill: RGBA
      switch style {
      case .active?: fill = t.sectorActive
      case .rejected?: fill = t.capsuleReject
      case .hover?: fill = sector.enabled ? t.sectorHover : t.sectorDisabled
      case nil: fill = sector.enabled ? t.sector : t.sectorDisabled
      }
      ctx.addPath(path)
      ctx.setFillColor(cg(fill))
      if outline.isFullRing { ctx.fillPath(using: .evenOdd) } else { ctx.fillPath() }

      if style == .rejected {
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip(using: outline.isFullRing ? .evenOdd : .winding)
        ctx.addPath(path)
        ctx.setStrokeColor(cg(t.capsuleText.withAlpha(t.capsuleText.a * 0.6)))
        ctx.setLineWidth(3)  // clipped to the inside: 1.5 pt visible
        ctx.setLineDash(phase: 0, lengths: [5, 4])
        ctx.strokePath()
        ctx.restoreGState()
      }
      if hc {
        ctx.addPath(path)
        ctx.setStrokeColor(cg(t.sectorText))
        ctx.setLineWidth(style == .active ? 2.5 : 1.25)
        ctx.strokePath()
      }

      let textColor: RGBA
      let iconColor: RGBA
      switch style {
      case .active?:
        textColor = t.sectorActiveText
        iconColor = t.sectorActiveText
      case .rejected?:
        // capsuleReject is designed to carry capsuleText (sectorDisabledText can equal it, e.g. high contrast).
        textColor = t.capsuleText.withAlpha(t.capsuleText.a * 0.85)
        iconColor = t.capsuleText.withAlpha(t.capsuleText.a * 0.85)
      default:
        textColor = sector.enabled ? t.sectorText : t.sectorDisabledText
        iconColor = sector.enabled ? t.sectorIcon : t.sectorDisabledText
      }
      let anchor = SectorShape.labelAnchor(index: index, count: count, innerRadius: ri, outerRadius: ro, startAngleDeg: g.startAngleDeg)
      let maxWidth = SectorShape.labelWidth(count: count, innerRadius: ri, outerRadius: ro, gap: g.sectorGap)
      drawLabel(ctx, sector, at: CGPoint(x: anchor.x, y: anchor.y), maxWidth: maxWidth, t: t, textColor: textColor, iconColor: iconColor)
    }
  }

  static func drawLabel(_ ctx: CGContext, _ sector: WheelSector, at anchor: CGPoint, maxWidth: Double, t: WheelTokens, textColor: RGBA, iconColor: RGBA) {
    let isASCII = sector.label.unicodeScalars.allSatisfy(\.isASCII)
    let line = fittedLine(sector.label, size: t.labelSize, minSize: 9, weight: t.labelWeight, color: textColor, maxWidth: maxWidth, kern: isASCII ? 0.4 : 0)
    let metrics = lineMetrics(line)
    var symbolImage: NSImage?
    if let icon = sector.icon { symbolImage = SymbolIcons.image(for: icon, pointSize: t.iconSize, weight: fontWeight(t.labelWeight), color: iconColor) }
    let iconHeight = symbolImage.map { Double($0.size.height) } ?? 0
    let spacing = symbolImage == nil ? 0 : 4.0
    let total = iconHeight + spacing + metrics.height
    var top = Double(anchor.y) - total / 2
    if let image = symbolImage {
      let s = image.size
      image.draw(in: NSRect(x: Double(anchor.x) - Double(s.width) / 2, y: top, width: Double(s.width), height: Double(s.height)), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
      top += iconHeight + spacing
    }
    drawLine(ctx, line, centerX: Double(anchor.x), top: top, metrics: metrics)
  }

  static func fillBand(_ ctx: CGContext, ri: Double, ro: Double, color: RGBA) {
    let path = CGMutablePath()
    path.addEllipse(in: CGRect(x: -ro, y: -ro, width: ro * 2, height: ro * 2))
    path.addEllipse(in: CGRect(x: -ri, y: -ri, width: ri * 2, height: ri * 2))
    ctx.addPath(path)
    ctx.setFillColor(cg(color))
    ctx.fillPath(using: .evenOdd)
  }

  static func cgPath(_ outline: SectorOutline) -> CGPath {
    let path = CGMutablePath()
    for element in outline.elements {
      switch element {
      case .move(let p): path.move(to: CGPoint(x: p.x, y: p.y))
      case .line(let p): path.addLine(to: CGPoint(x: p.x, y: p.y))
      case .arc(let c, let r, let start, let end, let increasing):
        path.addArc(center: CGPoint(x: c.x, y: c.y), radius: r, startAngle: start, endAngle: end, clockwise: !increasing)
      case .close: path.closeSubpath()
      }
    }
    return path
  }

  // MARK: Caption (secondary hint)

  /// One-line pill centered in the caption strip: the armed choice (or why it is refused),
  /// readable even when the drag image covers the sector and the capsule.
  static func drawCaption(_ ctx: CGContext, _ caption: CapsuleContent, in strip: CGRect, t: WheelTokens, highContrast hc: Bool, shadow deviceScale: CGFloat?) {
    let hPad = 12.0
    let size = min(13, max(10, t.capsuleTextSize - 3))
    let weight = max(t.labelWeight, 600)
    let line = fittedLine(caption.text, size: size, minSize: 10, weight: weight, color: t.capsuleText, maxWidth: Double(strip.width) - 2 * hPad, kern: 0)
    let metrics = lineMetrics(line)
    let width = min(Double(strip.width), max(56, metrics.width + 2 * hPad))
    let rect = CGRect(x: Double(strip.midX) - width / 2, y: Double(strip.minY), width: width, height: Double(strip.height))
    let path = CGPath(roundedRect: rect, cornerWidth: rect.height / 2, cornerHeight: rect.height / 2, transform: nil)
    ctx.saveGState()
    if let deviceScale, t.wheelShadow.a > 0, !hc {
      ctx.setShadow(offset: CGSize(width: 0, height: -2 * deviceScale), blur: 6 * deviceScale, color: cg(t.wheelShadow))
    }
    ctx.addPath(path)
    // Opaque pill: it is part of the panel's hit shape (a drop on it is a cancel by design).
    let fill = caption.style == .reject ? t.capsuleReject : t.capsule
    ctx.setFillColor(cg(fill.withAlpha(1)))
    ctx.fillPath()
    ctx.restoreGState()
    if hc {
      // Stroked inside the pill: a stroke centred on its edge would put a 0.75 pt line of
      // opaque pixels into the transparent gap next to the disc — outside the hit shape.
      let lineWidth = 1.5
      let inner = rect.insetBy(dx: lineWidth / 2, dy: lineWidth / 2)
      ctx.addPath(CGPath(roundedRect: inner, cornerWidth: inner.height / 2, cornerHeight: inner.height / 2, transform: nil))
      ctx.setStrokeColor(cg(t.sectorText))
      ctx.setLineWidth(lineWidth)
      ctx.strokePath()
    }
    drawLine(ctx, line, centerX: Double(rect.midX), top: Double(rect.midY) - metrics.height / 2, metrics: metrics)
  }

  // MARK: Capsule

  static func drawCapsule(_ ctx: CGContext, _ capsule: CapsuleContent, g: WheelGeometry, t: WheelTokens, innerRadius ri: Double, highContrast hc: Bool) {
    let layout = CapsuleLayout.make(text: capsule.text, style: capsule.style, g: g, t: t, innerRadius: ri)
    let rect = CGRect(x: -layout.width / 2, y: -layout.height / 2, width: layout.width, height: layout.height)
    let path = CGPath(roundedRect: rect, cornerWidth: layout.cornerRadius, cornerHeight: layout.cornerRadius, transform: nil)
    let fill: RGBA
    switch capsule.style {
    case .reject: fill = t.capsuleReject
    case .hint: fill = t.capsule.withAlpha(t.capsule.a * 0.8)
    case .info, .action: fill = t.capsule
    }
    ctx.addPath(path)
    ctx.setFillColor(cg(fill))
    ctx.fillPath()
    if hc {
      ctx.addPath(path)
      ctx.setStrokeColor(cg(t.sectorText))
      ctx.setLineWidth(1.5)
      ctx.strokePath()
    }
    guard !layout.lines.isEmpty else { return }
    var top = -layout.textHeight / 2
    for line in layout.lines {
      let metrics = lineMetrics(line)
      drawLine(ctx, line, centerX: 0, top: top, metrics: metrics)
      top += metrics.height + layout.lineSpacing
    }
  }

  // MARK: Text helpers

  struct LineMetrics {
    var width: Double
    var ascent: Double
    var descent: Double
    var height: Double { ascent + descent }
  }

  static func lineMetrics(_ line: CTLine) -> LineMetrics {
    var ascent: CGFloat = 0
    var descent: CGFloat = 0
    var leading: CGFloat = 0
    let width = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
    return LineMetrics(width: width, ascent: Double(ascent), descent: Double(descent))
  }

  /// Draws a CTLine horizontally centered at `centerX`, its typographic box starting at `top` (y-down space).
  static func drawLine(_ ctx: CGContext, _ line: CTLine, centerX: Double, top: Double, metrics: LineMetrics) {
    ctx.saveGState()
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)  // glyphs upright in a y-down space
    ctx.textPosition = CGPoint(x: centerX - metrics.width / 2, y: top + metrics.ascent)
    CTLineDraw(line, ctx)
    ctx.restoreGState()
  }

  static func makeLine(_ text: String, size: Double, weight: Int, color: RGBA, kern: Double = 0) -> CTLine {
    let font = NSFont.systemFont(ofSize: size, weight: fontWeight(weight))
    var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: nsColor(color)]
    if kern != 0 { attributes[.kern] = kern }
    return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
  }

  /// Shrinks the font down to `minSize` to fit `maxWidth`, then truncates with an ellipsis.
  static func fittedLine(_ text: String, size: Double, minSize: Double, weight: Int, color: RGBA, maxWidth: Double, kern: Double) -> CTLine {
    var s = size
    while s > minSize {
      let line = makeLine(text, size: s, weight: weight, color: color, kern: kern)
      if lineMetrics(line).width <= maxWidth { return line }
      s -= 0.5
    }
    let line = makeLine(text, size: minSize, weight: weight, color: color, kern: kern)
    if lineMetrics(line).width <= maxWidth { return line }
    let ellipsis = makeLine("…", size: minSize, weight: weight, color: color)
    return CTLineCreateTruncatedLine(line, maxWidth, .end, ellipsis) ?? line
  }

  static func fontWeight(_ cssWeight: Int) -> NSFont.Weight {
    switch cssWeight {
    case ..<150: return .ultraLight
    case ..<250: return .thin
    case ..<350: return .light
    case ..<450: return .regular
    case ..<550: return .medium
    case ..<650: return .semibold
    case ..<750: return .bold
    case ..<850: return .heavy
    default: return .black
    }
  }

  // MARK: Color helpers

  static let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

  static func cg(_ c: RGBA) -> CGColor {
    CGColor(colorSpace: srgb, components: [c.r, c.g, c.b, c.a]) ?? CGColor(gray: 0, alpha: 1)
  }

  static func nsColor(_ c: RGBA) -> NSColor {
    NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: c.a)
  }

  /// Pixels per user-space unit (2 on Retina) — CoreGraphics shadow parameters are in device units.
  static func deviceScaleFactor(_ ctx: CGContext) -> CGFloat {
    let m = ctx.userSpaceToDeviceSpaceTransform
    let s = (m.a * m.a + m.b * m.b).squareRoot()
    return s > 0 ? s : 1
  }
}

/// Text layout of the center capsule: the hovered action, a disabled reason, the
/// drop hint, or the file count/size. Short texts use one line in a pill; reasons
/// may wrap to three lines inside the dead zone, shrinking the font if needed.
struct CapsuleLayout {
  var lines: [CTLine]
  var width: Double
  var height: Double
  var textHeight: Double
  var lineSpacing: Double
  var cornerRadius: Double

  static func make(text: String, style: CapsuleStyle, g: WheelGeometry, t: WheelTokens, innerRadius ri: Double) -> CapsuleLayout {
    let hPad = 14.0
    let vPad = 8.0
    let maxWidth = max(g.capsuleWidth, min(ri * 2 * 0.9, 230))
    let maxLines = (style == .reject || style == .hint) ? 3 : 2
    let maxTextHeight = ri * 2 * 0.72 - 2 * vPad
    let color = t.capsuleText
    let weight = max(t.labelWeight, 600)
    var chosen: [CTLine] = []
    var size = t.capsuleTextSize
    let minSize = min(10.0, size)
    if text.isEmpty {
      return CapsuleLayout(lines: [], width: g.capsuleWidth, height: g.capsuleHeight, textHeight: 0, lineSpacing: 0, cornerRadius: g.capsuleHeight / 2)
    }
    while true {
      let lines = wrap(text, size: size, weight: weight, color: color, width: maxWidth - 2 * hPad)
      let height = lines.reduce(0) { $0 + WheelRenderer.lineMetrics($1).height } + Double(max(lines.count - 1, 0)) * 2
      if lines.count <= maxLines && height <= maxTextHeight {
        chosen = lines
        break
      }
      if size <= minSize {
        // Keep the first lines and truncate the last one.
        var kept = Array(lines.prefix(maxLines))
        if lines.count > maxLines, let last = kept.last {
          let ellipsis = WheelRenderer.makeLine("…", size: size, weight: weight, color: color)
          kept[kept.count - 1] = CTLineCreateTruncatedLine(last, maxWidth - 2 * hPad - 1, .end, ellipsis) ?? last
        }
        chosen = kept
        break
      }
      size = max(minSize, size - 1)
    }
    let widths = chosen.map { WheelRenderer.lineMetrics($0).width }
    let textHeight = chosen.reduce(0) { $0 + WheelRenderer.lineMetrics($1).height } + Double(max(chosen.count - 1, 0)) * 2
    let width = min(maxWidth, max(g.capsuleWidth, (widths.max() ?? 0) + 2 * hPad))
    let height = max(g.capsuleHeight, textHeight + 2 * vPad)
    let corner = chosen.count <= 1 ? height / 2 : min(height / 2, 20)
    return CapsuleLayout(lines: chosen, width: width, height: height, textHeight: textHeight, lineSpacing: 2, cornerRadius: corner)
  }

  /// Word-based line breaking (keeps Korean words such as "인코더가" together, like
  /// `word-break: keep-all`); a single word wider than the line falls back to
  /// CoreText's typesetter, which may break inside it.
  static func wrap(_ text: String, size: Double, weight: Int, color: RGBA, width: Double) -> [CTLine] {
    func line(_ s: String) -> CTLine { WheelRenderer.makeLine(s, size: size, weight: weight, color: color) }
    func fits(_ s: String) -> Bool { WheelRenderer.lineMetrics(line(s)).width <= width }
    var lines: [String] = []
    var current = ""
    for word in text.split(separator: " ", omittingEmptySubsequences: true).map(String.init) {
      let candidate = current.isEmpty ? word : current + " " + word
      if fits(candidate) {
        current = candidate
        continue
      }
      if !current.isEmpty { lines.append(current) }
      if fits(word) {
        current = word
      } else {
        let pieces = typesetterWrap(word, size: size, weight: weight, color: color, width: width)
        lines.append(contentsOf: pieces.dropLast())
        current = pieces.last ?? ""
      }
      if lines.count > 12 { break }
    }
    if !current.isEmpty { lines.append(current) }
    return lines.map(line)
  }

  /// CoreText line breaking for text without usable spaces.
  static func typesetterWrap(_ text: String, size: Double, weight: Int, color: RGBA, width: Double) -> [String] {
    let font = NSFont.systemFont(ofSize: size, weight: WheelRenderer.fontWeight(weight))
    let attributed = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: WheelRenderer.nsColor(color)])
    let typesetter = CTTypesetterCreateWithAttributedString(attributed)
    let ns = text as NSString
    var pieces: [String] = []
    var start = 0
    while start < ns.length && pieces.count <= 12 {
      var count = CTTypesetterSuggestLineBreak(typesetter, start, width)
      if count <= 0 { count = 1 }
      pieces.append(ns.substring(with: NSRange(location: start, length: min(count, ns.length - start))))
      start += count
    }
    return pieces
  }
}
