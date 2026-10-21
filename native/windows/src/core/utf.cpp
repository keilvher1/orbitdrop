#include "core/utf.h"

#include <cstdint>

namespace od::utf {

bool decodeUtf8(std::string_view s, size_t& i, uint32_t& cp) {
    if (i >= s.size()) return false;
    const auto byte = [&](size_t k) { return static_cast<uint8_t>(s[k]); };
    const uint8_t b0 = byte(i);
    if (b0 < 0x80) {
        cp = b0;
        i += 1;
        return true;
    }
    size_t len;
    uint32_t min;
    if (b0 >= 0xC2 && b0 <= 0xDF) {
        len = 2;
        cp = b0 & 0x1Fu;
        min = 0x80;
    } else if (b0 >= 0xE0 && b0 <= 0xEF) {
        len = 3;
        cp = b0 & 0x0Fu;
        min = 0x800;
    } else if (b0 >= 0xF0 && b0 <= 0xF4) {
        len = 4;
        cp = b0 & 0x07u;
        min = 0x10000;
    } else {
        return false;  // continuation byte, overlong lead (C0/C1) or > F4
    }
    if (i + len > s.size()) return false;
    for (size_t k = 1; k < len; ++k) {
        const uint8_t b = byte(i + k);
        if ((b & 0xC0u) != 0x80u) return false;
        cp = (cp << 6) | (b & 0x3Fu);
    }
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
    i += len;
    return true;
}

bool isValidUtf8(std::string_view s) {
    size_t i = 0;
    uint32_t cp;
    while (i < s.size()) {
        if (static_cast<uint8_t>(s[i]) < 0x80) {
            ++i;
            continue;
        }
        if (!decodeUtf8(s, i, cp)) return false;
    }
    return true;
}

void appendUtf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
        out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

size_t utf16Length(std::string_view utf8) {
    size_t i = 0;
    size_t units = 0;
    uint32_t cp;
    while (i < utf8.size()) {
        if (static_cast<uint8_t>(utf8[i]) < 0x80) {
            ++i;
            ++units;
            continue;
        }
        if (!decodeUtf8(utf8, i, cp)) return SIZE_MAX;
        units += cp >= 0x10000 ? 2 : 1;
    }
    return units;
}

size_t codePointLength(std::string_view utf8) {
    size_t i = 0;
    size_t n = 0;
    uint32_t cp;
    while (i < utf8.size()) {
        if (static_cast<uint8_t>(utf8[i]) < 0x80) {
            ++i;
        } else if (!decodeUtf8(utf8, i, cp)) {
            return SIZE_MAX;
        }
        ++n;
    }
    return n;
}

std::string truncateToCodePoints(std::string_view utf8, size_t maxCodePoints) {
    size_t i = 0;
    size_t n = 0;
    uint32_t cp;
    while (i < utf8.size() && n < maxCodePoints) {
        size_t next = i;
        if (!decodeUtf8(utf8, next, cp)) break;
        i = next;
        ++n;
    }
    return std::string(utf8.substr(0, i));
}

bool utf16ToUtf8(const char16_t* s, size_t n, std::string& out) {
    out.clear();
    out.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        const uint32_t u = s[i];
        if (u < 0xD800 || u > 0xDFFF) {
            appendUtf8(out, u);
            continue;
        }
        if (u >= 0xDC00 || i + 1 >= n) return false;  // lone low surrogate or truncated pair
        const uint32_t lo = s[i + 1];
        if (lo < 0xDC00 || lo > 0xDFFF) return false;
        appendUtf8(out, 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00));
        ++i;
    }
    return true;
}

bool utf8ToUtf16(std::string_view s, std::u16string& out) {
    out.clear();
    out.reserve(s.size());
    size_t i = 0;
    uint32_t cp;
    while (i < s.size()) {
        if (!decodeUtf8(s, i, cp)) return false;
        if (cp >= 0x10000) {
            cp -= 0x10000;
            out.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
            out.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3FF)));
        } else {
            out.push_back(static_cast<char16_t>(cp));
        }
    }
    return true;
}

std::string truncateToUtf16Units(std::string_view utf8, size_t maxUnits) {
    size_t i = 0;
    size_t units = 0;
    uint32_t cp;
    while (i < utf8.size()) {
        size_t next = i;
        if (!decodeUtf8(utf8, next, cp)) break;
        const size_t add = cp >= 0x10000 ? 2 : 1;
        if (units + add > maxUnits) break;
        units += add;
        i = next;
    }
    return std::string(utf8.substr(0, i));
}

}  // namespace od::utf
