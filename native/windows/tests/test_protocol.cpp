#include <functional>
#include <string>
#include <variant>

#include "core/defaults.h"
#include "core/json.h"
#include "core/protocol.h"
#include "test_framework.h"

using namespace od;
using proto::ParseErrorKind;

namespace {

json::Value* member(json::Value& v, const std::string& key) {
    for (json::Member& m : v.asObject()) {
        if (m.key == key) return &m.value;
    }
    return nullptr;
}

void removeMember(json::Value& v, const std::string& key) {
    auto& obj = v.asObject();
    for (auto it = obj.begin(); it != obj.end(); ++it) {
        if (it->key == key) {
            obj.erase(it);
            return;
        }
    }
}

json::Value referenceJson() {
    const auto cfg = defaults::referenceConfigure(proto::Locale::En);
    json::Value v;
    json::ParseError e;
    od::json::parse(defaults::configureToJson(*cfg), v, e);
    return v;
}

/** Applies `mutate` to the reference configure JSON and parses the result. */
proto::ParseResult mutated(const std::function<void(json::Value&)>& mutate) {
    json::Value v = referenceJson();
    mutate(v);
    return proto::parseMainToHelper(json::serialize(v));
}

json::Value& firstSector(json::Value& root) {
    return member(member(root, "menus")->asArray()[0], "convert")->asArray()[0];
}

void expectFail(const proto::ParseResult& r, ParseErrorKind kind, const char* file, int line) {
    if (r.ok()) {
        odtest::reportFailure(file, line, "expected rejection, got ok");
    } else if (r.failure.kind != kind) {
        odtest::reportFailure(file, line, "wrong failure kind " + std::to_string(static_cast<int>(r.failure.kind)) + ": " + r.failure.detail);
    }
}
#define EXPECT_FAIL(result, kind) expectFail((result), (kind), __FILE__, __LINE__)
#define EXPECT_OK(result)                                                                                      \
    do {                                                                                                       \
        const auto& od_r_ = (result);                                                                          \
        if (!od_r_.ok()) odtest::reportFailure(__FILE__, __LINE__, "unexpected rejection: " + od_r_.failure.detail); \
    } while (0)

std::string repeat(const std::string& s, size_t n) {
    std::string out;
    for (size_t i = 0; i < n; ++i) out += s;
    return out;
}

}  // namespace

TEST_CASE("protocol: reference configure round-trips through the validator") {
    const auto ref = defaults::referenceConfigure(proto::Locale::Ko, defaults::Theme::Dark);
    const auto r = proto::parseMainToHelper(defaults::configureToJson(*ref));
    REQUIRE(r.ok());
    const auto* cfgp = std::get_if<std::shared_ptr<const proto::Configure>>(&*r.message);
    REQUIRE(cfgp != nullptr);
    const proto::Configure& c = **cfgp;
    CHECK(c.enabled);
    CHECK(c.locale == proto::Locale::Ko);
    CHECK_EQ(c.geometry.diameter, 360.0);
    CHECK_EQ(c.geometry.innerRadiusRatio, 0.36);
    CHECK_EQ(c.geometry.startAngleDeg, -90.0);
    CHECK(c.tokens.sectorActive == ref->tokens.sectorActive);
    CHECK_EQ(c.tokens.labelWeight, 700);
    CHECK_EQ(int(c.convertModifiers), int(proto::kModShift));
    CHECK_EQ(int(c.toolsModifiers), int(proto::kModShift | proto::kModAlt));
    CHECK_EQ(c.extensions.size(), ref->extensions.size());
    CHECK(c.lookupExtension(".jfif") == proto::MenuKey::ImageJpeg);
    REQUIRE(c.menus.size() == proto::kMenuKeyCount);
    const proto::HelperMenu* pdf = c.findMenu(proto::MenuKey::Pdf);
    REQUIRE(pdf != nullptr);
    REQUIRE(pdf->convert.size() == 4);
    CHECK(pdf->convert[1].actionId == proto::ActionId::ConvertJpeg);
    CHECK_EQ(pdf->convert[1].label, std::string("JPG"));
    CHECK(pdf->tools.empty());
    const proto::HelperMenu* jpeg = c.findMenu(proto::MenuKey::ImageJpeg);
    REQUIRE(jpeg != nullptr);
    REQUIRE(jpeg->convert.size() == 8);  // the input's own format is not offered
    CHECK(jpeg->convert[0].actionId == proto::ActionId::ConvertPng);
    REQUIRE(jpeg->tools.size() == 7);
    CHECK(jpeg->tools[4].icon == proto::IconId::Background);
    CHECK(!jpeg->tools[4].batch);
    CHECK(jpeg->tools[0].batch);
    CHECK_EQ(c.strings.fileCount, ref->strings.fileCount);
}

TEST_CASE("protocol: Claude analysis menus (tool.analyze, icon analyze) round-trip; one-sector PDF and mixed tools") {
    const auto ref = defaults::referenceConfigure(proto::Locale::Ko, defaults::Theme::Light, true);
    const auto r = proto::parseMainToHelper(defaults::configureToJson(*ref));
    REQUIRE(r.ok());
    const auto* cfgp = std::get_if<std::shared_ptr<const proto::Configure>>(&*r.message);
    REQUIRE(cfgp != nullptr);
    const proto::Configure& c = **cfgp;
    for (const proto::MenuKey key : {proto::MenuKey::Pdf, proto::MenuKey::Mixed}) {
        const proto::HelperMenu* m = c.findMenu(key);
        REQUIRE(m != nullptr);
        REQUIRE(m->tools.size() == 1);  // the whole tools wheel: one sector
        CHECK(m->tools[0].actionId == proto::ActionId::ToolAnalyze);
        CHECK(m->tools[0].icon == proto::IconId::Analyze);
        CHECK(m->tools[0].batch);
        CHECK(m->tools[0].enabled);
        CHECK_EQ(m->tools[0].label, std::string("Claude \xEB\xB6\x84\xEC\x84\x9D"));  // Claude 분석
        CHECK_EQ(m->convert.size(), ref->findMenu(key)->convert.size());
    }
    for (const proto::HelperMenu& m : c.menus) {
        if (m.key == proto::MenuKey::Pdf || m.key == proto::MenuKey::Mixed) continue;
        REQUIRE(m.tools.size() == 8);  // the seven image tools, then Claude analysis
        CHECK(m.tools[6].actionId == proto::ActionId::ToolRedact);
        CHECK(m.tools[7].actionId == proto::ActionId::ToolAnalyze);
    }
    // Analysis is opt-in: without it the PDF and mixed tools wheels stay empty.
    const auto off = defaults::referenceConfigure(proto::Locale::Ko);
    CHECK(off->findMenu(proto::MenuKey::Pdf)->tools.empty());
    CHECK(off->findMenu(proto::MenuKey::Mixed)->tools.empty());
    CHECK_EQ(off->findMenu(proto::MenuKey::ImagePng)->tools.size(), size_t{7});
    const auto en = defaults::referenceConfigure(proto::Locale::En, defaults::Theme::Light, true);
    CHECK_EQ(en->findMenu(proto::MenuKey::Pdf)->tools[0].label, std::string("ANALYZE"));
}

TEST_CASE("protocol: envelope validation") {
    EXPECT_FAIL(proto::parseMainToHelper("not json"), ParseErrorKind::InvalidJson);
    EXPECT_FAIL(proto::parseMainToHelper("[1,2]"), ParseErrorKind::NotAnObject);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":5})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"drop"})"), ParseErrorKind::UnknownType);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"Ping","nonce":1})"), ParseErrorKind::UnknownType);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"type":"ping","nonce":1})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":"1","type":"ping","nonce":1})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":2,"type":"ping","nonce":1})"), ParseErrorKind::UnsupportedVersion);
    EXPECT_OK(proto::parseMainToHelper(R"({"v":1.0,"type":"ping","nonce":1})"));
    EXPECT_OK(proto::parseMainToHelper(R"({"type":"shutdown","v":1})"));
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"shutdown","extra":true})"), ParseErrorKind::InvalidMessage);
    EXPECT_OK(proto::parseMainToHelper(R"({"v":1,"type":"queryPermissions"})"));
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"queryPermissions","x":null})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"ping","nonce":1,"nonce":2})"), ParseErrorKind::InvalidJson);

    std::string big = R"({"v":1,"type":"ping","nonce":1,"pad":")" + std::string(proto::kMaxLineBytes, 'x') + "\"}";
    EXPECT_FAIL(proto::parseMainToHelper(big), ParseErrorKind::LineTooLong);
}

TEST_CASE("protocol: ping nonce and cancelSession id") {
    const auto r = proto::parseMainToHelper(R"({"v":1,"type":"ping","nonce":9007199254740991})");
    REQUIRE(r.ok());
    CHECK_EQ(std::get<proto::Ping>(*r.message).nonce, int64_t{9007199254740991});
    EXPECT_OK(proto::parseMainToHelper(R"({"v":1,"type":"ping","nonce":0})"));
    EXPECT_OK(proto::parseMainToHelper(R"({"v":1,"type":"ping","nonce":1e3})"));
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"ping","nonce":9007199254740992})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"ping","nonce":-1})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"ping","nonce":1.5})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"ping","nonce":"1"})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"ping"})"), ParseErrorKind::InvalidMessage);

    const auto c = proto::parseMainToHelper(R"({"v":1,"type":"cancelSession","sessionId":"s_ab-9"})");
    REQUIRE(c.ok());
    CHECK_EQ(std::get<proto::CancelSession>(*c.message).sessionId, std::string("s_ab-9"));
    EXPECT_OK(proto::parseMainToHelper(R"({"v":1,"type":"cancelSession","sessionId":")" + std::string(64, 'a') + "\"}"));
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"cancelSession","sessionId":")" + std::string(65, 'a') + "\"}"),
                ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"cancelSession","sessionId":""})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper(R"({"v":1,"type":"cancelSession","sessionId":"a b"})"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(proto::parseMainToHelper("{\"v\":1,\"type\":\"cancelSession\",\"sessionId\":\"\xC3\xA9\"}"), ParseErrorKind::InvalidMessage);
}

TEST_CASE("protocol: configure is strict about fields") {
    EXPECT_OK(mutated([](json::Value&) {}));
    EXPECT_FAIL(mutated([](json::Value& v) { v.set("extra", json::Value::makeBool(true)); }), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { member(v, "geometry")->set("bogus", json::Value::makeNumber(1)); }),
                ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { removeMember(*member(v, "tokens"), "capsule"); }), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { removeMember(v, "strings"); }), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { member(v, "modifiers")->set("other", json::Value::makeArray()); }),
                ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { firstSector(v).set("shortcut", json::Value::makeString("x")); }),
                ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { member(v, "menus")->asArray()[0].set("order", json::Value::makeNumber(1)); }),
                ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { member(v, "strings")->set("title", json::Value::makeString("x")); }),
                ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { *member(v, "enabled") = json::Value::makeString("true"); }),
                ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { *member(v, "locale") = json::Value::makeString("de"); }),
                ParseErrorKind::InvalidMessage);
}

TEST_CASE("protocol: configure numeric ranges match the zod schema") {
    const auto geo = [](const char* key, double value) {
        return mutated([&](json::Value& v) { *member(*member(v, "geometry"), key) = json::Value::makeNumber(value); });
    };
    EXPECT_OK(geo("diameter", 200));
    EXPECT_OK(geo("diameter", 600));
    EXPECT_FAIL(geo("diameter", 199.999), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(geo("diameter", 600.0001), ParseErrorKind::InvalidMessage);
    EXPECT_OK(geo("innerRadiusRatio", 0.15));
    EXPECT_FAIL(geo("innerRadiusRatio", 0.149), ParseErrorKind::InvalidMessage);
    EXPECT_OK(geo("startAngleDeg", -360));
    EXPECT_FAIL(geo("startAngleDeg", -360.5), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(geo("ringWidth", 8.01), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(geo("armDistance", -1), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { *member(*member(v, "geometry"), "diameter") = json::Value::makeString("360"); }),
                ParseErrorKind::InvalidMessage);

    const auto tok = [](const char* key, json::Value value) {
        return mutated([&](json::Value& v) { *member(*member(v, "tokens"), key) = value; });
    };
    EXPECT_OK(tok("labelWeight", json::Value::makeNumber(100)));
    EXPECT_FAIL(tok("labelWeight", json::Value::makeNumber(700.5)), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(tok("labelWeight", json::Value::makeNumber(901)), ParseErrorKind::InvalidMessage);
    EXPECT_OK(tok("appearMs", json::Value::makeNumber(1000)));
    EXPECT_FAIL(tok("appearMs", json::Value::makeNumber(1001)), ParseErrorKind::InvalidMessage);
    EXPECT_OK(tok("sector", json::Value::makeString("#ff00aa")));
    EXPECT_OK(tok("sector", json::Value::makeString("#FF00AA80")));
    EXPECT_FAIL(tok("sector", json::Value::makeString("#FFF")), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(tok("sector", json::Value::makeString("#GG0000")), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(tok("sector", json::Value::makeString("FF00AA")), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(tok("sector", json::Value::makeString("#FF00AA8")), ParseErrorKind::InvalidMessage);
    // "700.0" in JSON is the number 700 in JavaScript.
    json::Value v = referenceJson();
    std::string text = json::serialize(v);
    const size_t at = text.find("\"labelWeight\":700");
    REQUIRE(at != std::string::npos);
    text.replace(at, 17, "\"labelWeight\":700.0");
    EXPECT_OK(proto::parseMainToHelper(text));
}

TEST_CASE("protocol: modifier combos and the extension map") {
    const auto mods = [](std::initializer_list<const char*> keys) {
        return mutated([&](json::Value& v) {
            json::Value arr = json::Value::makeArray();
            for (const char* k : keys) arr.push(json::Value::makeString(k));
            *member(*member(v, "modifiers"), "tools") = arr;
        });
    };
    EXPECT_OK(mods({"command"}));
    EXPECT_OK(mods({"control", "alt", "shift"}));
    EXPECT_FAIL(mods({}), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mods({"shift", "shift"}), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mods({"hyper"}), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mods({"shift", "alt", "control", "command"}), ParseErrorKind::InvalidMessage);

    const auto ext = [](const char* key, const char* value) {
        return mutated([&](json::Value& v) { member(v, "extensions")->set(key, json::Value::makeString(value)); });
    };
    EXPECT_OK(ext(".raw2", "images"));
    EXPECT_OK(ext(".a1234567", "pdf"));
    EXPECT_FAIL(ext(".PDF2", "pdf"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(ext("xyz", "pdf"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(ext(".", "pdf"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(ext(".abcdefghi", "pdf"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(ext(".x-y", "pdf"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(ext(".xyz", "image/xyz"), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { *member(v, "extensions") = json::Value::makeArray(); }),
                ParseErrorKind::InvalidMessage);
}

TEST_CASE("protocol: menus and sectors") {
    EXPECT_FAIL(mutated([](json::Value& v) {
                    auto& menus = member(v, "menus")->asArray();
                    const json::Value first = menus[0];
                    while (menus.size() < 33) menus.push_back(first);
                }),
                ParseErrorKind::InvalidMessage);
    EXPECT_OK(mutated([](json::Value& v) {
        auto& menus = member(v, "menus")->asArray();
        const json::Value first = menus[0];
        while (menus.size() < 32) menus.push_back(first);
    }));
    EXPECT_FAIL(mutated([](json::Value& v) {
                    auto& conv = member(member(v, "menus")->asArray()[0], "convert")->asArray();
                    const json::Value s = conv[0];
                    while (conv.size() < 13) conv.push_back(s);
                }),
                ParseErrorKind::InvalidMessage);
    const auto sector = [](const char* key, json::Value value) {
        return mutated([&](json::Value& v) { *member(firstSector(v), key) = value; });
    };
    EXPECT_FAIL(sector("actionId", json::Value::makeString("convert.gif")), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(sector("actionId", json::Value::makeString("tool.Crop")), ParseErrorKind::InvalidMessage);
    EXPECT_OK(sector("actionId", json::Value::makeString("tool.addBackground")));
    EXPECT_OK(sector("actionId", json::Value::makeString("tool.analyze")));
    EXPECT_FAIL(sector("actionId", json::Value::makeString("tool.analyse")), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(sector("label", json::Value::makeString("")), ParseErrorKind::InvalidMessage);
    EXPECT_OK(sector("label", json::Value::makeString(std::string(32, 'L'))));
    EXPECT_FAIL(sector("label", json::Value::makeString(std::string(33, 'L'))), ParseErrorKind::InvalidMessage);
    // zod 4 measures strings in code points: an emoji counts once (two UTF-16 units).
    EXPECT_OK(sector("label", json::Value::makeString(std::string(31, 'L') + "\xF0\x9F\x98\x80")));       // 32 code points, 33 units
    EXPECT_FAIL(sector("label", json::Value::makeString(std::string(32, 'L') + "\xF0\x9F\x98\x80")),       // 33 code points
                ParseErrorKind::InvalidMessage);
    EXPECT_OK(sector("label", json::Value::makeString(repeat("\xF0\x9F\x98\x80", 32))));                   // 64 units
    EXPECT_FAIL(sector("label", json::Value::makeString(repeat("\xF0\x9F\x98\x80", 33))), ParseErrorKind::InvalidMessage);
    EXPECT_OK(sector("label", json::Value::makeString(repeat("\xED\x95\x9C", 32))));  // 32 Hangul syllables
    EXPECT_FAIL(sector("icon", json::Value::makeString("star")), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(sector("icon", json::Value::makeString("sparkles")), ParseErrorKind::InvalidMessage);
    EXPECT_OK(sector("icon", json::Value::makeString("background")));
    EXPECT_OK(sector("icon", json::Value::makeString("analyze")));
    EXPECT_OK(sector("icon", json::Value::makeNull()));
    EXPECT_FAIL(mutated([](json::Value& v) { removeMember(firstSector(v), "icon"); }), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(sector("enabled", json::Value::makeNumber(1)), ParseErrorKind::InvalidMessage);
    EXPECT_OK(mutated([](json::Value& v) { firstSector(v).set("reason", json::Value::makeString(std::string(120, 'r'))); }));
    EXPECT_FAIL(mutated([](json::Value& v) { firstSector(v).set("reason", json::Value::makeString(std::string(121, 'r'))); }),
                ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { firstSector(v).set("reason", json::Value::makeNull()); }),
                ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(mutated([](json::Value& v) { *member(member(v, "menus")->asArray()[0], "key") = json::Value::makeString("doc"); }),
                ParseErrorKind::InvalidMessage);
}

TEST_CASE("protocol: strings limits") {
    const auto str = [](const char* key, const std::string& value) {
        return mutated([&](json::Value& v) { *member(*member(v, "strings"), key) = json::Value::makeString(value); });
    };
    EXPECT_OK(str("dropHint", std::string(60, 'd')));
    EXPECT_OK(str("dropHint", ""));
    EXPECT_FAIL(str("dropHint", std::string(61, 'd')), ParseErrorKind::InvalidMessage);
    EXPECT_FAIL(str("fileCount", std::string(61, 'n')), ParseErrorKind::InvalidMessage);
}

TEST_CASE("protocol: optional specific unsupported strings") {
    // Present in the reference configure and parsed.
    const auto r = proto::parseMainToHelper(defaults::configureToJson(*defaults::referenceConfigure(proto::Locale::En)));
    REQUIRE(r.ok());
    const auto& c = *std::get<std::shared_ptr<const proto::Configure>>(*r.message);
    CHECK(c.strings.unsupportedFolder == std::optional<std::string>("Folders aren't supported"));
    CHECK(c.strings.unsupportedNonFile == std::optional<std::string>("Not a file"));
    CHECK(c.strings.unsupportedVirtual == std::optional<std::string>("No file on disk"));
    CHECK(c.strings.unsupportedCloud == std::optional<std::string>("Download it first"));
    for (const char* key : {"unsupportedFolder", "unsupportedNonFile", "unsupportedVirtual", "unsupportedCloud"}) {
        // Absent: fine (fallback to `unsupported`).
        const auto absent = mutated([&](json::Value& v) { removeMember(*member(v, "strings"), key); });
        EXPECT_OK(absent);
        if (absent.ok()) {
            const auto& cfg = *std::get<std::shared_ptr<const proto::Configure>>(*absent.message);
            const std::string k = key;
            const std::optional<std::string>& field = k == "unsupportedFolder"    ? cfg.strings.unsupportedFolder
                                                      : k == "unsupportedNonFile" ? cfg.strings.unsupportedNonFile
                                                      : k == "unsupportedVirtual" ? cfg.strings.unsupportedVirtual
                                                                                  : cfg.strings.unsupportedCloud;
            CHECK(!field.has_value());
        }
        EXPECT_OK(mutated([&](json::Value& v) { *member(*member(v, "strings"), key) = json::Value::makeString(std::string(60, 'f')); }));
        EXPECT_OK(mutated([&](json::Value& v) { *member(*member(v, "strings"), key) = json::Value::makeString(""); }));
        EXPECT_FAIL(mutated([&](json::Value& v) { *member(*member(v, "strings"), key) = json::Value::makeString(std::string(61, 'f')); }),
                    ParseErrorKind::InvalidMessage);
        EXPECT_FAIL(mutated([&](json::Value& v) { *member(*member(v, "strings"), key) = json::Value::makeNull(); }),
                    ParseErrorKind::InvalidMessage);
        EXPECT_FAIL(mutated([&](json::Value& v) { *member(*member(v, "strings"), key) = json::Value::makeNumber(1); }),
                    ParseErrorKind::InvalidMessage);
    }
    EXPECT_FAIL(mutated([](json::Value& v) { member(v, "strings")->set("unsupportedOther", json::Value::makeString("x")); }),
                ParseErrorKind::InvalidMessage);
}

TEST_CASE("protocol: helper → main serializers") {
    proto::ReadyInfo ready;
    ready.helperVersion = "0.1.0";
    ready.arch = "x64";
    ready.osVersion = "10.0.22631";
    ready.pid = 4242;
    CHECK_EQ(proto::serializeReady(ready),
             std::string(R"({"v":1,"type":"ready","helperVersion":"0.1.0","platform":"win32","arch":"x64","osVersion":"10.0.22631","pid":4242,"globalDrag":{"available":true}})"));
    ready.globalDragAvailable = false;
    ready.globalDragReason = "elevated";
    ready.helperVersion = std::string(40, 'v');
    const std::string r2 = proto::serializeReady(ready);
    CHECK(r2.find(R"("globalDrag":{"available":false,"reason":"elevated"})") != std::string::npos);
    CHECK(r2.find(std::string(32, 'v') + "\"") != std::string::npos);
    CHECK(r2.find(std::string(33, 'v')) == std::string::npos);
    ready.arch = "ia32";
    CHECK(proto::serializeReady(ready).empty());

    proto::StateMessage st;
    st.sessionId = "s1";
    st.state = proto::SessionState::PotentialDrag;
    CHECK_EQ(proto::serializeState(st), std::string(R"({"v":1,"type":"state","sessionId":"s1","state":"PotentialDrag"})"));
    st.state = proto::SessionState::WheelActive;
    st.mode = proto::WheelMode::Tools;
    st.hasMenuKey = true;
    st.fileCount = 3;
    CHECK_EQ(proto::serializeState(st),
             std::string(R"({"v":1,"type":"state","sessionId":"s1","state":"WheelActive","mode":"tools","menuKey":null,"fileCount":3})"));
    st.menuKey = proto::MenuKey::ImageJpeg;
    CHECK(proto::serializeState(st).find(R"("menuKey":"image/jpeg")") != std::string::npos);
    st.sessionId = "bad id";
    CHECK(proto::serializeState(st).empty());

    CHECK_EQ(proto::serializeCancelled("s1", proto::CancelReason::DisabledSector),
             std::string(R"({"v":1,"type":"cancelled","sessionId":"s1","reason":"disabledSector"})"));
    CHECK_EQ(proto::serializePong(9007199254740991LL), std::string(R"({"v":1,"type":"pong","nonce":9007199254740991})"));
    CHECK(proto::serializePong(-1).empty());
    CHECK_EQ(proto::serializePermissions(), std::string(R"({"v":1,"type":"permissions","items":[]})"));
    CHECK_EQ(proto::serializeError("invalidJson", "bad", false),
             std::string(R"({"v":1,"type":"error","code":"invalidJson","message":"bad","fatal":false})"));
    const std::string log = proto::serializeLog(proto::LogLevel::Warn, std::string(2500, 'm'));
    CHECK(log.find(std::string(2000, 'm') + "\"") != std::string::npos);
    const std::string elog = proto::serializeLog(proto::LogLevel::Info, repeat("\xF0\x9F\x98\x80", 2100));
    CHECK(elog.find(repeat("\xF0\x9F\x98\x80", 2000) + "\"") != std::string::npos);  // 2000 code points kept
    CHECK(elog.find(repeat("\xF0\x9F\x98\x80", 2001)) == std::string::npos);
    CHECK(log.find(std::string(2001, 'm')) == std::string::npos);
}

TEST_CASE("protocol: drop message contents and limits") {
    proto::DropMessage d;
    d.sessionId = "w1-2";
    d.actionId = proto::ActionId::ConvertJpeg;
    d.mode = proto::WheelMode::Convert;
    d.files = {"C:\\Users\\\xED\x95\x9C\\Page 001.pdf", "D:\\a \"quoted\".png"};
    CHECK_EQ(proto::serializeDrop(d),
             std::string("{\"v\":1,\"type\":\"drop\",\"sessionId\":\"w1-2\",\"actionId\":\"convert.jpeg\",\"mode\":\"convert\","
                         "\"files\":[\"C:\\\\Users\\\\\xED\x95\x9C\\\\Page 001.pdf\",\"D:\\\\a \\\"quoted\\\".png\"],\"dropEffect\":\"copy\"}"));
    d.files.clear();
    CHECK(proto::serializeDrop(d).empty());
    d.files.assign(201, "C:\\x.png");
    CHECK(proto::serializeDrop(d).empty());
    d.files.assign(200, "C:\\x.png");
    CHECK(!proto::serializeDrop(d).empty());
    d.files = {"C:\\" + std::string(32764, 'p')};  // 32767 code points
    CHECK(!proto::serializeDrop(d).empty());
    d.files = {"C:\\" + std::string(32765, 'p')};
    CHECK(proto::serializeDrop(d).empty());
    d.files = {"C:\\" + repeat("\xF0\x9F\x98\x80", 32764)};  // 32767 code points, 65531 UTF-16 units
    CHECK(!proto::serializeDrop(d).empty());
    d.files = {std::string("C:\\\xC0\xAF")};
    CHECK(proto::serializeDrop(d).empty());
    d.files.assign(40, "C:\\" + std::string(30000, 'p'));  // 1.2 MB > HELPER_MAX_LINE_BYTES
    CHECK(proto::serializeDrop(d).empty());
}

TEST_CASE("protocol: enum string tables") {
    for (size_t i = 0; i < proto::kActionCount; ++i) {
        const auto a = static_cast<proto::ActionId>(i);
        CHECK(proto::parseActionId(proto::toString(a)) == a);
    }
    for (size_t i = 0; i < proto::kIconCount; ++i) {
        const auto ic = static_cast<proto::IconId>(i);
        CHECK(proto::parseIconId(proto::toString(ic)) == ic);
    }
    CHECK_EQ(std::string(proto::toString(proto::ActionId::ToolAnalyze)), std::string("tool.analyze"));
    CHECK_EQ(std::string(proto::toString(proto::IconId::Analyze)), std::string("analyze"));
    for (size_t i = 0; i < proto::kMenuKeyCount; ++i) {
        const auto k = static_cast<proto::MenuKey>(i);
        CHECK(proto::parseMenuKey(proto::toString(k)) == k);
    }
    CHECK(proto::imageFormatOfKey(proto::MenuKey::ImageHeic) == proto::ImageFormat::Heic);
    CHECK(!proto::imageFormatOfKey(proto::MenuKey::Images));
    CHECK_EQ(std::string(proto::formatLabelOfKey(proto::MenuKey::ImageJpeg)), std::string("JPG"));
    CHECK_EQ(std::string(proto::formatLabelOfKey(proto::MenuKey::Pdf)), std::string("PDF"));
    CHECK_EQ(std::string(proto::formatLabelOfKey(proto::MenuKey::Mixed)), std::string(""));
    CHECK(proto::menuKeyForImage(proto::ImageFormat::Bmp) == proto::MenuKey::ImageBmp);
}
