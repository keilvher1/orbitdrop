#include "core/wheel_layout.h"

#include <algorithm>
#include <cmath>

namespace od::layout {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2 * kPi;

inline double rad(double deg) { return deg * kPi / 180.0; }
inline Vec2 add(Vec2 a, Vec2 b) { return Vec2{a.x + b.x, a.y + b.y}; }
inline Vec2 mul(Vec2 a, double k) { return Vec2{a.x * k, a.y * k}; }
inline double len(Vec2 a) { return std::sqrt(a.x * a.x + a.y * a.y); }
inline double angleOf(Vec2 v) { return std::atan2(v.y, v.x); }

double normalizeRad(double a) {
    double r = std::fmod(a, kTwoPi);
    if (r < 0) r += kTwoPi;
    return r;
}

Segment lineTo(Vec2 to) {
    Segment s;
    s.kind = SegKind::Line;
    s.to = to;
    return s;
}

Segment arcTo(Vec2 from, Vec2 to, Vec2 center, double radius, bool clockwise) {
    Segment s;
    s.kind = SegKind::Arc;
    s.to = to;
    s.center = center;
    s.radius = radius;
    s.clockwise = clockwise;
    const double a0 = angleOf(Vec2{from.x - center.x, from.y - center.y});
    const double a1 = angleOf(Vec2{to.x - center.x, to.y - center.y});
    const double sweep = clockwise ? normalizeRad(a1 - a0) : normalizeRad(a0 - a1);
    s.largeArc = sweep > kPi;
    return s;
}

/** One side of a sector: boundary ray direction u and the unit normal pointing into the sector. */
struct Side {
    Vec2 u;
    Vec2 n;
};

struct Corners {
    Vec2 outerArc, outerLine, outerCenter;  // fillet tangent points and center at the outer circle
    Vec2 innerArc, innerLine, innerCenter;  // same at the inner circle
    double tOuter = 0, tInner = 0;          // positions of the line tangent points along u
};

/** Fillet geometry for a side; returns false when rc does not fit. */
bool corners(const Side& s, double hg, double ro, double ri, double rc, bool needInner, Corners& c) {
    const double off = hg + rc;
    const double outerDist = ro - rc;
    if (outerDist <= off) return false;
    c.tOuter = std::sqrt(outerDist * outerDist - off * off);
    c.outerCenter = add(mul(s.u, c.tOuter), mul(s.n, off));
    c.outerLine = add(mul(s.u, c.tOuter), mul(s.n, hg));
    c.outerArc = mul(c.outerCenter, ro / outerDist);
    if (!needInner) return true;
    const double innerDist = ri + rc;
    if (innerDist <= off) return false;
    c.tInner = std::sqrt(innerDist * innerDist - off * off);
    c.innerCenter = add(mul(s.u, c.tInner), mul(s.n, off));
    c.innerLine = add(mul(s.u, c.tInner), mul(s.n, hg));
    c.innerArc = mul(c.innerCenter, ri / innerDist);
    return c.tInner <= c.tOuter;
}

/** Angular offset (radians) of a corner point from its side's boundary ray. */
double offsetAngle(const Side& s, Vec2 p) {
    const double along = p.x * s.u.x + p.y * s.u.y;
    const double across = p.x * s.n.x + p.y * s.n.y;
    return std::atan2(across, along);
}

Figure circleFigure(double r, bool clockwise) {
    Figure f;
    f.start = Vec2{r, 0};
    const Vec2 opposite{-r, 0};
    const Vec2 c{0, 0};
    f.segments.push_back(arcTo(f.start, opposite, c, r, clockwise));
    // Second half: from (-r, 0) back to (r, 0) in the same direction.
    Segment back;
    back.kind = SegKind::Arc;
    back.to = f.start;
    back.center = c;
    back.radius = r;
    back.clockwise = clockwise;
    back.largeArc = false;
    f.segments.push_back(back);
    return f;
}

}  // namespace

Layout computeLayout(int sectorCount, double diameter, const geo::WheelGeometry& g) {
    Layout L;
    L.outerR = diameter / 2;
    L.sectorOuterR = std::max(0.0, diameter / 2 - g.ringInset);
    L.innerR = (diameter / 2) * g.innerRadiusRatio;
    L.ringWidth = std::max(0.0, g.ringWidth);
    L.ringR = L.outerR - L.ringWidth / 2;
    const double capsuleLimit = std::max(0.0, 2 * (L.innerR - 2));
    L.capsuleWidth = std::min(g.capsuleWidth, capsuleLimit);
    L.capsuleHeight = std::min(g.capsuleHeight, capsuleLimit);

    if (sectorCount <= 0) return L;
    const double ro = L.sectorOuterR;
    const double ri = L.innerR;
    const double hg = std::max(0.0, g.sectorGap / 2);
    const double midR = (ri + ro) / 2;

    if (sectorCount == 1) {
        SectorShape s;
        s.visible = ro > ri;
        s.centerDeg = g.startAngleDeg;
        if (s.visible) {
            s.figures.push_back(circleFigure(ro, true));
            s.figures.push_back(circleFigure(ri, false));
        }
        const double a = rad(g.startAngleDeg);
        s.labelCenter = Vec2{midR * std::cos(a), midR * std::sin(a)};
        s.labelMaxWidth = std::max(0.0, ro * 1.2);
        s.labelMaxHeight = std::max(0.0, ro - ri - 8);
        L.sectors.push_back(s);
        L.cornerRadius = 0;
        return L;
    }

    const double spanDeg = 360.0 / sectorCount;
    const double hr = rad(spanDeg / 2);
    const bool parallelSides = spanDeg >= 180.0 - 1e-9;  // two sectors: the side lines are collinear
    // The two side lines of a sector meet at dApex from the center; when that is
    // outside the dead zone there is no inner arc (pointed inner end).
    const double dApex = parallelSides ? 0.0 : hg / std::sin(hr);
    const bool apexMode = parallelSides ? hg >= ri : dApex >= ri;

    // Choose the corner radius once for all sectors (they are congruent).
    const Side probe{Vec2{1, 0}, Vec2{0, 1}};
    double rc = std::max(0.0, std::min(g.sectorCornerRadius, (ro - ri) / 2));
    const auto fits = [&](double r) {
        Corners c;
        if (!corners(probe, hg, ro, ri, r, !apexMode, c)) return false;
        if (offsetAngle(probe, c.outerArc) > hr - 1e-9) return false;
        if (!apexMode && offsetAngle(probe, c.innerArc) > hr - 1e-9) return false;
        if (apexMode && !parallelSides && c.tOuter < dApex * std::cos(hr)) return false;
        return true;
    };
    while (rc > 0.01 && !fits(rc)) rc *= 0.85;
    if (rc <= 0.01) rc = 0;
    L.cornerRadius = rc;
    const bool anyFit = fits(rc);

    for (int i = 0; i < sectorCount; ++i) {
        SectorShape s;
        const double cDeg = g.startAngleDeg + i * spanDeg;
        s.centerDeg = cDeg;
        const double a0 = rad(cDeg - spanDeg / 2);
        const double a1 = rad(cDeg + spanDeg / 2);
        const Side side0{Vec2{std::cos(a0), std::sin(a0)}, Vec2{-std::sin(a0), std::cos(a0)}};
        const Side side1{Vec2{std::cos(a1), std::sin(a1)}, Vec2{std::sin(a1), -std::cos(a1)}};
        const double ca = rad(cDeg);
        const Vec2 bisector{std::cos(ca), std::sin(ca)};

        const double innerEdge = apexMode ? (parallelSides ? hg : dApex) : ri;
        const double labelR = (std::min(innerEdge, ro) + ro) / 2;
        s.labelCenter = mul(bisector, labelR);
        const double chord = parallelSides ? 2 * labelR : 2 * labelR * std::sin(hr);
        s.labelMaxWidth = std::max(0.0, chord - 2 * hg - 12);
        s.labelMaxHeight = std::max(0.0, ro - innerEdge - 8);

        Corners c0, c1;
        if (!anyFit || !corners(side0, hg, ro, ri, rc, !apexMode, c0) || !corners(side1, hg, ro, ri, rc, !apexMode, c1)) {
            s.visible = false;
            L.sectors.push_back(s);
            continue;
        }
        s.visible = true;
        Figure f;
        f.start = c0.outerArc;
        Vec2 cur = f.start;
        const auto push = [&](Segment seg) {
            f.segments.push_back(seg);
            cur = seg.to;
        };
        push(arcTo(cur, c1.outerArc, Vec2{0, 0}, ro, true));
        if (rc > 0) push(arcTo(cur, c1.outerLine, c1.outerCenter, rc, true));
        if (apexMode) {
            if (!parallelSides) push(lineTo(mul(bisector, dApex)));
        } else {
            push(lineTo(c1.innerLine));
            if (rc > 0) push(arcTo(cur, c1.innerArc, c1.innerCenter, rc, true));
            push(arcTo(cur, c0.innerArc, Vec2{0, 0}, ri, false));
            if (rc > 0) push(arcTo(cur, c0.innerLine, c0.innerCenter, rc, true));
        }
        push(lineTo(c0.outerLine));
        if (rc > 0) push(arcTo(cur, c0.outerArc, c0.outerCenter, rc, true));
        s.figures.push_back(std::move(f));
        L.sectors.push_back(std::move(s));
    }
    return L;
}

std::vector<Vec2> flatten(const Figure& f, double maxStepDeg) {
    std::vector<Vec2> pts;
    pts.push_back(f.start);
    Vec2 cur = f.start;
    for (const Segment& s : f.segments) {
        if (s.kind == SegKind::Line) {
            pts.push_back(s.to);
            cur = s.to;
            continue;
        }
        const double a0 = angleOf(Vec2{cur.x - s.center.x, cur.y - s.center.y});
        const double a1 = angleOf(Vec2{s.to.x - s.center.x, s.to.y - s.center.y});
        double sweep = s.clockwise ? normalizeRad(a1 - a0) : -normalizeRad(a0 - a1);
        if (std::fabs(sweep) < 1e-12 && len(Vec2{cur.x - s.to.x, cur.y - s.to.y}) > 1e-9) {
            sweep = s.clockwise ? kTwoPi : -kTwoPi;
        }
        // A 180° half circle: normalizeRad gives exactly pi either way.
        const int steps = std::max(1, static_cast<int>(std::ceil(std::fabs(sweep) / rad(maxStepDeg))));
        for (int k = 1; k <= steps; ++k) {
            const double a = a0 + sweep * k / steps;
            pts.push_back(Vec2{s.center.x + s.radius * std::cos(a), s.center.y + s.radius * std::sin(a)});
        }
        pts.back() = s.to;
        cur = s.to;
    }
    return pts;
}

double signedArea(const std::vector<Vec2>& p) {
    double a = 0;
    for (size_t i = 0; i < p.size(); ++i) {
        const Vec2& u = p[i];
        const Vec2& v = p[(i + 1) % p.size()];
        a += u.x * v.y - v.x * u.y;
    }
    return a / 2;
}

bool containsPoint(const std::vector<std::vector<Vec2>>& polygons, Vec2 p) {
    bool inside = false;
    for (const auto& poly : polygons) {
        for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
            const Vec2& a = poly[i];
            const Vec2& b = poly[j];
            if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
    }
    return inside;
}

}  // namespace od::layout
