// Turns the items of a real drag (read in draggingEntered) into a menu key and
// the sectors to show. Rules mirror packages/contracts/src/menus.ts `menuKeyFor`
// and packages/core/src/capabilities.ts `adjustMenuForFileCount`; the helper
// classifies by lower-case extension through the `extensions` map from
// `configure`. Any unknown extension, folder, file promise or non-file item
// makes the whole drag unsupported: the wheel never offers an action that would
// silently skip files.

/// One pasteboard item of the drag, already reduced to what classification needs.
/// Read once in draggingEntered; performDragOperation reuses it (no second read).
public enum DragItem: Sendable, Equatable {
  /// A file URL resolved to an absolute path. `isDirectory` comes from the URL
  /// itself (trailing slash) so no file-system access is needed to see a folder.
  case file(path: String, isDirectory: Bool)
  /// A file promise (e.g. Photos, Mail attachments) without a real file yet.
  case promise
  /// Text, web URLs, image data, …
  case nonFile
}

public enum Payload: Sendable, Equatable {
  /// Supported files: the menu key and the owned path strings (in drag order).
  case files(key: MenuKey, paths: [String])
  /// Not acceptable. `fileCount` counts the file items that were present.
  case unsupported(fileCount: Int, reason: UnsupportedReason)

  public var fileCount: Int {
    switch self {
    case .files(_, let paths): return paths.count
    case .unsupported(let count, _): return count
    }
  }

  public var menuKey: MenuKey? {
    if case .files(let key, _) = self { return key }
    return nil
  }

  public var paths: [String] {
    if case .files(_, let paths) = self { return paths }
    return []
  }

  public var unsupportedReason: UnsupportedReason? {
    if case .unsupported(_, let reason) = self { return reason }
    return nil
  }
}

public enum Classifier {
  // Port of packages/core/src/selection.ts (fileNameOfPath, asciiLower, extensionOfPath,
  // menuKeyForPaths). All parsing works on Unicode scalars — never Characters, never
  // normalization — so it matches the reference's UTF-16 code-unit semantics.

  static func isSeparator(_ s: Unicode.Scalar) -> Bool { s == "/" || s == "\\" }

  /// Last path component; both '/' and '\' separate; trailing separators are ignored.
  public static func fileNameOfPath(_ path: String) -> String {
    let scalars = Array(path.unicodeScalars)
    var end = scalars.count
    while end > 0 && isSeparator(scalars[end - 1]) { end -= 1 }
    var start = end
    while start > 0 && !isSeparator(scalars[start - 1]) { start -= 1 }
    var view = String.UnicodeScalarView()
    view.append(contentsOf: scalars[start..<end])
    return String(view)
  }

  /// ASCII-only lower-casing (A–Z → a–z); every other scalar is kept as is.
  public static func asciiLower(_ text: String) -> String {
    var view = String.UnicodeScalarView()
    for s in text.unicodeScalars {
      view.append((0x41...0x5A).contains(s.value) ? Unicode.Scalar(s.value + 32)! : s)
    }
    return String(view)
  }

  /// Extension including the dot, ASCII-lower-cased; "" when the name has no dot,
  /// only a leading dot (".png" is a hidden file) or ends with a dot ("photo.").
  public static func extensionOfPath(_ path: String) -> String {
    let name = Array(fileNameOfPath(path).unicodeScalars)
    guard let dot = name.lastIndex(of: "."), dot > 0, dot != name.count - 1 else { return "" }
    var view = String.UnicodeScalarView()
    view.append(contentsOf: name[dot...])
    return asciiLower(String(view))
  }

  /// `menuKeyForPaths`: every path must map (through the configure `extensions` map) to
  /// 'pdf' or 'image/<fmt>'; an empty list, an empty path, a path ending in '/' or '\'
  /// (a folder) or any unknown extension makes the selection unsupported (nil).
  public static func menuKeyForPaths(_ paths: [String], extensions: [String: MenuKey]) -> MenuKey? {
    if paths.isEmpty { return nil }
    var keys: [MenuKey] = []
    for path in paths {
      guard let last = path.unicodeScalars.last, !isSeparator(last) else { return nil }
      let ext = extensionOfPath(path)
      // Map keys are ASCII (^\.[a-z0-9]{1,8}$). Swift String equality is canonical
      // equivalence, so only ASCII extensions are looked up: code-unit exact, like JS.
      guard !ext.isEmpty, ext.unicodeScalars.allSatisfy(\.isASCII), let key = extensions[ext], key.isSingleFileKey else { return nil }
      keys.append(key)
    }
    return combinedMenuKey(keys)
  }

  /// `menuKeyFor` over single-file keys: pdf + images → mixed, all pdf → pdf,
  /// one image format → image/<fmt>, several image formats → images.
  public static func combinedMenuKey(_ keys: [MenuKey]) -> MenuKey? {
    if keys.isEmpty { return nil }
    var pdf = 0
    var images: [ImageFormat] = []
    for key in keys {
      switch key {
      case .pdf: pdf += 1
      case .image(let format): if !images.contains(format) { images.append(format) }
      case .images, .mixed: return nil
      }
    }
    if pdf > 0 && !images.isEmpty { return .mixed }
    if pdf > 0 { return .pdf }
    if images.count == 1 { return .image(images[0]) }
    return .images
  }

  public static func classify(_ items: [DragItem], extensions: [String: MenuKey]) -> Payload {
    let fileCount = items.reduce(0) { count, item in
      if case .file = item { return count + 1 }
      return count
    }
    guard !items.isEmpty else { return .unsupported(fileCount: 0, reason: .nonFile) }
    guard items.count <= HelperProtocol.maxFiles else { return .unsupported(fileCount: fileCount, reason: .tooMany) }
    // The most specific reason wins: items without a file on disk, then folders, then non-file data.
    var hasPromise = false
    var hasFolder = false
    var hasNonFile = false
    var paths: [String] = []
    for item in items {
      switch item {
      case .promise: hasPromise = true
      case .nonFile: hasNonFile = true
      case .file(let path, let isDirectory):
        if isDirectory || path.unicodeScalars.last.map(isSeparator) == true { hasFolder = true }
        paths.append(path)
      }
    }
    if hasPromise { return .unsupported(fileCount: fileCount, reason: .virtual) }
    if hasFolder { return .unsupported(fileCount: fileCount, reason: .folder) }
    if hasNonFile { return .unsupported(fileCount: fileCount, reason: .nonFile) }
    guard paths.allSatisfy({ $0.hasPrefix("/") && $0.unicodeScalars.count <= HelperProtocol.maxPathLength }),
      let key = menuKeyForPaths(paths, extensions: extensions)
    else { return .unsupported(fileCount: fileCount, reason: .unknownType) }
    return .files(key: key, paths: paths)
  }

  /// Sectors for a payload in a mode, or nil when there is nothing to offer
  /// (unsupported payload, no menu for the key, or an empty menu for this mode).
  public static func sectors(for payload: Payload, mode: WheelMode, config: HelperConfig) -> [WheelSector]? {
    guard case .files(let key, let paths) = payload, let menu = config.menu(for: key) else { return nil }
    let sectors = Array(menu.sectors(for: mode).prefix(HelperProtocol.maxSectorsPerMenu))
    if sectors.isEmpty { return nil }
    return adjustForFileCount(sectors, fileCount: paths.count, reason: config.strings.multiFileUnsupported)
  }

  /// Disable non-batch sectors when several files are dragged together
  /// (already-disabled sectors keep their own reason).
  public static func adjustForFileCount(_ sectors: [WheelSector], fileCount: Int, reason: String) -> [WheelSector] {
    guard fileCount > 1 else { return sectors }
    return sectors.map { sector in
      guard !sector.batch, sector.enabled else { return sector }
      var copy = sector
      copy.enabled = false
      copy.reason = reason
      return copy
    }
  }
}

/// Deterministic, locale-independent size text like Finder's ("1.2 MB"; decimal units).
public enum ByteFormat {
  public static func short(_ bytes: Int64) -> String {
    let value = Double(max(bytes, 0))
    if value < 1000 { return "\(Int64(value)) B" }
    if value < 999_500 { return "\(Int64((value / 1000).rounded())) KB" }
    if value < 999_950_000 { return oneDecimal(value / 1_000_000) + " MB" }
    if value < 999_995_000_000 { return twoDecimals(value / 1_000_000_000) + " GB" }
    return twoDecimals(value / 1_000_000_000_000) + " TB"
  }

  private static func oneDecimal(_ x: Double) -> String {
    let tenths = Int64((x * 10).rounded())
    return "\(tenths / 10).\(tenths % 10)"
  }

  private static func twoDecimals(_ x: Double) -> String {
    let hundredths = Int64((x * 100).rounded())
    let fraction = hundredths % 100
    return "\(hundredths / 100).\(fraction < 10 ? "0" : "")\(fraction)"
  }
}
