// Port of the atan/atan2 routines V8 uses for Math.atan/Math.atan2
// (v8/src/base/ieee754.cc, itself derived from FreeBSD msun / fdlibm) and of
// V8's Math.hypot builtin (v8/src/builtins/math.tq).
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunPro, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
//
// V8 is licensed under the BSD 3-Clause license
// (Copyright 2016 the V8 project authors). Only the algorithms are reproduced.

#include "core/jsmath.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace od::jsmath {
namespace {

inline int32_t highWord(double d) {
    uint64_t bits;
    std::memcpy(&bits, &d, sizeof bits);
    return static_cast<int32_t>(bits >> 32);
}

inline uint32_t lowWord(double d) {
    uint64_t bits;
    std::memcpy(&bits, &d, sizeof bits);
    return static_cast<uint32_t>(bits & 0xFFFFFFFFu);
}

// Two's complement negation without signed-overflow UB (V8: NegateWithWraparound).
inline uint32_t negateWrap(uint32_t v) { return 0u - v; }

}  // namespace

double atan(double x) {
    static const double atanhi[] = {
        4.63647609000806093515e-01, /* atan(0.5)hi 0x3FDDAC67, 0x0561BB4F */
        7.85398163397448278999e-01, /* atan(1.0)hi 0x3FE921FB, 0x54442D18 */
        9.82793723247329054082e-01, /* atan(1.5)hi 0x3FEF730B, 0xD281F69B */
        1.57079632679489655800e+00, /* atan(inf)hi 0x3FF921FB, 0x54442D18 */
    };
    static const double atanlo[] = {
        2.26987774529616870924e-17, /* atan(0.5)lo 0x3C7A2B7F, 0x222F65E2 */
        3.06161699786838301793e-17, /* atan(1.0)lo 0x3C81A626, 0x33145C07 */
        1.39033110312309984516e-17, /* atan(1.5)lo 0x3C700788, 0x7AF0CBBD */
        6.12323399573676603587e-17, /* atan(inf)lo 0x3C91A626, 0x33145C07 */
    };
    static const double aT[] = {
        3.33333333333329318027e-01,  /* 0x3FD55555, 0x5555550D */
        -1.99999999998764832476e-01, /* 0xBFC99999, 0x9998EBC4 */
        1.42857142725034663711e-01,  /* 0x3FC24924, 0x920083FF */
        -1.11111104054623557880e-01, /* 0xBFBC71C6, 0xFE231671 */
        9.09088713343650656196e-02,  /* 0x3FB745CD, 0xC54C206E */
        -7.69187620504482999495e-02, /* 0xBFB3B0F2, 0xAF749A6D */
        6.66107313738753120669e-02,  /* 0x3FB10D66, 0xA0D03D51 */
        -5.83357013379057348645e-02, /* 0xBFADDE2D, 0x52DEFD9A */
        4.97687799461593236017e-02,  /* 0x3FA97B4B, 0x24760DEB */
        -3.65315727442169155270e-02, /* 0xBFA2B444, 0x2C6A6C2F */
        1.62858201153657823623e-02,  /* 0x3F90AD3A, 0xE322DA11 */
    };
    static const double one = 1.0;
    static const double huge = 1.0e300;

    double w, s1, s2, z;
    int32_t ix, hx, id;

    hx = highWord(x);
    ix = hx & 0x7FFFFFFF;
    if (ix >= 0x44100000) { /* if |x| >= 2^66 */
        const uint32_t low = lowWord(x);
        if (ix > 0x7FF00000 || (ix == 0x7FF00000 && (low != 0))) return x + x; /* NaN */
        volatile double lo3 = atanlo[3];
        if (hx > 0) return atanhi[3] + lo3;
        return -atanhi[3] - lo3;
    }
    if (ix < 0x3FDC0000) {          /* |x| < 0.4375 */
        if (ix < 0x3E400000) {      /* |x| < 2^-27 */
            if (huge + x > one) return x; /* raise inexact */
        }
        id = -1;
    } else {
        x = std::fabs(x);
        if (ix < 0x3FF30000) {      /* |x| < 1.1875 */
            if (ix < 0x3FE60000) {  /* 7/16 <=|x|<11/16 */
                id = 0;
                x = std::fma(x, 2.0, -one) / (2.0 + x);
            } else { /* 11/16<=|x|< 19/16 */
                id = 1;
                x = (x - one) / (x + one);
            }
        } else {
            if (ix < 0x40038000) { /* |x| < 2.4375 */
                id = 2;
                x = (x - 1.5) / std::fma(x, 1.5, one);
            } else { /* 2.4375 <= |x| < 2^66 */
                id = 3;
                x = -1.0 / x;
            }
        }
    }
    /* end of argument reduction */
    z = x * x;
    w = z * z;
    /* break sum from i=0 to 10 aT[i]z**(i+1) into odd and even poly */
    // Node's V8 binary (arm64, clang -ffp-contract=on) evaluates these Horner
    // chains with fused multiply-adds; the explicit std::fma calls reproduce
    // exactly that rounding on every compiler and CPU (verified bit-for-bit
    // against Node's Math.atan2, see tests/test_jsmath.cpp).
    s1 = z * std::fma(w, std::fma(w, std::fma(w, std::fma(w, std::fma(w, aT[10], aT[8]), aT[6]), aT[4]), aT[2]), aT[0]);
    s2 = w * std::fma(w, std::fma(w, std::fma(w, std::fma(w, aT[9], aT[7]), aT[5]), aT[3]), aT[1]);
    if (id < 0) return std::fma(-x, s1 + s2, x);
    z = atanhi[id] - (std::fma(x, s1 + s2, -atanlo[id]) - x);
    return (hx < 0) ? -z : z;
}

double atan2(double y, double x) {
    static volatile double tiny = 1.0e-300;
    static const double zero = 0.0;
    static const double pi_o_4 = 7.8539816339744827900E-01; /* 0x3FE921FB, 0x54442D18 */
    static const double pi_o_2 = 1.5707963267948965580E+00; /* 0x3FF921FB, 0x54442D18 */
    static const double pi = 3.1415926535897931160E+00;     /* 0x400921FB, 0x54442D18 */
    static const double pi_lo = 1.2246467991473531772E-16;  /* 0x3CA1A626, 0x33145C07 */

    double z;
    int32_t k, m, hx, hy, ix, iy;
    uint32_t lx, ly;

    hx = highWord(x);
    lx = lowWord(x);
    ix = hx & 0x7FFFFFFF;
    hy = highWord(y);
    ly = lowWord(y);
    iy = hy & 0x7FFFFFFF;
    if ((static_cast<uint32_t>(ix) | ((lx | negateWrap(lx)) >> 31)) > 0x7FF00000u ||
        (static_cast<uint32_t>(iy) | ((ly | negateWrap(ly)) >> 31)) > 0x7FF00000u) {
        return x + y; /* x or y is NaN */
    }
    if (((static_cast<uint32_t>(hx) - 0x3FF00000u) | lx) == 0) return atan(y); /* x=1.0 */
    m = ((hy >> 31) & 1) | ((hx >> 30) & 2); /* 2*sign(x)+sign(y) */

    /* when y = 0 */
    if ((static_cast<uint32_t>(iy) | ly) == 0) {
        switch (m) {
            case 0:
            case 1:
                return y; /* atan(+-0,+anything)=+-0 */
            case 2:
                return pi + tiny; /* atan(+0,-anything) = pi */
            case 3:
                return -pi - tiny; /* atan(-0,-anything) =-pi */
        }
    }
    /* when x = 0 */
    if ((static_cast<uint32_t>(ix) | lx) == 0) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;

    /* when x is INF */
    if (ix == 0x7FF00000) {
        if (iy == 0x7FF00000) {
            switch (m) {
                case 0:
                    return pi_o_4 + tiny; /* atan(+INF,+INF) */
                case 1:
                    return -pi_o_4 - tiny; /* atan(-INF,+INF) */
                case 2:
                    return 3.0 * pi_o_4 + tiny; /*atan(+INF,-INF)*/
                case 3:
                    return -3.0 * pi_o_4 - tiny; /*atan(-INF,-INF)*/
            }
        } else {
            switch (m) {
                case 0:
                    return zero; /* atan(+...,+INF) */
                case 1:
                    return -zero; /* atan(-...,+INF) */
                case 2:
                    return pi + tiny; /* atan(+...,-INF) */
                case 3:
                    return -pi - tiny; /* atan(-...,-INF) */
            }
        }
    }
    /* when y is INF */
    if (iy == 0x7FF00000) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;

    /* compute y/x */
    k = (iy - ix) >> 20;
    if (k > 60) { /* |y/x| >  2**60 */
        z = pi_o_2 + 0.5 * pi_lo;
        m &= 1;
    } else if (hx < 0 && k < -60) {
        z = 0.0; /* 0 > |y|/x > -2**-60 */
    } else {
        z = atan(std::fabs(y / x)); /* safe to do y/x */
    }
    switch (m) {
        case 0:
            return z; /* atan(+,+) */
        case 1:
            return -z; /* atan(-,+) */
        case 2:
            return pi - (z - pi_lo); /* atan(+,-) */
        default:                     /* case 3 */
            return (z - pi_lo) - pi; /* atan(-,-) */
    }
}

double hypot(double a, double b) {
    // V8 MathHypot: NaN/Infinity handling, then Kahan summation of the
    // squares normalised by the largest magnitude.
    const bool aNaN = std::isnan(a);
    const bool bNaN = std::isnan(b);
    const double absA = aNaN ? 0.0 : std::fabs(a);
    const double absB = bNaN ? 0.0 : std::fabs(b);
    double max = 0.0;
    if (!aNaN && absA > max) max = absA;
    if (!bNaN && absB > max) max = absB;
    if (max == HUGE_VAL) return HUGE_VAL;
    if (aNaN || bNaN) return std::nan("");
    if (max == 0.0) return 0.0;

    double sum = 0.0;
    double compensation = 0.0;
    const double values[2] = {absA, absB};
    for (double v : values) {
        const double n = v / max;
        const double summand = n * n - compensation;
        const double preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    return std::sqrt(sum) * max;
}

double mod(double a, double b) { return std::fmod(a, b); }

bool isFinite(double v) { return std::isfinite(v); }

}  // namespace od::jsmath
