import AppKit
import XCTest

@testable import OrbitDropHelperCore
@testable import OrbitDropHelperKit

/// Reading drag payloads from a private, uniquely named pasteboard (the user's
/// general and drag pasteboards are never touched).
final class PasteboardTests: XCTestCase {
  var pasteboard: NSPasteboard!

  override func setUp() {
    pasteboard = NSPasteboard(name: NSPasteboard.Name("com.orbitdrop.helper.tests.\(UUID().uuidString)"))
    pasteboard.clearContents()
  }

  override func tearDown() {
    pasteboard.releaseGlobally()
  }

  func testFileURLsBecomeOwnedPaths() {
    let file = URL(fileURLWithPath: "/Users/someone/문서/Page 001 😀 #1%.pdf")
    let folder = URL(fileURLWithPath: "/Users/someone/Folder.pdf", isDirectory: true)
    XCTAssertTrue(pasteboard.writeObjects([file as NSURL, folder as NSURL]))
    let items = PasteboardReader.items(pasteboard)
    XCTAssertEqual(items, [
      .file(path: "/Users/someone/문서/Page 001 😀 #1%.pdf", isDirectory: false),
      .file(path: "/Users/someone/Folder.pdf/", isDirectory: true),
    ])
    XCTAssertEqual(Classifier.classify(items, extensions: DefaultConfig.extensions), .unsupported(fileCount: 2, reason: .folder), "a folder makes the drag unsupported")
    XCTAssertEqual(Classifier.classify(Array(items.prefix(1)), extensions: DefaultConfig.extensions), .files(key: .pdf, paths: ["/Users/someone/문서/Page 001 😀 #1%.pdf"]))
  }

  func testNonFileAndPromiseItems() {
    pasteboard.setString("just text", forType: .string)
    XCTAssertEqual(PasteboardReader.items(pasteboard), [.nonFile])

    pasteboard.clearContents()
    let web = URL(string: "https://example.com/a.pdf")!
    pasteboard.writeObjects([web as NSURL])
    XCTAssertEqual(PasteboardReader.items(pasteboard), [.nonFile], "web URLs are not files")

    pasteboard.clearContents()
    let promise = NSPasteboardItem()
    promise.setString("public.jpeg", forType: NSPasteboard.PasteboardType("com.apple.pasteboard.promised-file-content-type"))
    promise.setData(Data(), forType: NSPasteboard.PasteboardType("com.apple.pasteboard.promised-file-url"))
    pasteboard.writeObjects([promise])
    XCTAssertEqual(PasteboardReader.items(pasteboard), [.promise])

    pasteboard.clearContents()
    XCTAssertEqual(PasteboardReader.items(pasteboard), [.nonFile], "empty drag data")
  }

  // MARK: Hardening: names, encodings, packages, counts

  /// Writes raw file-URL strings (exactly as a source app put them on the pasteboard).
  func write(fileURLs raws: [String]) {
    pasteboard.clearContents()
    let items = raws.map { raw -> NSPasteboardItem in
      let item = NSPasteboardItem()
      item.setString(raw, forType: .fileURL)
      return item
    }
    XCTAssertTrue(pasteboard.writeObjects(items))
  }

  /// Names reach main byte for byte: NFD and NFC stay as they were (Swift `==` would call them
  /// equal, so bytes are compared), as do newlines, quotes, backslashes, percent signs and emoji.
  func testNamesPassToTheDropMessageByteExact() throws {
    let cases: [(raw: String, bytes: [UInt8])] = [
      ("file:///Users/me/e%CC%81.pdf", Array("/Users/me/".utf8) + [0x65, 0xCC, 0x81] + Array(".pdf".utf8)),  // é as e + U+0301 (NSURL writes NFD)
      ("file:///Users/me/%C3%A9.pdf", Array("/Users/me/".utf8) + [0xC3, 0xA9] + Array(".pdf".utf8)),  // é precomposed
      ("file:///Users/me/%E1%84%80%E1%85%A1.png", Array("/Users/me/".utf8) + [0xE1, 0x84, 0x80, 0xE1, 0x85, 0xA1] + Array(".png".utf8)),  // 가 as jamo
      ("file:///Users/me/%EA%B0%80.png", Array("/Users/me/".utf8) + [0xEA, 0xB0, 0x80] + Array(".png".utf8)),  // 가 precomposed
      ("file:///Users/me/new%0Aline%22q%22%5C%25%20%F0%9F%98%80.jpg", Array("/Users/me/new\nline\"q\"\\% 😀.jpg".utf8)),
      ("file://localhost/Users/me/a.pdf", Array("/Users/me/a.pdf".utf8)),
    ]
    for (raw, expected) in cases {
      write(fileURLs: [raw])
      let items = PasteboardReader.items(pasteboard)
      guard case .file(let path, false)? = items.first, items.count == 1 else { return XCTFail("\(raw): \(items)") }
      XCTAssertEqual(Array(path.utf8), expected, raw)
      guard case .files(_, let paths) = Classifier.classify(items, extensions: DefaultConfig.extensions) else { return XCTFail("\(raw) not classified as files") }
      XCTAssertEqual(paths.map { Array($0.utf8) }, [expected], raw)
      // The encoded line carries the same bytes (JSONDecoder: JSONSerialization would also do, but
      // it drops a leading U+FEFF — never trust it for byte-exact checks).
      let line = try NDJSON.encodeLine(.drop(DropMessage(sessionId: "m1-a-1", actionId: .convertJpeg, mode: .convert, files: paths)))
      XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1, "\(raw): one line")
      struct Drop: Decodable { let files: [String] }
      let decoded = try JSONDecoder().decode(Drop.self, from: line.dropLast())
      XCTAssertEqual(decoded.files.map { Array($0.utf8) }, [expected], raw)
      if !expected.contains(where: { $0 < 0x20 || $0 == 0x22 || $0 == 0x5C }) {
        XCTAssertNotNil(line.firstRange(of: Data(expected)), "\(raw): the path's bytes appear verbatim in the line (no escaping, no re-normalization)")
      }
    }
  }

  /// A file URL whose percent-escapes are not UTF-8 (a name from a foreign file system) cannot be
  /// a String path: it is never sent as "" (or as a different file), the drag is unsupported.
  func testNonUTF8FileURLIsUnsupportedNeverAnEmptyPath() {
    write(fileURLs: ["file:///Volumes/share/a%FFb.pdf"])
    let items = PasteboardReader.items(pasteboard)
    XCTAssertEqual(items.count, 1)
    XCTAssertEqual(Classifier.classify(items, extensions: DefaultConfig.extensions), .unsupported(fileCount: 1, reason: .unknownType))
    XCTAssertThrowsError(try NDJSON.encodeLine(.drop(DropMessage(sessionId: "m1", actionId: .convertJpeg, mode: .convert, files: [""]))), "an empty path could never be encoded anyway")
  }

  /// Packages are folders (Finder's URL ends in "/"), so .app / .rtfd drags show the folder text.
  func testPackagesAreFolders() {
    let urls = [URL(fileURLWithPath: "/Applications/Safari.app", isDirectory: true), URL(fileURLWithPath: "/Users/me/Notes.rtfd", isDirectory: true)]
    for url in urls {
      pasteboard.clearContents()
      pasteboard.writeObjects([url as NSURL])
      let items = PasteboardReader.items(pasteboard)
      XCTAssertEqual(Classifier.classify(items, extensions: DefaultConfig.extensions), .unsupported(fileCount: 1, reason: .folder), url.path)
    }
  }

  /// 1 000+ items: at most 201 are read (the protocol allows 200), the drag is "too many".
  func testThousandsOfItemsReadAtMostTheLimitPlusOne() {
    write(fileURLs: (0..<1500).map { "file:///Users/me/p\($0).png" })
    let started = Date()
    let items = PasteboardReader.items(pasteboard)
    XCTAssertEqual(items.count, HelperProtocol.maxFiles + 1)
    XCTAssertEqual(Classifier.classify(items, extensions: DefaultConfig.extensions), .unsupported(fileCount: 201, reason: .tooMany))
    XCTAssertLessThan(Date().timeIntervalSince(started), 2, "bounded work inside draggingEntered")
  }

  /// Paths longer than PATH_MAX pass (main's file check decides), beyond the protocol's
  /// 32 767 code points the drag is unsupported; 200 maximal paths never exceed the line limit
  /// unnoticed (the drop is refused as invalidPayload instead of an oversized line).
  func testLongPathsWithinProtocolLimits() throws {
    let deep = "/Users/me/" + String(repeating: "d/", count: 2600) + "x.pdf"  // 5 215 bytes > PATH_MAX 1024
    write(fileURLs: [URL(fileURLWithPath: deep).absoluteString])
    XCTAssertEqual(Classifier.classify(PasteboardReader.items(pasteboard), extensions: DefaultConfig.extensions), .files(key: .pdf, paths: [deep]))
    let tooLong = "/" + String(repeating: "a", count: HelperProtocol.maxPathLength) + ".pdf"
    XCTAssertEqual(Classifier.classify([.file(path: tooLong, isDirectory: false)], extensions: DefaultConfig.extensions), .unsupported(fileCount: 1, reason: .unknownType))
  }

  /// File promises — the receiver's readable types and the older pasteboard flavours — are
  /// virtual items: never Copy, shown with the "not a file on disk" text.
  func testEveryPromiseFlavourIsVirtual() {
    for type in PasteboardReader.promiseTypes {
      pasteboard.clearContents()
      let item = NSPasteboardItem()
      // The legacy name is no UTI (an item refuses it); legacy sources arrive as its dyn UTI below.
      guard item.setString("x", forType: NSPasteboard.PasteboardType(type)) else { continue }
      pasteboard.writeObjects([item])
      XCTAssertEqual(PasteboardReader.items(pasteboard), [.promise], type)
    }
    XCTAssertTrue(PasteboardReader.promiseTypes.isSuperset(of: NSFilePromiseReceiver.readableDraggedTypes))
    // A legacy (declareTypes) NSFilesPromisePboardType source, e.g. an older app's attachment drag.
    pasteboard.declareTypes([NSPasteboard.PasteboardType("Apple files promise pasteboard type")], owner: nil)
    pasteboard.setPropertyList(["pdf"], forType: NSPasteboard.PasteboardType("Apple files promise pasteboard type"))
    XCTAssertEqual(PasteboardReader.items(pasteboard), [.promise])
    // An item that offers a real file URL as well is the file (the source states it exists; main
    // still validates it). Pinned so a change of this rule is deliberate.
    pasteboard.clearContents()
    let both = NSPasteboardItem()
    both.setString("file:///Users/me/a.png", forType: .fileURL)
    both.setString("public.png", forType: NSPasteboard.PasteboardType("com.apple.pasteboard.promised-file-content-type"))
    pasteboard.writeObjects([both])
    XCTAssertEqual(PasteboardReader.items(pasteboard), [.file(path: "/Users/me/a.png", isDirectory: false)])
  }

  /// The capsule's size/type check only stats: on a FIFO named like a PDF any open/read would
  /// block forever (a dataless iCloud file would download). The result arrives at once.
  func testFileInfoResolverNeverOpensTheFile() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbitdrop-helper-fifo-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let fifo = dir.appendingPathComponent("Page 001.pdf")
    XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
    let done = expectation(description: "resolved without opening")
    FileInfoResolver.resolve(paths: [fifo.path]) { info in
      XCTAssertEqual(info, FileInfoResolver.Info(totalBytes: 0, containsDirectory: false, containsCloudPlaceholder: false))
      done.fulfill()
    }
    wait(for: [done], timeout: 2)
  }

  /// Online-only cloud files are recognised from `st_flags` alone (`SF_DATALESS`, set by iCloud
  /// Drive and File Provider domains; only root could set it, so the stat results are synthetic).
  func testDatalessFlagMarksACloudPlaceholder() {
    func entry(_ mode: mode_t, size: Int64, flags: UInt32 = 0) -> stat {
      var s = stat()
      s.st_mode = mode
      s.st_size = size
      s.st_flags = flags
      return s
    }
    let local = entry(S_IFREG | 0o644, size: 1_000)
    let online = entry(S_IFREG | 0o644, size: 5_000_000, flags: UInt32(SF_DATALESS))
    XCTAssertEqual(FileInfoResolver.summarize([local]), FileInfoResolver.Info(totalBytes: 1_000, containsDirectory: false, containsCloudPlaceholder: false))
    XCTAssertEqual(FileInfoResolver.summarize([local, online]), FileInfoResolver.Info(totalBytes: 5_001_000, containsDirectory: false, containsCloudPlaceholder: true), "the logical size is known; the contents are not here")
    XCTAssertEqual(FileInfoResolver.summarize([entry(S_IFREG, size: 1, flags: UInt32(UF_HIDDEN | UF_COMPRESSED))]).containsCloudPlaceholder, false, "other flags are not dataless")
    XCTAssertEqual(FileInfoResolver.summarize([online, entry(S_IFDIR | 0o755, size: 96, flags: UInt32(SF_DATALESS))]).containsDirectory, true)
    XCTAssertEqual(FileInfoResolver.summarize([local, nil]).totalBytes, nil, "a failed stat makes the size unknown")
  }

  func testFileSizeSumNeverTraps() {
    XCTAssertEqual(FileInfoResolver.adding(1_000, 234), 1_234)
    XCTAssertNil(FileInfoResolver.adding(Int64.max, 1), "overflow → unknown size, not a crash")
    XCTAssertNil(FileInfoResolver.adding(Int64.max / 2 + 1, Int64.max / 2 + 1))
    XCTAssertNil(FileInfoResolver.adding(0, -1), "a negative st_size is not a size")
  }

  func testRegisteredTypesCoverFilesPromisesAndText() {
    let types = Set(PasteboardReader.registeredTypes.map(\.rawValue))
    XCTAssertTrue(types.contains(NSPasteboard.PasteboardType.fileURL.rawValue))
    XCTAssertTrue(types.contains(NSPasteboard.PasteboardType.string.rawValue))
    XCTAssertTrue(types.contains("com.apple.pasteboard.promised-file-url"))
  }

  func testFileInfoResolverStatsOffMain() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbitdrop-helper-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let a = dir.appendingPathComponent("a.pdf")
    let b = dir.appendingPathComponent("b.pdf")
    try Data(count: 1000).write(to: a)
    try Data(count: 234).write(to: b)
    let done = expectation(description: "resolved")
    nonisolated(unsafe) var result: (Int64?, Bool) = (nil, false)
    FileInfoResolver.resolve(paths: [a.path, b.path]) { info in
      XCTAssertFalse(Thread.isMainThread)
      result = (info.totalBytes, info.containsDirectory)
      XCTAssertFalse(info.containsCloudPlaceholder, "a local file is not dataless")
      done.fulfill()
    }
    wait(for: [done], timeout: 5)
    XCTAssertEqual(result.0, 1234)
    XCTAssertEqual(result.1, false)

    let dirDone = expectation(description: "directory")
    nonisolated(unsafe) var isDirectory = false
    FileInfoResolver.resolve(paths: [dir.path]) { info in
      isDirectory = info.containsDirectory
      dirDone.fulfill()
    }
    wait(for: [dirDone], timeout: 5)
    XCTAssertTrue(isDirectory)
  }
}
