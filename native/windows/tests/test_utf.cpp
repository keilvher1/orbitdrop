#include <string>

#include "core/utf.h"
#include "test_framework.h"

using namespace od::utf;

TEST_CASE("utf: validation rejects malformed UTF-8") {
    CHECK(isValidUtf8(""));
    CHECK(isValidUtf8("plain ascii"));
    CHECK(isValidUtf8("\xEC\x95\x95\xEC\xB6\x95"));      // 압축
    CHECK(isValidUtf8("\xF0\x9F\x98\x80"));              // 😀
    CHECK(!isValidUtf8("\xC0\xAF"));                      // overlong '/'
    CHECK(!isValidUtf8("\xE0\x80\xAF"));                  // overlong
    CHECK(!isValidUtf8("\xED\xA0\x80"));                  // encoded surrogate (CESU-8)
    CHECK(!isValidUtf8("\xF4\x90\x80\x80"));              // > U+10FFFF
    CHECK(!isValidUtf8("\x80"));                          // stray continuation
    CHECK(!isValidUtf8("\xE2\x82"));                      // truncated
    CHECK(!isValidUtf8(std::string("a\xFF", 2)));
}

TEST_CASE("utf: utf16Length counts JavaScript string length") {
    CHECK_EQ(utf16Length(""), size_t{0});
    CHECK_EQ(utf16Length("JPG"), size_t{3});
    CHECK_EQ(utf16Length("\xEB\xB0\xB0\xEA\xB2\xBD \xEC\xB6\x94\xEA\xB0\x80"), size_t{5});  // 배경 추가
    CHECK_EQ(utf16Length("\xF0\x9F\x98\x80"), size_t{2});                                   // 😀 is a surrogate pair
    CHECK_EQ(utf16Length("\xC3\xA9"), size_t{1});
    CHECK_EQ(utf16Length("\xC0\xAF"), SIZE_MAX);
}

TEST_CASE("utf: UTF-16 to UTF-8 conversion and lone surrogates") {
    std::string out;
    const std::u16string ok = u"C:\\Users\\\uD55C\uAE00\\\U0001F600.png";
    CHECK(utf16ToUtf8(ok, out));
    CHECK_EQ(out, std::string("C:\\Users\\\xED\x95\x9C\xEA\xB8\x80\\\xF0\x9F\x98\x80.png"));
    std::u16string back;
    CHECK(utf8ToUtf16(out, back));
    CHECK(back == ok);

    const char16_t loneHigh[] = {u'a', 0xD83D, u'b'};
    CHECK(!utf16ToUtf8(loneHigh, 3, out));
    const char16_t loneLow[] = {0xDE00, u'x'};
    CHECK(!utf16ToUtf8(loneLow, 2, out));
    const char16_t truncated[] = {u'x', 0xD83D};
    CHECK(!utf16ToUtf8(truncated, 2, out));
    CHECK(!utf8ToUtf16("\xED\xA0\x80", back));
}

TEST_CASE("utf: code point length (zod 4 string length)") {
    CHECK_EQ(codePointLength(""), size_t{0});
    CHECK_EQ(codePointLength("abc"), size_t{3});
    CHECK_EQ(codePointLength("\xF0\x9F\x98\x80"), size_t{1});
    CHECK_EQ(codePointLength("\xF0\x9F\x91\x8D\xF0\x9F\x8F\xBD"), size_t{2});  // thumbs up + skin tone: 2 code points
    CHECK_EQ(codePointLength("\xEB\xB0\xB0\xEA\xB2\xBD"), size_t{2});
    CHECK_EQ(codePointLength("\xC0\xAF"), SIZE_MAX);
    CHECK_EQ(truncateToCodePoints("a\xF0\x9F\x98\x80" "b", 2), std::string("a\xF0\x9F\x98\x80"));
    CHECK_EQ(truncateToCodePoints("abc", 0), std::string(""));
}

TEST_CASE("utf: truncation keeps whole code points") {
    CHECK_EQ(truncateToUtf16Units("abcdef", 3), std::string("abc"));
    CHECK_EQ(truncateToUtf16Units("a\xF0\x9F\x98\x80" "b", 2), std::string("a"));  // pair does not fit
    CHECK_EQ(truncateToUtf16Units("a\xF0\x9F\x98\x80" "b", 3), std::string("a\xF0\x9F\x98\x80"));
    CHECK_EQ(truncateToUtf16Units("\xEC\x95\x95\xEC\xB6\x95", 1), std::string("\xEC\x95\x95"));
}
