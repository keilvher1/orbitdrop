#include "core/json.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <system_error>
#include <utility>

#include "core/utf.h"

namespace od::json {

// ------------------------------------------------------------------ Value

Value::Value() = default;
Value::~Value() = default;
Value::Value(const Value&) = default;
Value::Value(Value&&) noexcept = default;
Value& Value::operator=(const Value&) = default;
Value& Value::operator=(Value&&) noexcept = default;

Value Value::makeNull() { return Value(); }

Value Value::makeBool(bool b) {
    Value v;
    v.type_ = Type::Bool;
    v.bool_ = b;
    return v;
}

Value Value::makeNumber(double n) {
    Value v;
    v.type_ = Type::Number;
    v.number_ = n;
    return v;
}

Value Value::makeString(std::string s) {
    Value v;
    v.type_ = Type::String;
    v.string_ = std::move(s);
    return v;
}

Value Value::makeArray() {
    Value v;
    v.type_ = Type::Array;
    return v;
}

Value Value::makeObject() {
    Value v;
    v.type_ = Type::Object;
    return v;
}

const std::vector<Member>& Value::asObject() const { return object_; }
std::vector<Member>& Value::asObject() { return object_; }

const Value* Value::get(std::string_view key) const {
    if (type_ != Type::Object) return nullptr;
    for (const Member& m : object_) {
        if (m.key == key) return &m.value;
    }
    return nullptr;
}

void Value::push(Value v) { array_.push_back(std::move(v)); }

void Value::set(std::string key, Value v) { object_.push_back(Member{std::move(key), std::move(v)}); }

// ------------------------------------------------------------------ parser

namespace {

/**
 * True when two members share a key. Checked once per finished object: a
 * pairwise scan for small objects, a sort for large ones, so a 1 MiB line of
 * distinct keys costs O(n log n) — the former check on every key was O(n²) and
 * kept the reader thread busy for seconds on such a line.
 */
bool hasDuplicateKey(const std::vector<Member>& members) {
    const size_t n = members.size();
    if (n <= 8) {
        for (size_t i = 1; i < n; ++i) {
            for (size_t j = 0; j < i; ++j) {
                if (members[i].key == members[j].key) return true;
            }
        }
        return false;
    }
    std::vector<const std::string*> keys;
    keys.reserve(n);
    for (const Member& m : members) keys.push_back(&m.key);
    std::sort(keys.begin(), keys.end(), [](const std::string* a, const std::string* b) { return *a < *b; });
    for (size_t i = 1; i < n; ++i) {
        if (*keys[i] == *keys[i - 1]) return true;
    }
    return false;
}

class Parser {
public:
    Parser(std::string_view text, const ParseOptions& options, ParseError& error)
        : s_(text), opt_(options), err_(error) {}

    bool run(Value& out) {
        skipWs();
        if (!parseValue(out, 0)) return false;
        skipWs();
        if (pos_ != s_.size()) return fail("unexpected trailing characters");
        return true;
    }

private:
    bool fail(const char* message) {
        err_.offset = pos_;
        err_.message = message;
        return false;
    }

    void skipWs() {
        while (pos_ < s_.size()) {
            const char c = s_[pos_];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                ++pos_;
            } else {
                break;
            }
        }
    }

    bool countValue() {
        if (++values_ > opt_.maxValues) return fail("too many values");
        return true;
    }

    bool parseValue(Value& out, size_t depth) {
        if (!countValue()) return false;
        if (pos_ >= s_.size()) return fail("unexpected end of input");
        const char c = s_[pos_];
        switch (c) {
            case '{':
                return parseObject(out, depth + 1);
            case '[':
                return parseArray(out, depth + 1);
            case '"': {
                std::string str;
                if (!parseString(str)) return false;
                out = Value::makeString(std::move(str));
                return true;
            }
            case 't':
                return parseLiteral("true", Value::makeBool(true), out);
            case 'f':
                return parseLiteral("false", Value::makeBool(false), out);
            case 'n':
                return parseLiteral("null", Value::makeNull(), out);
            default:
                if (c == '-' || (c >= '0' && c <= '9')) return parseNumber(out);
                return fail("unexpected character");
        }
    }

    bool parseLiteral(std::string_view word, Value v, Value& out) {
        if (s_.substr(pos_, word.size()) != word) return fail("invalid literal");
        pos_ += word.size();
        out = std::move(v);
        return true;
    }

    bool parseObject(Value& out, size_t depth) {
        if (depth > opt_.maxDepth) return fail("nesting too deep");
        ++pos_;  // '{'
        out = Value::makeObject();
        skipWs();
        if (pos_ < s_.size() && s_[pos_] == '}') {
            ++pos_;
            return true;
        }
        for (;;) {
            skipWs();
            if (pos_ >= s_.size() || s_[pos_] != '"') return fail("expected object key");
            std::string key;
            if (!parseString(key)) return false;
            skipWs();
            if (pos_ >= s_.size() || s_[pos_] != ':') return fail("expected ':'");
            ++pos_;
            skipWs();
            Value v;
            if (!parseValue(v, depth)) return false;
            out.set(std::move(key), std::move(v));
            skipWs();
            if (pos_ >= s_.size()) return fail("unterminated object");
            if (s_[pos_] == ',') {
                ++pos_;
                continue;
            }
            if (s_[pos_] == '}') {
                ++pos_;
                // JSON.parse would keep the last value; the protocol rejects the line.
                if (hasDuplicateKey(out.asObject())) return fail("duplicate object key");
                return true;
            }
            return fail("expected ',' or '}'");
        }
    }

    bool parseArray(Value& out, size_t depth) {
        if (depth > opt_.maxDepth) return fail("nesting too deep");
        ++pos_;  // '['
        out = Value::makeArray();
        skipWs();
        if (pos_ < s_.size() && s_[pos_] == ']') {
            ++pos_;
            return true;
        }
        for (;;) {
            skipWs();
            Value v;
            if (!parseValue(v, depth)) return false;
            out.push(std::move(v));
            skipWs();
            if (pos_ >= s_.size()) return fail("unterminated array");
            if (s_[pos_] == ',') {
                ++pos_;
                continue;
            }
            if (s_[pos_] == ']') {
                ++pos_;
                return true;
            }
            return fail("expected ',' or ']'");
        }
    }

    static int hexDigit(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }

    bool parseHex4(uint32_t& v) {
        if (pos_ + 4 > s_.size()) return fail("truncated \\u escape");
        v = 0;
        for (size_t k = 0; k < 4; ++k) {
            const int d = hexDigit(s_[pos_ + k]);
            if (d < 0) return fail("invalid \\u escape");
            v = (v << 4) | static_cast<uint32_t>(d);
        }
        pos_ += 4;
        return true;
    }

    /** True when the next six bytes are a "\uDC00".."\uDFFF" escape (not consumed). */
    bool peekLowSurrogateEscape(uint32_t& lo) const {
        if (pos_ + 6 > s_.size() || s_[pos_] != '\\' || s_[pos_ + 1] != 'u') return false;
        lo = 0;
        for (size_t k = 2; k < 6; ++k) {
            const int d = hexDigit(s_[pos_ + k]);
            if (d < 0) return false;  // parsed (and refused) as its own escape next
            lo = (lo << 4) | static_cast<uint32_t>(d);
        }
        return lo >= 0xDC00 && lo <= 0xDFFF;
    }

    bool parseString(std::string& out) {
        ++pos_;  // opening quote
        out.clear();
        for (;;) {
            if (pos_ >= s_.size()) return fail("unterminated string");
            const auto c = static_cast<unsigned char>(s_[pos_]);
            if (c == '"') {
                ++pos_;
                return true;
            }
            if (c < 0x20) return fail("control character in string");
            if (c == '\\') {
                ++pos_;
                if (pos_ >= s_.size()) return fail("unterminated escape");
                const char e = s_[pos_++];
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        uint32_t cp;
                        if (!parseHex4(cp)) return false;
                        if (cp >= 0xD800 && cp <= 0xDBFF) {
                            uint32_t lo = 0;
                            if (peekLowSurrogateEscape(lo)) {
                                pos_ += 6;
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            }
                        }
                        // A lone surrogate (JSON.stringify writes one for a split pair)
                        // is a valid JavaScript string, so zod accepts the line. UTF-8
                        // cannot hold it: read it as U+FFFD, which zod's code point
                        // limits count the same way (one each) — the macOS helper too.
                        if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
                        utf::appendUtf8(out, cp);
                        break;
                    }
                    default:
                        return fail("invalid escape");
                }
                continue;
            }
            if (c < 0x80) {
                out.push_back(static_cast<char>(c));
                ++pos_;
                continue;
            }
            const size_t start = pos_;
            uint32_t cp;
            if (!utf::decodeUtf8(s_, pos_, cp)) return fail("invalid UTF-8 in string");
            out.append(s_.substr(start, pos_ - start));
        }
    }

    bool parseNumber(Value& out) {
        const size_t start = pos_;
        bool negative = false;
        if (s_[pos_] == '-') {
            negative = true;
            ++pos_;
        }
        const auto digit = [&](size_t p) { return p < s_.size() && s_[p] >= '0' && s_[p] <= '9'; };
        if (!digit(pos_)) return fail("invalid number");
        // Track the decimal exponent of the first significant digit to tell an
        // overflow from an underflow if from_chars reports out of range.
        long long firstSig = 0;  // exponent (power of ten) of the first non-zero digit
        bool haveSig = false;
        long long intDigits = 0;
        if (s_[pos_] == '0') {
            ++pos_;
            if (digit(pos_)) return fail("leading zero in number");
        } else {
            while (digit(pos_)) {
                if (!haveSig && s_[pos_] != '0') {
                    haveSig = true;
                    firstSig = intDigits;  // fixed up below
                }
                ++intDigits;
                ++pos_;
            }
            if (haveSig) firstSig = intDigits - 1 - firstSig;
        }
        if (pos_ < s_.size() && s_[pos_] == '.') {
            ++pos_;
            if (!digit(pos_)) return fail("invalid number fraction");
            long long frac = 0;
            while (digit(pos_)) {
                ++frac;
                if (!haveSig && s_[pos_] != '0') {
                    haveSig = true;
                    firstSig = -frac;
                }
                ++pos_;
            }
        }
        long long exp10 = 0;
        if (pos_ < s_.size() && (s_[pos_] == 'e' || s_[pos_] == 'E')) {
            ++pos_;
            bool expNegative = false;
            if (pos_ < s_.size() && (s_[pos_] == '+' || s_[pos_] == '-')) {
                expNegative = s_[pos_] == '-';
                ++pos_;
            }
            if (!digit(pos_)) return fail("invalid number exponent");
            while (digit(pos_)) {
                if (exp10 < 100000000) exp10 = exp10 * 10 + (s_[pos_] - '0');
                ++pos_;
            }
            if (expNegative) exp10 = -exp10;
        }
        double value = 0.0;
        const char* first = s_.data() + start;
        const char* last = s_.data() + pos_;
        const auto res = std::from_chars(first, last, value);
        if (res.ec == std::errc::result_out_of_range) {
            if (haveSig && firstSig + exp10 > 0) return fail("number out of range");
            value = negative ? -0.0 : 0.0;  // underflow: JSON.parse yields ±0
        } else if (res.ec != std::errc() || res.ptr != last) {
            return fail("invalid number");
        }
        if (!std::isfinite(value)) return fail("number out of range");
        out = Value::makeNumber(value);
        return true;
    }

    std::string_view s_;
    const ParseOptions& opt_;
    ParseError& err_;
    size_t pos_ = 0;
    size_t values_ = 0;
};

}  // namespace

bool parse(std::string_view text, Value& out, ParseError& error, const ParseOptions& options) {
    Parser p(text, options, error);
    Value v;
    if (!p.run(v)) return false;
    out = std::move(v);
    return true;
}

// ------------------------------------------------------------------ writer

void Writer::beforeValue() {
    if (afterKey_) {
        afterKey_ = false;
        return;
    }
    if (!hasElements_.empty()) {
        if (hasElements_.back()) out_.push_back(',');
        hasElements_.back() = true;
    }
}

void Writer::beginObject() {
    beforeValue();
    out_.push_back('{');
    hasElements_.push_back(false);
}

void Writer::endObject() {
    out_.push_back('}');
    if (!hasElements_.empty()) hasElements_.pop_back();
}

void Writer::beginArray() {
    beforeValue();
    out_.push_back('[');
    hasElements_.push_back(false);
}

void Writer::endArray() {
    out_.push_back(']');
    if (!hasElements_.empty()) hasElements_.pop_back();
}

void Writer::key(std::string_view k) {
    beforeValue();
    writeString(k);
    out_.push_back(':');
    afterKey_ = true;
}

void Writer::str(std::string_view s) {
    beforeValue();
    writeString(s);
}

void Writer::boolean(bool b) {
    beforeValue();
    out_.append(b ? "true" : "false");
}

void Writer::integer(int64_t n) {
    beforeValue();
    char buf[32];
    const auto res = std::to_chars(buf, buf + sizeof buf, n);
    out_.append(buf, res.ptr);
}

void Writer::number(double d) {
    beforeValue();
    if (!std::isfinite(d)) {
        ok_ = false;
        out_.append("null");
        return;
    }
    if (d == 0.0) {
        out_.push_back('0');  // JSON.stringify(-0) === "0"
        return;
    }
    char buf[64];
    const auto res = std::to_chars(buf, buf + sizeof buf, d);
    out_.append(buf, res.ptr);
}

void Writer::null() {
    beforeValue();
    out_.append("null");
}

void Writer::writeString(std::string_view s) {
    if (!utf::isValidUtf8(s)) ok_ = false;
    static const char* hex = "0123456789abcdef";
    out_.push_back('"');
    for (const char ch : s) {
        const auto c = static_cast<unsigned char>(ch);
        switch (c) {
            case '"': out_.append("\\\""); break;
            case '\\': out_.append("\\\\"); break;
            case '\b': out_.append("\\b"); break;
            case '\f': out_.append("\\f"); break;
            case '\n': out_.append("\\n"); break;
            case '\r': out_.append("\\r"); break;
            case '\t': out_.append("\\t"); break;
            default:
                if (c < 0x20) {
                    out_.append("\\u00");
                    out_.push_back(hex[c >> 4]);
                    out_.push_back(hex[c & 0xF]);
                } else {
                    out_.push_back(static_cast<char>(c));
                }
        }
    }
    out_.push_back('"');
}

namespace {

void writeValue(Writer& w, const Value& v) {
    switch (v.type()) {
        case Type::Null: w.null(); break;
        case Type::Bool: w.boolean(v.asBool()); break;
        case Type::Number: {
            const double d = v.asNumber();
            if (std::floor(d) == d && std::fabs(d) < 9007199254740992.0) {
                w.integer(static_cast<int64_t>(d));
            } else {
                w.number(d);
            }
            break;
        }
        case Type::String: w.str(v.asString()); break;
        case Type::Array:
            w.beginArray();
            for (const Value& e : v.asArray()) writeValue(w, e);
            w.endArray();
            break;
        case Type::Object:
            w.beginObject();
            for (const Member& m : v.asObject()) {
                w.key(m.key);
                writeValue(w, m.value);
            }
            w.endObject();
            break;
    }
}

}  // namespace

std::string serialize(const Value& v) {
    Writer w;
    writeValue(w, v);
    return w.take();
}

}  // namespace od::json
