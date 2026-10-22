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
// the per-display affine map as is. A pointer is hit-tested by converting it
// with the wheel display's map and comparing it with the DIP wheel center.
//
// The wheel window is laid out like the macOS panel: the disc's bounding square
// plus a strip for the secondary caption (PanelLayout), not the reference
// placeWheel windowFrame (still computed for golden parity). The window's
// alpha mask evaluates the hit-test function for every window pixel, so "a
// pixel is hit-testable by OLE (alpha >= 1)" and "hitTestWheel(...) is not
// outside, or the pixel is on the visible caption pill" are the same predicate.
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

/** Where the secondary caption goes (same rule as the macOS helper's WheelPanelLayout). */
enum class CaptionPlacement { Below, Above, None };

constexpr double kCaptionHeight = 26;    // DIP, height of the caption strip (macOS: the same)
constexpr double kCaptionGap = 6;        // DIP between the disc and the strip
constexpr double kCaptionPadding = 12;   // DIP left and right of the caption text inside the pill
constexpr double kCaptionMinWidth = 56;  // DIP, narrowest pill

/**
 * The wheel window's content in global DIP, as on macOS: the disc's bounding
 * square plus a strip for the secondary caption, below the disc, above it when
 * there is no room below in the work area (wheel pushed against the bottom
 * edge or the taskbar), none when neither fits (the capsule alone then shows
 * the choice). Only the disc and the visible caption pill get non-zero alpha:
 * the strip beside the pill and the square's corners let drags through.
 */
struct PanelLayout {
    Rect frame;
    CaptionPlacement captionPlacement = CaptionPlacement::None;
    Rect caption;  // the strip; zero size when captionPlacement is None
};

/** Lays the window out around a placed wheel, keeping the caption strip inside `workArea`. */
PanelLayout computePanelLayout(const geo::WheelPlacement& placement, const Rect& workArea, double captionHeight = kCaptionHeight,
                               double gap = kCaptionGap);

/** Where the wheel window goes and how screen pixels map to wheel-local DIP. */
struct WheelFrame {
    bool valid = false;
    int displayIndex = -1;
    Win32Display display;           // the wheel's display (its map converts every pointer)
    double scale = 1;
    geo::WheelPlacement placement;  // global DIP
    PanelLayout panel;              // window content: disc square + caption strip, global DIP
    Point activationDip;            // global DIP of the activation point
    Point centerPhysical;           // wheel center in physical px (unrounded)
    RectI windowFramePx;            // enclosing pixel rect of placement.windowFrame (golden coords.win parity; not the window)
    /**
     * The window: enclosing pixel rect of panel.frame, one pixel larger on each
     * side. The mask samples a pixel at its integer corner and drawing is offset
     * by half a pixel, so a disc pixel exactly on the right or bottom edge (an
     * integer center plus an integer radius, e.g. at 100 %) lies one pixel past
     * the enclosing rectangle. The left and top border only keep it symmetric.
     */
    RectI windowPx;
    double diameter = 0;  // = placement.diameter
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

// ------------------------------------------------------------------ caption pill and hit shape

/** The caption strip in wheel-local DIP (offset from the disc centre, like the sector outlines). */
Rect captionStripLocal(const WheelFrame& f);
/**
 * The caption pill for a line of text `textWidth` DIP wide, centred in `strip`:
 * the text plus kCaptionPadding on each side, at least kCaptionMinWidth, at most
 * the strip (the macOS pill). Same coordinate space as `strip`.
 */
Rect captionPillRect(const Rect& strip, double textWidth);
/** Inside the pill, a rounded rectangle with radius min(width, height) / 2 (closed, like the disc test). */
bool pillContains(const Rect& pill, Point p);
/** True when screen pixel p is on the caption pill (`pill` in wheel-local DIP), converted with the wheel display's map. */
bool screenPixelInsidePill(PointI p, const WheelFrame& f, const Rect& pill);
/** screenPixelInsidePill of window pixel (i, j): such pixels get alpha >= 1. */
bool windowPixelInsidePill(int32_t i, int32_t j, const WheelFrame& f, const Rect& pill);

/**
 * The window's hit shape, applied after drawing: every pixel on the disc (dead
 * zone and gaps included) or on the visible caption pill gets alpha >= 1, every
 * other pixel alpha 0, so layered-window hit-testing hands drags everywhere
 * else to the window below. `bgra` is premultiplied, top-down, `width` ×
 * `height` pixels with a stride of width * 4 (f.windowPx's size); `pill` is in
 * wheel-local DIP, null when no caption is drawn.
 */
void applyHitShape(uint8_t* bgra, int32_t width, int32_t height, const WheelFrame& f, const Rect* pill);

}  // namespace od::coords
