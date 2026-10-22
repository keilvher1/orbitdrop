// Port of the path classification in packages/core/src/selection.ts
// (fileNameOfPath, extensionOfPath, formatOfSingleFileKey, menuKeyForPaths)
// plus contracts/menus.ts menuKeyFor, and the helper-side payload checks that
// decide whether a drag can be offered at all.
//
// Paths are UTF-8. Every rule only looks at ASCII characters ('/', '\\', '.',
// 'A'-'Z'), so byte-wise processing of UTF-8 gives exactly the results of the
// reference's UTF-16 string operations.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "core/protocol.h"

namespace od::selection {

/** Last path component; '/' and '\\' both separate; trailing separators ignored. */
std::string_view fileNameOfPath(std::string_view path);

/** ASCII-only lower-casing. */
std::string asciiLower(std::string_view text);

/** Lower-cased (ASCII) extension including the dot; "" for no dot, a leading dot only, or a trailing dot. */
std::string extensionOfPath(std::string_view path);

/** The format named by a single-file menu key ('pdf' | 'image/<fmt>'). */
enum class SingleFormat { None, Pdf, Image };
struct FormatOfKey {
    SingleFormat kind = SingleFormat::None;
    proto::ImageFormat image = proto::ImageFormat::Jpeg;
};
FormatOfKey formatOfSingleFileKey(std::string_view key);

/** contracts menuKeyFor over already-resolved single-file formats (nullopt entries = unknown). */
std::optional<proto::MenuKey> menuKeyFor(const std::vector<FormatOfKey>& formats);

/**
 * Menu key for dragged paths using the configure `extensions` map, exactly as
 * selection.ts menuKeyForPaths: empty list, empty path, a path ending in a
 * separator, an unknown extension or a map value that is not 'pdf' /
 * 'image/<fmt>' → nullopt.
 */
std::optional<proto::MenuKey> menuKeyForPaths(const std::vector<std::string>& paths,
                                              const std::vector<std::pair<std::string, std::string>>& extensionMap);

/** Same, with the typed map of a validated configure message. */
std::optional<proto::MenuKey> menuKeyForPaths(const std::vector<std::string>& paths, const proto::Configure& cfg);

// ------------------------------------------------------------------ drag payload

/** What the drop target could read from the OS drag data (owned copies). */
struct DragPayload {
    /** CF_HDROP was present and readable. */
    bool hasFileList = false;
    /** Only virtual files (CFSTR_FILEDESCRIPTORW, e.g. mail attachments, zip contents) were offered. */
    bool virtualFilesOnly = false;
    /** Number of entries in the file list (may exceed paths.size() when too many). */
    size_t totalCount = 0;
    /** UTF-8 paths, in drag order (empty when totalCount > kMaxFiles). */
    std::vector<std::string> paths;
    /** A path could not be represented (unpaired UTF-16 surrogate) or was empty/too long. */
    bool badPath = false;
    /** At least one entry is known to be a directory (checked on local fixed drives only). */
    bool containsDirectory = false;
};

enum class Unsupported {
    None,
    NoFiles,           // not a file drag (text, URL, …)
    VirtualFiles,      // virtual files only
    TooManyFiles,      // > HELPER_MAX_FILES
    BadPath,           // unrepresentable / empty / too long path
    Directory,         // a folder is part of the selection
    UnknownType,       // menuKeyForPaths → null
    PayloadTooLarge,   // the drop message would exceed HELPER_MAX_LINE_BYTES
    NoMenu,            // configure has no menu for the key
    CloudPlaceholder,  // a file's content is not on this machine yet (cloud-only placeholder)
};

const char* toString(Unsupported u);

struct Classification {
    bool supported = false;
    Unsupported reason = Unsupported::NoFiles;
    std::optional<proto::MenuKey> menuKey;  // set whenever the paths classify, even if NoMenu
    size_t fileCount = 0;
};

/** Full helper-side classification of a payload against a configuration. */
Classification classify(const DragPayload& payload, const proto::Configure& cfg);

/** contracts adjustMenuForFileCount: non-batch enabled sectors are disabled for multi-file drags. */
std::vector<proto::WheelSector> adjustForFileCount(const std::vector<proto::WheelSector>& sectors, size_t fileCount,
                                                   const std::string& multiFileReason);

// ------------------------------------------------------------------ file-system metadata (worker thread)

/**
 * What the dragged paths' attributes say. Read with GetFileAttributesW off the
 * UI thread after DragEnter: metadata only, no file data is read, so a cloud
 * placeholder is never downloaded ("hydrated") by the check.
 */
struct PathFacts {
    /** At least one path is a folder. */
    bool containsDirectory = false;
    /** At least one file's content is not on this machine yet (OneDrive/Dropbox
     *  Files On-Demand online-only file, or an offline HSM file). Reading it would
     *  download it first; P0 accepts local files only. */
    bool containsCloudPlaceholder = false;
};

/** winnt.h attribute values used below (the core has no Windows headers). */
constexpr uint32_t kFileAttributeDirectory = 0x00000010;
constexpr uint32_t kFileAttributeOffline = 0x00001000;
constexpr uint32_t kFileAttributeRecallOnDataAccess = 0x00400000;
constexpr uint32_t kInvalidFileAttributes = 0xFFFFFFFF;

/**
 * Folds one path's GetFileAttributesW result into `facts`. Unknown attributes
 * (kInvalidFileAttributes: gone, no access) count as neither — main validates
 * every dropped path anyway. FILE_ATTRIBUTE_RECALL_ON_OPEN (0x40000) is not
 * used: it only appears in directory enumeration classes, and GetFileAttributesW
 * would report the same bit for FILE_ATTRIBUTE_EA (a file with extended attributes).
 */
void addFileAttributes(PathFacts& facts, uint32_t attributes);

}  // namespace od::selection
