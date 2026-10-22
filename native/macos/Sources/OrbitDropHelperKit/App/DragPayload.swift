import AppKit
import Darwin
import Foundation
import OrbitDropHelperCore

/// Reads the drag pasteboard into owned values. Called once per session, from the
/// first draggingEntered (re-entries and performDragOperation reuse the result) —
/// never from the global observers, which look only at the drag pasteboard's change
/// count. The only file-system call is resolving a file-reference URL
/// (file:///.file/id=…) to a path, which Finder does not normally use.
public enum PasteboardReader {
  /// Types a file promise can arrive under (no real file exists yet → unsupported).
  public static let promiseTypes: Set<String> = {
    var types = Set(NSFilePromiseReceiver.readableDraggedTypes)
    types.formUnion(["com.apple.pasteboard.promised-file-url", "com.apple.NSFilePromiseItemMetaData", "Apple files promise pasteboard type", "com.apple.pasteboard.promised-file-content-type"])
    return types
  }()

  /// Types the wheel registers for: file URLs, promises (to recognise them as unsupported)
  /// and common non-file content (so a text/image/URL drag shows "unsupported" instead of nothing).
  public static var registeredTypes: [NSPasteboard.PasteboardType] {
    var types: [NSPasteboard.PasteboardType] = [.fileURL, .URL, .string, .tiff, .png, .pdf, .rtf, .html, .fileContents, .color]
    types.append(NSPasteboard.PasteboardType("NSFilenamesPboardType"))
    types.append(contentsOf: promiseTypes.map { NSPasteboard.PasteboardType($0) })
    return types
  }

  public static func items(_ pasteboard: NSPasteboard) -> [DragItem] {
    guard let items = pasteboard.pasteboardItems, !items.isEmpty else {
      return [.nonFile]
    }
    return items.prefix(HelperProtocol.maxFiles + 1).map(item)
  }

  static func item(_ item: NSPasteboardItem) -> DragItem {
    let types = Set(item.types.map(\.rawValue))
    if types.contains(NSPasteboard.PasteboardType.fileURL.rawValue), let raw = item.string(forType: .fileURL), let url = fileURL(from: raw) {
      return .file(path: url.path(percentEncoded: false), isDirectory: url.hasDirectoryPath)
    }
    if !types.isDisjoint(with: promiseTypes) { return .promise }
    return .nonFile
  }

  /// file:// URL (resolving file-reference URLs like file:///.file/id=…) or nil.
  static func fileURL(from raw: String) -> URL? {
    guard let url = URL(string: raw), url.isFileURL else { return nil }
    if url.path(percentEncoded: false).hasPrefix("/.file/id=") {
      return (url as NSURL).filePathURL
    }
    return url
  }
}

/// Size/type check for the capsule, off the main thread: one stat() per path, contents are never
/// opened or read — so a dataless (online-only) cloud file is recognised without downloading it.
public enum FileInfoResolver {
  public struct Info: Sendable, Equatable {
    /// Sum of the sizes; nil when a stat failed or the sum overflowed.
    public var totalBytes: Int64?
    /// A folder (or package) without the trailing slash that would have told us earlier.
    public var containsDirectory: Bool
    /// An online-only cloud file: `SF_DATALESS` is set (iCloud Drive, File Provider domains).
    public var containsCloudPlaceholder: Bool

    public init(totalBytes: Int64?, containsDirectory: Bool, containsCloudPlaceholder: Bool) {
      self.totalBytes = totalBytes
      self.containsDirectory = containsDirectory
      self.containsCloudPlaceholder = containsCloudPlaceholder
    }
  }

  public static func resolve(paths: [String], completion: @escaping @Sendable (Info) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      completion(summarize(paths.map { path -> stat? in
        var info = stat()
        return stat(path, &info) == 0 ? info : nil
      }))
    }
  }

  /// Folds stat results (nil = the stat failed) into what the capsule needs.
  static func summarize(_ results: [stat?]) -> Info {
    var total: Int64 = 0
    var known = true
    var info = Info(totalBytes: nil, containsDirectory: false, containsCloudPlaceholder: false)
    for result in results {
      guard let entry = result else {
        known = false
        continue
      }
      if (entry.st_mode & S_IFMT) == S_IFDIR { info.containsDirectory = true }
      if (entry.st_flags & UInt32(SF_DATALESS)) != 0 { info.containsCloudPlaceholder = true }
      if let sum = adding(total, Int64(entry.st_size)) { total = sum } else { known = false }
    }
    info.totalBytes = known ? total : nil
    return info
  }

  /// Sum of two sizes, nil on overflow (a plain `+` would trap: 200 sizes reported by a network
  /// file system can exceed Int64; APFS itself caps a file at 2^55 bytes).
  static func adding(_ a: Int64, _ b: Int64) -> Int64? {
    let (sum, overflow) = a.addingReportingOverflow(b)
    return overflow || sum < 0 ? nil : sum
  }
}
