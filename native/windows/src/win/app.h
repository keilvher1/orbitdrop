// Win32 application glue for the drag helper.
//
// Threads: the UI thread is an OLE STA (OleInitialize) running the message
// loop; it owns the session controller, the wheel window, the drop target and
// all timers. A reader thread parses stdin; a writer thread drains stdout.
//
// Observation without hooks or injection: a timer polls GetAsyncKeyState
// (primary button honouring SM_SWAPBUTTON, Shift/Alt/Ctrl/Win, Esc) and
// GetCursorPos — every 50 ms (coalescable) while idle, every 15 ms while the
// button is down or a session is open — and only updates state.
//
// Window operations requested while inside an OLE callback are deferred with
// PostMessage so DragEnter/DragOver/Drop return immediately.
#pragma once

#include "win/win_util.h"

#include <string>
#include <utility>
#include <vector>

#include "core/helper_core.h"
#include "win/drop_target.h"
#include "win/renderer.h"
#include "win/stdio_channel.h"
#include "win/wheel_window.h"

namespace od::win {

class App final : public HelperCore::Platform, public DropSink {
public:
    explicit App(HINSTANCE instance);
    App(const App&) = delete;
    App& operator=(const App&) = delete;
    ~App() override;

    /** Runs the helper until stdin closes or `shutdown` arrives. Returns the exit code. */
    int run();

    // session::Host
    void send(std::string line) override;
    bool queryMonitors(std::vector<coords::Win32Monitor>& out) override;
    void showWheel(const coords::WheelFrame& frame, const session::RenderModel& model) override;
    void updateWheel(const session::RenderModel& model) override;
    void hideWheel(bool animate) override;
    void setPollMode(session::PollMode mode) override;
    std::string newSessionId() override;
    void log(proto::LogLevel level, const std::string& message) override;
    // HelperCore::Platform
    void requestExit(int code) override;

    // DropSink
    void enterOle() override { ++oleDepth_; }
    void leaveOle() override { --oleDepth_; }
    bool wantsPayload() override;
    session::Effect onDragEnter(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed) override;
    session::Effect onDragOver(coords::PointI pointer, bool copyAllowed) override;
    void onDragLeave(bool pointerValid, coords::PointI pointer) override;
    session::Effect onDrop(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed) override;

private:
    static constexpr UINT kMsgFlushVisuals = WM_APP + 10;
    static constexpr UINT kMsgExit = WM_APP + 11;
    static constexpr UINT_PTR kPollTimer = 1;
    static constexpr UINT_PTR kHousekeepingTimer = 2;  // drains stdio even if a wake message was lost

    bool initialize();
    void shutdown();
    static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
    LRESULT handleMessage(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
    void poll();
    void applyPollTimer();
    void flushVisuals();
    void requestVisualFlush();
    void updateSuspension();
    void drainStdio();
    static bool foregroundIsTracking();

    HINSTANCE instance_;
    HWND msgWnd_ = nullptr;
    HANDLE stdin_ = nullptr;
    HANDLE stdout_ = nullptr;
    bool oleInitialized_ = false;
    bool dropRegistered_ = false;
    bool rendererOk_ = false;
    bool wtsRegistered_ = false;
    bool globalDragAvailable_ = false;
    std::string globalDragReason_;

    Renderer renderer_;
    WheelWindow wheel_;
    DropTarget* dropTarget_ = nullptr;
    StdioChannel* stdio_ = nullptr;
    HelperCore core_;

    int oleDepth_ = 0;
    bool flushPosted_ = false;
    bool pendingShow_ = false;
    bool pendingUpdate_ = false;
    bool pendingHide_ = false;
    bool pendingHideAnimate_ = false;
    coords::WheelFrame pendingFrame_;
    session::RenderModel pendingModel_;

    session::PollMode pollMode_ = session::PollMode::Off;
    UINT timerInterval_ = 0;
    bool locked_ = false;
    bool sleeping_ = false;

    std::vector<std::pair<proto::LogLevel, std::string>> startupLogs_;  // sent right after `ready`
    std::string idSeed_;
    uint64_t idCounter_ = 0;
    bool debug_ = false;
    bool exiting_ = false;
    int exitCode_ = 0;
};

}  // namespace od::win
