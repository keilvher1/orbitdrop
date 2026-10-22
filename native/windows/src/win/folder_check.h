// Off-UI-thread metadata check of dragged paths: folders and cloud-only
// placeholders.
//
// OLE callbacks must not touch the file system (a sleeping disk or a slow
// network share would stall the source's drag), so DragEnter only copies the
// paths and the controller asks this worker whether any of them is a folder or
// a file whose content is not on this machine yet (OneDrive/Dropbox Files
// On-Demand online-only file: FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS or
// FILE_ATTRIBUTE_OFFLINE). GetFileAttributesW reads metadata only, so the check
// itself never downloads ("hydrates") a placeholder.
// One worker thread, latest request wins; the answer comes back through a
// locked slot plus a payload-less wake message (kMsgWake), like StdioChannel.
#pragma once

#include "win/win_util.h"

#include <string>
#include <vector>

#include "core/selection.h"

namespace od::win {

class FolderChecker {
public:
    static constexpr UINT kMsgWake = WM_APP + 2;

    struct Result {
        std::string sessionId;
        selection::PathFacts facts;
    };

    FolderChecker() = default;
    FolderChecker(const FolderChecker&) = delete;
    FolderChecker& operator=(const FolderChecker&) = delete;
    ~FolderChecker();

    bool start(HWND notify);
    /** UI thread: check `paths` (UTF-8) for session `sessionId`; replaces a pending request. */
    void request(const std::string& sessionId, const std::vector<std::string>& paths);
    /** UI thread: answers produced since the last call. */
    std::vector<Result> drain();
    void stop(DWORD timeoutMs);
    bool stopped() const { return thread_ == nullptr; }

private:
    static DWORD WINAPI threadMain(void* self);
    DWORD loop();
    void wake();

    HWND notify_ = nullptr;
    HANDLE thread_ = nullptr;
    SRWLOCK lock_ = SRWLOCK_INIT;
    CONDITION_VARIABLE cv_ = CONDITION_VARIABLE_INIT;
    bool stopping_ = false;
    uint64_t generation_ = 0;  // bumped by every request; a newer request abandons the old one
    bool pending_ = false;
    std::string requestId_;
    std::vector<std::wstring> requestPaths_;
    std::vector<Result> results_;
    volatile LONG wakePending_ = 0;
};

}  // namespace od::win
