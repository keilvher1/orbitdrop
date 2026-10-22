// The single wheel window: visual and OLE drop target in one HWND.
//
// WS_POPUP + WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
// shown with SW_SHOWNOACTIVATE (never takes focus, never ends the source's
// drag). The window is the disc's bounding square plus the caption strip
// (coords::PanelLayout). Content is a premultiplied 32-bit DIB pushed with
// UpdateLayeredWindow (ULW_ALPHA), so hit-testing follows per-pixel alpha: the
// disc and the visible caption pill (alpha >= 1) are the drop target,
// everything else (alpha 0) is click/drag-through. Created hidden at start-up
// and reused for every session.
#pragma once

#include "win/win_util.h"

#include <optional>

#include "core/coords.h"
#include "core/session.h"
#include "win/accessibility.h"
#include "win/renderer.h"

namespace od::win {

class WheelWindow {
public:
    WheelWindow() = default;
    WheelWindow(const WheelWindow&) = delete;
    WheelWindow& operator=(const WheelWindow&) = delete;
    ~WheelWindow();

    bool create(HINSTANCE instance, std::string& error);
    void destroy();
    HWND hwnd() const { return hwnd_; }
    bool visible() const { return visible_; }

    /** Renders and shows the wheel at `frame` (fade-in over appearMs unless reduced motion). */
    bool show(const coords::WheelFrame& frame, const session::RenderModel& model, Renderer& renderer);
    /** Re-renders in place (highlight/capsule changes). */
    bool update(const session::RenderModel& model, Renderer& renderer);
    /** Hides (fade-out over disappearMs when `animate`). */
    void hide(bool animate);
    /** True when screen pixel `p` is on the caption pill now on screen (part of the hit shape, like the disc). */
    bool captionContains(coords::PointI p) const;
    /** Window that gets `message` (no payload) when the wheel's DPI changes. */
    void setDpiChangeNotify(HWND window, UINT message) {
        notifyWindow_ = window;
        notifyMessage_ = message;
    }

private:
    static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
    bool push(Renderer& renderer, BYTE alpha, bool move);
    void setAlpha(BYTE alpha);
    void startFade(BYTE from, BYTE to, double durationMs, bool hideAtEnd);
    void onFadeTimer();
    void announce(const session::RenderModel& model, bool opening);

    HWND hwnd_ = nullptr;
    HINSTANCE instance_ = nullptr;
    WheelAccessible* accessible_ = nullptr;
    HWND notifyWindow_ = nullptr;
    UINT notifyMessage_ = 0;
    coords::WheelFrame frame_;
    std::optional<geo::Rect> caption_;  // pill of the frame on screen (wheel-local DIP)
    bool visible_ = false;
    BYTE alpha_ = 0;
    double disappearMs_ = 90;  // from the tokens of the model on screen (0 with reduced motion)
    // Fade animation.
    bool fading_ = false;
    BYTE fadeFrom_ = 0;
    BYTE fadeTo_ = 0;
    double fadeMs_ = 0;
    int64_t fadeStart_ = 0;
    bool hideAtEnd_ = false;
};

}  // namespace od::win
