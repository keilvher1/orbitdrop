#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>

#include "core/jsmath.h"
#include "test_framework.h"

namespace {

double fromHex(const std::string& s) {
    const uint64_t v = std::strtoull(s.c_str(), nullptr, 16);
    double d;
    std::memcpy(&d, &v, sizeof d);
    return d;
}

uint64_t bits(double d) {
    uint64_t v;
    std::memcpy(&v, &d, sizeof v);
    return v;
}

}  // namespace

TEST_CASE("jsmath: std::fma is correctly rounded (required by the atan port)") {
    // (1 + 2^-52)^2 - (1 + 2^-51) = 2^-104 exactly; a non-fused evaluation gives 0.
    const volatile double a = 1.0000000000000002;
    const volatile double c = -1.0000000000000004;
    CHECK_EQ(std::fma(a, a, c), std::ldexp(1.0, -104));
    CHECK_EQ(std::fma(0.1, 10.0, -1.0), 5.551115123125783e-17);
    CHECK_EQ(std::fma(2.0, 3.0, 4.0), 10.0);
}

TEST_CASE("jsmath: atan2/hypot match Node's V8 bit for bit") {
    std::string text;
    REQUIRE(odtest::readFile(odtest::dataDir() + "/jsmath-vectors.txt", text));
    std::istringstream in(text);
    std::string line;
    int checked = 0;
    int mismatches = 0;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') continue;
        std::istringstream ls(line);
        std::string op, y, x, r;
        ls >> op >> y >> x >> r;
        const double want = fromHex(r);
        const double got = op == "a" ? od::jsmath::atan2(fromHex(y), fromHex(x)) : od::jsmath::hypot(fromHex(y), fromHex(x));
        const bool same = (std::isnan(want) && std::isnan(got)) || bits(want) == bits(got);
        if (!same) {
            if (mismatches < 5) odtest::reportFailure(__FILE__, __LINE__, "mismatch: " + line);
            ++mismatches;
        }
        ++checked;
    }
    CHECK(checked > 6000);
    CHECK_EQ(mismatches, 0);
}

TEST_CASE("jsmath: special values") {
    using od::jsmath::atan2;
    using od::jsmath::hypot;
    CHECK_EQ(atan2(0.0, -1.0), od::jsmath::kPi);
    CHECK_EQ(atan2(-0.0, -1.0), -od::jsmath::kPi);
    CHECK(std::signbit(atan2(-0.0, 1.0)));
    CHECK_EQ(atan2(1.0, 0.0), od::jsmath::kPi / 2);
    CHECK(std::isnan(atan2(std::nan(""), 1.0)));
    CHECK_EQ(hypot(3, 4), 5.0);
    CHECK_EQ(hypot(-3, 0), 3.0);
    CHECK_EQ(hypot(HUGE_VAL, std::nan("")), HUGE_VAL);
    CHECK(std::isnan(hypot(1, std::nan(""))));
    CHECK_EQ(hypot(0, -0.0), 0.0);
    CHECK_EQ(od::jsmath::mod(-370, 360), -10.0);
    CHECK(std::signbit(od::jsmath::mod(-0.0, 360)));
}
