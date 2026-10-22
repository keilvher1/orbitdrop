#include "core/selection.h"

#include <array>

namespace od::selection {

namespace {
inline bool isSeparator(char c) { return c == '/' || c == '\\'; }
}  // namespace

std::string_view fileNameOfPath(std::string_view path) {
    size_t end = path.size();
    while (end > 0 && isSeparator(path[end - 1])) --end;
    const std::string_view trimmed = path.substr(0, end);
    size_t start = trimmed.size();
    while (start > 0 && !isSeparator(trimmed[start - 1])) --start;
    return trimmed.substr(start);
}

std::string asciiLower(std::string_view text) {
    std::string out(text);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
    }
    return out;
}

std::string extensionOfPath(std::string_view path) {
    const std::string_view name = fileNameOfPath(path);
    const size_t dot = name.rfind('.');
    if (dot == std::string_view::npos || dot == 0 || dot == name.size() - 1) return std::string();
    return asciiLower(name.substr(dot));
}

FormatOfKey formatOfSingleFileKey(std::string_view key) {
    FormatOfKey r;
    if (key == "pdf") {
        r.kind = SingleFormat::Pdf;
        return r;
    }
    constexpr std::string_view prefix = "image/";
    if (key.substr(0, prefix.size()) == prefix) {
        const auto f = proto::parseImageFormat(key.substr(prefix.size()));
        if (f) {
            r.kind = SingleFormat::Image;
            r.image = *f;
        }
    }
    return r;
}

std::optional<proto::MenuKey> menuKeyFor(const std::vector<FormatOfKey>& formats) {
    if (formats.empty()) return std::nullopt;
    size_t pdf = 0;
    std::array<bool, proto::kImageFormatCount> seen{};
    size_t distinctImages = 0;
    proto::ImageFormat lastImage = proto::ImageFormat::Jpeg;
    for (const FormatOfKey& f : formats) {
        if (f.kind == SingleFormat::None) return std::nullopt;
        if (f.kind == SingleFormat::Pdf) {
            ++pdf;
            continue;
        }
        const auto i = static_cast<size_t>(f.image);
        if (!seen[i]) {
            seen[i] = true;
            ++distinctImages;
            lastImage = f.image;
        }
    }
    if (pdf > 0 && distinctImages > 0) return proto::MenuKey::Mixed;
    if (pdf > 0) return proto::MenuKey::Pdf;
    if (distinctImages == 1) return proto::menuKeyForImage(lastImage);
    return proto::MenuKey::Images;
}

namespace {

template <typename Lookup>
std::optional<proto::MenuKey> menuKeyForPathsImpl(const std::vector<std::string>& paths, Lookup lookup) {
    if (paths.empty()) return std::nullopt;
    std::vector<FormatOfKey> formats;
    formats.reserve(paths.size());
    for (const std::string& path : paths) {
        if (path.empty() || isSeparator(path.back())) return std::nullopt;
        const std::string ext = extensionOfPath(path);
        if (ext.empty()) return std::nullopt;
        const std::optional<std::string_view> key = lookup(ext);
        if (!key) return std::nullopt;
        const FormatOfKey f = formatOfSingleFileKey(*key);
        if (f.kind == SingleFormat::None) return std::nullopt;
        formats.push_back(f);
    }
    return menuKeyFor(formats);
}

}  // namespace

std::optional<proto::MenuKey> menuKeyForPaths(const std::vector<std::string>& paths,
                                              const std::vector<std::pair<std::string, std::string>>& extensionMap) {
    return menuKeyForPathsImpl(paths, [&](const std::string& ext) -> std::optional<std::string_view> {
        // Object.hasOwn semantics on a JSON object: last occurrence would win in
        // JS; maps here come from validated JSON without duplicate keys.
        for (auto it = extensionMap.rbegin(); it != extensionMap.rend(); ++it) {
            if (it->first == ext) return std::string_view(it->second);
        }
        return std::nullopt;
    });
}

std::optional<proto::MenuKey> menuKeyForPaths(const std::vector<std::string>& paths, const proto::Configure& cfg) {
    return menuKeyForPathsImpl(paths, [&](const std::string& ext) -> std::optional<std::string_view> {
        const auto key = cfg.lookupExtension(ext);
        if (!key) return std::nullopt;
        return std::string_view(proto::toString(*key));
    });
}

const char* toString(Unsupported u) {
    switch (u) {
        case Unsupported::None: return "none";
        case Unsupported::NoFiles: return "noFiles";
        case Unsupported::VirtualFiles: return "virtualFiles";
        case Unsupported::TooManyFiles: return "tooManyFiles";
        case Unsupported::BadPath: return "badPath";
        case Unsupported::Directory: return "directory";
        case Unsupported::UnknownType: return "unknownType";
        case Unsupported::PayloadTooLarge: return "payloadTooLarge";
        case Unsupported::NoMenu: return "noMenu";
        case Unsupported::CloudPlaceholder: return "cloudPlaceholder";
    }
    return "unknown";
}

Classification classify(const DragPayload& payload, const proto::Configure& cfg) {
    Classification c;
    c.fileCount = payload.totalCount;
    if (!payload.hasFileList) {
        c.reason = payload.virtualFilesOnly ? Unsupported::VirtualFiles : Unsupported::NoFiles;
        return c;
    }
    if (payload.totalCount == 0) {
        c.reason = Unsupported::NoFiles;
        return c;
    }
    if (payload.totalCount > proto::kMaxFiles) {
        c.reason = Unsupported::TooManyFiles;
        return c;
    }
    if (payload.badPath || payload.paths.size() != payload.totalCount) {
        c.reason = Unsupported::BadPath;
        return c;
    }
    c.menuKey = menuKeyForPaths(payload.paths, cfg);
    if (!c.menuKey) {
        c.reason = Unsupported::UnknownType;
        return c;
    }
    if (payload.containsDirectory) {
        c.reason = Unsupported::Directory;
        c.menuKey.reset();
        return c;
    }
    // The drop message must fit in one protocol line.
    size_t bytes = 256;  // envelope: v, type, sessionId, actionId, mode, dropEffect
    for (const std::string& p : payload.paths) bytes += proto::estimateJsonStringBytes(p) + 1;
    if (bytes > proto::kMaxLineBytes) {
        c.reason = Unsupported::PayloadTooLarge;
        return c;
    }
    if (cfg.findMenu(*c.menuKey) == nullptr) {
        c.reason = Unsupported::NoMenu;
        return c;
    }
    c.supported = true;
    c.reason = Unsupported::None;
    return c;
}

std::vector<proto::WheelSector> adjustForFileCount(const std::vector<proto::WheelSector>& sectors, size_t fileCount,
                                                   const std::string& multiFileReason) {
    if (fileCount <= 1) return sectors;
    std::vector<proto::WheelSector> out = sectors;
    for (proto::WheelSector& s : out) {
        if (s.batch || !s.enabled) continue;
        s.enabled = false;
        s.reason = multiFileReason;
    }
    return out;
}

void addFileAttributes(PathFacts& facts, uint32_t attributes) {
    if (attributes == kInvalidFileAttributes) return;
    if ((attributes & kFileAttributeDirectory) != 0) {
        facts.containsDirectory = true;
    } else if ((attributes & (kFileAttributeRecallOnDataAccess | kFileAttributeOffline)) != 0) {
        facts.containsCloudPlaceholder = true;
    }
}

}  // namespace od::selection
