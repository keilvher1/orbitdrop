import Foundation
import OrbitDropHelperCore

/// `OrbitDropHelper --render-snapshot <out.png> --menu <MenuKey> --mode convert|tools
///   [--highlight <i>] [--highlight-style active|rejected|hover] [--diameter 360]
///   [--locale ko|en] [--theme light|dark|highContrast] [--config <configure.json>]
///   [--state neutral|active] [--files <n>] [--size <bytes>] [--scale 2]
///   [--backdrop none|desktop]`
///
/// Renders the wheel offscreen (no window) with the built-in default menus/tokens,
/// or with a `configure` message loaded from --config.
public enum SnapshotCommand {
  public static let usage = """
    usage: OrbitDropHelper --render-snapshot <out.png> --menu <MenuKey> --mode convert|tools
             [--highlight <index>] [--highlight-style active|rejected|hover]
             [--diameter 200…600] [--locale ko|en] [--theme light|dark|highContrast]
             [--config <configure.json>] [--state neutral|active] [--files <n>] [--size <bytes>]
             [--scale 1…4] [--backdrop none|desktop]
    """

  public static func run(_ args: [String]) -> Int32 {
    do {
      let model = try makeModel(args)
      let parsed = try parse(args)
      let scale = try parsed.double("--scale", in: 1...4) ?? 2
      let backdrop = Snapshot.Backdrop(rawValue: parsed.values["--backdrop"] ?? "none") ?? .none
      guard let out = parsed.values["--render-snapshot"] else { throw HelperCLIError.usage(usage) }
      guard let image = Snapshot.render(model, scale: scale, backdrop: backdrop) else { throw HelperCLIError.failed("rendering failed") }
      try Snapshot.writePNG(image, to: URL(fileURLWithPath: out), scale: scale)
      print("{\"ok\":true,\"width\":\(image.width),\"height\":\(image.height)}")
      return 0
    } catch let error as HelperCLIError {
      FileHandle.standardError.write(Data("OrbitDropHelper: \(error.description)\n".utf8))
      return error.exitCode
    } catch {
      FileHandle.standardError.write(Data("OrbitDropHelper: \(error)\n".utf8))
      return 1
    }
  }

  static func parse(_ args: [String]) throws -> CLIArguments {
    try CLIArguments(
      args,
      valued: ["--render-snapshot", "--menu", "--mode", "--highlight", "--highlight-style", "--diameter", "--locale", "--theme", "--config", "--state", "--files", "--size", "--scale", "--backdrop"],
      flags: []
    )
  }

  /// Builds the view model the snapshot shows (also used by tests).
  public static func makeModel(_ args: [String]) throws -> WheelViewModel {
    let a = try parse(args)
    guard a.positionals.isEmpty else { throw HelperCLIError.usage(usage) }
    guard let menuRaw = a.values["--menu"], let key = MenuKey(rawValue: menuRaw) else { throw HelperCLIError.usage("--menu must be a MenuKey (pdf, image/jpeg, …, images, mixed)") }
    guard let modeRaw = a.values["--mode"], let mode = WheelMode(rawValue: modeRaw) else { throw HelperCLIError.usage("--mode must be convert or tools") }
    let locale = try a.values["--locale"].map { raw -> HelperLocale in
      guard let l = HelperLocale(rawValue: raw) else { throw HelperCLIError.usage("--locale must be ko or en") }
      return l
    } ?? .ko
    let theme = try a.values["--theme"].map { raw -> ThemeName in
      guard let t = ThemeName(rawValue: raw) else { throw HelperCLIError.usage("--theme must be light, dark or highContrast") }
      return t
    } ?? .light

    var config: HelperConfig
    if let path = a.values["--config"] {
      let data: Data
      do { data = try Data(contentsOf: URL(fileURLWithPath: path)) } catch { throw HelperCLIError.io("cannot read --config") }
      switch NDJSON.parseMainLine(Array(data)) {
      case .message(.configure(let c)): config = c
      case .invalid(let e): throw HelperCLIError.usage("--config is not a valid configure message: \(e)")
      default: throw HelperCLIError.usage("--config is not a configure message")
      }
    } else {
      config = DefaultConfig.config(locale: locale, theme: theme)
    }
    if let d = try a.double("--diameter", in: 200...600) { config.geometry.diameter = d }

    let files = try a.int("--files", in: 1...HelperProtocol.maxFiles) ?? 1
    let size = try a.int("--size", in: 0...Int(Int32.max)).map(Int64.init)
    let ext = key.inputLabel.map { "." + $0.lowercased() } ?? ".bin"
    let payload = Payload.files(key: key, paths: (1...files).map { "/snapshot/file\($0)\(ext)" })

    let diameter = config.geometry.diameter
    let half = diameter / 2 + config.geometry.windowMargin
    let placement = WheelPlacement(center: Point(x: half, y: half), diameter: diameter, windowFrame: Rect(x: 0, y: 0, width: half * 2, height: half * 2), shifted: false)
    let presentation = WheelPresentation(placement: placement, geometry: config.geometry, tokens: config.tokens, highContrast: config.highContrast, reduceMotion: true, mode: mode)

    if a.values["--state"] == "neutral" {
      return WheelViewModel(presentation: presentation, content: .neutral, capsule: CapsuleContent(text: config.strings.dropHint, style: .hint))
    }
    guard let sectors = Classifier.sectors(for: payload, mode: mode, config: config) else {
      return WheelViewModel(presentation: presentation, content: .unsupported, capsule: CapsuleContent(text: config.strings.unsupported, style: .reject))
    }
    var capsule: CapsuleContent
    if files > 1 {
      capsule = CapsuleContent(text: config.strings.fileCountText(files), style: .info)
    } else if let size {
      capsule = CapsuleContent(text: ByteFormat.short(size), style: .info)
    } else {
      capsule = CapsuleContent(text: key.inputLabel ?? "", style: .info)
    }
    var highlight: SectorHighlight?
    if let index = try a.int("--highlight", in: 0...(sectors.count - 1)) {
      let sector = sectors[index]
      let style: SectorHighlightStyle
      switch a.values["--highlight-style"] {
      case nil: style = sector.enabled ? .active : .rejected
      case "active": style = .active
      case "rejected": style = .rejected
      case "hover": style = .hover
      default: throw HelperCLIError.usage("--highlight-style must be active, rejected or hover")
      }
      highlight = SectorHighlight(index: index, style: style)
      switch style {
      case .active: capsule = CapsuleContent(text: sector.label, style: .action)
      case .rejected: capsule = CapsuleContent(text: (sector.reason?.isEmpty == false ? sector.reason! : config.strings.unsupported), style: .reject)
      case .hover: break
      }
    }
    return WheelViewModel(presentation: presentation, content: .sectors(sectors), highlight: highlight, capsule: capsule)
  }
}
