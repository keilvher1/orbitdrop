// Bit-exact ports of the two JavaScript math functions the geometry reference
// (packages/core/src/geometry.ts) depends on, so that hit-testing in the helper
// matches the TypeScript reference — and tests/fixtures/wheel-golden.json —
// bit for bit, including points exactly on sector and dead-zone boundaries.
//
// Measured on this machine (Node 24.7 / V8 arm64, 300 016 random + special
// vectors, see scripts/gen-fixtures.mjs → Tests/.../Fixtures/js-math-vectors.json):
//   Darwin libm hypot  differs from Math.hypot  in 34 % of cases,
//   Darwin libm atan2  differs from Math.atan2  in 17 % of cases,
//   plain fdlibm atan2 differs in 0.1 % (V8's arm64 build fuses multiply-adds),
//   the ports below differ in 0 cases.
//
// `Double.addingProduct` is a correctly rounded fused multiply-add on every
// architecture (an `fmadd` instruction on arm64, libm `fma` on x86_64), so the
// arm64 and x86_64 helpers produce identical bits.

public enum JSMath {
  /// `Math.hypot(a, b)` as implemented by V8 (src/builtins/math.tq, MathHypot):
  /// scale by the largest magnitude, Kahan-compensated sum of squares, sqrt · max.
  public static func hypot(_ a: Double, _ b: Double) -> Double {
    let absA = a.magnitude
    let absB = b.magnitude
    var oneArgIsNaN = false
    var maxValue = 0.0
    if a.isNaN { oneArgIsNaN = true } else if absA > maxValue { maxValue = absA }
    if b.isNaN { oneArgIsNaN = true } else if absB > maxValue { maxValue = absB }
    if maxValue == .infinity { return .infinity }
    if oneArgIsNaN { return .nan }
    if maxValue == 0 { return 0 }
    var sum = 0.0
    var compensation = 0.0
    for value in [a.isNaN ? 0 : absA, b.isNaN ? 0 : absB] {
      let n = value / maxValue
      let summand = n * n - compensation
      let preliminary = sum + summand
      compensation = (preliminary - sum) - summand
      sum = preliminary
    }
    return sum.squareRoot() * maxValue
  }

  /// `Math.atan2(y, x)`: V8's base::ieee754::atan2 (FreeBSD msun / fdlibm) with the
  /// multiply-add contractions clang applies in the arm64 V8 build (verified by
  /// disassembling `v8::base::ieee754::atan` in the shipped node binary).
  public static func atan2(_ y: Double, _ x: Double) -> Double {
    let tiny = 1.0e-300
    let piOver4 = 7.8539816339744827900E-01
    let piOver2 = 1.5707963267948965580E+00
    let pi = 3.1415926535897931160E+00
    let piLo = 1.2246467991473531772E-16

    let hx = highWord(x)
    let ix = hx & 0x7FFF_FFFF
    let lx = lowWord(x)
    let hy = highWord(y)
    let iy = hy & 0x7FFF_FFFF
    let ly = lowWord(y)
    // (lx | -lx) >> 31 on an unsigned word: 1 when lx != 0.
    let lxNonZero = Int32(bitPattern: (lx | (0 &- lx)) >> 31)
    let lyNonZero = Int32(bitPattern: (ly | (0 &- ly)) >> 31)
    if (ix | lxNonZero) > 0x7FF0_0000 || (iy | lyNonZero) > 0x7FF0_0000 {
      return x + y  // NaN
    }
    if ((hx &- 0x3FF0_0000) | Int32(bitPattern: lx)) == 0 { return atan(y) }  // x == 1.0
    var m = ((hy >> 31) & 1) | ((hx >> 30) & 2)  // 2·sign(x) + sign(y)

    if (iy | Int32(bitPattern: ly)) == 0 {  // y == ±0
      switch m {
      case 0, 1: return y
      case 2: return pi + tiny
      default: return -pi - tiny
      }
    }
    if (ix | Int32(bitPattern: lx)) == 0 { return hy < 0 ? -piOver2 - tiny : piOver2 + tiny }  // x == ±0
    if ix == 0x7FF0_0000 {  // x is ±inf
      if iy == 0x7FF0_0000 {
        switch m {
        case 0: return piOver4 + tiny
        case 1: return -piOver4 - tiny
        case 2: return 3.0 * piOver4 + tiny
        default: return -3.0 * piOver4 - tiny
        }
      } else {
        switch m {
        case 0: return 0.0
        case 1: return -0.0
        case 2: return pi + tiny
        default: return -pi - tiny
        }
      }
    }
    if iy == 0x7FF0_0000 { return hy < 0 ? -piOver2 - tiny : piOver2 + tiny }  // y is ±inf

    let k = (iy &- ix) >> 20
    let z: Double
    if k > 60 {  // |y/x| > 2^60
      z = piOver2 + 0.5 * piLo
      m &= 1
    } else if hx < 0 && k < -60 {  // 0 > |y|/x > -2^-60
      z = 0.0
    } else {
      z = atan((y / x).magnitude)
    }
    switch m {
    case 0: return z
    case 1: return -z
    case 2: return pi - (z - piLo)
    default: return (z - piLo) - pi
    }
  }

  /// V8 base::ieee754::atan with arm64 contractions (fmadd/fmsub/fnmsub).
  public static func atan(_ input: Double) -> Double {
    var x = input
    let hx = highWord(x)
    let ix = hx & 0x7FFF_FFFF
    let id: Int
    if ix >= 0x4410_0000 {  // |x| >= 2^66
      if ix > 0x7FF0_0000 || (ix == 0x7FF0_0000 && lowWord(x) != 0) { return x + x }  // NaN
      return hx > 0 ? atanHi[3] + atanLo[3] : -atanHi[3] - atanLo[3]
    }
    if ix < 0x3FDC_0000 {  // |x| < 0.4375
      if ix < 0x3E40_0000 {  // |x| < 2^-27
        if 1.0e300 + x > 1.0 { return x }
      }
      id = -1
    } else {
      x = x.magnitude
      if ix < 0x3FF3_0000 {  // |x| < 1.1875
        if ix < 0x3FE6_0000 {  // 7/16 <= |x| < 11/16
          id = 0
          x = (-1.0).addingProduct(x, 2.0) / (2.0 + x)
        } else {  // 11/16 <= |x| < 19/16
          id = 1
          x = (x - 1.0) / (x + 1.0)
        }
      } else {
        if ix < 0x4003_8000 {  // |x| < 2.4375
          id = 2
          x = (x - 1.5) / (1.0).addingProduct(x, 1.5)
        } else {  // 2.4375 <= |x| < 2^66
          id = 3
          x = -1.0 / x
        }
      }
    }
    let z = x * x
    let w = z * z
    // s1 = z·(aT0 + w·(aT2 + w·(aT4 + w·(aT6 + w·(aT8 + w·aT10))))), each "a + w·b" fused.
    let s1 = z * aT[0].addingProduct(w, aT[2].addingProduct(w, aT[4].addingProduct(w, aT[6].addingProduct(w, aT[8].addingProduct(w, aT[10])))))
    let s2 = w * aT[1].addingProduct(w, aT[3].addingProduct(w, aT[5].addingProduct(w, aT[7].addingProduct(w, aT[9]))))
    if id < 0 {
      return x.addingProduct(-x, s1 + s2)  // x − x·(s1+s2), fused (fmsub)
    }
    let t = (-atanLo[id]).addingProduct(x, s1 + s2)  // x·(s1+s2) − atanlo[id], fused (fnmsub)
    let r = atanHi[id] - (t - x)
    return hx < 0 ? -r : r
  }

  private static let atanHi: [Double] = [
    4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00,
  ]
  private static let atanLo: [Double] = [
    2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17,
  ]
  private static let aT: [Double] = [
    3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
    9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
    4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02,
  ]

  @inline(__always) private static func highWord(_ x: Double) -> Int32 {
    Int32(truncatingIfNeeded: Int64(bitPattern: x.bitPattern) >> 32)
  }
  @inline(__always) private static func lowWord(_ x: Double) -> UInt32 {
    UInt32(truncatingIfNeeded: x.bitPattern)
  }

  /// `Math.PI`.
  public static let pi = 3.141592653589793

  /// JS `a % b` on doubles (fmod: truncated, sign of the dividend; exact).
  public static func remainder(_ a: Double, _ b: Double) -> Double {
    a.truncatingRemainder(dividingBy: b)
  }

  /// `Math.trunc`.
  public static func trunc(_ x: Double) -> Double { x.rounded(.towardZero) }

  /// `Math.floor`.
  public static func floor(_ x: Double) -> Double { x.rounded(.down) }

  /// `Math.min(a, b)` (NaN-propagating, −0 < +0).
  public static func min(_ a: Double, _ b: Double) -> Double {
    if a.isNaN || b.isNaN { return .nan }
    if a == 0 && b == 0 { return a.sign == .minus ? a : b }
    return a < b ? a : b
  }

  /// `Math.max(a, b)` (NaN-propagating, +0 > −0).
  public static func max(_ a: Double, _ b: Double) -> Double {
    if a.isNaN || b.isNaN { return .nan }
    if a == 0 && b == 0 { return a.sign == .minus ? b : a }
    return a > b ? a : b
  }
}
