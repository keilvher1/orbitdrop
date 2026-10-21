// Generates the static PDF fixtures that pdf-lib cannot produce:
//   korean-text.pdf  2 pages of Hangul text with an embedded (subset) Apple SD Gothic Neo font
//   encrypted.pdf    1 page, RC4-128 encrypted with a user password ("orbitdrop")
// Usage: swift make-pdfs.swift <output-dir>     (macOS; run by make-static-fixtures.mjs)
import CoreGraphics
import CoreText
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: swift make-pdfs.swift <output-dir>\n".data(using: .utf8)!)
    exit(2)
}
let outDir = URL(fileURLWithPath: args[1], isDirectory: true)

func drawPDF(_ url: URL, pages: [[String]], fontName: String, size: CGFloat, info: [CFString: Any]) {
    var mediaBox = CGRect(x: 0, y: 0, width: 595, height: 842)
    guard let context = CGContext(url as CFURL, mediaBox: &mediaBox, info as CFDictionary) else {
        FileHandle.standardError.write("cannot create \(url.path)\n".data(using: .utf8)!)
        exit(1)
    }
    let font = CTFontCreateWithName(fontName as CFString, size, nil)
    let black = CGColor(gray: 0, alpha: 1)
    for lines in pages {
        context.beginPDFPage(nil)
        var y: CGFloat = 760
        for line in lines {
            let attributes = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: black] as CFDictionary
            guard let text = CFAttributedStringCreate(nil, line as CFString, attributes) else { exit(1) }
            let ctLine = CTLineCreateWithAttributedString(text)
            context.textPosition = CGPoint(x: 72, y: y)
            CTLineDraw(ctLine, context)
            y -= size * 1.6
        }
        context.endPDFPage()
    }
    context.closePDF()
}

drawPDF(
    outDir.appendingPathComponent("korean-text.pdf"),
    pages: [
        ["안녕하세요 OrbitDrop", "한글 텍스트 추출 테스트"],
        ["두 번째 페이지입니다"],
    ],
    fontName: "AppleSDGothicNeo-Regular",
    size: 20,
    info: [kCGPDFContextCreator: "OrbitDrop fixtures"]
)

drawPDF(
    outDir.appendingPathComponent("encrypted.pdf"),
    pages: [["Encrypted fixture"]],
    fontName: "Helvetica",
    size: 20,
    info: [
        kCGPDFContextCreator: "OrbitDrop fixtures",
        kCGPDFContextUserPassword: "orbitdrop",
        kCGPDFContextOwnerPassword: "orbitdrop-owner",
        kCGPDFContextEncryptionKeyLength: 128,
    ]
)
print("wrote korean-text.pdf and encrypted.pdf to \(outDir.path)")
