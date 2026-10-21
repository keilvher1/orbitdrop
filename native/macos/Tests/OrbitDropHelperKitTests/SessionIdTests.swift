import XCTest

@testable import OrbitDropHelperCore
@testable import OrbitDropHelperKit

/// Session ids are never reused, not even by a restarted helper (main ignores ids it
/// saw from a previous process), and always satisfy the protocol's Id schema.
final class SessionIdTests: XCTestCase {
  func testIdsAreSchemaValidAndUniqueAcrossRestarts() {
    let first = SessionIdGenerator(pid: 4242)
    let restarted = SessionIdGenerator(pid: 4242)  // same pid reused by the OS: the random part still differs
    let other = SessionIdGenerator(pid: 4243)
    var all: Set<String> = []
    for generator in [first, restarted, other] {
      for _ in 0..<500 {
        let id = generator.next()
        XCTAssertTrue(Validation.isOpaqueId(id), id)
        XCTAssertTrue(id.hasPrefix("m4242-") || id.hasPrefix("m4243-"))
        XCTAssertTrue(all.insert(id).inserted, "duplicate \(id)")
      }
    }
    XCTAssertEqual(all.count, 1500)
    XCTAssertLessThanOrEqual("m\(Int32.max)-\(String(UInt32.max, radix: 36))-\(Int.max)".count, 64, "worst case fits ^[A-Za-z0-9_-]{1,64}$")
  }
}
