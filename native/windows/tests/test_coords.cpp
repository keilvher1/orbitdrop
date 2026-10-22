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
        // The reference frame (golden) is the enclosing pixel rectangle of the 408 DIP windowFrame …
        CHECK(f.windowFramePx.left <= 1001 - 204 * s + 1e-6);
        CHECK(f.windowFramePx.left + f.windowFramePx.width >= 1001 + 204 * s - 1e-6);
        CHECK(f.windowFramePx.width <= static_cast<int32_t>(std::ceil(408 * s)) + 1);
        // … the window is the disc's bounding square plus the caption strip below it
        // (360 × 392 DIP), enclosed in pixels and one pixel larger on each side.
        CHECK(f.panel.captionPlacement == coords::CaptionPlacement::Below);
        CHECK_EQ(f.windowPx.left, static_cast<int32_t>(std::floor(1001 - 180 * s + 1e-6)) - 1);
        CHECK_EQ(f.windowPx.top, static_cast<int32_t>(std::floor(777 - 180 * s + 1e-6)) - 1);
        CHECK_EQ(f.windowPx.left + f.windowPx.width, static_cast<int32_t>(std::ceil(1001 + 180 * s - 1e-6)) + 1);
        CHECK_EQ(f.windowPx.top + f.windowPx.height, static_cast<int32_t>(std::ceil(777 + 212 * s - 1e-6)) + 1);
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
    CHECK(f.windowFramePx.left < -2880);  // the reference frame's transparent margin hangs over the edge …
    CHECK(f.windowPx.left >= -2880);      // … the window (disc square + caption strip) stays on the monitor
    CHECK(f.windowPx.top >= -200);
    CHECK(f.panel.captionPlacement == coords::CaptionPlacement::Below);

    // Bottom-right corner of the primary, above the taskbar: no room below, the caption goes above.
    const coords::WheelFrame g = coords::computeWheelFrame({1919, 1079}, d, geo::kDefaultGeometry);
    REQUIRE(g.valid);
    CHECK_EQ(g.displayIndex, 0);
    CHECK_EQ(g.centerPhysical.x, 1920.0 - 188);
    CHECK_EQ(g.centerPhysical.y, 1040.0 - 188);
    CHECK(g.panel.captionPlacement == coords::CaptionPlacement::Above);
    CHECK(g.windowPx.top + g.windowPx.height <= 1040);  // the window ends with the disc, above the taskbar
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
        // The window border is never part of the disc, and no disc pixel lies just outside the window.
        CHECK(!coords::windowPixelInsideDisc(0, f.windowPx.height / 2, f));
        CHECK(!coords::windowPixelInsideDisc(f.windowPx.width - 1, f.windowPx.height / 2, f));
        int outsideWindow = 0;
        for (int32_t j = -1; j <= f.windowPx.height; ++j) {
            outsideWindow += coords::windowPixelInsideDisc(-1, j, f) + coords::windowPixelInsideDisc(f.windowPx.width, j, f);
        }
        for (int32_t i = -1; i <= f.windowPx.width; ++i) {
            outsideWindow += coords::windowPixelInsideDisc(i, -1, f) + coords::windowPixelInsideDisc(i, f.windowPx.height, f);
        }
        CHECK_EQ(outsideWindow, 0);
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

TEST_CASE("coords: the window is the disc's square plus a caption strip below, above or none") {
    // 1920 × 1080 at 100 % with a 40 px taskbar at the bottom (work area 1040 high).
    const auto d = coords::displaysFromWin32Monitors({mon(0, 0, 1920, 1080, 0, 1040, 96, true)});
    const geo::WheelGeometry& g = geo::kDefaultGeometry;

    // Room below: disc bounding square + 6 DIP gap + 26 DIP caption, the macOS panel (360 × 392).
    const coords::WheelFrame f = coords::computeWheelFrame({800, 500}, d, g);
    REQUIRE(f.valid);
    CHECK(f.panel.captionPlacement == coords::CaptionPlacement::Below);
    CHECK(rectEq(f.panel.frame, {620, 320, 360, 392}));
    CHECK(rectEq(f.panel.caption, {620, 686, 360, 26}));
    CHECK(rectEq(coords::captionStripLocal(f), {-180, 186, 360, 26}));
    CHECK_EQ(f.windowPx.left, 619);
    CHECK_EQ(f.windowPx.top, 319);
    CHECK_EQ(f.windowPx.width, 362);
    CHECK_EQ(f.windowPx.height, 394);
    CHECK_NEAR(coords::drawCenterPx(f).x, 181.5, 1e-9);
    CHECK_NEAR(coords::drawCenterPx(f).y, 181.5, 1e-9);
    // The disc's right-most pixel (integer center + integer radius) is on the disc
    // and inside the window thanks to the one-pixel border.
    CHECK(coords::windowPixelInsideDisc(980 - f.windowPx.left, 500 - f.windowPx.top, f));
    CHECK(980 - f.windowPx.left < f.windowPx.width);

    // Pushed against the bottom of the work area (above the taskbar): the strip goes
    // above the disc, the disc keeps its place and the window ends with it.
    const coords::WheelFrame b = coords::computeWheelFrame({800, 1035}, d, g);
    REQUIRE(b.valid);
    CHECK(b.placement.shifted);
    CHECK_EQ(b.placement.center.y, 1040.0 - 188);
    CHECK(b.panel.captionPlacement == coords::CaptionPlacement::Above);
    CHECK(rectEq(b.panel.frame, {620, 640, 360, 392}));
    CHECK(rectEq(b.panel.caption, {620, 640, 360, 26}));
    CHECK(rectEq(coords::captionStripLocal(b), {-180, -212, 360, 26}));
    CHECK_EQ(coords::rectBottom(b.panel.frame), 1040.0 - 8);
    CHECK_EQ(b.windowPx.top, 639);
    CHECK_EQ(b.windowPx.top + b.windowPx.height, 1033);
    CHECK_NEAR(coords::drawCenterPx(b).y, 852.5 - 639, 1e-9);
    // The disc's bottom pixel lies on the one-pixel border.
    CHECK(coords::windowPixelInsideDisc(800 - b.windowPx.left, 1032 - b.windowPx.top, b));
    CHECK(1032 - b.windowPx.top < b.windowPx.height);

    // The same DIP layout at 125/150/175/200 %: exact pixel values (360 × 392 DIP + the border).
    struct Scaled {
        double dpi;
        PointI cursor;  // DIP (800, 500)
        coords::RectI window;
    };
    for (const Scaled& c : {Scaled{120, {1000, 625}, {774, 399, 452, 492}}, Scaled{144, {1200, 750}, {929, 479, 542, 590}},
                            Scaled{168, {1400, 875}, {1084, 559, 632, 688}}, Scaled{192, {1600, 1000}, {1239, 639, 722, 786}}}) {
        const double s = c.dpi / 96;
        const auto sd = coords::displaysFromWin32Monitors({mon(0, 0, 1920 * s, 1080 * s, 0, 1040 * s, c.dpi, true)});
        const coords::WheelFrame sf = coords::computeWheelFrame(c.cursor, sd, g);
        REQUIRE(sf.valid);
        CHECK(sf.panel.captionPlacement == coords::CaptionPlacement::Below);
        CHECK(rectEq(sf.panel.frame, {620, 320, 360, 392}));
        CHECK_EQ(sf.windowPx.left, c.window.left);
        CHECK_EQ(sf.windowPx.top, c.window.top);
        CHECK_EQ(sf.windowPx.width, c.window.width);
        CHECK_EQ(sf.windowPx.height, c.window.height);
        CHECK_NEAR(coords::drawCenterPx(sf).x, 800 * s + 0.5 - c.window.left, 1e-9);
    }

    // The threshold: the strip fits below while its bottom stays inside the work area.
    CHECK(coords::computeWheelFrame({800, 828}, d, g).panel.captionPlacement == coords::CaptionPlacement::Below);
    CHECK(coords::computeWheelFrame({800, 829}, d, g).panel.captionPlacement == coords::CaptionPlacement::Above);
    // At the top edge there is always room below.
    CHECK(coords::computeWheelFrame({800, 2}, d, g).panel.captionPlacement == coords::CaptionPlacement::Below);

    // Too small for either side (the macOS test's numbers): no strip, the capsule alone shows the choice.
    const auto tiny = coords::displaysFromWin32Monitors({mon(0, 0, 400, 260, 0, 260, 96, true)});
    const coords::WheelFrame t = coords::computeWheelFrame({100, 100}, tiny, g);
    REQUIRE(t.valid);
    CHECK(t.panel.captionPlacement == coords::CaptionPlacement::None);
    CHECK_EQ(t.diameter, 244.0);
    CHECK(rectEq(t.panel.frame, {8, 8, 244, 244}));
    CHECK_EQ(t.panel.caption.width, 0.0);
    CHECK_EQ(t.windowPx.width, 246);
    CHECK_EQ(t.windowPx.height, 246);

    // 150 % monitor left of the primary (negative coordinates): the window is the
    // enclosing pixel rectangle of the DIP layout on that monitor, plus the border.
    const auto two = coords::displaysFromWin32Monitors({mon(0, 0, 1920, 1080, 0, 1040, 96, true), mon(-2880, -300, 2880, 1620, -300, 1560, 144)});
    const coords::WheelFrame n = coords::computeWheelFrame({-1500, 400}, two, g);
    REQUIRE(n.valid);
    CHECK_EQ(n.displayIndex, 1);
    CHECK(!n.placement.shifted);
    CHECK(n.panel.captionPlacement == coords::CaptionPlacement::Below);
    const geo::Rect px = coords::dipRectToPhysicalOn(n.display, n.panel.frame, coords::PixelRounding::Enclosing);
    CHECK_EQ(n.windowPx.left, static_cast<int32_t>(px.x) - 1);
    CHECK_EQ(n.windowPx.top, static_cast<int32_t>(px.y) - 1);
    CHECK_EQ(n.windowPx.width, 540 + 2);   // 360 DIP × 1.5
    CHECK_EQ(n.windowPx.height, 588 + 2);  // 392 DIP × 1.5
    CHECK_EQ(n.windowPx.left, -1770 - 1);
}

TEST_CASE("coords: the caption pill is sized to its text and centred in the strip") {
    const geo::Rect strip{-180, 186, 360, 26};
    CHECK(rectEq(coords::captionPillRect(strip, 20), {-28, 186, 56, 26}));    // narrowest pill
    CHECK(rectEq(coords::captionPillRect(strip, 100), {-62, 186, 124, 26}));  // text + 12 DIP on each side
    CHECK(rectEq(coords::captionPillRect(strip, 500), strip));                // never wider than the strip
    CHECK(rectEq(coords::captionPillRect(strip, std::nan("")), {-28, 186, 56, 26}));
    const geo::Rect pill{-62, 186, 124, 26};
    CHECK(coords::pillContains(pill, {0, 199}));     // centre
    CHECK(coords::pillContains(pill, {-49, 186}));   // top edge of the straight part (closed)
    CHECK(coords::pillContains(pill, {-62, 199}));   // tip of the left cap
    CHECK(!coords::pillContains(pill, {-62.01, 199}));
    CHECK(!coords::pillContains(pill, {-61, 187}));  // bounding-box corner beside the round cap
    CHECK(coords::pillContains(pill, {-49 - 9.1, 199 - 9.1}));   // just inside the cap at 45°
    CHECK(!coords::pillContains(pill, {-49 - 9.3, 199 - 9.3}));  // just outside
    CHECK(!coords::pillContains(pill, {0, 212.01}));
    CHECK(!coords::pillContains(pill, {std::nan(""), 199}));
    CHECK(!coords::pillContains(geo::Rect{0, 0, 0, 26}, {0, 13}));
}

TEST_CASE("coords: hit shape — the disc and a visible caption pill get alpha, the rest of the window none") {
    // The mask the renderer applies after drawing must give alpha >= 1 exactly where
    // OLE should find our window: the disc (hitTestWheel not outside) and the pill of
    // a visible caption. The strip beside the pill and the square's corners stay
    // alpha 0, so a release there reaches the window below. Several DPIs, both
    // placements, no caption, a short and a long caption.
    struct Case {
        double dpi;
        PointI cursor;
        coords::CaptionPlacement placement;
    };
    const Case cases[] = {
        {96, {800, 500}, coords::CaptionPlacement::Below},     {120, {805, 2900}, coords::CaptionPlacement::Above},
        {144, {-990, 1200}, coords::CaptionPlacement::Below},  {168, {123, 2940}, coords::CaptionPlacement::Above},
        {192, {1500, 700}, coords::CaptionPlacement::Below},
    };
    for (const Case& c : cases) {
        const auto d = coords::displaysFromWin32Monitors({mon(-1000, -1000, 4000, 4000, -1000, 3950, c.dpi, true)});
        const coords::WheelFrame f = coords::computeWheelFrame(c.cursor, d, geo::kDefaultGeometry);
        REQUIRE(f.valid);
        CHECK(f.panel.captionPlacement == c.placement);
        const geo::Rect strip = coords::captionStripLocal(f);
        const int32_t w = f.windowPx.width;
        const int32_t h = f.windowPx.height;
        // The pointer path (OLE's DragOver → hitTestWheel), independent of the mask code.
        std::vector<char> onDisc(static_cast<size_t>(w) * h);
        for (int32_t j = 0; j < h; ++j) {
            for (int32_t i = 0; i < w; ++i) {
                const PointI screen{f.windowPx.left + i, f.windowPx.top + j};
                const geo::WheelHit hit = geo::hitTestPlacedWheel(coords::pointerDip(screen, f), f.placement.center, f.diameter, 5);
                onDisc[static_cast<size_t>(j) * w + i] = hit.zone != geo::WheelHit::Zone::Outside;
            }
        }
        for (const double textWidth : {-1.0, 24.0, 150.0, 1000.0}) {  // no caption, "JPG", a reason, wider than the strip
            const bool hasPill = textWidth >= 0;
            const geo::Rect pill = coords::captionPillRect(strip, textWidth);
            // A renderer that painted every pixel: the mask must clear all but the shape …
            std::vector<uint8_t> painted(static_cast<size_t>(w) * h * 4, 200);
            coords::applyHitShape(painted.data(), w, h, f, hasPill ? &pill : nullptr);
            // … and one that painted nothing: the shape still gets alpha >= 1 (gaps, dead zone).
            std::vector<uint8_t> blank(static_cast<size_t>(w) * h * 4, 0);
            coords::applyHitShape(blank.data(), w, h, f, hasPill ? &pill : nullptr);
            int mismatches = 0;
            int pillPixels = 0;
            int besidePill = 0;
            for (int32_t j = 0; j < h; ++j) {
                for (int32_t i = 0; i < w; ++i) {
                    const PointI screen{f.windowPx.left + i, f.windowPx.top + j};
                    const bool disc = onDisc[static_cast<size_t>(j) * w + i] != 0;
                    const bool onPill = hasPill && coords::screenPixelInsidePill(screen, f, pill);
                    const bool shape = disc || onPill;
                    const uint8_t* p = &painted[(static_cast<size_t>(j) * w + i) * 4];
                    const uint8_t* q = &blank[(static_cast<size_t>(j) * w + i) * 4];
                    if (shape) {
                        if (p[0] != 200 || p[3] != 200 || q[0] != 0 || q[3] != 1) ++mismatches;  // kept; alpha floor, colour <= alpha
                    } else if ((p[0] | p[1] | p[2] | p[3] | q[3]) != 0) {
                        ++mismatches;  // nothing left outside the shape
                    }
                    const geo::Point local = coords::localDipOfScreenPixel(screen, f);
                    const bool inStrip = local.y >= strip.y && local.y <= strip.y + strip.height;
                    if (onPill && !disc) {
                        ++pillPixels;
                        if (!inStrip) ++mismatches;  // the pill stays inside its strip
                    }
                    if (inStrip && !shape) ++besidePill;
                }
            }
            CHECK_EQ(mismatches, 0);
            CHECK(hasPill ? pillPixels > 0 : pillPixels == 0);
            CHECK(besidePill > 0);  // the strip beside the pill (or the empty strip) lets drags through
            // The window covers the whole shape: nothing just outside it is on the disc or the pill.
            const auto onShape = [&](int32_t i, int32_t j) {
                return coords::windowPixelInsideDisc(i, j, f) || (hasPill && coords::windowPixelInsidePill(i, j, f, pill));
            };
            int outside = 0;
            for (int32_t j = -1; j <= h; ++j) outside += onShape(-1, j) + onShape(w, j);
            for (int32_t i = -1; i <= w; ++i) outside += onShape(i, -1) + onShape(i, h);
            CHECK_EQ(outside, 0);
        }
    }
}
