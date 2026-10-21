// Helper protocol v1 (packages/contracts/src/helper-protocol.ts), C++ side.
//
// Transport: UTF-8 JSON objects, one per line, main → helper on stdin and
// helper → main on stdout. Every field and limit below mirrors the zod schema
// in the contract; keep them in sync (tests/test_protocol.cpp pins them).
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "core/geometry.h"

namespace od::proto {

constexpr int kVersion = 1;                     // HELPER_PROTOCOL_VERSION
constexpr size_t kMaxLineBytes = 1048576;       // HELPER_MAX_LINE_BYTES
constexpr size_t kMaxFiles = 200;               // HELPER_MAX_FILES
constexpr size_t kMaxPathLength = 32767;        // HELPER_MAX_PATH_LENGTH (zod: code points; Windows: UTF-16 units)
constexpr int64_t kMaxSafeInteger = 9007199254740991LL;  // Number.MAX_SAFE_INTEGER (zod .int())

// ------------------------------------------------------------------ enums

enum class ActionId : uint8_t {
    ConvertJpeg, ConvertPng, ConvertWebp, ConvertHeic, ConvertTiff, ConvertAvif, ConvertBmp, ConvertPdf,
    ConvertDocx, ConvertTxt, ToolCompress, ToolMetadata, ToolEdit, ToolAnnotate, ToolAddBackground, ToolCrop,
    ToolRedact,
};
constexpr size_t kActionCount = 17;

enum class IconId : uint8_t { Compress, Metadata, Edit, Annotate, Background, Crop, Redact };
constexpr size_t kIconCount = 7;

enum class WheelMode : uint8_t { Convert, Tools };
enum class Locale : uint8_t { Ko, En };

/** contracts/menus.ts MENU_KEYS order. */
enum class MenuKey : uint8_t {
    Pdf, ImageJpeg, ImagePng, ImageWebp, ImageGif, ImageTiff, ImageAvif, ImageHeic, ImageBmp, Images, Mixed,
};
constexpr size_t kMenuKeyCount = 11;

/** contracts/formats.ts IMAGE_FORMATS order. */
enum class ImageFormat : uint8_t { Jpeg, Png, Webp, Gif, Tiff, Avif, Heic, Bmp };
constexpr size_t kImageFormatCount = 8;

/** Modifier bit set (contracts ModifierKeySchema; 'command' = Windows key on Windows). */
enum ModifierBits : uint8_t { kModShift = 1, kModAlt = 2, kModControl = 4, kModCommand = 8 };

enum class SessionState : uint8_t { PotentialDrag, AwaitingPayload, WheelActive, Idle };

enum class CancelReason : uint8_t {
    Escape, DragEnded, InvalidPayload, OutsideRing, DisabledSector, ParentRequest, Sleep, PermissionLost, Error,
};

enum class LogLevel : uint8_t { Debug, Info, Warn, Error };

const char* toString(ActionId v);
const char* toString(IconId v);
const char* toString(WheelMode v);
const char* toString(Locale v);
const char* toString(MenuKey v);
const char* toString(ImageFormat v);
const char* toString(SessionState v);
const char* toString(CancelReason v);
const char* toString(LogLevel v);

std::optional<ActionId> parseActionId(std::string_view s);
std::optional<IconId> parseIconId(std::string_view s);
std::optional<WheelMode> parseWheelMode(std::string_view s);
std::optional<Locale> parseLocale(std::string_view s);
std::optional<MenuKey> parseMenuKey(std::string_view s);
std::optional<ImageFormat> parseImageFormat(std::string_view s);

/** 'image/<fmt>' menu key for an image format, and the inverse (nullopt for pdf/images/mixed). */
MenuKey menuKeyForImage(ImageFormat f);
std::optional<ImageFormat> imageFormatOfKey(MenuKey k);

/** Short format label ("PDF", "JPG", …) of a single-format menu key (contracts FORMAT_INFO labels); "" otherwise. */
const char* formatLabelOfKey(MenuKey k);

/** contracts schemas.ts `Id`: ^[A-Za-z0-9_-]{1,64}$ */
bool isValidId(std::string_view s);

// ------------------------------------------------------------------ configure

struct Color {
    uint8_t r = 0, g = 0, b = 0, a = 255;
    bool operator==(const Color& o) const { return r == o.r && g == o.g && b == o.b && a == o.a; }
};
/** #RRGGBB or #RRGGBBAA (contracts ColorHex8). */
std::optional<Color> parseColor(std::string_view s);

struct WheelTokens {
    Color wheelDisc, wheelRing, wheelShadow, sector, sectorHover, sectorText, sectorIcon, sectorDisabled,
        sectorDisabledText, sectorActive, sectorActiveText, capsule, capsuleText, capsuleReject;
    double labelSize = 15;
    int labelWeight = 700;
    double iconSize = 20;
    double capsuleTextSize = 16;
    double appearMs = 140;
    double disappearMs = 90;
};

struct WheelSector {
    ActionId actionId = ActionId::ConvertJpeg;
    std::string label;
    std::optional<IconId> icon;
    bool enabled = false;
    std::optional<std::string> reason;
    bool batch = false;
};

struct HelperMenu {
    MenuKey key = MenuKey::Pdf;
    std::vector<WheelSector> convert;
    std::vector<WheelSector> tools;
    const std::vector<WheelSector>& sectors(WheelMode m) const { return m == WheelMode::Convert ? convert : tools; }
};

struct Strings {
    std::string dropHint;
    std::string unsupported;
    std::string multiFileUnsupported;
    std::string fileCount;
    // Optional, more specific centre texts; fall back to `unsupported` when absent.
    std::optional<std::string> unsupportedFolder;   // a folder is part of the drag
    std::optional<std::string> unsupportedNonFile;  // text, URL or other non-file data
    std::optional<std::string> unsupportedVirtual;  // virtual items without a file on disk
};

struct Configure {
    bool enabled = false;
    Locale locale = Locale::Ko;
    geo::WheelGeometry geometry = geo::kDefaultGeometry;
    WheelTokens tokens;
    bool reduceMotion = false;
    bool highContrast = false;
    uint8_t convertModifiers = kModShift;
    uint8_t toolsModifiers = kModAlt | kModShift;
    /** Lower-case extension with dot → menu key, in message order. */
    std::vector<std::pair<std::string, MenuKey>> extensions;
    std::vector<HelperMenu> menus;
    Strings strings;

    const HelperMenu* findMenu(MenuKey k) const;
    std::optional<MenuKey> lookupExtension(std::string_view ext) const;
};

// ------------------------------------------------------------------ main → helper

struct CancelSession {
    std::string sessionId;
};
struct Ping {
    int64_t nonce = 0;
};
struct Shutdown {};
struct QueryPermissions {};

using MainToHelper = std::variant<std::shared_ptr<const Configure>, CancelSession, Ping, Shutdown, QueryPermissions>;

enum class ParseErrorKind : uint8_t {
    LineTooLong,      // > kMaxLineBytes
    InvalidJson,      // not JSON / not UTF-8
    NotAnObject,
    UnsupportedVersion,
    UnknownType,
    InvalidMessage,   // wrong/missing/unknown field
};

struct ParseFailure {
    ParseErrorKind kind = ParseErrorKind::InvalidMessage;
    /** Field path or reason; never contains message contents. */
    std::string detail;
};

struct ParseResult {
    std::optional<MainToHelper> message;
    ParseFailure failure;
    bool ok() const { return message.has_value(); }
};

/** Parses and validates one line (without the trailing '\n'). */
ParseResult parseMainToHelper(std::string_view line);

/** Error code string reported to main for a parse failure ('lineTooLong', 'invalidJson', …). */
const char* errorCodeFor(ParseErrorKind k);

// ------------------------------------------------------------------ helper → main

struct ReadyInfo {
    std::string helperVersion;   // ≤ 32
    std::string arch;            // 'x64' | 'arm64'
    std::string osVersion;       // ≤ 64
    int64_t pid = 1;
    bool globalDragAvailable = true;
    std::string globalDragReason;  // ≤ 200, omitted when empty
};

struct StateMessage {
    std::string sessionId;
    SessionState state = SessionState::Idle;
    std::optional<WheelMode> mode;
    bool hasMenuKey = false;           // field present?
    std::optional<MenuKey> menuKey;    // null when present but unsupported
    std::optional<int64_t> fileCount;  // 0..100000
};

struct DropMessage {
    std::string sessionId;
    ActionId actionId = ActionId::ConvertJpeg;
    WheelMode mode = WheelMode::Convert;
    std::vector<std::string> files;  // UTF-8 absolute paths
};

/** Each serializer returns the JSON text without the trailing newline, or an
 *  empty string when the message would violate the contract (caller must not
 *  send it). Strings that only carry diagnostics are truncated instead. */
std::string serializeReady(const ReadyInfo& m);
std::string serializeState(const StateMessage& m);
std::string serializeDrop(const DropMessage& m);
std::string serializeCancelled(std::string_view sessionId, CancelReason reason);
std::string serializePong(int64_t nonce);
std::string serializePermissions();
std::string serializeLog(LogLevel level, std::string_view message);
std::string serializeError(std::string_view code, std::string_view message, bool fatal);

/** Upper bound of the serialized size of a drop message's file list, used to
 *  reject payloads that could never be sent within kMaxLineBytes. */
size_t estimateJsonStringBytes(std::string_view s);

}  // namespace od::proto
