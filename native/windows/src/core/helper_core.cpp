#include "core/helper_core.h"

#include <cstring>
#include <type_traits>
#include <utility>
#include <variant>

namespace od {

// ------------------------------------------------------------------ LineSplitter

void LineSplitter::feed(const char* data, size_t n, const LineFn& onLine, const OverflowFn& onOverflow) {
    size_t i = 0;
    while (i < n) {
        const char* nl = static_cast<const char*>(std::memchr(data + i, '\n', n - i));
        const size_t chunkEnd = nl ? static_cast<size_t>(nl - data) : n;
        const size_t chunkLen = chunkEnd - i;
        if (!discarding_) {
            if (buffer_.size() + chunkLen > max_) {
                discarding_ = true;
                buffer_.clear();
                buffer_.shrink_to_fit();
                onOverflow();
            } else {
                buffer_.append(data + i, chunkLen);
            }
        }
        if (nl == nullptr) break;
        if (!discarding_) onLine(buffer_);
        buffer_.clear();
        discarding_ = false;
        i = chunkEnd + 1;
    }
}

bool isBlankLine(std::string_view line) {
    for (const char c : line) {
        if (c != ' ' && c != '\t' && c != '\r' && c != '\n') return false;
    }
    return true;
}

// ------------------------------------------------------------------ HelperCore

HelperCore::HelperCore(Platform& platform, session::Tuning tuning) : platform_(platform), controller_(platform, tuning) {}

void HelperCore::start(const proto::ReadyInfo& info) {
    const std::string line = proto::serializeReady(info);
    if (!line.empty()) platform_.send(line);
}

void HelperCore::handleLine(std::string_view line) {
    if (isBlankLine(line)) return;
    handleParsed(proto::parseMainToHelper(line));
}

void HelperCore::handleParsed(proto::ParseResult&& result) {
    if (exiting_) return;
    if (!result.ok()) {
        report(result.failure.kind, result.failure.detail);
        return;
    }
    std::visit(
        [&](auto&& msg) {
            using T = std::decay_t<decltype(msg)>;
            if constexpr (std::is_same_v<T, std::shared_ptr<const proto::Configure>>) {
                configured_ = true;
                controller_.configure(msg);
            } else if constexpr (std::is_same_v<T, proto::CancelSession>) {
                controller_.cancelSession(msg.sessionId);
            } else if constexpr (std::is_same_v<T, proto::Ping>) {
                const std::string line = proto::serializePong(msg.nonce);
                if (!line.empty()) platform_.send(line);
            } else if constexpr (std::is_same_v<T, proto::Shutdown>) {
                exiting_ = true;
                controller_.shutdown();
                platform_.requestExit(0);
            } else if constexpr (std::is_same_v<T, proto::QueryPermissions>) {
                // Windows observation (polling + OLE drop target) needs no permission.
                platform_.send(proto::serializePermissions());
            }
        },
        *result.message);
}

void HelperCore::handleLineTooLong() { report(proto::ParseErrorKind::LineTooLong, "line exceeds HELPER_MAX_LINE_BYTES"); }

void HelperCore::handleInputClosed() {
    if (exiting_) return;
    exiting_ = true;
    controller_.shutdown();
    platform_.requestExit(0);
}

void HelperCore::report(proto::ParseErrorKind kind, const std::string& detail) {
    // Never echo message contents; the detail is a field path / parser reason.
    constexpr int kMaxReports = 50;
    if (errorsReported_ >= kMaxReports) return;
    ++errorsReported_;
    std::string message = "rejected message: " + detail;
    if (errorsReported_ == kMaxReports) message += " (further protocol errors are not reported)";
    const std::string line = proto::serializeError(proto::errorCodeFor(kind), message, false);
    if (!line.empty()) platform_.send(line);
}

}  // namespace od
