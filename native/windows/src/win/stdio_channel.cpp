#include "win/stdio_channel.h"

#include <algorithm>
#include <utility>
#include <vector>

#include "core/helper_core.h"

namespace od::win {

namespace {
constexpr size_t kSoftQueueLimit = 8u * 1024u * 1024u;  // bytes of non-critical lines kept while main is not reading
constexpr size_t kInboxLimit = 10000;                   // parsed messages waiting for the UI thread
}  // namespace

StdioChannel::~StdioChannel() { stop(0); }

bool StdioChannel::stopped() const { return readerThread_ == nullptr && writerThread_ == nullptr; }

bool StdioChannel::start(HWND notify, HANDLE input, HANDLE output) {
    notify_ = notify;
    input_ = input;
    output_ = output;
    writerThread_ = CreateThread(nullptr, 0, &StdioChannel::writerMain, this, 0, nullptr);
    if (writerThread_ == nullptr) return false;
    readerThread_ = CreateThread(nullptr, 0, &StdioChannel::readerMain, this, 0, nullptr);
    return readerThread_ != nullptr;
}

DWORD WINAPI StdioChannel::readerMain(void* self) { return static_cast<StdioChannel*>(self)->readerLoop(); }
DWORD WINAPI StdioChannel::writerMain(void* self) { return static_cast<StdioChannel*>(self)->writerLoop(); }

void StdioChannel::wake() {
    // Coalesced: at most one wake message in flight. If posting fails the flag
    // is cleared so the next event retries; the UI also drains on a slow timer.
    if (InterlockedExchange(&wakePending_, 1) == 0) {
        if (!PostMessageW(notify_, kMsgWake, 0, 0)) InterlockedExchange(&wakePending_, 0);
    }
}

void StdioChannel::push(proto::ParseResult&& result) {
    AcquireSRWLockExclusive(&inboxLock_);
    if (inbox_.size() < kInboxLimit) inbox_.push_back(std::move(result));  // main floods → oldest kept, rest dropped
    ReleaseSRWLockExclusive(&inboxLock_);
    wake();
}

StdioChannel::Drained StdioChannel::drain() {
    InterlockedExchange(&wakePending_, 0);  // before taking: an item pushed after this re-posts a wake
    Drained d;
    std::deque<proto::ParseResult> taken;
    AcquireSRWLockExclusive(&inboxLock_);
    taken.swap(inbox_);
    d.inputClosed = inputClosed_;
    d.outputBroken = outputBroken_;
    ReleaseSRWLockExclusive(&inboxLock_);
    d.messages.reserve(taken.size());
    for (auto& r : taken) d.messages.push_back(std::move(r));
    return d;
}

DWORD StdioChannel::readerLoop() {
    LineSplitter splitter(proto::kMaxLineBytes);
    std::vector<char> buf(64 * 1024);
    const DWORD type = GetFileType(input_);
    int emptyReads = 0;
    const auto onLine = [&](std::string_view line) {
        if (isBlankLine(line)) return;
        push(proto::parseMainToHelper(line));
    };
    const auto onOverflow = [&] {
        proto::ParseResult r;
        r.failure.kind = proto::ParseErrorKind::LineTooLong;
        r.failure.detail = "line exceeds HELPER_MAX_LINE_BYTES";
        push(std::move(r));
    };
    for (;;) {
        if (InterlockedCompareExchange(&readerStop_, 0, 0) != 0) return 0;
        DWORD got = 0;
        const BOOL ok = ReadFile(input_, buf.data(), static_cast<DWORD>(buf.size()), &got, nullptr);
        if (!ok) break;  // ERROR_BROKEN_PIPE (parent gone), ERROR_OPERATION_ABORTED (stop), …
        if (got == 0) {
            // Files and consoles signal EOF with 0 bytes; a byte-mode pipe only
            // does so for zero-length writes, which main never makes.
            if (type != FILE_TYPE_PIPE || ++emptyReads > 64) break;
            continue;
        }
        emptyReads = 0;
        splitter.feed(buf.data(), got, onLine, onOverflow);
    }
    if (InterlockedCompareExchange(&readerStop_, 0, 0) == 0) {
        AcquireSRWLockExclusive(&inboxLock_);
        inputClosed_ = true;
        ReleaseSRWLockExclusive(&inboxLock_);
        wake();
    }
    return 0;
}

DWORD StdioChannel::writerLoop() {
    for (;;) {
        std::string line;
        AcquireSRWLockExclusive(&lock_);
        while (queue_.empty() && !stopping_) SleepConditionVariableSRW(&wake_, &lock_, INFINITE, 0);
        if (queue_.empty()) {  // stopping and drained
            ReleaseSRWLockExclusive(&lock_);
            return 0;
        }
        line = std::move(queue_.front());
        queue_.pop_front();
        queuedBytes_ -= line.size();
        ReleaseSRWLockExclusive(&lock_);

        size_t offset = 0;
        while (offset < line.size()) {
            DWORD written = 0;
            const DWORD chunk = static_cast<DWORD>(std::min<size_t>(line.size() - offset, 1u << 20));
            if (!WriteFile(output_, line.data() + offset, chunk, &written, nullptr) || written == 0) {
                AcquireSRWLockExclusive(&lock_);
                broken_ = true;
                queue_.clear();
                queuedBytes_ = 0;
                ReleaseSRWLockExclusive(&lock_);
                AcquireSRWLockExclusive(&inboxLock_);
                outputBroken_ = true;
                ReleaseSRWLockExclusive(&inboxLock_);
                wake();
                return 1;
            }
            offset += written;
        }
    }
}

void StdioChannel::send(std::string line, bool critical) {
    line.push_back('\n');
    AcquireSRWLockExclusive(&lock_);
    if (!broken_ && !stopping_ && (critical || queuedBytes_ + line.size() <= kSoftQueueLimit)) {
        queuedBytes_ += line.size();
        queue_.push_back(std::move(line));
    }
    ReleaseSRWLockExclusive(&lock_);
    WakeConditionVariable(&wake_);
}

void StdioChannel::stop(DWORD timeoutMs) {
    AcquireSRWLockExclusive(&lock_);
    stopping_ = true;
    ReleaseSRWLockExclusive(&lock_);
    WakeConditionVariable(&wake_);
    if (writerThread_ != nullptr) {
        if (WaitForSingleObject(writerThread_, timeoutMs) == WAIT_OBJECT_0) {
            CloseHandle(writerThread_);
            writerThread_ = nullptr;
        }
        // Otherwise the writer is blocked on a full pipe; process exit ends it.
    }
    if (readerThread_ != nullptr) {
        InterlockedExchange(&readerStop_, 1);
        // CancelSynchronousIo only cancels I/O that is already pending: if it
        // lands just before ReadFile enters the kernel it finds nothing, so retry.
        const ULONGLONG deadline = GetTickCount64() + 300;
        for (;;) {
            CancelSynchronousIo(readerThread_);
            if (WaitForSingleObject(readerThread_, 10) == WAIT_OBJECT_0) {
                CloseHandle(readerThread_);
                readerThread_ = nullptr;
                break;
            }
            if (GetTickCount64() >= deadline) break;  // leave it; the owner must not free us (stopped() == false)
        }
    }
}

}  // namespace od::win
