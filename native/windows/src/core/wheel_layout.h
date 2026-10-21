// Drawing geometry of the wheel (portable, no graphics API).
//
// Sectors are annular wedges separated by a constant-width gap (the side edges
// are parallel to, and sectorGap/2 away from, the boundary rays used by
// hitTestWheel) with rounded corners of radius sectorCornerRadius (reduced when
// it does not fit). Coordinates are wheel-local DIP, y down, angles clockwise.
// The Direct2D renderer turns each Figure into an ID2D1PathGeometry; tests
// flatten them to check symmetry, gap width and orientation.
#pragma once

#include <vector>

#include "core/geometry.h"

namespace od::layout {

struct Vec2 {
    double x = 0;
    double y = 0;
};

enum class SegKind { Line, Arc };

struct Segment {
    SegKind kind = SegKind::Line;
    Vec2 to;
    // Arc only:
    Vec2 center;
    double radius = 0;
    bool clockwise = true;  // visually clockwise (increasing angle, y down) — D2D1_SWEEP_DIRECTION_CLOCKWISE
    bool largeArc = false;  // sweep > 180°
};

struct Figure {
    Vec2 start;
    std::vector<Segment> segments;
};

struct SectorShape {
    std::vector<Figure> figures;  // 1 figure; 2 for a full ring (outer clockwise + inner counter-clockwise)
    Vec2 labelCenter;
    double labelMaxWidth = 0;
    double labelMaxHeight = 0;
    double centerDeg = 0;
    bool visible = false;  // false when the gap swallows the whole sector
};

struct Layout {
    double outerR = 0;        // diameter / 2 (hit-test radius, disc edge)
    double sectorOuterR = 0;  // diameter / 2 − ringInset
    double innerR = 0;        // dead-zone radius
    double ringR = 0;         // stroke center of the outer ring (outer edge = outerR)
    double ringWidth = 0;
    double cornerRadius = 0;  // radius actually used
    double capsuleWidth = 0;
    double capsuleHeight = 0;
    std::vector<SectorShape> sectors;
};

Layout computeLayout(int sectorCount, double diameter, const geo::WheelGeometry& g);

/** Polyline approximation of a figure (arcs sampled every ≤ maxStepDeg degrees). */
std::vector<Vec2> flatten(const Figure& f, double maxStepDeg = 2.0);

/** Shoelace area; positive for visually clockwise outlines in y-down space. */
double signedArea(const std::vector<Vec2>& polygon);

/** Point-in-polygon (even-odd) test on flattened figures. */
bool containsPoint(const std::vector<std::vector<Vec2>>& polygons, Vec2 p);

}  // namespace od::layout
