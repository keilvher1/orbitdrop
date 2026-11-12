import XCTest

@testable import OrbitDropHelperCore

final class ClassificationTests: XCTestCase {
  let ext = DefaultConfig.extensions

  func file(_ path: String, dir: Bool = false) -> DragItem { .file(path: path, isDirectory: dir) }

  func testExtensionOfPathMatchesTheReference() {
    XCTAssertEqual(Classifier.extensionOfPath("/a/Page 001.PDF"), ".pdf")
    XCTAssertEqual(Classifier.extensionOfPath("/a/archive.tar.JPEG"), ".jpeg")
    XCTAssertEqual(Classifier.extensionOfPath("/a/.pdf"), "", "leading dot is not an extension")
    XCTAssertEqual(Classifier.extensionOfPath("/a/.hidden.png"), ".png")
    XCTAssertEqual(Classifier.extensionOfPath("/a/noext"), "")
    XCTAssertEqual(Classifier.extensionOfPath("/a/trailing."), "")
    XCTAssertEqual(Classifier.extensionOfPath("/a/b.pdf/"), ".pdf", "trailing separators ignored for the name")
    XCTAssertEqual(Classifier.extensionOfPath("/a.d/file"), "")
    XCTAssertEqual(Classifier.extensionOfPath("C:\\Users\\me\\Photo.PNG"), ".png", "'\\' separates on every platform")
    XCTAssertEqual(Classifier.extensionOfPath("/Users/me/odd\\.png"), "", "name after '\\' is '.png'")
    XCTAssertEqual(Classifier.extensionOfPath("/a/x.ＪＰＧ"), ".ＪＰＧ", "ASCII-only lower-casing")
    XCTAssertEqual(Classifier.fileNameOfPath("C:\\photos\\"), "photos")
    // A combining mark on the dot: as scalars the dot still starts the extension (a Character view would not see it).
    XCTAssertEqual(Classifier.extensionOfPath("/Users/me/x.png.\u{301}"), ".\u{301}")
    XCTAssertNil(Classifier.menuKeyForPaths(["/Users/me/x.png.\u{301}"], extensions: ext))
    XCTAssertNil(Classifier.menuKeyForPaths(["/a/folder.png/"], extensions: ext), "trailing separator = folder")
    XCTAssertNil(Classifier.menuKeyForPaths(["/a/b.pdf", ""], extensions: ext))
    // NFC vs NFD Korean names classify the same; a decomposed "é" in the extension never matches.
    XCTAssertEqual(Classifier.menuKeyForPaths(["/Users/me/사진.jpg", "/Users/me/\u{1109}\u{1161}\u{110C}\u{1175}\u{11AB}.jpg"], extensions: ext), .image(.jpeg))
    XCTAssertNil(Classifier.menuKeyForPaths(["/a/x.pn\u{301}g"], extensions: [".pńg": .image(.png)]))
  }

  func testSingleAndMultiKeys() {
    XCTAssertEqual(Classifier.classify([file("/x/Page 001.pdf")], extensions: ext), .files(key: .pdf, paths: ["/x/Page 001.pdf"]))
    XCTAssertEqual(Classifier.classify([file("/x/a.JPG"), file("/x/b.jpeg")], extensions: ext), .files(key: .image(.jpeg), paths: ["/x/a.JPG", "/x/b.jpeg"]))
    XCTAssertEqual(Classifier.classify([file("/x/a.jpg"), file("/x/b.png")], extensions: ext).menuKey, .images)
    XCTAssertEqual(Classifier.classify([file("/x/a.jpg"), file("/x/b.pdf")], extensions: ext).menuKey, .mixed)
    XCTAssertEqual(Classifier.classify([file("/x/a.pdf"), file("/x/b.pdf")], extensions: ext).menuKey, .pdf)
    XCTAssertEqual(Classifier.classify([file("/x/a.heif")], extensions: ext).menuKey, .image(.heic))
  }

  func testAnythingUnknownMakesTheWholeDragUnsupported() {
    XCTAssertEqual(Classifier.classify([], extensions: ext), .unsupported(fileCount: 0, reason: .nonFile))
    XCTAssertEqual(Classifier.classify([file("/x/a.txt")], extensions: ext), .unsupported(fileCount: 1, reason: .unknownType))
    XCTAssertEqual(Classifier.classify([file("/x/a.pdf"), file("/x/notes.docx")], extensions: ext), .unsupported(fileCount: 2, reason: .unknownType))
    XCTAssertEqual(Classifier.classify([file("/x/Folder.pdf", dir: true)], extensions: ext), .unsupported(fileCount: 1, reason: .folder), "folder")
    XCTAssertEqual(Classifier.classify([file("/x/a.pdf"), .promise], extensions: ext), .unsupported(fileCount: 1, reason: .virtual), "file promise")
    XCTAssertEqual(Classifier.classify([.nonFile], extensions: ext), .unsupported(fileCount: 0, reason: .nonFile), "text drag")
    XCTAssertEqual(Classifier.classify([file("relative.pdf")], extensions: ext), .unsupported(fileCount: 1, reason: .unknownType))
    XCTAssertEqual(Classifier.classify(Array(repeating: file("/x/a.pdf"), count: 201), extensions: ext), .unsupported(fileCount: 201, reason: .tooMany))
    XCTAssertEqual(Classifier.classify(Array(repeating: file("/x/a.pdf"), count: 200), extensions: ext).menuKey, .pdf)
    // Only extensions present in the configure map count (a build without a HEIC decoder omits .heic).
    var noHeic = ext
    noHeic[".heic"] = nil
    XCTAssertEqual(Classifier.classify([file("/x/a.heic")], extensions: noHeic), .unsupported(fileCount: 1, reason: .unknownType))
    // Extension entries naming multi-file keys are never used.
    XCTAssertEqual(Classifier.classify([file("/x/a.zzz")], extensions: [".zzz": .images]), .unsupported(fileCount: 1, reason: .unknownType))
  }

  func testUnsupportedReasonPrecedenceAndTexts() {
    // Virtual items beat folders, folders beat non-file data, anything else is generic.
    XCTAssertEqual(Classifier.classify([.promise, file("/x/F", dir: true), .nonFile], extensions: ext).unsupportedReason, .virtual)
    XCTAssertEqual(Classifier.classify([file("/x/F", dir: true), .nonFile], extensions: ext).unsupportedReason, .folder)
    XCTAssertEqual(Classifier.classify([file("/x/a.pdf"), .nonFile], extensions: ext).unsupportedReason, .nonFile)
    XCTAssertEqual(Classifier.classify([file("/x/folder.png/")], extensions: ext).unsupportedReason, .folder, "trailing separator is a folder")
    let full = DefaultConfig.strings(locale: .en)
    XCTAssertEqual(full.unsupportedText(.folder), "Folders aren't supported")
    XCTAssertEqual(full.unsupportedText(.nonFile), "Not a file")
    XCTAssertEqual(full.unsupportedText(.virtual), "Not a file on disk")
    XCTAssertEqual(full.unsupportedText(.unknownType), "Not supported")
    XCTAssertEqual(full.unsupportedText(.tooMany), "Not supported")
    XCTAssertEqual(full.unsupportedText(nil), "Not supported")
    // Main omits the optional strings (or sends ""): fall back to `unsupported`.
    let minimal = HelperStrings(dropHint: "d", unsupported: "U", multiFileUnsupported: "m", fileCount: "{n}", unsupportedNonFile: "")
    for reason in UnsupportedReason.allCases { XCTAssertEqual(minimal.unsupportedText(reason), "U") }
  }

  func testMultiFileDisablesNonBatchSectors() {
    let config = DefaultConfig.config(locale: .en)
    let single = Classifier.sectors(for: .files(key: .image(.png), paths: ["/a.png"]), mode: .tools, config: config)!
    XCTAssertTrue(single.allSatisfy(\.enabled))
    let multi = Classifier.sectors(for: .files(key: .image(.png), paths: ["/a.png", "/b.png"]), mode: .tools, config: config)!
    XCTAssertEqual(multi.map(\.actionId), DefaultConfig.imageToolsOrder, "order unchanged")
    for sector in multi {
      if sector.batch {
        XCTAssertTrue(sector.enabled, "\(sector.actionId)")
      } else {
        XCTAssertFalse(sector.enabled)
        XCTAssertEqual(sector.reason, "One file at a time")
      }
    }
    // Already-disabled sectors keep their own reason.
    let convert = Classifier.sectors(for: .files(key: .image(.png), paths: ["/a.png", "/b.png"]), mode: .convert, config: config)!
    XCTAssertEqual(convert.first { $0.actionId == .convertHeic }?.reason, "No HEIC encoder in this build")
  }

  func testEmptyMenuForModeIsNil() {
    let config = DefaultConfig.config(locale: .en)
    XCTAssertNil(Classifier.sectors(for: .files(key: .pdf, paths: ["/a.pdf"]), mode: .tools, config: config))
    XCTAssertNil(Classifier.sectors(for: .unsupported(fileCount: 1, reason: .unknownType), mode: .convert, config: config))
    XCTAssertEqual(Classifier.sectors(for: .files(key: .pdf, paths: ["/a.pdf"]), mode: .convert, config: config)?.map(\.label), ["DOCX", "JPG", "PNG", "TXT"])
    XCTAssertEqual(Classifier.sectors(for: .files(key: .mixed, paths: ["/a.pdf", "/b.png"]), mode: .convert, config: config)?.map(\.actionId), [.convertDocx, .convertJpeg, .convertPng])
    XCTAssertNil(Classifier.sectors(for: .files(key: .mixed, paths: ["/a.pdf", "/b.png"]), mode: .tools, config: config))
  }

  /// Claude analysis (opt-in): the only tools sector of PDF and mixed drags, last after the image
  /// tools; batch-capable, so several files keep it enabled. Convert wheels do not change.
  func testClaudeAnalysisMenus() {
    let config = DefaultConfig.config(locale: .ko, analysis: true)
    let analyze = WheelSector(actionId: .toolAnalyze, label: "Claude 분석", icon: .analyze, enabled: true, batch: true)
    XCTAssertEqual(Classifier.sectors(for: .files(key: .pdf, paths: ["/a.pdf"]), mode: .tools, config: config), [analyze])
    XCTAssertEqual(Classifier.sectors(for: .files(key: .pdf, paths: ["/a.pdf", "/b.pdf"]), mode: .tools, config: config), [analyze])
    XCTAssertEqual(Classifier.sectors(for: .files(key: .mixed, paths: ["/a.pdf", "/b.png"]), mode: .tools, config: config), [analyze])
    for key in [MenuKey.image(.png), .image(.gif), .images] {
      let tools = Classifier.sectors(for: .files(key: key, paths: ["/a", "/b"]), mode: .tools, config: config)
      XCTAssertEqual(tools?.map(\.actionId), DefaultConfig.imageToolsOrder + [.toolAnalyze], key.rawValue)
      XCTAssertEqual(tools?.last, analyze, "\(key.rawValue): enabled with two files")
    }
    let off = DefaultConfig.config(locale: .ko)
    for key in MenuKey.allCases {
      XCTAssertEqual(config.menu(for: key)?.convert, off.menu(for: key)?.convert, key.rawValue)
      XCTAssertEqual(config.menu(for: key)?.tools.dropLast(), off.menu(for: key)?.tools[...], key.rawValue)
    }
    XCTAssertEqual(DefaultConfig.action(.toolAnalyze).label.en, "ANALYZE")
    XCTAssertEqual(DefaultConfig.inputs(.toolAnalyze), ["image", "pdf"])
  }

  func testByteFormat() {
    XCTAssertEqual(ByteFormat.short(0), "0 B")
    XCTAssertEqual(ByteFormat.short(999), "999 B")
    XCTAssertEqual(ByteFormat.short(1_000), "1 KB")
    XCTAssertEqual(ByteFormat.short(12_345), "12 KB")
    XCTAssertEqual(ByteFormat.short(999_499), "999 KB")
    XCTAssertEqual(ByteFormat.short(999_500), "1.0 MB")
    XCTAssertEqual(ByteFormat.short(1_234_567), "1.2 MB")
    XCTAssertEqual(ByteFormat.short(3_450_000_000), "3.45 GB")
    XCTAssertEqual(ByteFormat.short(3_050_000_000), "3.05 GB")
    XCTAssertEqual(HelperStrings(dropHint: "", unsupported: "", multiFileUnsupported: "", fileCount: "{n}개 파일").fileCountText(3), "3개 파일")
  }

  func testModifierMatchingIsExact() {
    let config = DefaultConfig.config()
    XCTAssertEqual(config.mode(forHeld: [.shift]), .convert)
    XCTAssertEqual(config.mode(forHeld: [.alt, .shift]), .tools)
    XCTAssertNil(config.mode(forHeld: [.alt]))
    XCTAssertNil(config.mode(forHeld: [.shift, .command]))
    XCTAssertNil(config.mode(forHeld: []))
  }
}
