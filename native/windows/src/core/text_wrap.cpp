#include "core/text_wrap.h"

#include <cstddef>
#include <utility>

namespace od::text {

namespace {

/** Length in bytes of the word separator starting at `i`, or 0 when `text[i]` starts a word character. */
size_t separatorAt(const std::string& text, size_t i) {
    const auto b = static_cast<unsigned char>(text[i]);
    if (b <= 0x20 || b == 0x7F) return 1;  // space and ASCII control characters (\t, \n, \r, …)
    if (b == 0xC2 && i + 1 < text.size() && static_cast<unsigned char>(text[i + 1]) == 0x85) return 2;  // U+0085 NEL
    if (b == 0xE2 && i + 2 < text.size() && static_cast<unsigned char>(text[i + 1]) == 0x80) {
        const auto c = static_cast<unsigned char>(text[i + 2]);
        if (c == 0xA8 || c == 0xA9) return 3;  // U+2028 line separator, U+2029 paragraph separator
    }
    return 0;
}

}  // namespace

std::vector<std::string> wrapWords(const std::string& text, const std::function<bool(const std::string&)>& fits) {
    std::vector<std::string> lines;
    std::string current;
    size_t i = 0;
    while (i < text.size()) {
        if (const size_t sep = separatorAt(text, i)) {
            i += sep;
            continue;
        }
        const size_t start = i;
        while (i < text.size() && separatorAt(text, i) == 0) ++i;
        std::string word = text.substr(start, i - start);
        if (current.empty()) {
            current = std::move(word);
            continue;
        }
        std::string candidate = current + ' ' + word;
        if (fits(candidate)) {
            current = std::move(candidate);
        } else {
            lines.push_back(std::move(current));
            current = std::move(word);
        }
    }
    if (!current.empty()) lines.push_back(std::move(current));
    return lines;
}

std::string joinLines(const std::vector<std::string>& lines) {
    std::string joined;
    for (size_t i = 0; i < lines.size(); ++i) {
        if (i > 0) joined += '\n';
        joined += lines[i];
    }
    return joined;
}

}  // namespace od::text
