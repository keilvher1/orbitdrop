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
    XCTAssertEqual(Classifier.classify(items, extensions: DefaultConfig.extensions), .unsupported(fileCount: 2), "a folder makes the drag unsupported")
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
    FileInfoResolver.resolve(paths: [a.path, b.path]) { total, directory in
      XCTAssertFalse(Thread.isMainThread)
      result = (total, directory)
      done.fulfill()
    }
    wait(for: [done], timeout: 5)
    XCTAssertEqual(result.0, 1234)
    XCTAssertEqual(result.1, false)

    let dirDone = expectation(description: "directory")
    nonisolated(unsafe) var isDirectory = false
    FileInfoResolver.resolve(paths: [dir.path]) { _, directory in
      isDirectory = directory
      dirDone.fulfill()
    }
    wait(for: [dirDone], timeout: 5)
    XCTAssertTrue(isDirectory)
  }
}
