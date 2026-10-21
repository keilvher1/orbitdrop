// OrbitDropHelper — macOS native drag helper for OrbitDrop.
//
//   OrbitDropHelper                      stdio NDJSON helper (spawned by Electron main)
//   OrbitDropHelper --render-snapshot …  render the wheel offscreen to PNG
//   OrbitDropHelper imageio …            ImageIO codec mode (processors, P2 HEIC)
//   OrbitDropHelper --version | --help
import Foundation
import OrbitDropHelperCore
import OrbitDropHelperKit

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.first == "imageio" {
  exit(ImageIOCommand.run(Array(arguments.dropFirst())))
}
if arguments.contains("--render-snapshot") {
  exit(SnapshotCommand.run(arguments))
}
if arguments == ["--version"] {
  print("OrbitDropHelper \(HelperInfo.version) (\(HelperInfo.platform)-\(HelperInfo.arch), protocol v\(HelperProtocol.version))")
  exit(0)
}
if arguments == ["--help"] || arguments == ["-h"] {
  print("""
    OrbitDropHelper \(HelperInfo.version) — OrbitDrop drag helper for macOS

      OrbitDropHelper            run the helper: NDJSON protocol v\(HelperProtocol.version) on stdin/stdout
                                 (packages/contracts/src/helper-protocol.ts); exits when stdin closes
    \(SnapshotCommand.usage)
    \(ImageIOCommand.usage)
    """)
  exit(0)
}
if !arguments.isEmpty && arguments != ["--stdio"] {
  FileHandle.standardError.write(Data("OrbitDropHelper: unknown arguments (try --help)\n".utf8))
  exit(2)
}

HelperMain.run()
