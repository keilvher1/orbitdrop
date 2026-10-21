#include <cmath>
#include <vector>

#include "core/coords.h"
#include "core/geometry.h"
#include "core/jsmath.h"
#include "test_framework.h"

using namespace od;
using coords::PointI;
using coords::Win32Monitor;

namespace {

Win32Monitor mon(double x, double y, double w, double h, double workY, double workH, double dpi, bool primary = false) {
    Win32Monitor m;
    m.bounds = {x, y, w, h};
    m.workArea = {x, workY, w, workH};
    m.dpi = dpi;
    m.primary = primary;
    return m;
}

bool rectEq(const geo::Rect& a, const geo::Rect& b) {
    return a.x == b.x && a.y == b.y && a.width == b.width && a.height == b.height;
}

}  // namespace

TEST_CASE("coords: displaysFromWin32Monitors matches the reference layout") {
    // Values computed with packages/core/src/coords.ts.
    auto d = coords::displaysFromWin32Monitors({mon(0, 0, 1920, 1080, 0, 1040, 96, true)});
    REQUIRE(d.size() == 1);
    CHECK(rectEq(d[0].bounds, {0, 0, 1920, 1080}));
    CHECK(rectEq(d[0].workArea, {0, 0, 1920, 1040}));
    CHECK(d[0].primary);

    // 150 % primary with a 100 % monitor on its left (negative physical x).
    d = coords::displaysFromWin32Monitors({mon(0, 0, 2880, 1620, 0, 1560, 144, true), mon(-1920, 0, 1920, 1080, 0, 1040, 96)});
    REQUIRE(d.size() == 2);
    CHECK(rectEq(d[0].bounds, {0, 0, 1920, 1080}));
    CHECK(rectEq(d[0].workArea, {0, 0, 1920, 1040}));
    CHECK_EQ(d[0].scaleFactor, 1.5);
    CHECK(rectEq(d[1].bounds, {-1920, 0, 1920, 1080}));
    CHECK(!d[1].primary);

    // 200 % monitor on the right, offset upwards.
    d = coords::displaysFromWin32Monitors({mon(0, 0, 1920, 1080, 0, 1040, 96, true), mon(1920, -200, 3840, 2160, -200, 2100, 192)});
    CHECK(rectEq(d[1].bounds, {1920, -100, 1920, 1080}));
    CHECK(rectEq(d[1].workArea, {1920, -100, 1920, 1050}));

    // 125 % primary, a monitor above, and a disconnected one (gap) on the right.
    Win32Monitor primary = mon(0, 0, 2560, 1440, 40, 1400, 120, true);
    d = coords::displaysFromWin32Monitors({primary, mon(0, -1080, 1920, 1080, -1080, 1080, 96), mon(3000, 100, 1280, 1024, 100, 1024, 96)});
    CHECK(rectEq(d[0].bounds, {0, 0, 2048, 1152}));
    CHECK(rectEq(d[0].workArea, {0, 32, 2048, 1120}));
    CHECK(rectEq(d[1].bounds, {0, -1080, 1920, 1080}));
    CHECK(rectEq(d[2].bounds, {2400, 80, 1280, 1024}));

    // No primary flag: the monitor containing (0, 0) is primary.
    d = coords::displaysFromWin32Monitors({mon(-1920, 0, 1920, 1080, 0, 1080, 96), mon(0, 0, 1920, 1080, 0, 1080, 96)});
    CHECK(!d[0].primary);
    CHECK(d[1].primary);
    CHECK(coords::displaysFromWin32Monitors({}).empty());
}

TEST_CASE("coords: half-open containment and nearest display") {
    const std::vector<geo::Rect> b = {{0, 0, 1920, 1080}, {1920, 0, 1920, 1080}};
    CHECK_EQ(coords::displayIndexAtPoint({1919.9, 10}, b), 0);
    CHECK_EQ(coords::displayIndexAtPoint({1920, 10}, b), 1);  // shared edge belongs to the right display
    CHECK_EQ(coords::displayIndexAtPoint({5000, 10}, b), 1);  // nearest
    CHECK_EQ(coords::displayIndexAtPoint({-50, -50}, b), 0);
    CHECK_EQ(coords::displayIndexAtPoint({0, 0}, {}), -1);
    CHECK_EQ(coords::roundHalfUp(2.5), 3.0);
    CHECK_EQ(coords::roundHalfUp(-2.5), -2.0);  // not std::round (-3)
    const geo::Rect r = coords::roundRect({0.4, 1.6, 10.2, 3.3}, coords::PixelRounding::Enclosing);
    CHECK(rectEq(r, {0, 1, 11, 4}));
    const geo::Rect n = coords::roundRect({0.5, 1.4999, 10, 3}, coords::PixelRounding::Nearest);
    CHECK(rectEq(n, {1, 1, 10, 3}));
    const geo::Rect s = coords::roundRect({2.0000001, 0, 3.9999998, 1}, coords::PixelRounding::Enclosing);
    CHECK(rectEq(s, {2, 0, 4, 1}));  // within PIXEL_SNAP_EPSILON of integers
}

TEST_CASE("coords: physical ↔ DIP per display") {
    const auto d = coords::displaysFromWin32Monitors({mon(0, 0, 2880, 1620, 0, 1560, 144, true), mon(-1920, 0, 1920, 1080, 0, 1040, 96)});
    geo::Point out;
    CHECK_EQ(coords::physicalToDipPoint({1500, 300}, d, out), 0);
    CHECK_EQ(out.x, 1000.0);
    CHECK_EQ(out.y, 200.0);
    CHECK_EQ(coords::physicalToDipPoint({-10, 300}, d, out), 1);
    CHECK_EQ(out.x, -10.0);
    CHECK_EQ(coords::dipToPhysicalPoint({1000, 200}, d, out), 0);
    CHECK_EQ(out.x, 1500.0);
    const geo::Rect pr = coords::dipRectToPhysicalOn(d[0], {10.1, 10.1, 100, 100}, coords::PixelRounding::Enclosing);
    CHECK(rectEq(pr, {15, 15, 151, 151}));
}

TEST_CASE("coords: wheel frame at 100/125/150/200 % is centred on the cursor") {
    for (const double dpi : {96.0, 120.0, 144.0, 192.0}) {
        const double s = dpi / 96;
        const auto d = coords::displaysFromWin32Monitors({mon(0, 0, 3840, 2160, 0, 2100, dpi, true)});
        const PointI cursor{1001, 777};
        const coords::WheelFrame f = coords::computeWheelFrame(cursor, d, geo::kDefaultGeometry);
        REQUIRE(f.valid);
        CHECK(!f.placement.shifted);
        CHECK_NEAR(f.centerPhysical.x, 1001.0, 1e-9);
        CHECK_NEAR(f.centerPhysical.y, 777.0, 1e-9);
        CHECK_EQ(f.scale, s);
        // The window is the enclosing pixel rectangle of the 408 DIP frame.
        CHECK(f.windowPx.left <= 1001 - 204 * s + 1e-6);
        CHECK(f.windowPx.left + f.windowPx.width >= 1001 + 204 * s - 1e-6);
        CHECK(f.windowPx.width <= static_cast<int32_t>(std::ceil(408 * s)) + 1);
        // The cursor pixel itself is the wheel center (dead zone).
        const geo::Point local = coords::localDipOfScreenPixel(cursor, f);
        CHECK_NEAR(local.x, 0.0, 1e-9);
        CHECK_NEAR(local.y, 0.0, 1e-9);
        // 120 DIP to the right is sector 1 of 4 at every scale.
        const PointI right{1001 + static_cast<int32_t>(std::lround(120 * s)), 777};
        const geo::Point lr = coords::localDipOfScreenPixel(right, f);
        CHECK_NEAR(lr.x, 120.0, 1.0 / s);
        CHECK(geo::hitTestWheel(lr.x, lr.y, 4, f.diameter) == geo::WheelHit::sector(1));
        const geo::Point c = coords::drawCenterPx(f);
        CHECK_NEAR(c.x, 1001.5 - f.windowPx.left, 1e-9);
    }
}

TEST_CASE("coords: wheel frame on a negative-coordinate monitor and at screen edges") {
    // 150 % monitor left of a 100 % primary.
    const auto d = coords::displaysFromWin32Monitors({mon(0, 0, 1920, 1080, 0, 1040, 96, true), mon(-2880, -200, 2880, 1620, -200, 1560, 144)});
    REQUIRE(d.size() == 2);
    CHECK(rectEq(d[1].bounds, {-1920, -133.33333333333334, 1920, 1080}));

    const coords::WheelFrame f = coords::computeWheelFrame({-2875, -195}, d, geo::kDefaultGeometry);
    REQUIRE(f.valid);
    CHECK_EQ(f.displayIndex, 1);
    CHECK(f.placement.shifted);
    // Disc (radius 180 DIP = 270 px) + edge padding (8 DIP = 12 px) inside the work area.
    CHECK(f.centerPhysical.x - 270 >= -2880 + 12 - 1e-6);
    CHECK(f.centerPhysical.y - 270 >= -200 + 12 - 1e-6);
    CHECK_EQ(f.scale, 1.5);
    CHECK(f.windowPx.left < -2880);  // the transparent margin may hang over the edge

    // Bottom-right corner of the primary, above the taskbar.
    const coords::WheelFrame g = coords::computeWheelFrame({1919, 1079}, d, geo::kDefaultGeometry);
    REQUIRE(g.valid);
    CHECK_EQ(g.displayIndex, 0);
    CHECK_EQ(g.centerPhysical.x, 1920.0 - 188);
    CHECK_EQ(g.centerPhysical.y, 1040.0 - 188);
    // The activation point is outside the disc at a corner; arming then needs movement.
    const geo::Point a = coords::localDipOfScreenPixel({1919, 1079}, g);
    CHECK(od::jsmath::hypot(a.x, a.y) > 180);

    // Shared edge: x = -1 is on the left monitor, x = 0 on the primary (half-open rectangles).
    CHECK_EQ(coords::computeWheelFrame({-1, 500}, d, geo::kDefaultGeometry).displayIndex, 1);
    CHECK_EQ(coords::computeWheelFrame({0, 500}, d, geo::kDefaultGeometry).displayIndex, 0);
    CHECK(!coords::computeWheelFrame({0, 0}, {}, geo::kDefaultGeometry).valid);
}

TEST_CASE("coords: alpha mask and hit-testing agree on every window pixel") {
    // A pixel is a drop target for OLE iff its alpha is non-zero; the helper
    // gives alpha >= 1 exactly to windowPixelInsideDisc pixels. That set must be
    // the set where hitTestWheel is not "outside" — including the dead zone and
    // the gaps between sectors — at every DPI, shifted or not.
    struct Case {
        double dpi;
        PointI cursor;
    };
    for (const Case& c : {Case{96, {-3, 7}}, Case{120, {5, 5}}, Case{144, {-990, -990}}, Case{168, {123, 456}}, Case{192, {2990, 1950}}}) {
        const auto d = coords::displaysFromWin32Monitors({mon(-1000, -1000, 4000, 3000, -1000, 2950, c.dpi, true)});
        const coords::WheelFrame f = coords::computeWheelFrame(c.cursor, d, geo::kDefaultGeometry);
        REQUIRE(f.valid);
        int mismatches = 0;
        int inside = 0;
        for (int32_t j = 0; j < f.windowPx.height; ++j) {
            for (int32_t i = 0; i < f.windowPx.width; ++i) {
                const bool mask = coords::windowPixelInsideDisc(i, j, f);
                const PointI screen{f.windowPx.left + i, f.windowPx.top + j};
                const geo::Point local = coords::localDipOfScreenPixel(screen, f);
                const geo::WheelHit hit = geo::hitTestPlacedWheel(coords::pointerDip(screen, f), f.placement.center, f.diameter, 7);
                if (mask != (hit.zone != geo::WheelHit::Zone::Outside)) ++mismatches;
                if (mask != (od::jsmath::hypot(local.x, local.y) <= 180)) ++mismatches;
                if (mask) ++inside;
            }
        }
        CHECK_EQ(mismatches, 0);
        const double expected = 3.14159265358979 * std::pow(180 * c.dpi / 96, 2);
        CHECK(std::fabs(inside - expected) / expected < 0.01);
        // The window border (transparent margin) is never part of the disc.
        CHECK(!coords::windowPixelInsideDisc(0, f.windowPx.height / 2, f));
        CHECK(!coords::windowPixelInsideDisc(f.windowPx.width - 1, f.windowPx.height / 2, f));
    }
}

TEST_CASE("coords: rect clamping and union") {
    const geo::Rect area{-1536, 0, 1536, 825.6};
    CHECK(rectEq(coords::clampRectIntoArea({-1600, -20, 480, 360}, area), {-1536, 0, 480, 360}));
    CHECK(rectEq(coords::clampRectIntoArea({-100, 700, 480, 360}, area), {-480, 465.6, 480, 360}));
    CHECK(rectEq(coords::clampRectIntoArea({-2000, -500, 2000, 1000}, area), {-1768, -87.19999999999999, 2000, 1000}));
    CHECK(rectEq(coords::fitRectIntoArea({-2000, -500, 2000, 1000}, area), {-1536, 0, 1536, 825.6}));
    geo::Rect u;
    CHECK(coords::unionRects({{0, 0, 10, 10}, {-5, 2, 3, 30}}, u));
    CHECK(rectEq(u, {-5, 0, 15, 32}));
    CHECK(!coords::unionRects({}, u));
}
