#include <cstddef>
#include <string>
#include <vector>

#include "core/text_wrap.h"
#include "test_framework.h"

using od::text::joinLines;
using od::text::wrapWords;

namespace {

size_t codePoints(const std::string& s) {
    size_t n = 0;
    for (const char c : s) {
        if ((static_cast<unsigned char>(c) & 0xC0) != 0x80) ++n;
    }
    return n;
}

/** Lines of at most `n` code points (a stand-in for "fits the capsule's width"), joined with '\n'. */
std::string wrapAt(const std::string& text, size_t n) {
    return joinLines(wrapWords(text, [n](const std::string& line) { return codePoints(line) <= n; }));
}

const std::string kNotAFile = "\xED\x8C\x8C\xEC\x9D\xBC\xEC\x9D\xB4\x20\xEC\x95\x84\xEB\x8B\x98";  // 파일이 아님
const std::string kNotAFileLines = "\xED\x8C\x8C\xEC\x9D\xBC\xEC\x9D\xB4\n\xEC\x95\x84\xEB\x8B\x98";  // 파일이 / 아님
const std::string kDownloadFirst =
    "\xEB\xA8\xBC\xEC\xA0\x80\x20\xEB\x82\xB4\xEB\xA0\xA4\xEB\xB0\x9B\xEC\x9C\xBC\xEC\x84\xB8\xEC\x9A\x94";  // 먼저 내려받으세요
const std::string kDownloadFirstLines =
    "\xEB\xA8\xBC\xEC\xA0\x80\n\xEB\x82\xB4\xEB\xA0\xA4\xEB\xB0\x9B\xEC\x9C\xBC\xEC\x84\xB8\xEC\x9A\x94";  // 먼저 / 내려받으세요

}  // namespace

TEST_CASE("text wrap: Korean words stay whole (keep-all), as in the macOS capsule") {
    // Found by the Windows runner GUI test: DirectWrite broke "파일이 아님" as "파일이 아" / "님".
    CHECK_EQ(wrapAt(kNotAFile, 5), kNotAFileLines);
    CHECK_EQ(wrapAt(kNotAFile, 4), kNotAFileLines);
    CHECK_EQ(wrapAt(kNotAFile, 6), kNotAFile);  // fits on one line: unchanged
    // "먼저 내려" / "받으세요" in the helper's own snapshot; the word 내려받으세요 must not be split.
    CHECK_EQ(wrapAt(kDownloadFirst, 7), kDownloadFirstLines);
    // A word longer than the line keeps its own line; the renderer shrinks it (and only at the
    // smallest size lets DirectWrite break inside it).
    CHECK_EQ(wrapAt(kDownloadFirst, 3), kDownloadFirstLines);
}

TEST_CASE("text wrap: greedy lines at spaces for Latin text") {
    CHECK_EQ(wrapAt("Not available in this build", 16), std::string("Not available in\nthis build"));
    CHECK_EQ(wrapAt("Not available in this build", 100), std::string("Not available in this build"));
    CHECK_EQ(wrapAt("Folders aren\xE2\x80\x99t supported", 8), std::string("Folders\naren\xE2\x80\x99t\nsupported"));
}

TEST_CASE("text wrap: separators collapse, no empty lines") {
    CHECK_EQ(wrapAt("", 10), std::string());
    CHECK_EQ(wrapAt("   ", 10), std::string());
    CHECK_EQ(wrapAt("  a   b  ", 10), std::string("a b"));
    CHECK_EQ(wrapAt("a\nb\tc\r\nd", 100), std::string("a b c d"));
    // U+2028, U+2029 and U+0085 separate words; other multi-byte characters (an em dash) do not.
    CHECK_EQ(wrapAt("a\xE2\x80\xA8" "b\xE2\x80\xA9" "c\xC2\x85" "d", 100), std::string("a b c d"));
    CHECK_EQ(wrapAt("a\xE2\x80\x94" "b", 100), std::string("a\xE2\x80\x94" "b"));
    CHECK_EQ(wrapAt("a b c", 1), std::string("a\nb\nc"));
}

TEST_CASE("text wrap: fits is asked only about lines of two or more words") {
    std::vector<std::string> asked;
    const auto lines = wrapWords("one two three", [&asked](const std::string& line) {
        asked.push_back(line);
        return line.size() <= 7;
    });
    CHECK_EQ(joinLines(lines), std::string("one two\nthree"));
    CHECK_EQ(joinLines(asked), std::string("one two\none two three"));
}
