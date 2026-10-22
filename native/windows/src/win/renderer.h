// Wheel renderer: Direct2D (DC render target, software) + DirectWrite into a
// premultiplied 32-bit top-down DIB section, ready for UpdateLayeredWindow and
// for PNG snapshots (WIC). The DIB is the whole window: the disc's bounding
// square plus the caption strip (coords::PanelLayout). After drawing, an exact
// alpha pass (coords::applyHitShape) gives every pixel of the disc (dead zone
// and gaps included) and of the visible caption pill alpha >= 1 and every
// other pixel alpha 0, using the same predicates as hit-testing, so OLE finds
// the drop target exactly there and hands drags anywhere else to the window
// below.
#pragma once

#include "win/win_util.h"

#include <d2d1.h>
#include <dwrite.h>

#include <map>
#include <optional>
#include <string>
#include <tuple>

#include "core/coords.h"
#include "core/session.h"

namespace od::win {

class Renderer {
public:
    Renderer() = default;
    Renderer(const Renderer&) = delete;
    Renderer& operator=(const Renderer&) = delete;
    ~Renderer();

    /** Creates the D2D/DWrite factories and picks fonts. */
    bool init(std::string& error);
    /** Draws `model` for `frame` into the DIB (sized to frame.windowPx). */
    bool render(const session::RenderModel& model, const coords::WheelFrame& frame);
    /** Releases COM objects and GDI resources (call before CoUninitialize/OleUninitialize). */
    void release();

    HDC dc() const { return memDC_; }
    int width() const { return width_; }
    int height() const { return height_; }
    int stride() const { return width_ * 4; }
    const uint8_t* pixels() const { return static_cast<const uint8_t*>(bits_); }
    bool iconFontAvailable() const { return !iconFamily_.empty(); }
    const std::wstring& textFamily() const { return textFamily_; }
    const std::wstring& iconFamily() const { return iconFamily_; }
    const std::string& lastError() const { return lastError_; }
    /** The caption pill of the last render (wheel-local DIP), if one was drawn: part of the hit shape. */
    const std::optional<geo::Rect>& caption() const { return caption_; }

private:
    bool ensureSurface(int w, int h);
    bool ensureTarget();
    bool draw(const session::RenderModel& m, const coords::WheelFrame& f);
    void drawCaption(const session::RenderModel& m, const coords::WheelFrame& f);
    IDWriteTextFormat* format(const std::wstring& family, float size, int weight, proto::Locale locale);
    void drawText(const std::wstring& text, const D2D1_RECT_F& box, float size, int weight, const proto::Color& color,
                  bool wrap, const std::wstring& family, proto::Locale locale, float minScale);
    ID2D1SolidColorBrush* brush(const proto::Color& c);

    ComPtr<ID2D1Factory> d2d_;
    ComPtr<IDWriteFactory> dwrite_;
    ComPtr<ID2D1DCRenderTarget> target_;
    ComPtr<ID2D1SolidColorBrush> brush_;
    std::map<std::tuple<std::wstring, int, int, int>, ComPtr<IDWriteTextFormat>> formats_;
    HDC memDC_ = nullptr;
    HBITMAP dib_ = nullptr;
    HGDIOBJ oldBitmap_ = nullptr;
    void* bits_ = nullptr;
    int width_ = 0;
    int height_ = 0;
    std::wstring textFamily_;
    std::wstring iconFamily_;
    std::string lastError_;
    std::optional<geo::Rect> caption_;
};

}  // namespace od::win
