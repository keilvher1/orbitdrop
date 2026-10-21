#include "core/geometry.h"

#include <algorithm>
#include <cmath>

#include "core/jsmath.h"

namespace od::geo {

namespace {
// Math.min / Math.max semantics, including NaN propagation and the ordering of
// signed zeros (Math.max(0, -0) === 0, Math.min(0, -0) === -0).
inline double jsMin(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return std::nan("");
    if (a < b) return a;
    if (b < a) return b;
    if (a == 0 && b == 0) return std::signbit(a) ? a : b;
    return a;
}
inline double jsMax(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return std::nan("");
    if (a > b) return a;
    if (b > a) return b;
    if (a == 0 && b == 0) return std::signbit(a) ? b : a;
    return a;
}
}  // namespace

double normalizeDeg(double deg) {
    const double r = jsmath::mod(deg, 360);
    return r < 0 ? r + 360 : r;
}

double outerRadius(double diameter) { return diameter / 2; }

double innerRadius(double diameter, const WheelGeometry& g) { return (diameter / 2) * g.innerRadiusRatio; }

double sectorOuterRadius(double diameter, const WheelGeometry& g) { return diameter / 2 - g.ringInset; }

double sectorSpan(double sectorCount) { return 360 / sectorCount; }

double sectorCenterDeg(double index, double sectorCount, const WheelGeometry& g) {
    return g.startAngleDeg + index * sectorSpan(sectorCount);
}

double sectorStartDeg(double index, double sectorCount, const WheelGeometry& g) {
    const double span = sectorSpan(sectorCount);
    return g.startAngleDeg + index * span - span / 2;
}

WheelHit hitTestWheel(double dx, double dy, double sectorCount, double diameter, const WheelGeometry& g) {
    const double r = jsmath::hypot(dx, dy);
    if (!jsmath::isFinite(r)) return WheelHit::outside();
    if (r <= innerRadius(diameter, g)) return WheelHit::center();
    if (r > outerRadius(diameter)) return WheelHit::outside();
    const double count = std::trunc(sectorCount);  // Math.trunc
    if (!(count >= 1)) return WheelHit::outside();
    const double angle = (jsmath::atan2(dy, dx) * 180) / jsmath::kPi;
    const double span = sectorSpan(count);
    const double rel = normalizeDeg(angle - g.startAngleDeg + span / 2);
    const double index = jsMin(count - 1, std::floor(rel / span));
    // The reference would return a non-finite index for an infinite count; an
    // int cannot carry that, so such (absurd) input is reported as outside.
    if (!jsmath::isFinite(index) || index < 0 || index > 2147483647.0) return WheelHit::outside();
    return WheelHit::sector(static_cast<int>(index));
}

WheelPlacement placeWheel(Point activation, Rect workArea, const WheelGeometry& g) {
    const double available = jsMin(workArea.width, workArea.height) - 2 * g.edgePadding;
    const double smallest = jsMin(g.minDiameter, g.diameter);
    const double diameter = jsMax(smallest, jsMin(g.diameter, available));
    const double radius = diameter / 2;
    const auto clampAxis = [&](double value, double start, double length) {
        const double lo = start + radius + g.edgePadding;
        const double hi = start + length - radius - g.edgePadding;
        if (lo > hi || !jsmath::isFinite(value)) return start + length / 2;
        return jsMin(hi, jsMax(lo, value));
    };
    WheelPlacement p;
    p.center.x = clampAxis(activation.x, workArea.x, workArea.width);
    p.center.y = clampAxis(activation.y, workArea.y, workArea.height);
    p.diameter = diameter;
    const double half = radius + g.windowMargin;
    p.windowFrame = Rect{p.center.x - half, p.center.y - half, half * 2, half * 2};
    p.shifted = p.center.x != activation.x || p.center.y != activation.y;
    return p;
}

WheelHit hitTestPlacedWheel(Point pointer, Point center, double diameter, double sectorCount, const WheelGeometry& g) {
    return hitTestWheel(pointer.x - center.x, pointer.y - center.y, sectorCount, diameter, g);
}

bool isArmed(Point activation, Point pointer, bool passedCenter, const WheelGeometry& g) {
    if (passedCenter) return true;
    const double distance = jsmath::hypot(pointer.x - activation.x, pointer.y - activation.y);
    return jsmath::isFinite(distance) && distance >= g.armDistance;
}

}  // namespace od::geo
