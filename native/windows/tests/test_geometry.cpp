// Vectors computed with the TypeScript reference (packages/core/src/geometry.ts)
// under Node; the exhaustive comparison lives in test_golden.cpp
// (tests/fixtures/wheel-golden.json) and tests/tools/parity.mjs.
#include <cmath>

#include "core/geometry.h"
#include "test_framework.h"

using namespace od::geo;

namespace {

void expectHit(double dx, double dy, double count, double diameter, WheelHit expected, const char* file, int line) {
    const WheelHit got = hitTestWheel(dx, dy, count, diameter);
    if (!(got == expected)) {
        odtest::reportFailure(file, line,
                              "hitTestWheel(" + odtest::show(dx) + ", " + odtest::show(dy) + ", " + odtest::show(count) +
                                  ") zone=" + std::to_string(static_cast<int>(got.zone)) + " index=" + std::to_string(got.index));
    }
}
#define EXPECT_HIT(dx, dy, n, d, hit) expectHit((dx), (dy), (n), (d), (hit), __FILE__, __LINE__)

}  // namespace

TEST_CASE("geometry: hitTestWheel matches the reference") {
    EXPECT_HIT(0, 0, 4, 360, WheelHit::center());
    EXPECT_HIT(0, -60, 4, 360, WheelHit::center());
    EXPECT_HIT(0, -181, 4, 360, WheelHit::outside());
    EXPECT_HIT(0, -120, 4, 360, WheelHit::sector(0));
    EXPECT_HIT(120, 0, 4, 360, WheelHit::sector(1));
    EXPECT_HIT(0, 120, 4, 360, WheelHit::sector(2));
    EXPECT_HIT(-120, 0, 4, 360, WheelHit::sector(3));
    EXPECT_HIT(64.8, 0, 4, 360, WheelHit::center());       // r == innerRadius → dead zone
    EXPECT_HIT(64.80001, 0, 4, 360, WheelHit::sector(1));
    EXPECT_HIT(180, 0, 4, 360, WheelHit::sector(1));       // r == outer radius is still on the wheel
    EXPECT_HIT(180.00001, 0, 4, 360, WheelHit::outside());
    EXPECT_HIT(100, -100, 4, 360, WheelHit::sector(1));    // exactly on a boundary: half-open interval
    EXPECT_HIT(-100, -100, 4, 360, WheelHit::sector(0));
    EXPECT_HIT(100, -100.0000001, 4, 360, WheelHit::sector(0));
    EXPECT_HIT(0, -100, 7, 360, WheelHit::sector(0));
    EXPECT_HIT(50, -90, 7, 360, WheelHit::sector(1));
    EXPECT_HIT(90, -30, 12, 360, WheelHit::sector(2));
    EXPECT_HIT(1, -150, 0, 360, WheelHit::outside());      // empty menu
    EXPECT_HIT(1, -150, 4.9, 360, WheelHit::sector(0));    // count is truncated
    EXPECT_HIT(-150, -1e-12, 8, 320, WheelHit::sector(6));
    EXPECT_HIT(std::nan(""), 0, 4, 360, WheelHit::outside());
    EXPECT_HIT(HUGE_VAL, 0, 4, 360, WheelHit::outside());
    EXPECT_HIT(100, 0, std::nan(""), 360, WheelHit::outside());
}

TEST_CASE("geometry: placeWheel clamps into the work area") {
    WheelPlacement p = placeWheel({-1915, 5}, {-1920, 0, 1920, 1080});
    CHECK_EQ(p.center.x, -1732.0);
    CHECK_EQ(p.center.y, 188.0);
    CHECK_EQ(p.diameter, 360.0);
    CHECK_EQ(p.windowFrame.x, -1936.0);
    CHECK_EQ(p.windowFrame.y, -16.0);
    CHECK_EQ(p.windowFrame.width, 408.0);
    CHECK(p.shifted);

    p = placeWheel({500, 400}, {0, 0, 1920, 1040});
    CHECK_EQ(p.center.x, 500.0);
    CHECK_EQ(p.center.y, 400.0);
    CHECK(!p.shifted);

    p = placeWheel({1919, 1039}, {0, 0, 1920, 1040});
    CHECK_EQ(p.center.x, 1732.0);
    CHECK_EQ(p.center.y, 852.0);
    CHECK(p.shifted);

    p = placeWheel({100, 100}, {0, 0, 300, 200});  // tiny work area: min diameter, then centred on the short axis
    CHECK_EQ(p.diameter, 240.0);
    CHECK_EQ(p.center.x, 128.0);
    CHECK_EQ(p.center.y, 100.0);
    CHECK_EQ(p.windowFrame.y, -44.0);

    p = placeWheel({10, 10}, {0, 0, 250, 250});
    CHECK_EQ(p.diameter, 240.0);
    CHECK_EQ(p.center.x, 125.0);
    CHECK_EQ(p.center.y, 125.0);

    p = placeWheel({-1000.25, -300.5}, {-1536, -864, 1536, 816});
    CHECK_EQ(p.center.x, -1000.25);
    CHECK_EQ(p.center.y, -300.5);
    CHECK_EQ(p.windowFrame.x, -1204.25);
    CHECK(!p.shifted);

    WheelGeometry g = kDefaultGeometry;
    g.minDiameter = 400;  // larger than diameter: smallest = min(minDiameter, diameter)
    p = placeWheel({500, 500}, {0, 0, 1000, 1000}, g);
    CHECK_EQ(p.diameter, 360.0);
}

TEST_CASE("geometry: isArmed and helpers") {
    CHECK(!isArmed({0, 0}, {3, 4}, false));
    CHECK(!isArmed({0, 0}, {3, 5}, false));  // hypot(3, 5) = 5.83 < armDistance 6
    CHECK(isArmed({0, 0}, {6, 0}, false));
    CHECK(!isArmed({0, 0}, {5.999, 0}, false));
    CHECK(isArmed({0, 0}, {1, 0}, true));
    CHECK(!isArmed({0, 0}, {std::nan(""), 0}, false));

    CHECK_EQ(normalizeDeg(-0.0), 0.0);
    CHECK_EQ(normalizeDeg(-1e-15), 360.0);  // rounding: callers clamp (see hitTestWheel)
    CHECK_EQ(normalizeDeg(360), 0.0);
    CHECK_EQ(normalizeDeg(725), 5.0);
    CHECK_EQ(normalizeDeg(-725), 355.0);
    CHECK_EQ(innerRadius(360), 64.8);
    CHECK_EQ(sectorOuterRadius(360), 172.0);
    CHECK_EQ(sectorCenterDeg(1, 4), 0.0);
    CHECK_EQ(sectorStartDeg(0, 4), -135.0);
    CHECK(hitTestPlacedWheel({620, 400}, {500, 400}, 360, 4) == WheelHit::sector(1));
}
