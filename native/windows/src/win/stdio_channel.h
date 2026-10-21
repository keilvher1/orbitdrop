// NDJSON over the inherited stdio pipes.
//
// Reader thread: blocking ReadFile on stdin → LineSplitter (HELPER_MAX_LINE_BYTES)
// → parse + validate off the UI thread → push into a locked inbox and post a
// payload-less wake message (kMsgWake). EOF / a broken pipe sets a flag.
// Writer thread: serialises queued lines to stdout so the UI thread (and the
// OLE drop callbacks running on it) never block on a full pipe; a failed write
// sets a flag.
//
// The UI thread drains the inbox and reads the flags on wake. No message ever
// carries a pointer or a decision: another process posting kMsgWake to our
// (top-level) window can only cause a harmless empty drain.
#pragma once

#include "win/win_util.h"

#include <deque>
#include <string>
#include <vector>

#include "core/protocol.h"

namespace od::win {

class StdioChannel {
public:
    static constexpr UINT kMsgWake = WM_APP + 1;

    StdioChannel() = default;
    StdioChannel(const StdioChannel&) = delete;
    StdioChannel& operator=(const StdioChannel&) = delete;
    ~StdioChannel();

    /** Starts both threads. `notify` receives kMsgWake. */
    bool start(HWND notify, HANDLE input, HANDLE output);

    /** Queues one line (a '\n' is appended). Never blocks. `critical` lines are
     *  kept even when the queue is over its soft limit (parent not reading). */
    void send(std::string line, bool critical);

    struct Drained {
        std::vector<proto::ParseResult> messages;  // in arrival order (line-too-long = a LineTooLong failure)
        bool inputClosed = false;                   // stdin reached EOF / failed (after `messages`)
        bool outputBroken = false;                  // a write to stdout failed
    };
    /** UI thread: takes everything the threads produced since the last call. */
    Drained drain();

    /** Lets the writer drain for up to `timeoutMs`, then stops both threads. */
    void stop(DWORD timeoutMs);
    /** True when both threads have exited (only then may the object be destroyed). */
    bool stopped() const;

private:
    static DWORD WINAPI readerMain(void* self);
    static DWORD WINAPI writerMain(void* self);
    DWORD readerLoop();
    DWORD writerLoop();
    void push(proto::ParseResult&& result);
    void wake();

    HWND notify_ = nullptr;
    HANDLE input_ = nullptr;
    HANDLE output_ = nullptr;
    HANDLE readerThread_ = nullptr;
    HANDLE writerThread_ = nullptr;

    // Outgoing queue (UI → writer).
    SRWLOCK lock_ = SRWLOCK_INIT;
    CONDITION_VARIABLE wake_ = CONDITION_VARIABLE_INIT;
    std::deque<std::string> queue_;
    size_t queuedBytes_ = 0;
    bool stopping_ = false;
    bool broken_ = false;

    // Incoming inbox (reader → UI).
    SRWLOCK inboxLock_ = SRWLOCK_INIT;
    std::deque<proto::ParseResult> inbox_;
    bool inputClosed_ = false;
    bool outputBroken_ = false;
    volatile LONG wakePending_ = 0;
    volatile LONG readerStop_ = 0;
};

}  // namespace od::win
