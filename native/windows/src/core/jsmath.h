// JavaScript-compatible math primitives.
//
// The wheel geometry is specified by a TypeScript reference implementation
// (packages/core/src/geometry.ts) and pinned by golden vectors generated with
// Node (V8). To agree bit-for-bit on sector boundaries we use the same
// algorithms V8 uses for Math.atan2 (fdlibm / FreeBSD msun) and Math.hypot
// (max-normalised Kahan summation) instead of the C runtime's versions, whose
// last-ulp results differ between libm implementations.
//
// Compile with -ffp-contract=off (GCC/Clang) or /fp:precise (MSVC) so that no
// fused multiply-add changes the rounding (see CMakeLists.txt).
#pragma once

namespace od::jsmath {

/** Math.atan2(y, x) as implemented by V8 (fdlibm e_atan2.c / s_atan.c). */
double atan2(double y, double x);

/** Math.atan(x) as implemented by V8. */
double atan(double x);

/** Math.hypot(a, b) as implemented by V8 (two-argument form). */
double hypot(double a, double b);

/** Math.PI. */
constexpr double kPi = 3.141592653589793;

/** JavaScript `%` on doubles (C fmod: the result has the sign of the dividend). */
double mod(double a, double b);

/** Number.isFinite. */
bool isFinite(double v);

}  // namespace od::jsmath
