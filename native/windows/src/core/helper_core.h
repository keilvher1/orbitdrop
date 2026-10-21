// Protocol dispatch: validated main → helper messages drive the session
// controller; replies and diagnostics go back through the platform.
#pragma once

#include <cstddef>
#include <functional>
#include <string>
#include <string_view>

#include "core/protocol.h"
#include "core/session.h"

namespace od {

/** Splits an NDJSON byte stream into lines, enforcing HELPER_MAX_LINE_BYTES. */
class LineSplitter {
public:
    using LineFn = std::function<void(std::string_view)>;
    using OverflowFn = std::function<void()>;

    explicit LineSplitter(size_t maxLineBytes = proto::kMaxLineBytes) : max_(maxLineBytes) {}

    /** Calls onLine for every complete line (without '\n') and onOverflow once
     *  for every line longer than the limit (its bytes are discarded). */
    void feed(const char* data, size_t n, const LineFn& onLine, const OverflowFn& onOverflow);

    /** Bytes of the unterminated line kept so far. */
    size_t pending() const { return buffer_.size(); }

private:
    size_t max_;
    std::string buffer_;
    bool discarding_ = false;
};

/** True for lines that only contain JSON whitespace (ignored silently). */
bool isBlankLine(std::string_view line);

class HelperCore {
public:
    class Platform : public session::Host {
    public:
        /** Leave the message loop and exit the process with `code` after flushing stdout. */
        virtual void requestExit(int code) = 0;
    };

    explicit HelperCore(Platform& platform, session::Tuning tuning = session::Tuning());

    /** Sends `ready`. */
    void start(const proto::ReadyInfo& info);

    /** Parses and dispatches one line (single-threaded callers and tests). */
    void handleLine(std::string_view line);
    /** Dispatches a line parsed elsewhere (the Win32 reader thread parses off the UI thread). */
    void handleParsed(proto::ParseResult&& result);
    /** A line exceeded HELPER_MAX_LINE_BYTES (reported, then ignored). */
    void handleLineTooLong();
    /** stdin reached EOF or failed: the parent is gone. Hide everything and exit. */
    void handleInputClosed();

    session::Controller& controller() { return controller_; }
    bool configured() const { return configured_; }
    bool exiting() const { return exiting_; }

private:
    void report(proto::ParseErrorKind kind, const std::string& detail);

    Platform& platform_;
    session::Controller controller_;
    bool configured_ = false;
    bool exiting_ = false;
    int errorsReported_ = 0;
};

}  // namespace od
