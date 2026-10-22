// Minimal strict JSON (RFC 8259) parser and writer for the helper protocol.
//
// Parser: UTF-8 input only (malformed UTF-8 is rejected), escapes including
// surrogate pairs (an escaped lone surrogate, valid in JavaScript, is read as
// U+FFFD: UTF-8 has no form for it and zod counts either as one code point),
// no comments / trailing commas / NaN / Infinity / leading zeros, depth and
// value-count limits, duplicate object keys rejected. Numbers are IEEE-754
// doubles parsed with the same rounding as JavaScript's JSON.parse
// (std::from_chars, round-to-nearest); overflow is an error (JS would yield
// Infinity, which no protocol schema accepts), underflow yields ±0 like JS.
//
// Writer: compact output equivalent to JSON.stringify for the value types the
// helper emits (strings, booleans, integers, null, arrays, objects).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace od::json {

enum class Type : uint8_t { Null, Bool, Number, String, Array, Object };

struct Member;

class Value {
public:
    Value();
    ~Value();
    Value(const Value&);
    Value(Value&&) noexcept;
    Value& operator=(const Value&);
    Value& operator=(Value&&) noexcept;

    static Value makeNull();
    static Value makeBool(bool b);
    static Value makeNumber(double n);
    static Value makeString(std::string s);
    static Value makeArray();
    static Value makeObject();

    Type type() const { return type_; }
    bool isNull() const { return type_ == Type::Null; }
    bool isBool() const { return type_ == Type::Bool; }
    bool isNumber() const { return type_ == Type::Number; }
    bool isString() const { return type_ == Type::String; }
    bool isArray() const { return type_ == Type::Array; }
    bool isObject() const { return type_ == Type::Object; }

    bool asBool() const { return bool_; }
    double asNumber() const { return number_; }
    const std::string& asString() const { return string_; }
    const std::vector<Value>& asArray() const { return array_; }
    std::vector<Value>& asArray() { return array_; }
    const std::vector<Member>& asObject() const;
    std::vector<Member>& asObject();

    /** Object member lookup (nullptr when absent or not an object). */
    const Value* get(std::string_view key) const;

    /** Builders. */
    void push(Value v);
    void set(std::string key, Value v);

private:
    Type type_ = Type::Null;
    bool bool_ = false;
    double number_ = 0.0;
    std::string string_;
    std::vector<Value> array_;
    std::vector<Member> object_;
};

struct Member {
    std::string key;
    Value value;
};

struct ParseOptions {
    size_t maxDepth = 32;
    size_t maxValues = 50000;
};

struct ParseError {
    size_t offset = 0;
    std::string message;
};

/** Parses one JSON text. On failure returns false and fills `error`. */
bool parse(std::string_view text, Value& out, ParseError& error, const ParseOptions& options = {});

/** Streaming writer producing compact JSON. */
class Writer {
public:
    void beginObject();
    void endObject();
    void beginArray();
    void endArray();
    void key(std::string_view k);
    void str(std::string_view s);
    void boolean(bool b);
    void integer(int64_t n);
    /** Finite doubles only (shortest round-trip form); sets ok() = false otherwise. */
    void number(double d);
    void null();

    /** False when a string was not valid UTF-8 or a number was not finite. */
    bool ok() const { return ok_; }
    const std::string& text() const { return out_; }
    std::string take() { return std::move(out_); }

private:
    void beforeValue();
    void writeString(std::string_view s);

    std::string out_;
    std::vector<bool> hasElements_;
    bool afterKey_ = false;
    bool ok_ = true;
};

/** Serialises a Value (used by tests and diagnostics). */
std::string serialize(const Value& v);

}  // namespace od::json
