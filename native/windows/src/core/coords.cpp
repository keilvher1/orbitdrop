#include "core/coords.h"

#include <algorithm>
#include <cmath>
#include <deque>
#include <limits>
#include <numeric>

#include "core/jsmath.h"

namespace od::coords {

namespace {
inline double jsMin(double a, double b) { return a < b ? a : (b < a ? b : a); }
inline double jsMax(double a, double b) { return a > b ? a : (b > a ? b : a); }
}  // namespace

// ------------------------------------------------------------------ rect helpers

double rectRight(const Rect& r) { return r.x + r.width; }
double rectBottom(const Rect& r) { return r.y + r.height; }
Point rectCenter(const Rect& r) { return Point{r.x + r.width / 2, r.y + r.height / 2}; }

bool rectContainsPoint(const Rect& r, Point p) {
    return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

double distanceToRect(const Rect& r, Point p) {
    const double dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.width ? p.x - (r.x + r.width) : 0;
    const double dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.height ? p.y - (r.y + r.height) : 0;
    return jsmath::hypot(dx, dy);
}

double distanceBetweenRects(const Rect& a, const Rect& b) {
    const double dx = jsMax(0, jsMax(a.x - rectRight(b), b.x - rectRight(a)));
    const double dy = jsMax(0, jsMax(a.y - rectBottom(b), b.y - rectBottom(a)));
    return jsmath::hypot(dx, dy);
}

bool intersectRects(const Rect& a, const Rect& b, Rect& out) {
    const double x = jsMax(a.x, b.x);
    const double y = jsMax(a.y, b.y);
    const double right = jsMin(rectRight(a), rectRight(b));
    const double bottom = jsMin(rectBottom(a), rectBottom(b));
    if (right <= x || bottom <= y) return false;
    out = Rect{x, y, right - x, bottom - y};
    return true;
}

int displayIndexAtPoint(Point p, const std::vector<Rect>& bounds) {
    for (size_t i = 0; i < bounds.size(); ++i) {
        if (rectContainsPoint(bounds[i], p)) return static_cast<int>(i);
    }
    int best = -1;
    double bestDistance = std::numeric_limits<double>::infinity();
    for (size_t i = 0; i < bounds.size(); ++i) {
        const double d = distanceToRect(bounds[i], p);
        if (d < bestDistance) {
            bestDistance = d;
            best = static_cast<int>(i);
        }
    }
    return best;
}

int displayIndexForRect(const Rect& r, const std::vector<Rect>& bounds) {
    int best = -1;
    double bestArea = 0;
    for (size_t i = 0; i < bounds.size(); ++i) {
        Rect overlap;
        const double area = intersectRects(r, bounds[i], overlap) ? overlap.width * overlap.height : 0;
        if (area > bestArea) {
            bestArea = area;
            best = static_cast<int>(i);
        }
    }
    return best >= 0 ? best : displayIndexAtPoint(rectCenter(r), bounds);
}

double roundHalfUp(double x) { return std::floor(x + 0.5); }

Rect roundRect(const Rect& r, PixelRounding mode) {
    if (mode == PixelRounding::None) return r;
    const double left = r.x;
    const double top = r.y;
    const double right = r.x + r.width;
    const double bottom = r.y + r.height;
    if (mode == PixelRounding::Nearest) {
        const double x = roundHalfUp(left);
        const double y = roundHalfUp(top);
        return Rect{x, y, roundHalfUp(right) - x, roundHalfUp(bottom) - y};
    }
    const double x = std::floor(left + kPixelSnapEpsilon);
    const double y = std::floor(top + kPixelSnapEpsilon);
    return Rect{x, y, std::ceil(right - kPixelSnapEpsilon) - x, std::ceil(bottom - kPixelSnapEpsilon) - y};
}

// ------------------------------------------------------------------ Win32 display layout

double scaleFactorForDpi(double dpi) { return std::isfinite(dpi) && dpi > 0 ? dpi / 96 : 1; }

namespace {

enum class Edge { None, Right, Left, Bottom, Top };

Edge touchingEdge(const Rect& parent, const Rect& child) {
    const bool yOverlap = child.y <= rectBottom(parent) && rectBottom(child) >= parent.y;
    const bool xOverlap = child.x <= rectRight(parent) && rectRight(child) >= parent.x;
    if (child.x == rectRight(parent) && yOverlap) return Edge::Right;
    if (rectRight(child) == parent.x && yOverlap) return Edge::Left;
    if (child.y == rectBottom(parent) && xOverlap) return Edge::Bottom;
    if (rectBottom(child) == parent.y && xOverlap) return Edge::Top;
    return Edge::None;
}

double attachAlongEdge(double parentBegin, double parentEnd, double childBegin, double childEnd, double parentDipBegin,
                       double parentDipLength, double parentScale, double childScale) {
    if (childBegin == parentBegin) return parentDipBegin;
    if (childEnd == parentEnd) return parentDipBegin + parentDipLength - (childEnd - childBegin) / childScale;
    const double anchor = jsMax(childBegin, parentBegin);
    return parentDipBegin + (anchor - parentBegin) / parentScale - (anchor - childBegin) / childScale;
}

}  // namespace

std::vector<Win32Display> displaysFromWin32Monitors(const std::vector<Win32Monitor>& monitors) {
    const size_t n = monitors.size();
    std::vector<Win32Display> out;
    if (n == 0) return out;

    std::vector<double> scales(n);
    for (size_t i = 0; i < n; ++i) scales[i] = scaleFactorForDpi(monitors[i].dpi);

    int primary = -1;
    for (size_t i = 0; i < n && primary < 0; ++i) {
        if (monitors[i].primary) primary = static_cast<int>(i);
    }
    for (size_t i = 0; i < n && primary < 0; ++i) {
        if (rectContainsPoint(monitors[i].bounds, Point{0, 0})) primary = static_cast<int>(i);
    }
    if (primary < 0) primary = 0;

    // Rank by (physical top, physical left, input index); stable sort keeps index order on ties.
    std::vector<size_t> ranked(n);
    std::iota(ranked.begin(), ranked.end(), size_t{0});
    std::stable_sort(ranked.begin(), ranked.end(), [&](size_t a, size_t b) {
        if (monitors[a].bounds.y != monitors[b].bounds.y) return monitors[a].bounds.y < monitors[b].bounds.y;
        if (monitors[a].bounds.x != monitors[b].bounds.x) return monitors[a].bounds.x < monitors[b].bounds.x;
        return a < b;
    });

    std::vector<bool> placed(n, false);
    std::vector<Point> origins(n);
    const auto dipRect = [&](size_t i) {
        return Rect{origins[i].x, origins[i].y, monitors[i].bounds.width / scales[i],
                    monitors[i].bounds.height / scales[i]};
    };

    const size_t p0 = static_cast<size_t>(primary);
    origins[p0] = Point{monitors[p0].bounds.x / scales[p0], monitors[p0].bounds.y / scales[p0]};
    placed[p0] = true;
    std::deque<size_t> queue{p0};
    size_t placedCount = 1;

    const auto attach = [&](size_t p, size_t c, Edge edge) -> Point {
        const Rect& P = monitors[p].bounds;
        const Rect& C = monitors[c].bounds;
        const Rect D = dipRect(p);
        const double sp = scales[p];
        const double sc = scales[c];
        switch (edge) {
            case Edge::Right:
                return Point{D.x + D.width, attachAlongEdge(P.y, rectBottom(P), C.y, rectBottom(C), D.y, D.height, sp, sc)};
            case Edge::Left:
                return Point{D.x - C.width / sc, attachAlongEdge(P.y, rectBottom(P), C.y, rectBottom(C), D.y, D.height, sp, sc)};
            case Edge::Bottom:
                return Point{attachAlongEdge(P.x, rectRight(P), C.x, rectRight(C), D.x, D.width, sp, sc), D.y + D.height};
            case Edge::Top:
                return Point{attachAlongEdge(P.x, rectRight(P), C.x, rectRight(C), D.x, D.width, sp, sc), D.y - C.height / sc};
            case Edge::None:
                break;
        }
        return Point{};
    };

    while (placedCount < n || !queue.empty()) {
        while (!queue.empty()) {
            const size_t p = queue.front();
            queue.pop_front();
            for (const size_t c : ranked) {
                if (placed[c]) continue;
                const Edge edge = touchingEdge(monitors[p].bounds, monitors[c].bounds);
                if (edge == Edge::None) continue;
                origins[c] = attach(p, c, edge);
                placed[c] = true;
                ++placedCount;
                queue.push_back(c);
            }
        }
        if (placedCount >= n) break;
        // Disconnected monitor: the closest unplaced one (rank order on ties), relative to its nearest placed monitor.
        size_t bestChild = n;
        size_t bestParent = n;
        double bestDistance = std::numeric_limits<double>::infinity();
        for (const size_t c : ranked) {
            if (placed[c]) continue;
            for (const size_t p : ranked) {
                if (!placed[p]) continue;
                const double d = distanceBetweenRects(monitors[p].bounds, monitors[c].bounds);
                if (d < bestDistance) {
                    bestDistance = d;
                    bestChild = c;
                    bestParent = p;
                }
            }
        }
        if (bestChild == n) break;  // unreachable with finite rectangles
        const Rect& P = monitors[bestParent].bounds;
        const Rect& C = monitors[bestChild].bounds;
        const Point D = origins[bestParent];
        const double sp = scales[bestParent];
        origins[bestChild] = Point{D.x + (C.x - P.x) / sp, D.y + (C.y - P.y) / sp};
        placed[bestChild] = true;
        ++placedCount;
        queue.push_back(bestChild);
    }

    out.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        const Win32Monitor& m = monitors[i];
        const double s = scales[i];
        Win32Display d;
        d.id = m.id.empty() ? "monitor-" + std::to_string(i) : m.id;
        d.bounds = dipRect(i);
        d.workArea = Rect{origins[i].x + (m.workArea.x - m.bounds.x) / s, origins[i].y + (m.workArea.y - m.bounds.y) / s,
                          m.workArea.width / s, m.workArea.height / s};
        d.scaleFactor = s;
        d.primary = static_cast<int>(i) == primary;
        d.physicalBounds = m.bounds;
        d.physicalWorkArea = m.workArea;
        d.dpi = m.dpi;
        out.push_back(d);
    }
    return out;
}

Point physicalPointToDipOn(const Win32Display& d, Point p) {
    const double s = d.scaleFactor;
    return Point{d.bounds.x + (p.x - d.physicalBounds.x) / s, d.bounds.y + (p.y - d.physicalBounds.y) / s};
}

Point dipPointToPhysicalOn(const Win32Display& d, Point p) {
    const double s = d.scaleFactor;
    return Point{d.physicalBounds.x + (p.x - d.bounds.x) * s, d.physicalBounds.y + (p.y - d.bounds.y) * s};
}

Rect physicalRectToDipOn(const Win32Display& d, const Rect& r) {
    const Point origin = physicalPointToDipOn(d, Point{r.x, r.y});
    return Rect{origin.x, origin.y, r.width / d.scaleFactor, r.height / d.scaleFactor};
}

Rect dipRectToPhysicalOn(const Win32Display& d, const Rect& r, PixelRounding rounding) {
    const Point origin = dipPointToPhysicalOn(d, Point{r.x, r.y});
    return roundRect(Rect{origin.x, origin.y, r.width * d.scaleFactor, r.height * d.scaleFactor}, rounding);
}

int physicalToDipPoint(Point p, const std::vector<Win32Display>& displays, Point& out) {
    std::vector<Rect> bounds;
    bounds.reserve(displays.size());
    for (const auto& d : displays) bounds.push_back(d.physicalBounds);
    const int i = displayIndexAtPoint(p, bounds);
    if (i >= 0) out = physicalPointToDipOn(displays[static_cast<size_t>(i)], p);
    return i;
}

int dipToPhysicalPoint(Point p, const std::vector<Win32Display>& displays, Point& out) {
    std::vector<Rect> bounds;
    bounds.reserve(displays.size());
    for (const auto& d : displays) bounds.push_back(d.bounds);
    const int i = displayIndexAtPoint(p, bounds);
    if (i >= 0) out = dipPointToPhysicalOn(displays[static_cast<size_t>(i)], p);
    return i;
}

// ------------------------------------------------------------------ rect placement

Rect rectCenteredAt(Point center, double width, double height) {
    return Rect{center.x - width / 2, center.y - height / 2, width, height};
}

Rect clampRectIntoArea(const Rect& rect, const Rect& area) {
    const auto axis = [](double start, double length, double areaStart, double areaLength) {
        if (length > areaLength) return areaStart + (areaLength - length) / 2;
        return jsMin(jsMax(start, areaStart), areaStart + areaLength - length);
    };
    return Rect{axis(rect.x, rect.width, area.x, area.width), axis(rect.y, rect.height, area.y, area.height), rect.width,
                rect.height};
}

Rect fitRectIntoArea(const Rect& rect, const Rect& area) {
    const double width = jsMax(0, jsMin(rect.width, area.width));
    const double height = jsMax(0, jsMin(rect.height, area.height));
    return clampRectIntoArea(rectCenteredAt(rectCenter(rect), width, height), area);
}

bool unionRects(const std::vector<Rect>& rects, Rect& out) {
    if (rects.empty()) return false;
    double x = std::numeric_limits<double>::infinity();
    double y = x;
    double right = -x;
    double bottom = -x;
    for (const Rect& r : rects) {
        x = jsMin(x, r.x);
        y = jsMin(y, r.y);
        right = jsMax(right, rectRight(r));
        bottom = jsMax(bottom, rectBottom(r));
    }
    out = Rect{x, y, right - x, bottom - y};
    return true;
}

int dipToPhysicalRect(const Rect& r, const std::vector<Win32Display>& displays, PixelRounding rounding, Rect& out) {
    std::vector<Rect> bounds;
    bounds.reserve(displays.size());
    for (const auto& d : displays) bounds.push_back(d.bounds);
    const int i = displayIndexForRect(r, bounds);
    if (i >= 0) out = dipRectToPhysicalOn(displays[static_cast<size_t>(i)], r, rounding);
    return i;
}

// ------------------------------------------------------------------ wheel frame

WheelFrame computeWheelFrame(PointI activation, const std::vector<Win32Display>& displays, const geo::WheelGeometry& g) {
    WheelFrame f;
    Point activationDip;
    const int index = physicalToDipPoint(Point{static_cast<double>(activation.x), static_cast<double>(activation.y)}, displays,
                                         activationDip);
    if (index < 0) return f;
    f.displayIndex = index;
    f.display = displays[static_cast<size_t>(index)];
    f.scale = f.display.scaleFactor;
    f.activationDip = activationDip;
    f.placement = geo::placeWheel(activationDip, f.display.workArea, g);
    f.diameter = f.placement.diameter;
    f.centerPhysical = dipPointToPhysicalOn(f.display, f.placement.center);
    const Rect frame = dipRectToPhysicalOn(f.display, f.placement.windowFrame, PixelRounding::Enclosing);
    const double limit = 1e9;
    if (!std::isfinite(frame.x) || !std::isfinite(frame.y) || std::fabs(frame.x) > limit || std::fabs(frame.y) > limit ||
        !(frame.width >= 1 && frame.width <= 1e5) || !(frame.height >= 1 && frame.height <= 1e5)) {
        return f;
    }
    f.windowPx = RectI{static_cast<int32_t>(frame.x), static_cast<int32_t>(frame.y), static_cast<int32_t>(frame.width),
                       static_cast<int32_t>(frame.height)};
    f.valid = true;
    return f;
}

Point pointerDip(PointI p, const WheelFrame& f) {
    return physicalPointToDipOn(f.display, Point{static_cast<double>(p.x), static_cast<double>(p.y)});
}

Point localDipOfScreenPixel(PointI p, const WheelFrame& f) {
    const Point d = pointerDip(p, f);
    return Point{d.x - f.placement.center.x, d.y - f.placement.center.y};
}

Point localDipOfWindowPixel(int32_t i, int32_t j, const WheelFrame& f) {
    return localDipOfScreenPixel(PointI{f.windowPx.left + i, f.windowPx.top + j}, f);
}

bool windowPixelInsideDisc(int32_t i, int32_t j, const WheelFrame& f) {
    const Point p = localDipOfWindowPixel(i, j, f);
    return jsmath::hypot(p.x, p.y) <= geo::outerRadius(f.diameter);
}

Point drawCenterPx(const WheelFrame& f) {
    return Point{f.centerPhysical.x - f.windowPx.left + 0.5, f.centerPhysical.y - f.windowPx.top + 0.5};
}

}  // namespace od::coords
