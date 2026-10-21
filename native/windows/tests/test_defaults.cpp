// Drift check: the built-in defaults (used for snapshots and before the first
// `configure`) must equal packages/contracts/design-tokens.json.
#include <string>

#include "core/defaults.h"
#include "core/json.h"
#include "test_framework.h"

using namespace od;

namespace {

std::string hex(const proto::Color& c, bool withAlpha) {
    static const char* digits = "0123456789ABCDEF";
    std::string s = "#";
    const uint8_t bytes[4] = {c.r, c.g, c.b, c.a};
    for (int i = 0; i < (withAlpha ? 4 : 3); ++i) {
        s.push_back(digits[bytes[i] >> 4]);
        s.push_back(digits[bytes[i] & 15]);
    }
    return s;
}

std::string upper(std::string s) {
    for (char& ch : s) {
        if (ch >= 'a' && ch <= 'f') ch = static_cast<char>(ch - 32);
    }
    return s;
}

}  // namespace

TEST_CASE("defaults: wheel tokens match packages/contracts/design-tokens.json") {
    const std::string path = odtest::repoFixturesDir() + "/../../packages/contracts/design-tokens.json";
    std::string text;
    if (!odtest::readFile(path, text)) {
        if (odtest::goldenRequired()) odtest::reportFailure(__FILE__, __LINE__, "design-tokens.json not found: " + path);
        else odtest::note("SKIPPED: " + path + " not found");
        return;
    }
    json::Value root;
    json::ParseError err;
    REQUIRE(json::parse(text, root, err));
    const json::Value* colors = root.get("color");
    const json::Value* font = root.get("font");
    const json::Value* motion = root.get("motion");
    REQUIRE(colors != nullptr && font != nullptr && motion != nullptr);

    const struct {
        const char* name;
        defaults::Theme theme;
    } themes[] = {{"light", defaults::Theme::Light}, {"dark", defaults::Theme::Dark}, {"highContrast", defaults::Theme::HighContrast}};
    for (const auto& th : themes) {
        const json::Value* c = colors->get(th.name);
        REQUIRE(c != nullptr);
        const proto::WheelTokens t = defaults::tokens(th.theme);
        const std::pair<const char*, proto::Color> fields[] = {
            {"wheelDisc", t.wheelDisc},       {"wheelRing", t.wheelRing},           {"wheelShadow", t.wheelShadow},
            {"sector", t.sector},             {"sectorHover", t.sectorHover},       {"sectorText", t.sectorText},
            {"sectorIcon", t.sectorIcon},     {"sectorDisabled", t.sectorDisabled}, {"sectorDisabledText", t.sectorDisabledText},
            {"sectorActive", t.sectorActive}, {"sectorActiveText", t.sectorActiveText}, {"capsule", t.capsule},
            {"capsuleText", t.capsuleText},   {"capsuleReject", t.capsuleReject},
        };
        for (const auto& [key, value] : fields) {
            const json::Value* v = c->get(key);
            if (v == nullptr || !v->isString()) {
                odtest::reportFailure(__FILE__, __LINE__, std::string(th.name) + "." + key + " missing in design-tokens.json");
                continue;
            }
            const std::string want = upper(v->asString());
            const std::string have = hex(value, want.size() == 9);
            if (want != have) odtest::reportFailure(__FILE__, __LINE__, std::string(th.name) + "." + key + ": defaults " + have + " != " + want);
            // Six-digit tokens are opaque.
            if (want.size() == 7 && value.a != 255) odtest::reportFailure(__FILE__, __LINE__, std::string(th.name) + "." + key + " should be opaque");
        }
    }
    const proto::WheelTokens t = defaults::tokens(defaults::Theme::Light);
    CHECK_EQ(t.labelSize, font->get("wheelLabelSize")->asNumber());
    CHECK_EQ(static_cast<double>(t.labelWeight), font->get("wheelLabelWeight")->asNumber());
    CHECK_EQ(t.iconSize, font->get("wheelIconSize")->asNumber());
    CHECK_EQ(t.capsuleTextSize, font->get("capsuleSize")->asNumber());
    CHECK_EQ(t.appearMs, motion->get("wheelAppearMs")->asNumber());
    CHECK_EQ(t.disappearMs, motion->get("wheelDisappearMs")->asNumber());
    const proto::WheelTokens reduced = defaults::tokens(defaults::Theme::Light, true);
    CHECK_EQ(reduced.appearMs, 0.0);
    CHECK_EQ(reduced.disappearMs, 0.0);
}
