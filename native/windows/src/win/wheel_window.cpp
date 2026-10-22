#include "win/wheel_window.h"

#include <algorithm>
#include <cmath>

namespace od::win {

namespace {
constexpr wchar_t kClassName[] = L"OrbitDropWheelWindow";
constexpr UINT_PTR kFadeTimer = 1;
constexpr UINT kFadeIntervalMs = 15;
}  // namespace

WheelWindow::~WheelWindow() { destroy(); }

bool WheelWindow::create(HINSTANCE instance, std::string& error) {
    instance_ = instance;
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof wc;
    wc.lpfnWndProc = &WheelWindow::wndProc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
    wc.lpszClassName = kClassName;
    if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        error = "RegisterClassEx(wheel) failed";
        return false;
    }
    hwnd_ = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kClassName, L"OrbitDrop", WS_POPUP, 0,
                            0, 1, 1, nullptr, nullptr, instance, this);
    if (hwnd_ == nullptr) {
        error = "CreateWindowEx(wheel) failed";
        return false;
    }
    // The first ShowWindow of a process may be overridden by STARTUPINFO
    // (e.g. spawn with windowsHide). Consume that special case now, hidden.
    ShowWindow(hwnd_, SW_HIDE);
    accessible_ = new WheelAccessible(hwnd_);
    return true;
}

void WheelWindow::destroy() {
    if (accessible_ != nullptr) {
        accessible_->disconnect();
        accessible_->Release();
        accessible_ = nullptr;
    }
    if (hwnd_ != nullptr) {
        KillTimer(hwnd_, kFadeTimer);
        SetWindowLongPtrW(hwnd_, GWLP_USERDATA, 0);
        DestroyWindow(hwnd_);
        hwnd_ = nullptr;
    }
    visible_ = false;
}

LRESULT CALLBACK WheelWindow::wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_NCCREATE) {
        const auto* cs = reinterpret_cast<CREATESTRUCTW*>(lp);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
    }
    auto* self = reinterpret_cast<WheelWindow*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    switch (msg) {
        case WM_MOUSEACTIVATE:
            return MA_NOACTIVATE;  // a click on the wheel never activates it
        case WM_DPICHANGED:
            // Position and size are computed for the target monitor; a scale change
            // while a wheel is open means the session must be re-checked.
            if (self != nullptr && self->notifyWindow_ != nullptr) PostMessageW(self->notifyWindow_, self->notifyMessage_, 0, 0);
            return 0;
        case WM_GETOBJECT:
            if (self != nullptr && self->accessible_ != nullptr) {
                if (const LRESULT r = self->accessible_->handleGetObject(wp, lp)) return r;
            }
            break;
        case WM_ERASEBKGND:
            return 1;
        case WM_PAINT:
            ValidateRect(hwnd, nullptr);  // content comes from UpdateLayeredWindow
            return 0;
        case WM_TIMER:
            if (wp == kFadeTimer && self != nullptr) self->onFadeTimer();
            return 0;
        case WM_CLOSE:
            return 0;  // owned by the helper; never closed by others
        default:
            break;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

bool WheelWindow::push(Renderer& renderer, BYTE alpha, bool move) {
    POINT dst{frame_.windowPx.left, frame_.windowPx.top};
    SIZE size{renderer.width(), renderer.height()};
    POINT src{0, 0};
    BLENDFUNCTION blend{AC_SRC_OVER, 0, alpha, AC_SRC_ALPHA};
    // Screen DC not needed (hdcDst = NULL uses the screen palette).
    if (!UpdateLayeredWindow(hwnd_, nullptr, move ? &dst : nullptr, &size, renderer.dc(), &src, 0, &blend, ULW_ALPHA)) return false;
    alpha_ = alpha;
    return true;
}

void WheelWindow::setAlpha(BYTE alpha) {
    BLENDFUNCTION blend{AC_SRC_OVER, 0, alpha, AC_SRC_ALPHA};
    // Content and position unchanged: only the constant alpha.
    UpdateLayeredWindow(hwnd_, nullptr, nullptr, nullptr, nullptr, nullptr, 0, &blend, ULW_ALPHA);
    alpha_ = alpha;
}

bool WheelWindow::show(const coords::WheelFrame& frame, const session::RenderModel& model, Renderer& renderer) {
    if (hwnd_ == nullptr || !frame.valid) return false;
    KillTimer(hwnd_, kFadeTimer);
    fading_ = false;
    frame_ = frame;
    disappearMs_ = model.reduceMotion ? 0 : model.tokens.disappearMs;
    const bool animate = !model.reduceMotion && model.tokens.appearMs > 0;
    const BYTE startAlpha = animate ? 40 : 255;
    if (!renderer.render(model, frame) || !push(renderer, startAlpha, true)) {
        // Never leave a previous (possibly fading) wheel on screen with a stale frame.
        ShowWindow(hwnd_, SW_HIDE);
        visible_ = false;
        caption_.reset();
        return false;
    }
    caption_ = renderer.caption();
    ShowWindow(hwnd_, SW_SHOWNOACTIVATE);
    SetWindowPos(hwnd_, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW);
    // Best effort, unverified (see checklist item 17): keep the shell's drag
    // image ("SysDragImage", a click-through topmost layered window) above the
    // wheel by placing the wheel directly below it. No-op if it is not found.
    if (HWND dragImage = FindWindowW(L"SysDragImage", nullptr); dragImage != nullptr && IsWindowVisible(dragImage)) {
        SetWindowPos(hwnd_, dragImage, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
    visible_ = true;
    if (animate) startFade(startAlpha, 255, model.tokens.appearMs, false);
    announce(model, true);
    return true;
}

bool WheelWindow::update(const session::RenderModel& model, Renderer& renderer) {
    if (hwnd_ == nullptr || !visible_ || !frame_.valid) return false;
    if (!renderer.render(model, frame_)) return false;
    // Same window rectangle: a caption appearing or disappearing only changes the alpha shape.
    const bool ok = push(renderer, alpha_, false);
    if (ok) caption_ = renderer.caption();
    announce(model, false);
    return ok;
}

bool WheelWindow::captionContains(coords::PointI p) const {
    return visible_ && frame_.valid && caption_.has_value() && coords::screenPixelInsidePill(p, frame_, *caption_);
}

void WheelWindow::announce(const session::RenderModel& model, bool opening) {
    if (accessible_ == nullptr) return;
    if (opening) {
        const bool ko = model.locale == proto::Locale::Ko;
        accessible_->setNames(ko ? L"OrbitDrop \uD720" : L"OrbitDrop wheel", ko ? L"\uC6D0\uD615 \uBA54\uB274" : L"radial menu");
    }
    // The armed, selectable sector under the pointer; otherwise the centre text
    // (drop hint, disabled reason, unsupported text, file count). The caption
    // only repeats the centre text, so it adds nothing to announce.
    std::wstring text;
    if (model.highlight >= 0 && static_cast<size_t>(model.highlight) < model.sectors.size()) {
        text = utf8ToWide(model.sectors[static_cast<size_t>(model.highlight)].label);
    } else {
        text = utf8ToWide(model.capsuleText);
    }
    accessible_->announce(text, opening);
}

void WheelWindow::hide(bool animate) {
    if (hwnd_ == nullptr) return;
    if (!visible_) {
        KillTimer(hwnd_, kFadeTimer);
        fading_ = false;
        return;
    }
    if (animate && disappearMs_ > 0) {
        startFade(alpha_, 0, disappearMs_, true);
        return;
    }
    KillTimer(hwnd_, kFadeTimer);
    fading_ = false;
    ShowWindow(hwnd_, SW_HIDE);
    visible_ = false;
    caption_.reset();
}

void WheelWindow::startFade(BYTE from, BYTE to, double durationMs, bool hideAtEnd) {
    fading_ = true;
    fadeFrom_ = from;
    fadeTo_ = to;
    fadeMs_ = std::max(1.0, durationMs);
    fadeStart_ = nowMs();
    hideAtEnd_ = hideAtEnd;
    SetTimer(hwnd_, kFadeTimer, kFadeIntervalMs, nullptr);
}

void WheelWindow::onFadeTimer() {
    if (!fading_) {
        KillTimer(hwnd_, kFadeTimer);
        return;
    }
    const double t = std::min(1.0, static_cast<double>(nowMs() - fadeStart_) / fadeMs_);
    const double eased = 1.0 - (1.0 - t) * (1.0 - t);  // ease-out
    const double a = fadeFrom_ + (static_cast<double>(fadeTo_) - fadeFrom_) * eased;
    setAlpha(static_cast<BYTE>(std::lround(std::clamp(a, 0.0, 255.0))));
    if (t >= 1.0) {
        KillTimer(hwnd_, kFadeTimer);
        fading_ = false;
        if (hideAtEnd_) {
            ShowWindow(hwnd_, SW_HIDE);
            visible_ = false;
            caption_.reset();
        }
    }
}

}  // namespace od::win
