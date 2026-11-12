#include <cmath>
#include <vector>

#include "core/geometry.h"
#include "core/wheel_layout.h"
#include "test_framework.h"

using namespace od;
using layout::Vec2;

namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<std::vector<Vec2>> polys(const layout::SectorShape& s) {
    std::vector<std::vector<Vec2>> out;
    for (const auto& f : s.figures) out.push_back(layout::flatten(f, 1.0));
    return out;
}

Vec2 polar(double r, double deg) { return Vec2{r * std::cos(deg * kPi / 180), r * std::sin(deg * kPi / 180)}; }

}  // namespace

TEST_CASE("layout: sectors are closed, clockwise, congruent and inside the ring") {
    const geo::WheelGeometry g = geo::kDefaultGeometry;
    for (int n = 2; n <= 12; ++n) {
        const layout::Layout L = layout::computeLayout(n, 360, g);
        REQUIRE(static_cast<int>(L.sectors.size()) == n);
        CHECK_EQ(L.outerR, 180.0);
        CHECK_EQ(L.sectorOuterR, 172.0);
        CHECK_EQ(L.innerR, 64.8);
        double firstArea = 0;
        for (int i = 0; i < n; ++i) {
            const auto& s = L.sectors[static_cast<size_t>(i)];
            REQUIRE(s.visible);
            REQUIRE(s.figures.size() == 1);
            const auto pts = layout::flatten(s.figures[0], 1.0);
            const double area = layout::signedArea(pts);
            CHECK(area > 0);
            if (i == 0) firstArea = area;
            CHECK_NEAR(area, firstArea, firstArea * 1e-9);
            for (const Vec2& p : pts) {
                const double r = std::sqrt(p.x * p.x + p.y * p.y);
                if (r < L.innerR - 1e-6 || r > L.sectorOuterR + 1e-6) {
                    odtest::reportFailure(__FILE__, __LINE__, "outline leaves the ring at r=" + odtest::show(r));
                    break;
                }
            }
            // The label sits inside its sector and hit-testing agrees on the index.
            CHECK(layout::containsPoint(polys(s), s.labelCenter));
            const geo::WheelHit hit = geo::hitTestWheel(s.labelCenter.x, s.labelCenter.y, n, 360, g);
            CHECK(hit == geo::WheelHit::sector(i));
            CHECK(s.labelMaxWidth > 20);
        }
        // Sector 0 is centred at 12 o'clock and the order is clockwise.
        CHECK_NEAR(L.sectors[0].labelCenter.x, 0.0, 1e-9);
        CHECK(L.sectors[0].labelCenter.y < 0);
        CHECK(L.sectors[1].labelCenter.x > 0);
    }
}

TEST_CASE("layout: constant-width gaps between neighbours") {
    const geo::WheelGeometry g = geo::kDefaultGeometry;
    for (int n : {3, 4, 7, 8, 12}) {
        const layout::Layout L = layout::computeLayout(n, 360, g);
        const double span = 360.0 / n;
        for (int i = 0; i < n; ++i) {
            const auto a = polys(L.sectors[static_cast<size_t>(i)]);
            const auto b = polys(L.sectors[static_cast<size_t>((i + 1) % n)]);
            const double boundary = g.startAngleDeg + i * span + span / 2;
            for (double r : {L.innerR + 22, (L.innerR + L.sectorOuterR) / 2, L.sectorOuterR - 22}) {
                const Vec2 on = polar(r, boundary);
                const Vec2 normal = polar(1, boundary + 90);  // towards sector i + 1
                const auto offset = [&](double d) { return Vec2{on.x + normal.x * d, on.y + normal.y * d}; };
                CHECK(!layout::containsPoint(a, on));
                CHECK(!layout::containsPoint(b, on));
                CHECK(!layout::containsPoint(b, offset(g.sectorGap / 2 - 0.05)));
                CHECK(layout::containsPoint(b, offset(g.sectorGap / 2 + 0.05)));
                CHECK(!layout::containsPoint(a, offset(-(g.sectorGap / 2 - 0.05))));
                CHECK(layout::containsPoint(a, offset(-(g.sectorGap / 2 + 0.05))));
            }
        }
    }
}

TEST_CASE("layout: corner radius is clamped and corners stay tangent") {
    geo::WheelGeometry g = geo::kDefaultGeometry;
    g.sectorCornerRadius = 40;
    const layout::Layout big = layout::computeLayout(12, 360, g);
    CHECK(big.cornerRadius > 0);
    CHECK(big.cornerRadius < 40);
    for (const auto& s : big.sectors) CHECK(layout::signedArea(layout::flatten(s.figures[0])) > 0);

    g.sectorCornerRadius = 0;
    const layout::Layout sharp = layout::computeLayout(4, 360, g);
    CHECK_EQ(sharp.cornerRadius, 0.0);
    // Sharp sectors: outer arc, side, inner arc, side.
    CHECK_EQ(sharp.sectors[0].figures[0].segments.size(), size_t{4});

    const layout::Layout normal = layout::computeLayout(4, 360, geo::kDefaultGeometry);
    CHECK_EQ(normal.cornerRadius, 14.0);
    CHECK_EQ(normal.sectors[0].figures[0].segments.size(), size_t{8});
}

TEST_CASE("layout: one sector is a full ring, two are half rings") {
    const layout::Layout one = layout::computeLayout(1, 360, geo::kDefaultGeometry);
    REQUIRE(one.sectors.size() == 1);
    REQUIRE(one.sectors[0].figures.size() == 2);
    CHECK(layout::signedArea(layout::flatten(one.sectors[0].figures[0])) > 0);
    CHECK(layout::signedArea(layout::flatten(one.sectors[0].figures[1])) < 0);
    CHECK(layout::containsPoint(polys(one.sectors[0]), one.sectors[0].labelCenter));
    CHECK(!layout::containsPoint(polys(one.sectors[0]), Vec2{0, 0}));
    // No gap and no seam: every point of the band is drawn and hit-tests to sector 0, straight down
    // (where the single sector's span starts and ends) included; the dead zone and outside never.
    const auto ring = polys(one.sectors[0]);
    for (int deg = 0; deg < 360; deg += 5) {
        for (double r : {one.innerR + 1, (one.innerR + one.sectorOuterR) / 2, one.sectorOuterR - 1}) {
            const Vec2 p = polar(r, deg);
            CHECK(layout::containsPoint(ring, p));
            CHECK(geo::hitTestWheel(p.x, p.y, 1, 360) == geo::WheelHit::sector(0));
        }
    }
    for (double dx : {-1e-9, 0.0, 1e-9}) CHECK(geo::hitTestWheel(dx, 120, 1, 360) == geo::WheelHit::sector(0));
    CHECK(geo::hitTestWheel(0, one.innerR - 1, 1, 360) == geo::WheelHit::center());
    CHECK(geo::hitTestWheel(0, one.outerR + 1, 1, 360) == geo::WheelHit::outside());
    CHECK_NEAR(one.sectors[0].labelCenter.x, 0.0, 1e-9);  // label at the top (startAngleDeg −90°)
    CHECK(one.sectors[0].labelCenter.y < -one.innerR);

    const layout::Layout two = layout::computeLayout(2, 360, geo::kDefaultGeometry);
    REQUIRE(two.sectors.size() == 2);
    for (int i = 0; i < 2; ++i) {
        const auto& s = two.sectors[static_cast<size_t>(i)];
        CHECK(layout::signedArea(layout::flatten(s.figures[0])) > 0);
        CHECK(geo::hitTestWheel(s.labelCenter.x, s.labelCenter.y, 2, 360) == geo::WheelHit::sector(i));
    }
    CHECK(layout::computeLayout(0, 360, geo::kDefaultGeometry).sectors.empty());
}

TEST_CASE("layout: extreme geometry degrades to pointed sectors without breaking") {
    geo::WheelGeometry g = geo::kDefaultGeometry;
    g.innerRadiusRatio = 0.15;
    g.sectorGap = 24;
    const layout::Layout L = layout::computeLayout(12, 200, g);
    REQUIRE(L.sectors.size() == 12);
    for (const auto& s : L.sectors) {
        REQUIRE(s.visible);
        CHECK(layout::signedArea(layout::flatten(s.figures[0])) > 0);
        CHECK(layout::containsPoint(polys(s), s.labelCenter));
    }
    g.capsuleWidth = 200;
    const layout::Layout c = layout::computeLayout(4, 360, g);
    CHECK(c.capsuleWidth <= 2 * (c.innerR - 2) + 1e-9);
    CHECK_EQ(layout::computeLayout(4, 360, geo::kDefaultGeometry).capsuleWidth, 104.0);
}
