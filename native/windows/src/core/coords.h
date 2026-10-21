// Windows coordinate model.
//
// Port of the Windows parts of packages/core/src/coords.ts (global DIP layout
// of per-monitor-DPI displays, half-open rectangles, nearest-display lookup,
// roundHalfUp / roundRect) plus the helper's pixel-exact wheel frame.
//
// Per-Monitor DPI Aware v2: the helper sees physical pixels in virtual-screen
// coordinates (primary monitor top-left = (0, 0), others may be negative).
// Conversions are affine per display: dip = dipOrigin + (physical − physicalOrigin) / scale.
//
// Pixel convention (same as the golden vectors, tests/fixtures/wheel-golden.json
// coords.win): an integer physical position p (cursor, pixel) is converted with
// the per-display affine map as is. The wheel window is the enclosing pixel
// rectangle of the DIP window frame. A pointer is hit-tested by converting it
// with the wheel display's map and comparing it with the DIP wheel center.
// The window's alpha mask evaluates exactly that function for every window
// pixel, so "a pixel is hit-testable by OLE (alpha >= 1)" and
// "hitTestWheel(...) is not outside" are the same predicate.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "core/geometry.h"

namespace od::coords {

using geo::Point;
using geo::Rect;

// ------------------------------------------------------------------ rect helpers (coords.ts)

double rectRight(const Rect& r);
double rectBottom(const Rect& r);
Point rectCenter(const Rect& r);
/** Half-open containment: x <= p.x < x + width (same for y). */
bool rectContainsPoint(const Rect& r, Point p);
/** Distance from p to the closed rectangle (0 inside or on an edge). */
double distanceToRect(const Rect& r, Point p);
/** Distance between two closed rectangles (0 when they touch or overlap). */
double distanceBetweenRects(const Rect& a, const Rect& b);
/** Overlap with positive area, or false. */
bool intersectRects(const Rect& a, const Rect& b, Rect& out);

/** Containing display (first match), else the nearest (ties → lower index); -1 for none. */
int displayIndexAtPoint(Point p, const std::vector<Rect>& bounds);
/** Display a rectangle mostly lies on (largest intersection), else nearest to its center. */
int displayIndexForRect(const Rect& r, const std::vector<Rect>& bounds);

/** floor(x + 0.5) — natives must use this instead of std::round. */
double roundHalfUp(double x);
constexpr double kPixelSnapEpsilon = 1e-6;
enum class PixelRounding { None, Nearest, Enclosing };
Rect roundRect(const Rect& r, PixelRounding mode);

// ------------------------------------------------------------------ Win32 displays

/** One monitor as read from Win32 (MONITORINFO + GetDpiForMonitor(MDT_EFFECTIVE_DPI)). */
struct Win32Monitor {
    std::string id;
    Rect bounds;      // rcMonitor, physical px
    Rect workArea;    // rcWork, physical px
    double dpi = 96;  // effective DPI
    bool primary = false;
};

struct Win32Display {
    std::string id;
    Rect bounds;    // global DIP
    Rect workArea;  // global DIP
    double scaleFactor = 1;
    bool primary = false;
    Rect physicalBounds;
    Rect physicalWorkArea;
    double dpi = 96;
};

double scaleFactorForDpi(double dpi);

/** coords.ts displaysFromWin32Monitors: monitors laid out in global DIP so that touching monitors keep touching. */
std::vector<Win32Display> displaysFromWin32Monitors(const std::vector<Win32Monitor>& monitors);

Point physicalPointToDipOn(const Win32Display& d, Point p);
Point dipPointToPhysicalOn(const Win32Display& d, Point p);
Rect physicalRectToDipOn(const Win32Display& d, const Rect& r);
Rect dipRectToPhysicalOn(const Win32Display& d, const Rect& r, PixelRounding rounding = PixelRounding::None);

/** Physical point → global DIP using the display containing it physically (nearest otherwise). -1 when empty. */
int physicalToDipPoint(Point p, const std::vector<Win32Display>& displays, Point& out);
/** Global DIP point → physical using the display containing it in DIP (nearest otherwise). */
int dipToPhysicalPoint(Point p, const std::vector<Win32Display>& displays, Point& out);

// ------------------------------------------------------------------ rect placement (coords.ts)

Rect rectCenteredAt(Point center, double width, double height);
/** Move (never resize) `rect` inside `area`; centred on an axis where it is larger. */
Rect clampRectIntoArea(const Rect& rect, const Rect& area);
/** Shrink to at most the area's size (keeping the center), then clamp. */
Rect fitRectIntoArea(const Rect& rect, const Rect& area);
/** Smallest rectangle containing all rectangles (false for an empty list). */
bool unionRects(const std::vector<Rect>& rects, Rect& out);
/** DIP rect → physical using the display with the largest DIP overlap; returns the display index. */
int dipToPhysicalRect(const Rect& r, const std::vector<Win32Display>& displays, PixelRounding rounding, Rect& out);

// ------------------------------------------------------------------ wheel frame (helper)

struct PointI {
    int32_t x = 0;
    int32_t y = 0;
};

struct RectI {
    int32_t left = 0;
    int32_t top = 0;
    int32_t width = 0;
    int32_t height = 0;
};

/** Where the wheel window goes and how screen pixels map to wheel-local DIP. */
struct WheelFrame {
    bool valid = false;
    int displayIndex = -1;
    Win32Display display;           // the wheel's display (its map converts every pointer)
    double scale = 1;
    geo::WheelPlacement placement;  // global DIP
    Point activationDip;            // global DIP of the activation point
    Point centerPhysical;           // wheel center in physical px (unrounded)
    RectI windowPx;                 // window = enclosing pixel rect of placement.windowFrame
    double diameter = 0;            // = placement.diameter
};

/** Places the wheel for an activation at `activation` (physical px) on the given displays. */
WheelFrame computeWheelFrame(PointI activation, const std::vector<Win32Display>& displays, const geo::WheelGeometry& g);

/** Global DIP of a physical point using the wheel display's map. */
Point pointerDip(PointI p, const WheelFrame& f);
/** Wheel-local DIP offset (pointer − center) of a physical point. */
Point localDipOfScreenPixel(PointI p, const WheelFrame& f);
/** Wheel-local DIP offset of window pixel (i, j): localDipOfScreenPixel of that screen pixel. */
Point localDipOfWindowPixel(int32_t i, int32_t j, const WheelFrame& f);
/** True when window pixel (i, j) is on the disc (r <= diameter / 2): such pixels get alpha >= 1. */
bool windowPixelInsideDisc(int32_t i, int32_t j, const WheelFrame& f);
/**
 * Wheel center in window pixel coordinates for drawing. The mask samples each
 * pixel at its integer corner; drawing is offset by half a pixel so a pixel's
 * coverage (centred at i + 0.5) lines up with that sample.
 */
Point drawCenterPx(const WheelFrame& f);

}  // namespace od::coords
