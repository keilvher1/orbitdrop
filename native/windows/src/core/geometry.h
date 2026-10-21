// Line-by-line port of packages/core/src/geometry.ts (wheel hit-testing,
// placement and arming). Space: global DIP, top-left origin, y down; angles in
// degrees, positive = clockwise on screen. All arithmetic is IEEE-754 double
// precision with JavaScript semantics (see jsmath.h); golden vectors in
// tests/fixtures/wheel-golden.json keep this file equal to the reference.
#pragma once

#include <vector>

namespace od::geo {

struct Point {
    double x = 0;
    double y = 0;
};

struct Rect {
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;
};

/** contracts/geometry.ts WheelGeometry. */
struct WheelGeometry {
    double diameter;
    double minDiameter;
    double ringWidth;
    double ringInset;
    double innerRadiusRatio;
    double sectorGap;
    double sectorCornerRadius;
    double capsuleWidth;
    double capsuleHeight;
    double startAngleDeg;
    double windowMargin;
    double edgePadding;
    double armDistance;
};

/** contracts/geometry.ts DEFAULT_WHEEL_GEOMETRY. */
constexpr WheelGeometry kDefaultGeometry{
    360,   // diameter
    240,   // minDiameter
    1.5,   // ringWidth
    8,     // ringInset
    0.36,  // innerRadiusRatio
    6,     // sectorGap
    14,    // sectorCornerRadius
    104,   // capsuleWidth
    46,    // capsuleHeight
    -90,   // startAngleDeg
    24,    // windowMargin
    8,     // edgePadding
    6,     // armDistance
};

struct WheelHit {
    enum class Zone { Center, Outside, Sector };
    Zone zone = Zone::Outside;
    int index = -1;  // valid when zone == Sector

    static WheelHit center() { return {Zone::Center, -1}; }
    static WheelHit outside() { return {Zone::Outside, -1}; }
    static WheelHit sector(int i) { return {Zone::Sector, i}; }
    bool operator==(const WheelHit& o) const { return zone == o.zone && index == o.index; }
};

double normalizeDeg(double deg);
double outerRadius(double diameter);
double innerRadius(double diameter, const WheelGeometry& g = kDefaultGeometry);
double sectorOuterRadius(double diameter, const WheelGeometry& g = kDefaultGeometry);
double sectorSpan(double sectorCount);
double sectorCenterDeg(double index, double sectorCount, const WheelGeometry& g = kDefaultGeometry);
double sectorStartDeg(double index, double sectorCount, const WheelGeometry& g = kDefaultGeometry);

/** Hit-test a point relative to the wheel center (DIP, y down). */
WheelHit hitTestWheel(double dx, double dy, double sectorCount, double diameter, const WheelGeometry& g = kDefaultGeometry);

struct WheelPlacement {
    Point center;
    double diameter = 0;
    Rect windowFrame;
    bool shifted = false;
};

/** Place the wheel near the activation point, fully inside the work area. */
WheelPlacement placeWheel(Point activation, Rect workArea, const WheelGeometry& g = kDefaultGeometry);

/** Hit-test a pointer given in global DIP against a placed wheel. */
WheelHit hitTestPlacedWheel(Point pointer, Point center, double diameter, double sectorCount,
                            const WheelGeometry& g = kDefaultGeometry);

/** Sector arming (see geometry.ts). */
bool isArmed(Point activation, Point pointer, bool passedCenter, const WheelGeometry& g = kDefaultGeometry);

}  // namespace od::geo
