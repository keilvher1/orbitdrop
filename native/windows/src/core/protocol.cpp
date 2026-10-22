#include "core/protocol.h"

#include <cmath>
#include <initializer_list>
#include <utility>

#include "core/json.h"
#include "core/utf.h"

namespace od::proto {

// ------------------------------------------------------------------ enum tables

namespace {

constexpr std::array<const char*, kActionCount> kActionNames = {
    "convert.jpeg", "convert.png",   "convert.webp",  "convert.heic",     "convert.tiff",  "convert.avif",
    "convert.bmp",  "convert.pdf",   "convert.docx",  "convert.txt",      "tool.compress", "tool.metadata",
    "tool.edit",    "tool.annotate", "tool.addBackground", "tool.crop", "tool.redact",
};
constexpr std::array<const char*, kIconCount> kIconNames = {"compress", "metadata", "edit",  "annotate",
                                                            "background", "crop",   "redact"};
constexpr std::array<const char*, kMenuKeyCount> kMenuKeyNames = {
    "pdf",        "image/jpeg", "image/png",  "image/webp", "image/gif", "image/tiff",
    "image/avif", "image/heic", "image/bmp",  "images",     "mixed",
};
constexpr std::array<const char*, kImageFormatCount> kImageFormatNames = {"jpeg", "png",  "webp", "gif",
                                                                          "tiff", "avif", "heic", "bmp"};
constexpr std::array<const char*, kImageFormatCount> kImageFormatLabels = {"JPG",  "PNG",  "WEBP", "GIF",
                                                                           "TIFF", "AVIF", "HEIC", "BMP"};

template <typename E, size_t N>
std::optional<E> lookup(const std::array<const char*, N>& names, std::string_view s) {
    for (size_t i = 0; i < N; ++i) {
        if (s == names[i]) return static_cast<E>(i);
    }
    return std::nullopt;
}

}  // namespace

const char* toString(ActionId v) { return kActionNames[static_cast<size_t>(v)]; }
const char* toString(IconId v) { return kIconNames[static_cast<size_t>(v)]; }
const char* toString(WheelMode v) { return v == WheelMode::Convert ? "convert" : "tools"; }
const char* toString(Locale v) { return v == Locale::Ko ? "ko" : "en"; }
const char* toString(MenuKey v) { return kMenuKeyNames[static_cast<size_t>(v)]; }
const char* toString(ImageFormat v) { return kImageFormatNames[static_cast<size_t>(v)]; }

const char* toString(SessionState v) {
    switch (v) {
        case SessionState::PotentialDrag: return "PotentialDrag";
        case SessionState::AwaitingPayload: return "AwaitingPayload";
        case SessionState::WheelActive: return "WheelActive";
        case SessionState::Idle: return "Idle";
    }
    return "Idle";
}

const char* toString(CancelReason v) {
    switch (v) {
        case CancelReason::Escape: return "escape";
        case CancelReason::DragEnded: return "dragEnded";
        case CancelReason::InvalidPayload: return "invalidPayload";
        case CancelReason::OutsideRing: return "outsideRing";
        case CancelReason::DisabledSector: return "disabledSector";
        case CancelReason::ParentRequest: return "parentRequest";
        case CancelReason::Sleep: return "sleep";
        case CancelReason::PermissionLost: return "permissionLost";
        case CancelReason::Error: return "error";
    }
    return "error";
}

const char* toString(LogLevel v) {
    switch (v) {
        case LogLevel::Debug: return "debug";
        case LogLevel::Info: return "info";
        case LogLevel::Warn: return "warn";
        case LogLevel::Error: return "error";
    }
    return "info";
}

std::optional<ActionId> parseActionId(std::string_view s) { return lookup<ActionId>(kActionNames, s); }
std::optional<IconId> parseIconId(std::string_view s) { return lookup<IconId>(kIconNames, s); }
std::optional<MenuKey> parseMenuKey(std::string_view s) { return lookup<MenuKey>(kMenuKeyNames, s); }
std::optional<ImageFormat> parseImageFormat(std::string_view s) { return lookup<ImageFormat>(kImageFormatNames, s); }

std::optional<WheelMode> parseWheelMode(std::string_view s) {
    if (s == "convert") return WheelMode::Convert;
    if (s == "tools") return WheelMode::Tools;
    return std::nullopt;
}

std::optional<Locale> parseLocale(std::string_view s) {
    if (s == "ko") return Locale::Ko;
    if (s == "en") return Locale::En;
    return std::nullopt;
}

MenuKey menuKeyForImage(ImageFormat f) { return static_cast<MenuKey>(static_cast<size_t>(MenuKey::ImageJpeg) + static_cast<size_t>(f)); }

std::optional<ImageFormat> imageFormatOfKey(MenuKey k) {
    const auto i = static_cast<size_t>(k);
    if (i < static_cast<size_t>(MenuKey::ImageJpeg) || i > static_cast<size_t>(MenuKey::ImageBmp)) return std::nullopt;
    return static_cast<ImageFormat>(i - static_cast<size_t>(MenuKey::ImageJpeg));
}

const char* formatLabelOfKey(MenuKey k) {
    if (k == MenuKey::Pdf) return "PDF";
    const auto f = imageFormatOfKey(k);
    return f ? kImageFormatLabels[static_cast<size_t>(*f)] : "";
}

bool isValidId(std::string_view s) {
    if (s.empty() || s.size() > 64) return false;
    for (const char c : s) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
        if (!ok) return false;
    }
    return true;
}

std::optional<Color> parseColor(std::string_view s) {
    if ((s.size() != 7 && s.size() != 9) || s[0] != '#') return std::nullopt;
    const auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    uint8_t bytes[4] = {0, 0, 0, 255};
    const size_t n = (s.size() - 1) / 2;
    for (size_t i = 0; i < n; ++i) {
        const int hi = hex(s[1 + 2 * i]);
        const int lo = hex(s[2 + 2 * i]);
        if (hi < 0 || lo < 0) return std::nullopt;
        bytes[i] = static_cast<uint8_t>(hi * 16 + lo);
    }
    return Color{bytes[0], bytes[1], bytes[2], bytes[3]};
}

const HelperMenu* Configure::findMenu(MenuKey k) const {
    for (const HelperMenu& m : menus) {
        if (m.key == k) return &m;
    }
    return nullptr;
}

std::optional<MenuKey> Configure::lookupExtension(std::string_view ext) const {
    for (const auto& [e, k] : extensions) {
        if (e == ext) return k;
    }
    return std::nullopt;
}

// ------------------------------------------------------------------ validation

namespace {

using json::Value;

/** Validation context: records the first failing field path. */
class Checker {
public:
    explicit Checker(ParseFailure& f) : failure_(f) {}

    bool fail(const std::string& path, const char* what) {
        if (failure_.detail.empty()) failure_.detail = path + ": " + what;
        failure_.kind = ParseErrorKind::InvalidMessage;
        return false;
    }

    /** Object whose keys are a subset of `allowed` and include every `required` key. */
    bool strictObject(const Value* v, const std::string& path, std::initializer_list<const char*> required,
                      std::initializer_list<const char*> optional = {}) {
        if (v == nullptr) return fail(path, "required");
        if (!v->isObject()) return fail(path, "expected object");
        for (const json::Member& m : v->asObject()) {
            bool known = false;
            for (const char* k : required) known = known || m.key == k;
            for (const char* k : optional) known = known || m.key == k;
            if (!known) return fail(join(path, safeKey(m.key)), "unknown field");
        }
        for (const char* k : required) {
            if (v->get(k) == nullptr) return fail(join(path, k), "required");
        }
        return true;
    }

    bool boolean(const Value& obj, const std::string& path, const char* key, bool& out) {
        const Value* v = obj.get(key);
        if (v == nullptr || !v->isBool()) return fail(join(path, key), "expected boolean");
        out = v->asBool();
        return true;
    }

    bool number(const Value& obj, const std::string& path, const char* key, double min, double max, double& out) {
        const Value* v = obj.get(key);
        if (v == nullptr || !v->isNumber()) return fail(join(path, key), "expected number");
        const double d = v->asNumber();
        if (!(d >= min && d <= max)) return fail(join(path, key), "out of range");
        out = d;
        return true;
    }

    bool integer(const Value* v, const std::string& path, int64_t min, int64_t max, int64_t& out) {
        if (v == nullptr || !v->isNumber()) return fail(path, "expected integer");
        const double d = v->asNumber();
        if (std::floor(d) != d || std::fabs(d) > static_cast<double>(kMaxSafeInteger)) return fail(path, "expected integer");
        if (d < static_cast<double>(min) || d > static_cast<double>(max)) return fail(path, "out of range");
        out = static_cast<int64_t>(d);
        return true;
    }

    /** String with min/max length in Unicode code points (zod 4 string length). */
    bool string(const Value* v, const std::string& path, size_t minLength, size_t maxLength, std::string& out) {
        if (v == nullptr || !v->isString()) return fail(path, "expected string");
        const size_t length = utf::codePointLength(v->asString());
        if (length == SIZE_MAX) return fail(path, "invalid UTF-8");
        if (length < minLength || length > maxLength) return fail(path, "length out of range");
        out = v->asString();
        return true;
    }

    bool color(const Value& obj, const std::string& path, const char* key, Color& out) {
        const Value* v = obj.get(key);
        if (v == nullptr || !v->isString()) return fail(join(path, key), "expected color");
        const auto c = parseColor(v->asString());
        if (!c) return fail(join(path, key), "invalid color");
        out = *c;
        return true;
    }

    static std::string join(const std::string& path, const std::string& key) {
        return path.empty() ? key : path + "." + key;
    }

    /** An unknown key as it may appear in an error report: field-like names
     *  only, anything else (a path, text, …) is message content and is not echoed. */
    static std::string safeKey(const std::string& key) {
        if (key.empty() || key.size() > 40) return "<key>";
        for (const char ch : key) {
            const bool ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_';
            if (!ok) return "<key>";
        }
        return key;
    }

private:
    ParseFailure& failure_;
};

bool parseGeometry(Checker& c, const Value* v, geo::WheelGeometry& g) {
    const std::string p = "geometry";
    if (!c.strictObject(v, p,
                        {"diameter", "minDiameter", "ringWidth", "ringInset", "innerRadiusRatio", "sectorGap",
                         "sectorCornerRadius", "capsuleWidth", "capsuleHeight", "startAngleDeg", "windowMargin",
                         "edgePadding", "armDistance"})) {
        return false;
    }
    return c.number(*v, p, "diameter", 200, 600, g.diameter) && c.number(*v, p, "minDiameter", 160, 600, g.minDiameter) &&
           c.number(*v, p, "ringWidth", 0, 8, g.ringWidth) && c.number(*v, p, "ringInset", 0, 40, g.ringInset) &&
           c.number(*v, p, "innerRadiusRatio", 0.15, 0.6, g.innerRadiusRatio) &&
           c.number(*v, p, "sectorGap", 0, 24, g.sectorGap) &&
           c.number(*v, p, "sectorCornerRadius", 0, 40, g.sectorCornerRadius) &&
           c.number(*v, p, "capsuleWidth", 40, 200, g.capsuleWidth) &&
           c.number(*v, p, "capsuleHeight", 20, 100, g.capsuleHeight) &&
           c.number(*v, p, "startAngleDeg", -360, 360, g.startAngleDeg) &&
           c.number(*v, p, "windowMargin", 0, 80, g.windowMargin) && c.number(*v, p, "edgePadding", 0, 80, g.edgePadding) &&
           c.number(*v, p, "armDistance", 0, 40, g.armDistance);
}

bool parseTokens(Checker& c, const Value* v, WheelTokens& t) {
    const std::string p = "tokens";
    if (!c.strictObject(v, p,
                        {"wheelDisc", "wheelRing", "wheelShadow", "sector", "sectorHover", "sectorText", "sectorIcon",
                         "sectorDisabled", "sectorDisabledText", "sectorActive", "sectorActiveText", "capsule",
                         "capsuleText", "capsuleReject", "labelSize", "labelWeight", "iconSize", "capsuleTextSize",
                         "appearMs", "disappearMs"})) {
        return false;
    }
    int64_t weight = 0;
    const bool ok =
        c.color(*v, p, "wheelDisc", t.wheelDisc) && c.color(*v, p, "wheelRing", t.wheelRing) &&
        c.color(*v, p, "wheelShadow", t.wheelShadow) && c.color(*v, p, "sector", t.sector) &&
        c.color(*v, p, "sectorHover", t.sectorHover) && c.color(*v, p, "sectorText", t.sectorText) &&
        c.color(*v, p, "sectorIcon", t.sectorIcon) && c.color(*v, p, "sectorDisabled", t.sectorDisabled) &&
        c.color(*v, p, "sectorDisabledText", t.sectorDisabledText) && c.color(*v, p, "sectorActive", t.sectorActive) &&
        c.color(*v, p, "sectorActiveText", t.sectorActiveText) && c.color(*v, p, "capsule", t.capsule) &&
        c.color(*v, p, "capsuleText", t.capsuleText) && c.color(*v, p, "capsuleReject", t.capsuleReject) &&
        c.number(*v, p, "labelSize", 8, 32, t.labelSize) &&
        c.integer(v->get("labelWeight"), p + ".labelWeight", 100, 900, weight) &&
        c.number(*v, p, "iconSize", 8, 48, t.iconSize) && c.number(*v, p, "capsuleTextSize", 8, 32, t.capsuleTextSize) &&
        c.number(*v, p, "appearMs", 0, 1000, t.appearMs) && c.number(*v, p, "disappearMs", 0, 1000, t.disappearMs);
    t.labelWeight = static_cast<int>(weight);
    return ok;
}

bool parseModifierCombo(Checker& c, const Value* v, const std::string& path, uint8_t& out) {
    if (v == nullptr || !v->isArray()) return c.fail(path, "expected array");
    const auto& arr = v->asArray();
    if (arr.empty() || arr.size() > 3) return c.fail(path, "expected 1-3 modifiers");
    uint8_t bits = 0;
    for (const Value& e : arr) {
        if (!e.isString()) return c.fail(path, "expected modifier name");
        uint8_t bit = 0;
        const std::string& s = e.asString();
        if (s == "shift") bit = kModShift;
        else if (s == "alt") bit = kModAlt;
        else if (s == "control") bit = kModControl;
        else if (s == "command") bit = kModCommand;
        else return c.fail(path, "unknown modifier");
        if (bits & bit) return c.fail(path, "duplicate modifier");
        bits |= bit;
    }
    out = bits;
    return true;
}

bool isExtensionKey(std::string_view k) {
    if (k.size() < 2 || k.size() > 9 || k[0] != '.') return false;
    for (size_t i = 1; i < k.size(); ++i) {
        const char ch = k[i];
        if (!((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9'))) return false;
    }
    return true;
}

bool parseSectors(Checker& c, const Value* v, const std::string& path, std::vector<WheelSector>& out) {
    if (v == nullptr || !v->isArray()) return c.fail(path, "expected array");
    const auto& arr = v->asArray();
    if (arr.size() > 12) return c.fail(path, "too many sectors");
    out.clear();
    for (size_t i = 0; i < arr.size(); ++i) {
        const std::string p = path + "[" + std::to_string(i) + "]";
        const Value& s = arr[i];
        if (!c.strictObject(&s, p, {"actionId", "label", "icon", "enabled", "batch"}, {"reason"})) return false;
        WheelSector sector;
        const Value* action = s.get("actionId");
        if (!action->isString()) return c.fail(p + ".actionId", "expected string");
        const auto id = parseActionId(action->asString());
        if (!id) return c.fail(p + ".actionId", "unknown action id");
        sector.actionId = *id;
        if (!c.string(s.get("label"), p + ".label", 1, 32, sector.label)) return false;
        const Value* icon = s.get("icon");
        if (icon->isNull()) {
            sector.icon.reset();
        } else if (icon->isString()) {
            const auto ic = parseIconId(icon->asString());
            if (!ic) return c.fail(p + ".icon", "unknown icon id");
            sector.icon = *ic;
        } else {
            return c.fail(p + ".icon", "expected icon id or null");
        }
        if (!c.boolean(s, p, "enabled", sector.enabled)) return false;
        if (const Value* reason = s.get("reason")) {
            std::string r;
            if (!c.string(reason, p + ".reason", 0, 120, r)) return false;
            sector.reason = std::move(r);
        }
        if (!c.boolean(s, p, "batch", sector.batch)) return false;
        out.push_back(std::move(sector));
    }
    return true;
}

bool parseConfigure(Checker& c, const Value& root, Configure& cfg) {
    if (!c.strictObject(&root, "",
                        {"v", "type", "enabled", "locale", "geometry", "tokens", "reduceMotion", "highContrast",
                         "modifiers", "extensions", "menus", "strings"})) {
        return false;
    }
    if (!c.boolean(root, "", "enabled", cfg.enabled)) return false;
    const Value* locale = root.get("locale");
    if (!locale->isString() || !parseLocale(locale->asString())) return c.fail("locale", "expected 'ko' or 'en'");
    cfg.locale = *parseLocale(locale->asString());
    if (!parseGeometry(c, root.get("geometry"), cfg.geometry)) return false;
    if (!parseTokens(c, root.get("tokens"), cfg.tokens)) return false;
    if (!c.boolean(root, "", "reduceMotion", cfg.reduceMotion)) return false;
    if (!c.boolean(root, "", "highContrast", cfg.highContrast)) return false;

    const Value* mods = root.get("modifiers");
    if (!c.strictObject(mods, "modifiers", {"convert", "tools"})) return false;
    if (!parseModifierCombo(c, mods->get("convert"), "modifiers.convert", cfg.convertModifiers)) return false;
    if (!parseModifierCombo(c, mods->get("tools"), "modifiers.tools", cfg.toolsModifiers)) return false;

    const Value* exts = root.get("extensions");
    if (!exts->isObject()) return c.fail("extensions", "expected object");
    cfg.extensions.clear();
    for (const json::Member& m : exts->asObject()) {
        if (!isExtensionKey(m.key)) return c.fail("extensions", "invalid extension key");
        if (!m.value.isString()) return c.fail("extensions." + m.key, "expected menu key");
        const auto key = parseMenuKey(m.value.asString());
        if (!key) return c.fail("extensions." + m.key, "unknown menu key");
        cfg.extensions.emplace_back(m.key, *key);
    }

    const Value* menus = root.get("menus");
    if (!menus->isArray()) return c.fail("menus", "expected array");
    if (menus->asArray().size() > 32) return c.fail("menus", "too many menus");
    cfg.menus.clear();
    for (size_t i = 0; i < menus->asArray().size(); ++i) {
        const std::string p = "menus[" + std::to_string(i) + "]";
        const Value& m = menus->asArray()[i];
        if (!c.strictObject(&m, p, {"key", "convert", "tools"})) return false;
        HelperMenu menu;
        const Value* key = m.get("key");
        if (!key->isString() || !parseMenuKey(key->asString())) return c.fail(p + ".key", "unknown menu key");
        menu.key = *parseMenuKey(key->asString());
        if (!parseSectors(c, m.get("convert"), p + ".convert", menu.convert)) return false;
        if (!parseSectors(c, m.get("tools"), p + ".tools", menu.tools)) return false;
        cfg.menus.push_back(std::move(menu));
    }

    const Value* strings = root.get("strings");
    if (!c.strictObject(strings, "strings", {"dropHint", "unsupported", "multiFileUnsupported", "fileCount"},
                        {"unsupportedFolder", "unsupportedNonFile", "unsupportedVirtual", "unsupportedCloud"})) {
        return false;
    }
    const auto optional = [&](const char* key, std::optional<std::string>& out) {
        const Value* v = strings->get(key);
        if (v == nullptr) return true;  // .optional(): absent is fine, null is not
        std::string text;
        if (!c.string(v, std::string("strings.") + key, 0, 60, text)) return false;
        out = std::move(text);
        return true;
    };
    return c.string(strings->get("dropHint"), "strings.dropHint", 0, 60, cfg.strings.dropHint) &&
           c.string(strings->get("unsupported"), "strings.unsupported", 0, 60, cfg.strings.unsupported) &&
           c.string(strings->get("multiFileUnsupported"), "strings.multiFileUnsupported", 0, 60,
                    cfg.strings.multiFileUnsupported) &&
           c.string(strings->get("fileCount"), "strings.fileCount", 0, 60, cfg.strings.fileCount) &&
           optional("unsupportedFolder", cfg.strings.unsupportedFolder) &&
           optional("unsupportedNonFile", cfg.strings.unsupportedNonFile) &&
           optional("unsupportedVirtual", cfg.strings.unsupportedVirtual) &&
           optional("unsupportedCloud", cfg.strings.unsupportedCloud);
}

ParseResult failWith(ParseErrorKind kind, std::string detail) {
    ParseResult r;
    r.failure.kind = kind;
    r.failure.detail = std::move(detail);
    return r;
}

}  // namespace

const char* errorCodeFor(ParseErrorKind k) {
    switch (k) {
        case ParseErrorKind::LineTooLong: return "lineTooLong";
        case ParseErrorKind::InvalidJson: return "invalidJson";
        case ParseErrorKind::NotAnObject: return "invalidMessage";
        case ParseErrorKind::UnsupportedVersion: return "protocolVersion";
        case ParseErrorKind::UnknownType: return "unknownType";
        case ParseErrorKind::InvalidMessage: return "invalidMessage";
    }
    return "invalidMessage";
}

ParseResult parseMainToHelper(std::string_view line) {
    if (line.size() > kMaxLineBytes) return failWith(ParseErrorKind::LineTooLong, "line exceeds HELPER_MAX_LINE_BYTES");
    json::Value root;
    json::ParseError jerr;
    if (!json::parse(line, root, jerr)) {
        return failWith(ParseErrorKind::InvalidJson, jerr.message + " at byte " + std::to_string(jerr.offset));
    }
    if (!root.isObject()) return failWith(ParseErrorKind::NotAnObject, "message is not a JSON object");

    const json::Value* type = root.get("type");
    if (type == nullptr || !type->isString()) return failWith(ParseErrorKind::InvalidMessage, "type: expected string");
    const std::string& t = type->asString();
    const bool known = t == "configure" || t == "cancelSession" || t == "ping" || t == "shutdown" || t == "queryPermissions";
    if (!known) return failWith(ParseErrorKind::UnknownType, "unknown message type");

    const json::Value* v = root.get("v");
    if (v == nullptr || !v->isNumber()) return failWith(ParseErrorKind::InvalidMessage, "v: expected number");
    if (v->asNumber() != kVersion) return failWith(ParseErrorKind::UnsupportedVersion, "unsupported protocol version");

    ParseResult result;
    Checker c(result.failure);
    if (t == "configure") {
        auto cfg = std::make_shared<Configure>();
        if (!parseConfigure(c, root, *cfg)) return result;
        result.message = MainToHelper(std::shared_ptr<const Configure>(std::move(cfg)));
    } else if (t == "cancelSession") {
        if (!c.strictObject(&root, "", {"v", "type", "sessionId"})) return result;
        CancelSession m;
        const json::Value* id = root.get("sessionId");
        if (!id->isString() || !isValidId(id->asString())) {
            c.fail("sessionId", "invalid id");
            return result;
        }
        m.sessionId = id->asString();
        result.message = MainToHelper(std::move(m));
    } else if (t == "ping") {
        if (!c.strictObject(&root, "", {"v", "type", "nonce"})) return result;
        Ping m;
        if (!c.integer(root.get("nonce"), "nonce", 0, kMaxSafeInteger, m.nonce)) return result;
        result.message = MainToHelper(m);
    } else if (t == "shutdown") {
        if (!c.strictObject(&root, "", {"v", "type"})) return result;
        result.message = MainToHelper(Shutdown{});
    } else {
        if (!c.strictObject(&root, "", {"v", "type"})) return result;
        result.message = MainToHelper(QueryPermissions{});
    }
    return result;
}

// ------------------------------------------------------------------ serializers

namespace {

void header(json::Writer& w, const char* type) {
    w.beginObject();
    w.key("v");
    w.integer(kVersion);
    w.key("type");
    w.str(type);
}

std::string finish(json::Writer& w) {
    w.endObject();
    if (!w.ok() || w.text().size() > kMaxLineBytes) return std::string();
    return w.take();
}

/** Diagnostic strings are cut to the schema's maximum (zod counts code points). */
std::string clip(std::string_view s, size_t maxCodePoints) {
    if (!utf::isValidUtf8(s)) return std::string();
    return utf::truncateToCodePoints(s, maxCodePoints);
}

}  // namespace

std::string serializeReady(const ReadyInfo& m) {
    if (m.pid <= 0 || m.pid > kMaxSafeInteger) return std::string();
    if (m.arch != "x64" && m.arch != "arm64") return std::string();
    json::Writer w;
    header(w, "ready");
    w.key("helperVersion");
    w.str(clip(m.helperVersion, 32));
    w.key("platform");
    w.str("win32");
    w.key("arch");
    w.str(m.arch);
    w.key("osVersion");
    w.str(clip(m.osVersion, 64));
    w.key("pid");
    w.integer(m.pid);
    w.key("globalDrag");
    w.beginObject();
    w.key("available");
    w.boolean(m.globalDragAvailable);
    if (!m.globalDragReason.empty()) {
        w.key("reason");
        w.str(clip(m.globalDragReason, 200));
    }
    w.endObject();
    return finish(w);
}

std::string serializeState(const StateMessage& m) {
    if (!isValidId(m.sessionId)) return std::string();
    json::Writer w;
    header(w, "state");
    w.key("sessionId");
    w.str(m.sessionId);
    w.key("state");
    w.str(toString(m.state));
    if (m.mode) {
        w.key("mode");
        w.str(toString(*m.mode));
    }
    if (m.hasMenuKey) {
        w.key("menuKey");
        if (m.menuKey) w.str(toString(*m.menuKey));
        else w.null();
    }
    if (m.fileCount) {
        int64_t n = *m.fileCount;
        if (n < 0) n = 0;
        if (n > 100000) n = 100000;
        w.key("fileCount");
        w.integer(n);
    }
    return finish(w);
}

std::string serializeDrop(const DropMessage& m) {
    if (!isValidId(m.sessionId)) return std::string();
    if (m.files.empty() || m.files.size() > kMaxFiles) return std::string();
    for (const std::string& f : m.files) {
        // zod: z.string().min(1).max(HELPER_MAX_PATH_LENGTH), measured in code points.
        const size_t length = utf::codePointLength(f);
        if (length == SIZE_MAX || length < 1 || length > kMaxPathLength) return std::string();
    }
    json::Writer w;
    header(w, "drop");
    w.key("sessionId");
    w.str(m.sessionId);
    w.key("actionId");
    w.str(toString(m.actionId));
    w.key("mode");
    w.str(toString(m.mode));
    w.key("files");
    w.beginArray();
    for (const std::string& f : m.files) w.str(f);
    w.endArray();
    w.key("dropEffect");
    w.str("copy");
    return finish(w);
}

std::string serializeCancelled(std::string_view sessionId, CancelReason reason) {
    if (!isValidId(sessionId)) return std::string();
    json::Writer w;
    header(w, "cancelled");
    w.key("sessionId");
    w.str(sessionId);
    w.key("reason");
    w.str(toString(reason));
    return finish(w);
}

std::string serializePong(int64_t nonce) {
    if (nonce < 0 || nonce > kMaxSafeInteger) return std::string();
    json::Writer w;
    header(w, "pong");
    w.key("nonce");
    w.integer(nonce);
    return finish(w);
}

std::string serializePermissions() {
    json::Writer w;
    header(w, "permissions");
    w.key("items");
    w.beginArray();
    w.endArray();
    return finish(w);
}

std::string serializeLog(LogLevel level, std::string_view message) {
    json::Writer w;
    header(w, "log");
    w.key("level");
    w.str(toString(level));
    w.key("message");
    w.str(clip(message, 2000));
    return finish(w);
}

std::string serializeError(std::string_view code, std::string_view message, bool fatal) {
    json::Writer w;
    header(w, "error");
    w.key("code");
    w.str(clip(code, 64));
    w.key("message");
    w.str(clip(message, 2000));
    w.key("fatal");
    w.boolean(fatal);
    return finish(w);
}

size_t estimateJsonStringBytes(std::string_view s) {
    size_t n = 2;  // quotes
    for (const char ch : s) {
        const auto c = static_cast<unsigned char>(ch);
        if (c == '"' || c == '\\' || c == '\b' || c == '\f' || c == '\n' || c == '\r' || c == '\t') n += 2;
        else if (c < 0x20) n += 6;
        else n += 1;
    }
    return n;
}

}  // namespace od::proto
