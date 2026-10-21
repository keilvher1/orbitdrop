import Darwin
import Foundation
import OrbitDropHelperCore

/// Serialized NDJSON writer for stdout. Encoding happens on the caller's thread;
/// the blocking write(2) runs on a private serial queue so a slow reader in main
/// can never stall the AppKit thread (e.g. inside a drop callback).
public final class StdoutWriter: @unchecked Sendable {
  private let queue = DispatchQueue(label: "com.orbitdrop.helper.stdout", qos: .userInitiated)
  private let fd: Int32
  private let lock = NSLock()
  private var brokenFlag = false
  private let onBrokenPipe: @Sendable () -> Void

  public init(fd: Int32 = STDOUT_FILENO, onBrokenPipe: @escaping @Sendable () -> Void) {
    self.fd = fd
    self.onBrokenPipe = onBrokenPipe
  }

  public var isBroken: Bool {
    lock.lock()
    defer { lock.unlock() }
    return brokenFlag
  }

  public func send(_ message: HelperToMainMessage) {
    let line: Data
    do {
      line = try NDJSON.encodeLine(message)
    } catch {
      StderrLog.write("dropping invalid outgoing \(message.typeName): \(error)")
      return
    }
    queue.async { [self] in write(line) }
  }

  /// Waits until everything queued so far has been written (or the timeout passes).
  @discardableResult
  public func flush(timeout: TimeInterval) -> Bool {
    let done = DispatchSemaphore(value: 0)
    queue.async { done.signal() }
    return done.wait(timeout: .now() + timeout) == .success
  }

  private func write(_ data: Data) {
    if isBroken { return }
    let ok = data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Bool in
      guard let base = buffer.baseAddress else { return true }
      var offset = 0
      while offset < buffer.count {
        let n = Darwin.write(fd, base + offset, buffer.count - offset)
        if n > 0 {
          offset += n
        } else if n < 0 && errno == EINTR {
          continue
        } else if n < 0 && errno == EAGAIN {
          usleep(1000)
        } else {
          return false
        }
      }
      return true
    }
    if !ok {
      lock.lock()
      let first = !brokenFlag
      brokenFlag = true
      lock.unlock()
      if first { onBrokenPipe() }
    }
  }
}

/// Reads stdin on a dedicated thread, frames lines (with the 1 MiB limit) and parses
/// them off the main thread. Callbacks run on the reader thread; the app hops to main.
public final class StdinReader: @unchecked Sendable {
  private let fd: Int32
  private let onLine: @Sendable (ParsedLine) -> Void
  private let onOversized: @Sendable (Int) -> Void
  private let onEOF: @Sendable () -> Void

  public init(
    fd: Int32 = STDIN_FILENO, onLine: @escaping @Sendable (ParsedLine) -> Void, onOversized: @escaping @Sendable (Int) -> Void,
    onEOF: @escaping @Sendable () -> Void
  ) {
    self.fd = fd
    self.onLine = onLine
    self.onOversized = onOversized
    self.onEOF = onEOF
  }

  public func start() {
    let thread = Thread { [self] in run() }
    thread.name = "orbitdrop.stdin"
    thread.qualityOfService = .userInitiated
    thread.start()
  }

  private func run() {
    var framer = LineFramer(maxLineBytes: HelperProtocol.maxLineBytes)
    let capacity = 64 * 1024
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 16)
    defer { buffer.deallocate() }
    while true {
      let n = Darwin.read(fd, buffer, capacity)
      if n > 0 {
        let bytes = UnsafeRawBufferPointer(start: buffer, count: n)
        for event in framer.push(bytes) { deliver(event) }
      } else if n < 0 && errno == EINTR {
        continue
      } else {
        // 0 = EOF (parent closed the pipe or exited); < 0 = broken descriptor.
        for event in framer.finish() { deliver(event) }
        onEOF()
        return
      }
    }
  }

  private func deliver(_ event: LineFramer.Event) {
    switch event {
    case .line(let bytes):
      let parsed = NDJSON.parseMainLine(bytes)
      if parsed != .blank { onLine(parsed) }
    case .oversized(let count):
      onOversized(count)
    }
  }
}

/// Free-form diagnostics on stderr (main logs them at debug level). Never paths or contents.
public enum StderrLog {
  public static func write(_ message: String) {
    FileHandle.standardError.write(Data("[OrbitDropHelper] \(message)\n".utf8))
  }
}
