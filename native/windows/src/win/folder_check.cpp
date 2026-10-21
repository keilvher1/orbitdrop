#include "win/folder_check.h"

#include <utility>

namespace od::win {

namespace {

/** "\\?\" form for long paths, so the check does not depend on longPathAware. */
std::wstring extendedPath(const std::wstring& path) {
    if (path.size() < MAX_PATH || path.rfind(L"\\\\?\\", 0) == 0) return path;
    if (path.size() >= 3 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) return L"\\\\?\\" + path;
    if (path.rfind(L"\\\\", 0) == 0) return L"\\\\?\\UNC\\" + path.substr(2);
    return path;
}

}  // namespace

FolderChecker::~FolderChecker() { stop(0); }

bool FolderChecker::start(HWND notify) {
    notify_ = notify;
    thread_ = CreateThread(nullptr, 0, &FolderChecker::threadMain, this, 0, nullptr);
    return thread_ != nullptr;
}

DWORD WINAPI FolderChecker::threadMain(void* self) { return static_cast<FolderChecker*>(self)->loop(); }

void FolderChecker::wake() {
    if (InterlockedExchange(&wakePending_, 1) == 0) {
        if (!PostMessageW(notify_, kMsgWake, 0, 0)) InterlockedExchange(&wakePending_, 0);
    }
}

void FolderChecker::request(const std::string& sessionId, const std::vector<std::string>& paths) {
    std::vector<std::wstring> wide;
    wide.reserve(paths.size());
    for (const std::string& p : paths) wide.push_back(utf8ToWide(p));
    AcquireSRWLockExclusive(&lock_);
    ++generation_;
    pending_ = true;
    requestId_ = sessionId;
    requestPaths_ = std::move(wide);
    ReleaseSRWLockExclusive(&lock_);
    WakeConditionVariable(&cv_);
}

std::vector<FolderChecker::Result> FolderChecker::drain() {
    InterlockedExchange(&wakePending_, 0);
    std::vector<Result> out;
    AcquireSRWLockExclusive(&lock_);
    out.swap(results_);
    ReleaseSRWLockExclusive(&lock_);
    return out;
}

DWORD FolderChecker::loop() {
    for (;;) {
        std::string id;
        std::vector<std::wstring> paths;
        uint64_t generation = 0;
        AcquireSRWLockExclusive(&lock_);
        while (!pending_ && !stopping_) SleepConditionVariableSRW(&cv_, &lock_, INFINITE, 0);
        if (stopping_) {
            ReleaseSRWLockExclusive(&lock_);
            return 0;
        }
        pending_ = false;
        id = std::move(requestId_);
        paths = std::move(requestPaths_);
        generation = generation_;
        ReleaseSRWLockExclusive(&lock_);

        bool directory = false;
        bool superseded = false;
        for (const std::wstring& path : paths) {
            AcquireSRWLockShared(&lock_);
            superseded = generation != generation_ || stopping_;
            ReleaseSRWLockShared(&lock_);
            if (superseded) break;
            // Metadata only (no content read, no hydration of cloud placeholders);
            // SEM_FAILCRITICALERRORS (process-wide) prevents "insert disk" prompts.
            const DWORD attrs = GetFileAttributesW(extendedPath(path).c_str());
            if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0) {
                directory = true;
                break;
            }
        }
        if (superseded) continue;
        AcquireSRWLockExclusive(&lock_);
        if (results_.size() < 64) results_.push_back(Result{std::move(id), directory});
        ReleaseSRWLockExclusive(&lock_);
        wake();
    }
}

void FolderChecker::stop(DWORD timeoutMs) {
    if (thread_ == nullptr) return;
    AcquireSRWLockExclusive(&lock_);
    stopping_ = true;
    ReleaseSRWLockExclusive(&lock_);
    WakeConditionVariable(&cv_);
    // A check stuck on an unreachable network share cannot be interrupted; then
    // the thread is left to process exit (stopped() stays false, so the owner
    // must not free this object).
    if (WaitForSingleObject(thread_, timeoutMs) == WAIT_OBJECT_0) {
        CloseHandle(thread_);
        thread_ = nullptr;
    }
}

}  // namespace od::win
