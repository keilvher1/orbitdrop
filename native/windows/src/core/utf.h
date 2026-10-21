// Strict UTF-8 / UTF-16 helpers (no platform dependencies).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace od::utf {

/** Decodes one UTF-8 sequence starting at s[i]. Returns false on malformed input
 *  (overlong forms, surrogates, > U+10FFFF, truncated sequences). */
bool decodeUtf8(std::string_view s, size_t& i, uint32_t& cp);

/** True when the whole string is well-formed UTF-8. */
bool isValidUtf8(std::string_view s);

/** Appends the UTF-8 encoding of a Unicode scalar value (cp must not be a surrogate). */
void appendUtf8(std::string& out, uint32_t cp);

/** Number of UTF-16 code units of a well-formed UTF-8 string, i.e. JavaScript's
 *  `string.length` (zod's .min()/.max() on strings count these). Returns
 *  SIZE_MAX for malformed input. */
size_t utf16Length(std::string_view utf8);

/** Number of Unicode code points of a well-formed UTF-8 string — how zod 4
 *  (.min()/.max() on strings) measures length. SIZE_MAX for malformed input. */
size_t codePointLength(std::string_view utf8);

/** Longest prefix with at most `maxCodePoints` code points. */
std::string truncateToCodePoints(std::string_view utf8, size_t maxCodePoints);

/** UTF-16 → UTF-8. Returns false (and leaves `out` unspecified) when the input
 *  contains an unpaired surrogate, which has no UTF-8 representation. */
bool utf16ToUtf8(const char16_t* s, size_t n, std::string& out);
inline bool utf16ToUtf8(std::u16string_view s, std::string& out) { return utf16ToUtf8(s.data(), s.size(), out); }

/** UTF-8 → UTF-16. Returns false on malformed UTF-8. */
bool utf8ToUtf16(std::string_view s, std::u16string& out);

/** Longest prefix of a well-formed UTF-8 string with at most `maxUnits` UTF-16
 *  code units, cut on a code point boundary. */
std::string truncateToUtf16Units(std::string_view utf8, size_t maxUnits);

}  // namespace od::utf
