import AppKit
import Darwin
import Foundation
import OrbitDropHelperCore

/// Reads the drag pasteboard into owned values. Called only from
/// draggingEntered / performDragOperation — never from the global observers,
/// which look at nothing but the drag pasteboard's change count.
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

/// Size/type check for the capsule, off the main thread (stat only; contents are never read).
public enum FileInfoResolver {
  public static func resolve(paths: [String], completion: @escaping @Sendable (_ totalBytes: Int64?, _ containsDirectory: Bool) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      var total: Int64 = 0
      var known = true
      var directory = false
      for path in paths {
        var info = stat()
        if stat(path, &info) == 0 {
          if (info.st_mode & S_IFMT) == S_IFDIR { directory = true }
          total += Int64(info.st_size)
        } else {
          known = false
        }
      }
      completion(known ? total : nil, directory)
    }
  }
}
