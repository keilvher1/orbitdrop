// Tiny self-contained test framework (no third-party dependency).
#pragma once

#include <cmath>
#include <cstdint>
#include <sstream>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace odtest {

struct TestCase {
    const char* name;
    void (*fn)();
};

std::vector<TestCase>& registry();

struct Registrar {
    Registrar(const char* name, void (*fn)()) { registry().push_back(TestCase{name, fn}); }
};

void reportFailure(const char* file, int line, const std::string& message);
void note(const std::string& message);

/** Directory of the repository's tests/fixtures (for wheel-golden.json). */
std::string repoFixturesDir();
/** True when --require-golden / ORBITDROP_REQUIRE_GOLDEN=1: a missing golden file fails instead of skipping. */
bool goldenRequired();
/** Directory of native/windows/tests/data. */
std::string dataDir();
bool readFile(const std::string& path, std::string& out);

template <typename T, typename = void>
struct Streamable : std::false_type {};
template <typename T>
struct Streamable<T, std::void_t<decltype(std::declval<std::ostream&>() << std::declval<const T&>())>> : std::true_type {};

template <typename T>
std::string show(const T& v) {
    if constexpr (std::is_same_v<T, bool>) {
        return v ? "true" : "false";
    } else if constexpr (std::is_enum_v<T>) {
        return "enum(" + std::to_string(static_cast<long long>(v)) + ")";
    } else if constexpr (std::is_floating_point_v<T>) {
        std::ostringstream os;
        os.precision(17);
        os << v;
        return os.str();
    } else if constexpr (Streamable<T>::value) {
        std::ostringstream os;
        os << v;
        return os.str();
    } else {
        return "<value>";
    }
}

}  // namespace odtest

#define OD_TEST_CONCAT2(a, b) a##b
#define OD_TEST_CONCAT(a, b) OD_TEST_CONCAT2(a, b)
#define OD_TEST_CASE_IMPL(name, id)                                                      \
    static void OD_TEST_CONCAT(od_test_fn_, id)();                                       \
    static const odtest::Registrar OD_TEST_CONCAT(od_test_reg_, id)(name, &OD_TEST_CONCAT(od_test_fn_, id)); \
    static void OD_TEST_CONCAT(od_test_fn_, id)()
#define TEST_CASE(name) OD_TEST_CASE_IMPL(name, __COUNTER__)

#define CHECK(expr)                                                                  \
    do {                                                                             \
        if (!(expr)) odtest::reportFailure(__FILE__, __LINE__, "CHECK(" #expr ")"); \
    } while (0)

#define REQUIRE(expr)                                                                  \
    do {                                                                               \
        if (!(expr)) {                                                                 \
            odtest::reportFailure(__FILE__, __LINE__, "REQUIRE(" #expr ")");          \
            return;                                                                    \
        }                                                                              \
    } while (0)

#define CHECK_EQ(a, b)                                                                                     \
    do {                                                                                                   \
        const auto od_a_ = (a); /* copies: operands may refer into temporaries */                        \
        const auto od_b_ = (b);                                                                            \
        if (!(od_a_ == od_b_)) {                                                                           \
            odtest::reportFailure(__FILE__, __LINE__,                                                      \
                                  "CHECK_EQ(" #a ", " #b "): " + odtest::show(od_a_) + " != " + odtest::show(od_b_)); \
        }                                                                                                  \
    } while (0)

#define CHECK_NEAR(a, b, eps)                                                                              \
    do {                                                                                                   \
        const double od_a_ = (a);                                                                          \
        const double od_b_ = (b);                                                                          \
        if (!(std::fabs(od_a_ - od_b_) <= (eps))) {                                                        \
            odtest::reportFailure(__FILE__, __LINE__,                                                      \
                                  "CHECK_NEAR(" #a ", " #b "): " + odtest::show(od_a_) + " vs " + odtest::show(od_b_)); \
        }                                                                                                  \
    } while (0)
