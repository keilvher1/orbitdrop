// swift-tools-version: 6.0
//
// OrbitDrop native drag helper for macOS (AppKit).
//
//   OrbitDropHelperCore  pure Swift: NDJSON protocol, geometry port, menu
//                        classification, drag-session state machine (unit-tested)
//   OrbitDropHelperKit   AppKit/CoreGraphics/ImageIO: wheel rendering, the wheel
//                        panel + drop target, global observation, CLI modes
//   OrbitDropHelper      the executable (thin main.swift)
//
// Build:  swift build -c release            (see scripts/build-native-mac.mjs)
// Test:   swift test
import PackageDescription

/// The helper is a bare Mach-O executable (not an .app bundle). Embedding an
/// Info.plist gives it a bundle identifier/version (used by codesign and logs)
/// and LSUIElement, so it never shows a Dock icon even before AppKit starts.
let infoPlist = Context.packageDirectory + "/Support/Info.plist"

let package = Package(
  name: "OrbitDropHelper",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "OrbitDropHelper", targets: ["OrbitDropHelper"]),
  ],
  targets: [
    .target(name: "OrbitDropHelperCore"),
    .target(
      name: "OrbitDropHelperKit",
      dependencies: ["OrbitDropHelperCore"],
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("ImageIO"),
        .linkedFramework("UniformTypeIdentifiers"),
        .linkedFramework("ApplicationServices"),
      ]
    ),
    .executableTarget(
      name: "OrbitDropHelper",
      dependencies: ["OrbitDropHelperCore", "OrbitDropHelperKit"],
      linkerSettings: [
        .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
      ]
    ),
    .testTarget(
      name: "OrbitDropHelperCoreTests",
      dependencies: ["OrbitDropHelperCore"],
      exclude: ["Fixtures"]
    ),
    .testTarget(
      name: "OrbitDropHelperKitTests",
      dependencies: ["OrbitDropHelperKit", "OrbitDropHelperCore"]
    ),
    .testTarget(
      name: "OrbitDropHelperProcessTests",
      // Depending on the executable makes `swift test` build the binary that the
      // end-to-end tests launch (they never link against it).
      dependencies: ["OrbitDropHelper"]
    ),
  ]
)
