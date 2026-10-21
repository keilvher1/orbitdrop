#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

#include "test_framework.h"

#ifndef OD_REPO_FIXTURES_DIR
#define OD_REPO_FIXTURES_DIR "../../tests/fixtures"
#endif
#ifndef OD_TEST_DATA_DIR
#define OD_TEST_DATA_DIR "tests/data"
#endif

namespace odtest {

namespace {
int g_failures = 0;
int g_currentFailures = 0;
std::string g_fixtures = OD_REPO_FIXTURES_DIR;
std::string g_data = OD_TEST_DATA_DIR;
bool g_requireGolden = false;
}  // namespace

bool goldenRequired() { return g_requireGolden; }

std::vector<TestCase>& registry() {
    static std::vector<TestCase> r;
    return r;
}

void reportFailure(const char* file, int line, const std::string& message) {
    ++g_failures;
    ++g_currentFailures;
    std::fprintf(stderr, "    %s:%d: %s\n", file, line, message.c_str());
}

void note(const std::string& message) { std::printf("    note: %s\n", message.c_str()); }

std::string repoFixturesDir() { return g_fixtures; }
std::string dataDir() { return g_data; }

bool readFile(const std::string& path, std::string& out) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::ostringstream ss;
    ss << in.rdbuf();
    out = ss.str();
    return true;
}

}  // namespace odtest

int main(int argc, char** argv) {
    const char* filter = nullptr;
    bool list = false;
    if (const char* env = std::getenv("ORBITDROP_FIXTURES")) odtest::g_fixtures = env;
    if (const char* env = std::getenv("ORBITDROP_REQUIRE_GOLDEN")) odtest::g_requireGolden = std::strcmp(env, "1") == 0;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--fixtures") == 0 && i + 1 < argc) {
            odtest::g_fixtures = argv[++i];
        } else if (std::strcmp(argv[i], "--data") == 0 && i + 1 < argc) {
            odtest::g_data = argv[++i];
        } else if (std::strcmp(argv[i], "--filter") == 0 && i + 1 < argc) {
            filter = argv[++i];
        } else if (std::strcmp(argv[i], "--list") == 0) {
            list = true;
        } else if (std::strcmp(argv[i], "--require-golden") == 0) {
            odtest::g_requireGolden = true;
        } else {
            std::fprintf(stderr, "usage: %s [--fixtures DIR] [--data DIR] [--filter TEXT] [--list] [--require-golden]\n", argv[0]);
            return 2;
        }
    }
    int run = 0;
    int failedTests = 0;
    for (const auto& t : odtest::registry()) {
        if (filter != nullptr && std::strstr(t.name, filter) == nullptr) continue;
        if (list) {
            std::printf("%s\n", t.name);
            continue;
        }
        odtest::g_currentFailures = 0;
        std::printf("[ RUN  ] %s\n", t.name);
        std::fflush(stdout);
        t.fn();
        ++run;
        if (odtest::g_currentFailures > 0) {
            ++failedTests;
            std::printf("[ FAIL ] %s (%d)\n", t.name, odtest::g_currentFailures);
        } else {
            std::printf("[  OK  ] %s\n", t.name);
        }
    }
    if (list) return 0;
    std::printf("\n%d test(s) run, %d failed, %d failed check(s)\n", run, failedTests, odtest::g_failures);
    return failedTests == 0 ? 0 : 1;
}
