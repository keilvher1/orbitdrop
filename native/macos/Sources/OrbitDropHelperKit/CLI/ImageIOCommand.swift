import Foundation

/// `OrbitDropHelper imageio …` — see ImageIOTool. Contract (docs/architecture.md):
///
///   imageio --probe
///       → stdout: {"decode":["jpeg",…,"heic",…],"encode":[…,"heic",…]}
///   imageio --decode <in|-> --out <out.png|-> [--no-orient] [--max-pixels N]
///   imageio --encode <format> --quality <0..1> <in.png|-> --out <out|-> [--max-pixels N]
///
/// `-` reads stdin / writes the image bytes to stdout. Otherwise the output file is
/// written atomically (temp file + rename) and one JSON line is printed:
///   {"ok":true,"width":W,"height":H}   or   {"ok":false,"error":"CODE","message":"…"}
/// Exit codes: 0 ok, 1 failed (decode/encode/IO), 2 usage, 3 encoder unavailable.
public enum ImageIOCommand {
  public static let usage = """
    usage: OrbitDropHelper imageio --probe
           OrbitDropHelper imageio --decode <in|-> --out <out.png|-> [--no-orient] [--max-pixels N]
           OrbitDropHelper imageio --encode <heic|avif|jpeg|png|tiff|…> --quality <0..1> <in|-> --out <out|-> [--max-pixels N]
    """

  public static func run(_ args: [String]) -> Int32 {
    var jsonOutput = true
    do {
      let a = try CLIArguments(args, valued: ["--decode", "--encode", "--out", "--quality", "--max-pixels"], flags: ["--probe", "--no-orient"])
      if a.flags.contains("--probe") {
        guard a.values.isEmpty, a.positionals.isEmpty else { throw HelperCLIError.usage(usage) }
        print(ImageIOTool.probe().json)
        return 0
      }
      guard let out = a.values["--out"] else { throw HelperCLIError.usage(usage) }
      jsonOutput = out != "-"
      let maxPixels = try a.int("--max-pixels", in: 1...Int(Int32.max)) ?? ImageIOTool.defaultMaxPixels
      let result: ImageIOTool.Result
      if let input = a.values["--decode"] {
        guard a.values["--encode"] == nil, a.positionals.isEmpty else { throw HelperCLIError.usage(usage) }
        result = try ImageIOTool.decodeToPNG(try read(input), applyOrientation: !a.flags.contains("--no-orient"), maxPixels: maxPixels)
      } else if let format = a.values["--encode"] {
        guard a.positionals.count == 1 else { throw HelperCLIError.usage(usage) }
        guard let quality = try a.double("--quality", in: 0...1) else { throw HelperCLIError.usage("--quality <0..1> is required") }
        result = try ImageIOTool.encode(try read(a.positionals[0]), format: format, quality: quality, maxPixels: maxPixels)
      } else {
        throw HelperCLIError.usage(usage)
      }
      if out == "-" {
        FileHandle.standardOutput.write(result.data)
      } else {
        do {
          try result.data.write(to: URL(fileURLWithPath: out), options: .atomic)
        } catch {
          throw HelperCLIError.io("IO_ERROR: cannot write the output file")
        }
        print("{\"ok\":true,\"width\":\(result.width),\"height\":\(result.height)}")
      }
      return 0
    } catch let error as HelperCLIError {
      FileHandle.standardError.write(Data("OrbitDropHelper imageio: \(error.description)\n".utf8))
      if jsonOutput {
        let (code, message) = split(error)
        print("{\"ok\":false,\"error\":\"\(code)\",\"message\":\(jsonString(message))}")
      }
      return error.exitCode
    } catch {
      FileHandle.standardError.write(Data("OrbitDropHelper imageio: \(error)\n".utf8))
      return 1
    }
  }

  static func read(_ path: String) throws -> Data {
    if path == "-" { return FileHandle.standardInput.readDataToEndOfFile() }
    do {
      return try Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe)
    } catch {
      throw HelperCLIError.io("IO_ERROR: cannot read the input file")
    }
  }

  /// "CODE: message" descriptions carry a machine-readable code.
  static func split(_ error: HelperCLIError) -> (String, String) {
    let text = error.description
    if let colon = text.firstIndex(of: ":"), text[..<colon].allSatisfy({ $0.isUppercase || $0 == "_" }), !text[..<colon].isEmpty {
      return (String(text[..<colon]), text[text.index(after: colon)...].trimmingCharacters(in: .whitespaces))
    }
    return (error.code, text)
  }

  static func jsonString(_ s: String) -> String {
    let data = (try? JSONEncoder().encode(s)) ?? Data("\"\"".utf8)
    return String(decoding: data, as: UTF8.self)
  }
}
