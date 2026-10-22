#include "win/app.h"

#include <ole2.h>
#include <wtsapi32.h>

#include <cstdlib>
#include <cstring>

#include "core/protocol.h"

#ifndef ORBITDROP_HELPER_VERSION
#define ORBITDROP_HELPER_VERSION "0.0.0"
#endif

namespace od::win {

namespace {

constexpr wchar_t kMsgClass[] = L"OrbitDropHelperMessageWindow";
constexpr UINT kIdleIntervalMs = 50;
constexpr UINT kIdleToleranceMs = 40;
constexpr UINT kActiveIntervalMs = 15;

const char* buildArch() {
#if defined(_M_ARM64) || defined(__aarch64__)
    return "arm64";
#else
    return "x64";
#endif
}

bool isLogLine(const std::string& line) {
    static const char prefix[] = "{\"v\":1,\"type\":\"log\"";
    return line.compare(0, sizeof prefix - 1, prefix) == 0;
}

}  // namespace

App::App(HINSTANCE instance) : instance_(instance), core_(*this) {}

App::~App() = default;

// ------------------------------------------------------------------ lifecycle

bool App::initialize() {
    // A background helper never shows UI: no "insert a disk" boxes from attribute
    // checks and no Windows Error Reporting dialog (it would take focus mid-drag);
    // after a crash main restarts the helper.
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX | SEM_NOGPFAULTERRORBOX);
    HeapSetInformation(nullptr, HeapEnableTerminationOnCorruption, nullptr, 0);
    // The manifest already requests Per-Monitor V2; this covers a stripped manifest.
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (const char* d = std::getenv("ORBITDROP_HELPER_DEBUG")) debug_ = std::strcmp(d, "1") == 0;
    idSeed_ = sessionIdSeed();

    stdin_ = GetStdHandle(STD_INPUT_HANDLE);
    stdout_ = GetStdHandle(STD_OUTPUT_HANDLE);
    if (stdin_ == nullptr || stdin_ == INVALID_HANDLE_VALUE || stdout_ == nullptr || stdout_ == INVALID_HANDLE_VALUE) {
        // Started without pipes (e.g. double-clicked): nothing to talk to.
        return false;
    }

    const HRESULT oleHr = OleInitialize(nullptr);
    oleInitialized_ = SUCCEEDED(oleHr);

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof wc;
    wc.lpfnWndProc = &App::wndProc;
    wc.hInstance = instance_;
    wc.lpszClassName = kMsgClass;
    if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
    // A hidden top-level window (not HWND_MESSAGE): only top-level windows get
    // WM_POWERBROADCAST, WM_QUERYENDSESSION and session-change broadcasts.
    msgWnd_ = CreateWindowExW(WS_EX_TOOLWINDOW, kMsgClass, L"OrbitDrop Helper", WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, instance_, this);
    if (msgWnd_ == nullptr) return false;

    stdio_ = new StdioChannel();
    if (!stdio_->start(msgWnd_, stdin_, stdout_, GetStdHandle(STD_ERROR_HANDLE))) return false;
    SetCoalescableTimer(msgWnd_, kHousekeepingTimer, 1000, nullptr, 500);
    folders_ = new FolderChecker();
    if (!folders_->start(msgWnd_)) {
        delete folders_;
        folders_ = nullptr;  // folder wording then simply falls back to the generic text
    }

    std::string error;
    rendererOk_ = renderer_.init(error);
    if (!rendererOk_) startupLogs_.emplace_back(proto::LogLevel::Error, "renderer unavailable: " + error);
    std::string wheelError;
    const bool wheelOk = wheel_.create(instance_, wheelError);
    if (!wheelOk) startupLogs_.emplace_back(proto::LogLevel::Error, wheelError);
    wheel_.setDpiChangeNotify(msgWnd_, kMsgDisplayChanged);
    if (oleInitialized_ && wheelOk) {
        dropTarget_ = new DropTarget(this, wheel_.hwnd());
        const HRESULT hr = RegisterDragDrop(wheel_.hwnd(), dropTarget_);
        dropRegistered_ = SUCCEEDED(hr);
        if (!dropRegistered_) startupLogs_.emplace_back(proto::LogLevel::Error, "RegisterDragDrop failed " + hresultHex(hr));
    }
    wtsRegistered_ = WTSRegisterSessionNotification(msgWnd_, NOTIFY_FOR_THIS_SESSION) != 0;

    if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
        startupLogs_.emplace_back(proto::LogLevel::Warn, "process is not Per-Monitor DPI Aware v2; mixed-DPI placement may be off");
    }

    const bool uipiBlocked = shellDragsBlockedByIntegrity();
    globalDragAvailable_ = oleInitialized_ && dropRegistered_ && rendererOk_ && wheelOk && !uipiBlocked;
    if (!oleInitialized_) {
        globalDragReason_ = "OleInitialize failed " + hresultHex(oleHr);
    } else if (!wheelOk || !dropRegistered_) {
        globalDragReason_ = "drop target window could not be created/registered";
    } else if (!rendererOk_) {
        globalDragReason_ = "Direct2D/DirectWrite unavailable: " + error;
    } else if (uipiBlocked) {
        globalDragReason_ = "helper runs elevated (higher integrity level than Explorer): Windows (UIPI) blocks drags from Explorer";
    }
    return true;
}

int App::run() {
    if (!initialize()) {
        shutdown();
        return 2;
    }
    proto::ReadyInfo info;
    info.helperVersion = ORBITDROP_HELPER_VERSION;
    info.arch = buildArch();
    info.osVersion = osVersionString();
    info.pid = static_cast<int64_t>(GetCurrentProcessId());
    info.globalDragAvailable = globalDragAvailable_;
    info.globalDragReason = globalDragReason_;
    core_.start(info);
    for (const auto& [level, message] : startupLogs_) log(level, message);
    startupLogs_.clear();

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    shutdown();
    return exitCode_;
}

void App::shutdown() {
    if (msgWnd_ != nullptr) {
        KillTimer(msgWnd_, kPollTimer);
        KillTimer(msgWnd_, kHousekeepingTimer);
    }
    pendingShow_ = pendingUpdate_ = false;
    wheel_.hide(false);
    if (dropRegistered_) {
        RevokeDragDrop(wheel_.hwnd());  // before the window is destroyed
        dropRegistered_ = false;
    }
    if (dropTarget_ != nullptr) {
        dropTarget_->detach();
        dropTarget_->Release();
        dropTarget_ = nullptr;
    }
    if (folders_ != nullptr) {
        folders_->stop(100);
        if (folders_->stopped()) delete folders_;
        // else: a check is stuck on a network path; leave it to process exit.
        folders_ = nullptr;
    }
    if (stdio_ != nullptr) {
        stdio_->stop(1000);  // flush the final cancelled/log lines
        if (stdio_->stopped()) delete stdio_;
        // else: a thread is still blocked on a pipe; leave the object alive until process exit.
        stdio_ = nullptr;
    }
    wheel_.destroy();
    if (wtsRegistered_) {
        WTSUnRegisterSessionNotification(msgWnd_);
        wtsRegistered_ = false;
    }
    if (msgWnd_ != nullptr) {
        SetWindowLongPtrW(msgWnd_, GWLP_USERDATA, 0);
        DestroyWindow(msgWnd_);
        msgWnd_ = nullptr;
    }
    renderer_.release();
    if (oleInitialized_) {
        OleUninitialize();
        oleInitialized_ = false;
    }
}

void App::requestExit(int code) {
    exiting_ = true;
    exitCode_ = code;
    if (msgWnd_ != nullptr) PostMessageW(msgWnd_, kMsgExit, 0, 0);
}

// ------------------------------------------------------------------ messages

LRESULT CALLBACK App::wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_NCCREATE) {
        const auto* cs = reinterpret_cast<CREATESTRUCTW*>(lp);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
    }
    auto* self = reinterpret_cast<App*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (self != nullptr) {
        // C++ exceptions must not unwind into user32's message dispatcher.
        try {
            return self->handleMessage(hwnd, msg, wp, lp);
        } catch (...) {
            return 0;
        }
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

void App::drainStdio() {
    if (stdio_ == nullptr) return;
    StdioChannel::Drained d = stdio_->drain();
    for (proto::ParseResult& r : d.messages) core_.handleParsed(std::move(r));
    if (d.inputClosed || d.outputBroken) core_.handleInputClosed();  // parent gone: hide everything and exit
}

void App::drainFolderChecks() {
    if (folders_ == nullptr) return;
    for (const FolderChecker::Result& r : folders_->drain()) core_.controller().fileInfo(r.sessionId, r.facts);
}

void App::onDisplayChanged() { core_.controller().displaysChanged(enumerateMonitors()); }

void App::checkPaths(const std::string& sessionId, const std::vector<std::string>& paths) {
    if (folders_ != nullptr && !paths.empty()) folders_->request(sessionId, paths);
}

LRESULT App::handleMessage(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case StdioChannel::kMsgWake:
            drainStdio();  // carries no data: a spoofed wake is just an empty drain
            return 0;
        case FolderChecker::kMsgWake:
            drainFolderChecks();  // likewise payload-less
            return 0;
        case kMsgDisplayChanged:
        case WM_DISPLAYCHANGE:
        case WM_DPICHANGED:
            onDisplayChanged();  // monitor added/removed/rescaled: cancel a wheel on a changed monitor
            return 0;
        case kMsgFlushVisuals:
            flushPosted_ = false;
            flushVisuals();
            return 0;
        case kMsgExit:
            if (!exiting_) return 0;  // only honour our own requestExit()
            flushVisuals();
            PostQuitMessage(exitCode_);
            return 0;
        case WM_TIMER:
            if (wp == kPollTimer) poll();
            if (wp == kHousekeepingTimer) {
                drainStdio();
                drainFolderChecks();
            }
            return 0;
        case WM_POWERBROADCAST:
            if (wp == PBT_APMSUSPEND) {
                sleeping_ = true;
                updateSuspension();
            } else if (wp == PBT_APMRESUMEAUTOMATIC || wp == PBT_APMRESUMESUSPEND) {
                sleeping_ = false;
                updateSuspension();
            }
            return TRUE;
        case WM_WTSSESSION_CHANGE:
            switch (wp) {
                case WTS_SESSION_LOCK:
                case WTS_CONSOLE_DISCONNECT:
                case WTS_REMOTE_DISCONNECT:
                case WTS_SESSION_LOGOFF:
                    locked_ = true;
                    break;
                case WTS_SESSION_UNLOCK:
                case WTS_CONSOLE_CONNECT:
                case WTS_REMOTE_CONNECT:
                case WTS_SESSION_LOGON:
                    locked_ = false;
                    break;
                default:
                    break;
            }
            updateSuspension();
            return 0;
        case WM_QUERYENDSESSION:
            return TRUE;
        case WM_ENDSESSION:
            if (wp) {
                // Logoff, or Restart Manager (ENDSESSION_CLOSEAPP, e.g. an installer
                // replacing this exe): hide now and exit. On logoff the process may
                // be terminated as soon as we return.
                core_.handleInputClosed();  // cancels the session (best effort) and requests exit
                pendingShow_ = pendingUpdate_ = false;
                wheel_.hide(false);
                if (dropRegistered_ && oleDepth_ == 0) {
                    RevokeDragDrop(wheel_.hwnd());
                    dropRegistered_ = false;
                }
                requestExit(0);
            }
            return 0;
        case WM_CLOSE:
            core_.handleInputClosed();  // e.g. taskkill without /F: cancel the session, then exit
            return 0;
        default:
            break;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

void App::updateSuspension() { core_.controller().setSuspended(locked_ || sleeping_); }

// ------------------------------------------------------------------ polling

bool App::foregroundIsTracking() {
    // Window moves/resizes and menu tracking also hold the button while the
    // mouse moves; they are never file drags. Read-only query, no hook.
    const HWND fg = GetForegroundWindow();
    if (fg == nullptr) return false;
    const DWORD tid = GetWindowThreadProcessId(fg, nullptr);
    GUITHREADINFO gti{};
    gti.cbSize = sizeof gti;
    if (!GetGUIThreadInfo(tid, &gti)) return false;
    return (gti.flags & (GUI_INMOVESIZE | GUI_INMENUMODE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE)) != 0;
}

void App::poll() {
    // Never sample input in the middle of an IDropTarget method: if a COM wait
    // loop inside IDataObject::GetData dispatched this timer, a release seen here
    // would end the session (dragEnded) right before OLE delivers its Drop for
    // that very release. The next tick, 15 ms later, sees the settled state.
    if (oleDepth_ > 0) return;
    session::Observation o;
    o.timeMs = nowMs();
    // GetAsyncKeyState reports physical buttons: with swapped buttons the
    // primary (drag) button is the physical right one.
    const bool swapped = GetSystemMetrics(SM_SWAPBUTTON) != 0;
    o.primaryDown = (GetAsyncKeyState(swapped ? VK_RBUTTON : VK_LBUTTON) & 0x8000) != 0;
    POINT pt{};
    if (GetCursorPos(&pt)) {
        o.pointerValid = true;
        o.pointer = coords::PointI{pt.x, pt.y};
    }
    const session::Phase phase = core_.controller().phase();
    const bool wheelOpen = phase == session::Phase::AwaitingPayload || phase == session::Phase::WheelActive;
    // While idle only the primary button is read: GetAsyncKeyState's "pressed
    // since the last query" bit is shared with other programs, so keys are not
    // polled unless a drag could be in progress.
    if (o.primaryDown || phase != session::Phase::Idle) {
        uint8_t mods = 0;
        if (GetAsyncKeyState(VK_SHIFT) & 0x8000) mods |= proto::kModShift;
        if (GetAsyncKeyState(VK_MENU) & 0x8000) mods |= proto::kModAlt;
        if (GetAsyncKeyState(VK_CONTROL) & 0x8000) mods |= proto::kModControl;
        if ((GetAsyncKeyState(VK_LWIN) & 0x8000) || (GetAsyncKeyState(VK_RWIN) & 0x8000)) mods |= proto::kModCommand;
        o.modifiers = mods;
        const SHORT esc = GetAsyncKeyState(VK_ESCAPE);
        // Bit 0 ("pressed since the last query") catches a quick tap between polls while a wheel is open.
        o.escapeDown = (esc & 0x8000) != 0 || (wheelOpen && (esc & 1) != 0);
    }
    if (o.primaryDown && o.pointerValid) {
        const UINT dpi = dpiForMonitor(MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST));
        o.dragThresholdX = GetSystemMetricsForDpi(SM_CXDRAG, dpi);
        o.dragThresholdY = GetSystemMetricsForDpi(SM_CYDRAG, dpi);
        if (phase == session::Phase::Pressed || phase == session::Phase::PotentialDrag) o.suppressed = foregroundIsTracking();
    }
    core_.controller().tick(o);
}

void App::setPollMode(session::PollMode mode) {
    pollMode_ = mode;
    applyPollTimer();
}

void App::applyPollTimer() {
    if (msgWnd_ == nullptr) return;
    const session::PollMode effective = globalDragAvailable_ ? pollMode_ : session::PollMode::Off;
    UINT interval = 0;
    if (effective == session::PollMode::Idle) interval = kIdleIntervalMs;
    if (effective == session::PollMode::Active) interval = kActiveIntervalMs;
    if (interval == timerInterval_) return;
    timerInterval_ = interval;
    if (interval == 0) {
        KillTimer(msgWnd_, kPollTimer);
    } else {
        SetCoalescableTimer(msgWnd_, kPollTimer, interval, nullptr,
                            interval == kIdleIntervalMs ? kIdleToleranceMs : TIMERV_NO_COALESCING);
    }
}

// ------------------------------------------------------------------ session::Host

void App::send(std::string line) {
    if (stdio_ == nullptr || line.empty()) return;
    const bool critical = !isLogLine(line);
    stdio_->send(std::move(line), critical);
}

bool App::queryMonitors(std::vector<coords::Win32Monitor>& out) {
    out = enumerateMonitors();
    return !out.empty();
}

void App::showWheel(const coords::WheelFrame& frame, const session::RenderModel& model) {
    if (!globalDragAvailable_) return;
    pendingShow_ = true;
    pendingUpdate_ = false;
    pendingHide_ = false;
    pendingFrame_ = frame;
    pendingModel_ = model;
    requestVisualFlush();
}

void App::updateWheel(const session::RenderModel& model) {
    pendingModel_ = model;
    if (!pendingShow_) pendingUpdate_ = true;
    requestVisualFlush();
}

void App::hideWheel(bool animate) {
    pendingHide_ = true;
    pendingHideAnimate_ = animate;
    pendingShow_ = false;
    pendingUpdate_ = false;
    requestVisualFlush();
}

void App::requestVisualFlush() {
    if (oleDepth_ == 0) {
        flushVisuals();
        return;
    }
    // Inside DragEnter/DragOver/Drop: return to OLE first, render afterwards.
    if (!flushPosted_ && msgWnd_ != nullptr) flushPosted_ = PostMessageW(msgWnd_, kMsgFlushVisuals, 0, 0) != 0;
}

void App::flushVisuals() {
    if (pendingHide_) {
        pendingHide_ = false;
        wheel_.hide(pendingHideAnimate_);
    }
    if (pendingShow_) {
        pendingShow_ = false;
        pendingUpdate_ = false;
        if (!wheel_.show(pendingFrame_, pendingModel_, renderer_)) log(proto::LogLevel::Warn, "wheel show failed: " + renderer_.lastError());
    } else if (pendingUpdate_) {
        pendingUpdate_ = false;
        wheel_.update(pendingModel_, renderer_);
    }
}

std::string App::newSessionId() { return idSeed_ + "-" + std::to_string(++idCounter_); }

void App::log(proto::LogLevel level, const std::string& message) {
    if (level >= proto::LogLevel::Warn || debug_) send(proto::serializeLog(level, message));
    if (debug_) {
        // Written by the writer thread: a full stderr pipe never blocks the UI thread.
        if (stdio_ != nullptr) stdio_->sendDiagnostic(std::string("[orbitdrop-helper] ") + proto::toString(level) + ": " + message + "\n");
    }
}

// ------------------------------------------------------------------ DropSink

// The OLE depth is held by DropTarget for each whole IDropTarget method
// (enterOle/leaveOle), so window operations requested from here — or from a
// message dispatched by a COM wait loop inside GetData — are deferred.

bool App::wantsPayload() { return core_.controller().wantsPayload(); }

session::Effect App::onDragEnter(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed) {
    return core_.controller().dragEnter(payload, pointer, copyAllowed, nowMs());
}

session::Effect App::onDragOver(coords::PointI pointer, bool copyAllowed) {
    return core_.controller().dragOver(pointer, copyAllowed, nowMs());
}

void App::onDragLeave(bool pointerValid, coords::PointI pointer) {
    // A refused release on the visible caption pill is ours, like one on the
    // disc. Only the window knows the pill as drawn (its width follows the text).
    core_.controller().dragLeave(pointerValid, pointer, nowMs(), pointerValid && wheel_.captionContains(pointer));
}

session::Effect App::onDrop(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed) {
    return core_.controller().drop(payload, pointer, copyAllowed, nowMs());
}

}  // namespace od::win
