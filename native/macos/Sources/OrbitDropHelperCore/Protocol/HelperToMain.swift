import Foundation

/// helper → main (HelperToMainSchema).
public enum HelperToMainMessage: Sendable, Equatable {
  case ready(ReadyMessage)
  case state(StateMessage)
  case drop(DropMessage)
  case cancelled(sessionId: String, reason: CancelReason)
  case pong(nonce: Int64)
  case permissions([PermissionItem])
  case log(level: LogLevel, message: String)
  case error(code: String, message: String, fatal: Bool)

  public var typeName: String {
    switch self {
    case .ready: return "ready"
    case .state: return "state"
    case .drop: return "drop"
    case .cancelled: return "cancelled"
    case .pong: return "pong"
    case .permissions: return "permissions"
    case .log: return "log"
    case .error: return "error"
    }
  }
}

public struct ReadyMessage: Sendable, Equatable {
  public var helperVersion: String
  public var platform: String
  public var arch: String
  public var osVersion: String
  public var pid: Int64
  public var globalDragAvailable: Bool
  public var globalDragReason: String?

  public init(helperVersion: String, platform: String, arch: String, osVersion: String, pid: Int64, globalDragAvailable: Bool, globalDragReason: String? = nil) {
    self.helperVersion = helperVersion
    self.platform = platform
    self.arch = arch
    self.osVersion = osVersion
    self.pid = pid
    self.globalDragAvailable = globalDragAvailable
    self.globalDragReason = globalDragReason
  }
}

public struct StateMessage: Sendable, Equatable {
  public var sessionId: String
  public var state: SessionStateName
  public var mode: WheelMode?
  /// nil → omitted; `.some(nil)` → `null` (unsupported payload).
  public var menuKey: MenuKey??
  public var fileCount: Int?

  public init(sessionId: String, state: SessionStateName, mode: WheelMode? = nil, menuKey: MenuKey?? = nil, fileCount: Int? = nil) {
    self.sessionId = sessionId
    self.state = state
    self.mode = mode
    self.menuKey = menuKey
    self.fileCount = fileCount
  }
}

public struct DropMessage: Sendable, Equatable {
  public var sessionId: String
  public var actionId: ActionId
  public var mode: WheelMode
  /// Absolute paths copied out of the drag data before the drop callback returned.
  public var files: [String]

  public init(sessionId: String, actionId: ActionId, mode: WheelMode, files: [String]) {
    self.sessionId = sessionId
    self.actionId = actionId
    self.mode = mode
    self.files = files
  }
}

public struct PermissionItem: Sendable, Equatable {
  public var name: PermissionName
  public var required: Bool
  public var granted: Bool

  public init(name: PermissionName, required: Bool, granted: Bool) {
    self.name = name
    self.required = required
    self.granted = granted
  }
}

extension HelperToMainMessage: Encodable {
  /// Encodes with schema limits enforced: free text is truncated to its maximum,
  /// structurally invalid messages (bad ids, empty/oversized file lists) throw.
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(HelperProtocol.version, forKey: AnyKey("v"))
    try c.encode(typeName, forKey: AnyKey("type"))
    switch self {
    case .ready(let ready):
      try c.encode(Validation.truncated(ready.helperVersion, maxLength: 32), forKey: AnyKey("helperVersion"))
      guard ready.platform == "darwin" || ready.platform == "win32" else { throw ProtocolError.invalidValue("platform") }
      try c.encode(ready.platform, forKey: AnyKey("platform"))
      guard ready.arch == "arm64" || ready.arch == "x64" else { throw ProtocolError.invalidValue("arch") }
      try c.encode(ready.arch, forKey: AnyKey("arch"))
      try c.encode(Validation.truncated(ready.osVersion, maxLength: 64), forKey: AnyKey("osVersion"))
      guard ready.pid > 0 else { throw ProtocolError.outOfRange("pid") }
      try c.encode(ready.pid, forKey: AnyKey("pid"))
      var global = c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("globalDrag"))
      try global.encode(ready.globalDragAvailable, forKey: AnyKey("available"))
      if let reason = ready.globalDragReason {
        try global.encode(Validation.truncated(reason, maxLength: 200), forKey: AnyKey("reason"))
      }
    case .state(let state):
      guard Validation.isOpaqueId(state.sessionId) else { throw ProtocolError.invalidValue("sessionId") }
      try c.encode(state.sessionId, forKey: AnyKey("sessionId"))
      try c.encode(state.state.rawValue, forKey: AnyKey("state"))
      if let mode = state.mode { try c.encode(mode.rawValue, forKey: AnyKey("mode")) }
      if let menuKey = state.menuKey {
        if let key = menuKey { try c.encode(key.rawValue, forKey: AnyKey("menuKey")) } else { try c.encodeNil(forKey: AnyKey("menuKey")) }
      }
      if let count = state.fileCount {
        try c.encode(min(max(count, 0), HelperProtocol.maxFileCount), forKey: AnyKey("fileCount"))
      }
    case .drop(let drop):
      guard Validation.isOpaqueId(drop.sessionId) else { throw ProtocolError.invalidValue("sessionId") }
      guard (1...HelperProtocol.maxFiles).contains(drop.files.count) else { throw ProtocolError.outOfRange("files") }
      for file in drop.files where file.isEmpty || Validation.length(file) > HelperProtocol.maxPathLength {
        throw ProtocolError.outOfRange("files")
      }
      try c.encode(drop.sessionId, forKey: AnyKey("sessionId"))
      try c.encode(drop.actionId.rawValue, forKey: AnyKey("actionId"))
      try c.encode(drop.mode.rawValue, forKey: AnyKey("mode"))
      try c.encode(drop.files, forKey: AnyKey("files"))
      try c.encode("copy", forKey: AnyKey("dropEffect"))
    case .cancelled(let sessionId, let reason):
      guard Validation.isOpaqueId(sessionId) else { throw ProtocolError.invalidValue("sessionId") }
      try c.encode(sessionId, forKey: AnyKey("sessionId"))
      try c.encode(reason.rawValue, forKey: AnyKey("reason"))
    case .pong(let nonce):
      guard nonce >= 0, Double(nonce) <= HelperProtocol.maxSafeInteger else { throw ProtocolError.outOfRange("nonce") }
      try c.encode(nonce, forKey: AnyKey("nonce"))
    case .permissions(let items):
      guard items.count <= 4 else { throw ProtocolError.outOfRange("items") }
      var list = c.nestedUnkeyedContainer(forKey: AnyKey("items"))
      for item in items {
        var entry = list.nestedContainer(keyedBy: AnyKey.self)
        try entry.encode(item.name.rawValue, forKey: AnyKey("name"))
        try entry.encode(item.required, forKey: AnyKey("required"))
        try entry.encode(item.granted, forKey: AnyKey("granted"))
      }
    case .log(let level, let message):
      try c.encode(level.rawValue, forKey: AnyKey("level"))
      try c.encode(Validation.truncated(message, maxLength: 2000), forKey: AnyKey("message"))
    case .error(let code, let message, let fatal):
      try c.encode(Validation.truncated(code, maxLength: 64), forKey: AnyKey("code"))
      try c.encode(Validation.truncated(message, maxLength: 2000), forKey: AnyKey("message"))
      try c.encode(fatal, forKey: AnyKey("fatal"))
    }
  }
}
