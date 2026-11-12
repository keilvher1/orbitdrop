// Word-based line breaking for the wheel's centre capsule (portable, no Windows headers).
#pragma once

#include <functional>
#include <string>
#include <vector>

namespace od::text {

/**
 * Breaks UTF-8 `text` into lines at spaces only, like CSS `word-break: keep-all`: a Korean word such
 * as "아님" or "내려받으세요" is never split between its syllables. DirectWrite's own wrapping may
 * break between any two Hangul syllables ("파일이 아" / "님"); the macOS helper's CapsuleLayout.wrap
 * keeps words whole, and this is the same rule.
 *
 * Greedy: a line takes words while `fits(candidate line)` accepts them. A word that does not fit
 * on a line of its own still gets that line (the caller shrinks the font, and only at the smallest
 * size lets the text engine break inside it). Spaces, ASCII control characters, U+0085, U+2028
 * and U+2029 separate words; runs of them collapse; no line is empty. `fits` is only asked about
 * lines of two or more words.
 */
std::vector<std::string> wrapWords(const std::string& text, const std::function<bool(const std::string&)>& fits);

/** The lines joined with '\n' (a mandatory line break for DirectWrite). */
std::string joinLines(const std::vector<std::string>& lines);

}  // namespace od::text
