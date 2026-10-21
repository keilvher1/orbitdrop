import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import OrbitDropHelperCore

/// Host facts and permission status. Nothing here ever prompts the user:
/// AXIsProcessTrusted() and CGPreflightListenEventAccess() only read TCC state.
public enum SystemInfo {
  public static var osVersion: String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
  }

  /// True when an x86_64 build runs under Rosetta 2.
  public static var isTranslated: Bool {
    var value: Int32 = 0
    var size = MemoryLayout<Int32>.size
    return sysctlbyname("sysctl.proc_translated", &value, &size, nil, 0) == 0 && value == 1
  }

  /// Accessibility trust (not needed by the helper; reported for diagnostics).
  public static var accessibilityTrusted: Bool { AXIsProcessTrusted() }

  /// Input Monitoring (kTCCServiceListenEvent). Not needed; when already granted the
  /// helper additionally polls the Escape key while a wheel is visible.
  public static var inputMonitoringGranted: Bool { CGPreflightListenEventAccess() }

  /// The observation method (global mouse monitor + polled modifier flags + drag
  /// pasteboard change count) needs no permission, so nothing is `required`.
  public static func permissions() -> [PermissionItem] {
    [
      PermissionItem(name: .accessibility, required: false, granted: accessibilityTrusted),
      PermissionItem(name: .inputMonitoring, required: false, granted: inputMonitoringGranted),
    ]
  }

  /// AppKit screens converted to OrbitDrop global DIP (screens[0] is the primary).
  @MainActor public static func displays() -> [Display] {
    Coords.displaysFromAppKitScreens(NSScreen.screens.map { screen in
      AppKitScreen(frame: rect(screen.frame), visibleFrame: rect(screen.visibleFrame), backingScaleFactor: Double(screen.backingScaleFactor))
    })
  }

  @MainActor public static var primaryFrame: Rect {
    NSScreen.screens.first.map { rect($0.frame) } ?? Rect(x: 0, y: 0, width: 0, height: 0)
  }

  /// Current pointer in global DIP.
  @MainActor public static var pointer: Point {
    let p = NSEvent.mouseLocation
    return Coords.appKitPointToGlobal(Point(x: Double(p.x), y: Double(p.y)), primaryFrame: primaryFrame)
  }

  public static func rect(_ r: NSRect) -> Rect {
    Rect(x: Double(r.origin.x), y: Double(r.origin.y), width: Double(r.size.width), height: Double(r.size.height))
  }

  public static func nsRect(_ r: Rect) -> NSRect {
    NSRect(x: r.x, y: r.y, width: r.width, height: r.height)
  }

  /// Held modifiers as the protocol names them ('alt' = Option). Caps Lock, Fn etc. are ignored.
  public static func modifiers(_ flags: NSEvent.ModifierFlags) -> Set<ModifierKey> {
    var set: Set<ModifierKey> = []
    if flags.contains(.shift) { set.insert(.shift) }
    if flags.contains(.option) { set.insert(.alt) }
    if flags.contains(.control) { set.insert(.control) }
    if flags.contains(.command) { set.insert(.command) }
    return set
  }
}
