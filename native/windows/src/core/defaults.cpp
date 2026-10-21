#include "core/defaults.h"

#include <array>
#include <vector>

#include "core/json.h"

namespace od::defaults {

using proto::ActionId;
using proto::Color;

namespace {

Color c(const char* hex) { return *proto::parseColor(hex); }

struct ActionInfo {
    ActionId id;
    const char* ko;
    const char* en;
    std::optional<proto::IconId> icon;
    bool batch;
};

// contracts/actions.ts ACTIONS (wheelLabel, icon, batch).
const ActionInfo& info(ActionId id) {
    static const std::array<ActionInfo, proto::kActionCount> table = {{
        {ActionId::ConvertJpeg, "JPG", "JPG", std::nullopt, true},
        {ActionId::ConvertPng, "PNG", "PNG", std::nullopt, true},
        {ActionId::ConvertWebp, "WEBP", "WEBP", std::nullopt, true},
        {ActionId::ConvertHeic, "HEIC", "HEIC", std::nullopt, true},
        {ActionId::ConvertTiff, "TIFF", "TIFF", std::nullopt, true},
        {ActionId::ConvertAvif, "AVIF", "AVIF", std::nullopt, true},
        {ActionId::ConvertBmp, "BMP", "BMP", std::nullopt, true},
        {ActionId::ConvertPdf, "PDF", "PDF", std::nullopt, true},
        {ActionId::ConvertDocx, "DOCX", "DOCX", std::nullopt, true},
        {ActionId::ConvertTxt, "TXT", "TXT", std::nullopt, true},
        {ActionId::ToolCompress, "\xEC\x95\x95\xEC\xB6\x95", "COMPRESS", proto::IconId::Compress, true},
        {ActionId::ToolMetadata, "\xEB\xA9\x94\xED\x83\x80\xEB\x8D\xB0\xEC\x9D\xB4\xED\x84\xB0", "METADATA",
         proto::IconId::Metadata, true},
        {ActionId::ToolEdit, "\xED\x8E\xB8\xEC\xA7\x91", "EDIT", proto::IconId::Edit, false},
        {ActionId::ToolAnnotate, "\xEC\xA3\xBC\xEC\x84\x9D", "ANNOTATE", proto::IconId::Annotate, false},
        {ActionId::ToolAddBackground, "\xEB\xB0\xB0\xEA\xB2\xBD \xEC\xB6\x94\xEA\xB0\x80", "ADD BG",
         proto::IconId::Background, false},
        {ActionId::ToolCrop, "\xEC\x9E\x90\xEB\xA5\xB4\xEA\xB8\xB0", "CROP", proto::IconId::Crop, false},
        {ActionId::ToolRedact, "\xEA\xB0\x80\xEB\xA6\xAC\xEA\xB8\xB0", "REDACT", proto::IconId::Redact, false},
    }};
    return table[static_cast<size_t>(id)];
}

const std::vector<ActionId> kPdfConvert = {ActionId::ConvertDocx, ActionId::ConvertJpeg, ActionId::ConvertPng,
                                           ActionId::ConvertTxt};
const std::vector<ActionId> kImageConvert = {ActionId::ConvertJpeg, ActionId::ConvertPng,  ActionId::ConvertWebp,
                                             ActionId::ConvertHeic, ActionId::ConvertTiff, ActionId::ConvertAvif,
                                             ActionId::ConvertBmp,  ActionId::ConvertPdf,  ActionId::ConvertDocx};
const std::vector<ActionId> kImageTools = {ActionId::ToolCompress, ActionId::ToolMetadata, ActionId::ToolEdit,
                                           ActionId::ToolAnnotate, ActionId::ToolAddBackground, ActionId::ToolCrop,
                                           ActionId::ToolRedact};
// PDF order filtered to actions accepting both PDF and image input (menus.ts baseMenuOrder 'mixed').
const std::vector<ActionId> kMixedConvert = {ActionId::ConvertDocx, ActionId::ConvertJpeg, ActionId::ConvertPng};

std::vector<proto::WheelSector> sectors(const std::vector<ActionId>& ids, proto::Locale locale) {
    std::vector<proto::WheelSector> out;
    for (ActionId id : ids) {
        const ActionInfo& a = info(id);
        proto::WheelSector s;
        s.actionId = id;
        s.label = locale == proto::Locale::Ko ? a.ko : a.en;
        s.icon = a.icon;
        s.enabled = true;
        s.batch = a.batch;
        out.push_back(std::move(s));
    }
    return out;
}

std::optional<ActionId> convertActionFor(proto::ImageFormat f) {
    switch (f) {
        case proto::ImageFormat::Jpeg: return ActionId::ConvertJpeg;
        case proto::ImageFormat::Png: return ActionId::ConvertPng;
        case proto::ImageFormat::Webp: return ActionId::ConvertWebp;
        case proto::ImageFormat::Heic: return ActionId::ConvertHeic;
        case proto::ImageFormat::Tiff: return ActionId::ConvertTiff;
        case proto::ImageFormat::Avif: return ActionId::ConvertAvif;
        case proto::ImageFormat::Bmp: return ActionId::ConvertBmp;
        case proto::ImageFormat::Gif: return std::nullopt;
    }
    return std::nullopt;
}

void writeColor(json::Writer& w, const char* key, const Color& col) {
    static const char* hex = "0123456789ABCDEF";
    std::string s = "#";
    const uint8_t bytes[4] = {col.r, col.g, col.b, col.a};
    for (uint8_t b : bytes) {
        s.push_back(hex[b >> 4]);
        s.push_back(hex[b & 15]);
    }
    w.key(key);
    w.str(s);
}

void writeCombo(json::Writer& w, const char* key, uint8_t bits) {
    w.key(key);
    w.beginArray();
    if (bits & proto::kModAlt) w.str("alt");
    if (bits & proto::kModShift) w.str("shift");
    if (bits & proto::kModControl) w.str("control");
    if (bits & proto::kModCommand) w.str("command");
    w.endArray();
}

void writeSectors(json::Writer& w, const char* key, const std::vector<proto::WheelSector>& list) {
    w.key(key);
    w.beginArray();
    for (const proto::WheelSector& s : list) {
        w.beginObject();
        w.key("actionId");
        w.str(proto::toString(s.actionId));
        w.key("label");
        w.str(s.label);
        w.key("icon");
        if (s.icon) w.str(proto::toString(*s.icon));
        else w.null();
        w.key("enabled");
        w.boolean(s.enabled);
        if (s.reason) {
            w.key("reason");
            w.str(*s.reason);
        }
        w.key("batch");
        w.boolean(s.batch);
        w.endObject();
    }
    w.endArray();
}

}  // namespace

proto::WheelTokens tokens(Theme theme, bool reduceMotion) {
    proto::WheelTokens t;
    switch (theme) {
        case Theme::Light:
            t.wheelDisc = c("#FFF3E6B8");
            t.wheelRing = c("#FFFFFFD9");
            t.wheelShadow = c("#7A2E0040");
            t.sector = c("#FCE4CCF2");
            t.sectorHover = c("#FFD9B8F7");
            t.sectorText = c("#3B2A1E");
            t.sectorIcon = c("#4A3426");
            t.sectorDisabled = c("#F1E5DAD9");
            t.sectorDisabledText = c("#A8978A");
            t.sectorActive = c("#D4441C");  // WCAG AA for white bold labels (contracts design-tokens.json)
            t.sectorActiveText = c("#FFFFFF");
            t.capsule = c("#F7B98AF2");
            t.capsuleText = c("#3B2A1E");
            t.capsuleReject = c("#E9D9CCF2");
            break;
        case Theme::Dark:
            t.wheelDisc = c("#2C211BCC");
            t.wheelRing = c("#FFFFFF59");
            t.wheelShadow = c("#00000066");
            t.sector = c("#4A372BF2");
            t.sectorHover = c("#5C4434F7");
            t.sectorText = c("#FCE8D8");
            t.sectorIcon = c("#FCE8D8");
            t.sectorDisabled = c("#3A2E27D9");
            t.sectorDisabledText = c("#8C7A6D");
            t.sectorActive = c("#FF6A3D");
            t.sectorActiveText = c("#1E120B");
            t.capsule = c("#7A4A2EF2");
            t.capsuleText = c("#FFF1E6");
            t.capsuleReject = c("#3A2E27F2");
            break;
        case Theme::HighContrast:
            t.wheelDisc = c("#FFFFFFFF");
            t.wheelRing = c("#000000FF");
            t.wheelShadow = c("#00000000");
            t.sector = c("#FFFFFFFF");
            t.sectorHover = c("#FFE7D6FF");
            t.sectorText = c("#000000");
            t.sectorIcon = c("#000000");
            t.sectorDisabled = c("#E6E6E6FF");
            t.sectorDisabledText = c("#595959");
            t.sectorActive = c("#B33000");
            t.sectorActiveText = c("#FFFFFF");
            t.capsule = c("#000000FF");
            t.capsuleText = c("#FFFFFF");
            t.capsuleReject = c("#595959FF");
            break;
    }
    t.labelSize = 15;
    t.labelWeight = 700;
    t.iconSize = 20;
    t.capsuleTextSize = 16;
    t.appearMs = reduceMotion ? 0 : 140;
    t.disappearMs = reduceMotion ? 0 : 90;
    return t;
}

std::shared_ptr<proto::Configure> referenceConfigure(proto::Locale locale, Theme theme) {
    auto cfg = std::make_shared<proto::Configure>();
    cfg->enabled = true;
    cfg->locale = locale;
    cfg->geometry = geo::kDefaultGeometry;
    cfg->tokens = tokens(theme);
    cfg->highContrast = theme == Theme::HighContrast;
    cfg->convertModifiers = proto::kModShift;
    cfg->toolsModifiers = proto::kModAlt | proto::kModShift;

    // contracts/formats.ts FORMAT_INFO extensions of the readable input formats.
    const std::vector<std::pair<const char*, proto::MenuKey>> exts = {
        {".jpg", proto::MenuKey::ImageJpeg},  {".jpeg", proto::MenuKey::ImageJpeg}, {".jpe", proto::MenuKey::ImageJpeg},
        {".jfif", proto::MenuKey::ImageJpeg}, {".png", proto::MenuKey::ImagePng},   {".webp", proto::MenuKey::ImageWebp},
        {".gif", proto::MenuKey::ImageGif},   {".tif", proto::MenuKey::ImageTiff},  {".tiff", proto::MenuKey::ImageTiff},
        {".avif", proto::MenuKey::ImageAvif}, {".heic", proto::MenuKey::ImageHeic}, {".heif", proto::MenuKey::ImageHeic},
        {".hif", proto::MenuKey::ImageHeic},  {".bmp", proto::MenuKey::ImageBmp},   {".dib", proto::MenuKey::ImageBmp},
        {".pdf", proto::MenuKey::Pdf},
    };
    for (const auto& [e, k] : exts) cfg->extensions.emplace_back(e, k);

    for (size_t i = 0; i < proto::kMenuKeyCount; ++i) {
        const auto key = static_cast<proto::MenuKey>(i);
        proto::HelperMenu menu;
        menu.key = key;
        if (key == proto::MenuKey::Pdf) {
            menu.convert = sectors(kPdfConvert, locale);
        } else if (key == proto::MenuKey::Mixed) {
            menu.convert = sectors(kMixedConvert, locale);
        } else if (key == proto::MenuKey::Images) {
            menu.convert = sectors(kImageConvert, locale);
            menu.tools = sectors(kImageTools, locale);
        } else {
            const auto fmt = proto::imageFormatOfKey(key);
            const auto own = fmt ? convertActionFor(*fmt) : std::nullopt;
            std::vector<ActionId> order;
            for (ActionId id : kImageConvert) {
                if (!own || id != *own) order.push_back(id);
            }
            menu.convert = sectors(order, locale);
            menu.tools = sectors(kImageTools, locale);
        }
        cfg->menus.push_back(std::move(menu));
    }

    if (locale == proto::Locale::Ko) {
        cfg->strings.dropHint = "\xEC\x97\xAC\xEA\xB8\xB0\xEC\x97\x90 \xEB\x86\x93\xEA\xB8\xB0";  // 여기에 놓기
        cfg->strings.unsupported = "\xEC\xA7\x80\xEC\x9B\x90\xED\x95\x98\xEC\xA7\x80 \xEC\x95\x8A\xEB\x8A\x94 \xED\x98\x95\xEC\x8B\x9D";  // 지원하지 않는 형식
        cfg->strings.multiFileUnsupported = "\xED\x95\x9C \xEB\xB2\x88\xEC\x97\x90 \xED\x95\x9C \xED\x8C\x8C\xEC\x9D\xBC\xEB\xA7\x8C";  // 한 번에 한 파일만
        cfg->strings.fileCount = "\xED\x8C\x8C\xEC\x9D\xBC {n}\xEA\xB0\x9C";  // 파일 {n}개
    } else {
        cfg->strings.dropHint = "Drop here";
        cfg->strings.unsupported = "Not supported";
        cfg->strings.multiFileUnsupported = "One file at a time";
        cfg->strings.fileCount = "{n} files";
    }
    return cfg;
}

std::string configureToJson(const proto::Configure& cfg) {
    json::Writer w;
    w.beginObject();
    w.key("v");
    w.integer(proto::kVersion);
    w.key("type");
    w.str("configure");
    w.key("enabled");
    w.boolean(cfg.enabled);
    w.key("locale");
    w.str(proto::toString(cfg.locale));
    const geo::WheelGeometry& g = cfg.geometry;
    w.key("geometry");
    w.beginObject();
    const std::pair<const char*, double> geom[] = {
        {"diameter", g.diameter},         {"minDiameter", g.minDiameter},
        {"ringWidth", g.ringWidth},       {"ringInset", g.ringInset},
        {"innerRadiusRatio", g.innerRadiusRatio}, {"sectorGap", g.sectorGap},
        {"sectorCornerRadius", g.sectorCornerRadius}, {"capsuleWidth", g.capsuleWidth},
        {"capsuleHeight", g.capsuleHeight}, {"startAngleDeg", g.startAngleDeg},
        {"windowMargin", g.windowMargin}, {"edgePadding", g.edgePadding},
        {"armDistance", g.armDistance},
    };
    for (const auto& [k, v] : geom) {
        w.key(k);
        w.number(v);
    }
    w.endObject();
    const proto::WheelTokens& t = cfg.tokens;
    w.key("tokens");
    w.beginObject();
    writeColor(w, "wheelDisc", t.wheelDisc);
    writeColor(w, "wheelRing", t.wheelRing);
    writeColor(w, "wheelShadow", t.wheelShadow);
    writeColor(w, "sector", t.sector);
    writeColor(w, "sectorHover", t.sectorHover);
    writeColor(w, "sectorText", t.sectorText);
    writeColor(w, "sectorIcon", t.sectorIcon);
    writeColor(w, "sectorDisabled", t.sectorDisabled);
    writeColor(w, "sectorDisabledText", t.sectorDisabledText);
    writeColor(w, "sectorActive", t.sectorActive);
    writeColor(w, "sectorActiveText", t.sectorActiveText);
    writeColor(w, "capsule", t.capsule);
    writeColor(w, "capsuleText", t.capsuleText);
    writeColor(w, "capsuleReject", t.capsuleReject);
    w.key("labelSize");
    w.number(t.labelSize);
    w.key("labelWeight");
    w.integer(t.labelWeight);
    w.key("iconSize");
    w.number(t.iconSize);
    w.key("capsuleTextSize");
    w.number(t.capsuleTextSize);
    w.key("appearMs");
    w.number(t.appearMs);
    w.key("disappearMs");
    w.number(t.disappearMs);
    w.endObject();
    w.key("reduceMotion");
    w.boolean(cfg.reduceMotion);
    w.key("highContrast");
    w.boolean(cfg.highContrast);
    w.key("modifiers");
    w.beginObject();
    writeCombo(w, "convert", cfg.convertModifiers);
    writeCombo(w, "tools", cfg.toolsModifiers);
    w.endObject();
    w.key("extensions");
    w.beginObject();
    for (const auto& [e, k] : cfg.extensions) {
        w.key(e);
        w.str(proto::toString(k));
    }
    w.endObject();
    w.key("menus");
    w.beginArray();
    for (const proto::HelperMenu& m : cfg.menus) {
        w.beginObject();
        w.key("key");
        w.str(proto::toString(m.key));
        writeSectors(w, "convert", m.convert);
        writeSectors(w, "tools", m.tools);
        w.endObject();
    }
    w.endArray();
    w.key("strings");
    w.beginObject();
    w.key("dropHint");
    w.str(cfg.strings.dropHint);
    w.key("unsupported");
    w.str(cfg.strings.unsupported);
    w.key("multiFileUnsupported");
    w.str(cfg.strings.multiFileUnsupported);
    w.key("fileCount");
    w.str(cfg.strings.fileCount);
    w.endObject();
    w.endObject();
    return w.take();
}

}  // namespace od::defaults
