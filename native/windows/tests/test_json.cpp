#include <cmath>
#include <string>

#include "core/json.h"
#include "test_framework.h"

using od::json::ParseError;
using od::json::ParseOptions;
using od::json::Value;

namespace {

bool parses(const std::string& text, Value* out = nullptr, const ParseOptions& opt = ParseOptions()) {
    Value v;
    ParseError e;
    const bool ok = od::json::parse(text, v, e, opt);
    if (ok && out) *out = v;
    return ok;
}

std::string roundTrip(const std::string& text) {
    Value v;
    ParseError e;
    if (!od::json::parse(text, v, e)) return "ERROR: " + e.message;
    return od::json::serialize(v);
}

}  // namespace

TEST_CASE("json: accepts RFC 8259 documents") {
    Value v;
    REQUIRE(parses(R"( {"a":[1,-2.5,3e2,0,-0,1E-2],"b":{"c":null,"d":true,"e":false},"s":"x"} )", &v));
    REQUIRE(v.isObject());
    const Value* a = v.get("a");
    REQUIRE(a && a->isArray() && a->asArray().size() == 6);
    CHECK_EQ(a->asArray()[1].asNumber(), -2.5);
    CHECK_EQ(a->asArray()[2].asNumber(), 300.0);
    CHECK(std::signbit(a->asArray()[4].asNumber()));
    CHECK_EQ(a->asArray()[5].asNumber(), 0.01);
    CHECK(v.get("b")->get("c")->isNull());
    CHECK(v.get("b")->get("d")->asBool());
    CHECK_EQ(v.get("s")->asString(), std::string("x"));
    CHECK(v.get("zzz") == nullptr);
    CHECK(parses("[]"));
    CHECK(parses("{}"));
    CHECK(parses("\"top-level string\""));
    CHECK(parses("12"));
    CHECK(parses(" \t\r\n[ ] \r\n"));
}

TEST_CASE("json: rejects non-JSON syntax") {
    const char* bad[] = {
        "",           "   ",         "{",           "}",          "[1,]",        "{\"a\":1,}",   "[01]",
        "[1.]",       "[.5]",        "[1e]",        "[+1]",       "[NaN]",       "[Infinity]",   "[-]",
        "{'a':1}",    "{a:1}",       "[1 2]",       "[true false]", "tru",       "nul",          "[\"\\x\"]",
        "[\"a",       "// c\n{}",    "{} {}",       "[1]x",       "{\"a\" 1}",   "[\"\\u12\"]",  "[\"\\uZZZZ\"]",
    };
    for (const char* b : bad) {
        if (parses(b)) odtest::reportFailure(__FILE__, __LINE__, std::string("accepted: ") + b);
    }
    CHECK(!parses(std::string("[\"a\x01b\"]")));        // raw control character
    CHECK(!parses(std::string("[\"\xC0\xAF\"]")));      // invalid UTF-8
    CHECK(!parses(std::string("[\"\xED\xA0\x80\"]")));  // UTF-8 encoded surrogate
    CHECK(!parses(std::string("[1]\0", 4)));             // NUL after the value
}

TEST_CASE("json: string escapes and surrogate pairs") {
    Value v;
    REQUIRE(parses(R"(["\"\\\/\b\f\n\r\t", "\u00e9\uD55C", "\uD83D\uDE00"])", &v));
    CHECK_EQ(v.asArray()[0].asString(), std::string("\"\\/\b\f\n\r\t"));
    CHECK_EQ(v.asArray()[1].asString(), std::string("\xC3\xA9\xED\x95\x9C"));
    CHECK_EQ(v.asArray()[2].asString(), std::string("\xF0\x9F\x98\x80"));
    CHECK(!parses(R"(["\uD83D"])"));         // lone high surrogate
    CHECK(!parses(R"(["\uDE00"])"));         // lone low surrogate
    CHECK(!parses(R"(["\uD83Dx"])"));
    CHECK(!parses(R"(["\uD83D\u0041"])"));   // high surrogate + non-low
    CHECK(parses("[\"\xF0\x9F\x98\x80 raw\"]"));
}

TEST_CASE("json: numbers follow JSON.parse rounding and limits") {
    Value v;
    REQUIRE(parses("[0.1, 1.7976931348623157e308, 5e-324, 1e-400, -1e-400, 123456789012345678901234567890]", &v));
    CHECK_EQ(v.asArray()[0].asNumber(), 0.1);
    CHECK_EQ(v.asArray()[1].asNumber(), 1.7976931348623157e308);
    CHECK_EQ(v.asArray()[3].asNumber(), 0.0);
    CHECK(std::signbit(v.asArray()[4].asNumber()));
    CHECK_EQ(v.asArray()[5].asNumber(), 1.2345678901234568e29);
    CHECK(!parses("[1e309]"));   // Infinity in JS; no schema accepts it
    CHECK(!parses("[-1e400]"));
}

TEST_CASE("json: duplicate keys, depth and value limits") {
    CHECK(!parses(R"({"a":1,"a":2})"));
    CHECK(parses(R"({"a":{"a":1}})"));
    ParseOptions opt;
    opt.maxDepth = 3;
    CHECK(parses("[[[1]]]", nullptr, opt));
    CHECK(!parses("[[[[1]]]]", nullptr, opt));
    std::string deep(1000, '[');
    deep += std::string(1000, ']');
    CHECK(!parses(deep));  // default depth limit, no stack exhaustion
    opt = ParseOptions();
    opt.maxValues = 5;
    CHECK(parses("[1,2,3,4]", nullptr, opt));
    CHECK(!parses("[1,2,3,4,5]", nullptr, opt));
}

TEST_CASE("json: writer output equals JSON.stringify") {
    od::json::Writer w;
    w.beginObject();
    w.key("v");
    w.integer(1);
    w.key("s");
    w.str("q\"b\\s/\n\t\x01\x1F\x7F\xED\x95\x9C");
    w.key("a");
    w.beginArray();
    w.boolean(true);
    w.null();
    w.integer(-9007199254740991LL);
    w.number(0.5);
    w.number(-0.0);
    w.beginObject();
    w.endObject();
    w.endArray();
    w.endObject();
    CHECK(w.ok());
    CHECK_EQ(w.text(), std::string("{\"v\":1,\"s\":\"q\\\"b\\\\s/\\n\\t\\u0001\\u001f\x7F\xED\x95\x9C\",\"a\":[true,null,-9007199254740991,0.5,0,{}]}"));

    od::json::Writer bad;
    bad.str("\xC0\xAF");
    CHECK(!bad.ok());
    od::json::Writer inf;
    inf.number(HUGE_VAL);
    CHECK(!inf.ok());
}

TEST_CASE("json: parse/serialize round trip") {
    CHECK_EQ(roundTrip(R"({ "b" : [ 1 , 2.25 , "x" ] , "a" : { } })"), std::string(R"({"b":[1,2.25,"x"],"a":{}})"));
    CHECK_EQ(roundTrip(R"("\u0000")"), std::string("\"\\u0000\""));
}
