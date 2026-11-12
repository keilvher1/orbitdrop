#include "win/renderer.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "core/jsmath.h"
#include "core/wheel_layout.h"

namespace od::win {

namespace {

D2D1_COLOR_F toD2D(const proto::Color& c, float alphaScale = 1.0f) {
    return D2D1::ColorF(c.r / 255.0f, c.g / 255.0f, c.b / 255.0f, (c.a / 255.0f) * alphaScale);
}

const wchar_t* localeName(proto::Locale l) { return l == proto::Locale::Ko ? L"ko-KR" : L"en-US"; }

/**
 * Segoe Fluent Icons (Windows 11) / Segoe MDL2 Assets (Windows 10) share these
 * code points. Mapping chosen to match the reference look: compress = arrows
 * pointing inwards (BackToWindow), metadata = Tag, edit = sliders (Equalizer),
 * annotate = pen (Edit), background = Picture, crop = Crop, redact = eye with a
 * slash (Hide). Must be checked visually on Windows (see the workstream doc).
 */
wchar_t iconGlyph(proto::IconId id) {
    switch (id) {
        case proto::IconId::Compress: return 0xE73F;
        case proto::IconId::Metadata: return 0xE8EC;
        case proto::IconId::Edit: return 0xE9E9;
        case proto::IconId::Annotate: return 0xE70F;
        case proto::IconId::Background: return 0xE8B9;
        case proto::IconId::Crop: return 0xE7A8;
        case proto::IconId::Redact: return 0xED1A;
    }
    return 0;
}

bool hasFamily(IDWriteFactory* dw, const wchar_t* name) {
    ComPtr<IDWriteFontCollection> fonts;
    if (FAILED(dw->GetSystemFontCollection(fonts.put(), FALSE))) return false;
    UINT32 index = 0;
    BOOL exists = FALSE;
    return SUCCEEDED(fonts->FindFamilyName(name, &index, &exists)) && exists;
}

}  // namespace

Renderer::~Renderer() { release(); }

void Renderer::release() {
    formats_.clear();
    brush_.reset();
    target_.reset();
    dwrite_.reset();
    d2d_.reset();
    if (memDC_ != nullptr) {
        if (oldBitmap_ != nullptr) SelectObject(memDC_, oldBitmap_);
        DeleteDC(memDC_);
        memDC_ = nullptr;
        oldBitmap_ = nullptr;
    }
    if (dib_ != nullptr) {
        DeleteObject(dib_);
        dib_ = nullptr;
    }
    bits_ = nullptr;
    width_ = height_ = 0;
}

bool Renderer::init(std::string& error) {
    D2D1_FACTORY_OPTIONS options{};
    options.debugLevel = D2D1_DEBUG_LEVEL_NONE;
    HRESULT hr = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, __uuidof(ID2D1Factory), &options, d2d_.putVoid());
    if (FAILED(hr)) {
        error = "D2D1CreateFactory failed " + hresultHex(hr);
        return false;
    }
    hr = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), reinterpret_cast<IUnknown**>(dwrite_.put()));
    if (FAILED(hr)) {
        error = "DWriteCreateFactory failed " + hresultHex(hr);
        return false;
    }
    textFamily_ = hasFamily(dwrite_.get(), L"Segoe UI Variable Text") ? L"Segoe UI Variable Text" : L"Segoe UI";
    if (hasFamily(dwrite_.get(), L"Segoe Fluent Icons")) {
        iconFamily_ = L"Segoe Fluent Icons";
    } else if (hasFamily(dwrite_.get(), L"Segoe MDL2 Assets")) {
        iconFamily_ = L"Segoe MDL2 Assets";
    }
    memDC_ = CreateCompatibleDC(nullptr);
    if (memDC_ == nullptr) {
        error = "CreateCompatibleDC failed";
        return false;
    }
    return true;
}

bool Renderer::ensureSurface(int w, int h) {
    if (dib_ != nullptr && w == width_ && h == height_) return true;
    if (dib_ != nullptr) {
        SelectObject(memDC_, oldBitmap_);
        DeleteObject(dib_);
        dib_ = nullptr;
        bits_ = nullptr;
    }
    BITMAPINFO bi{};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;  // top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    dib_ = CreateDIBSection(memDC_, &bi, DIB_RGB_COLORS, &bits_, nullptr, 0);
    if (dib_ == nullptr || bits_ == nullptr) {
        lastError_ = "CreateDIBSection failed";
        return false;
    }
    oldBitmap_ = SelectObject(memDC_, dib_);
    width_ = w;
    height_ = h;
    return true;
}

bool Renderer::ensureTarget() {
    if (target_) return true;
    // Software rasterisation: deterministic, no GPU readback for a few hundred
    // pixels, and works in sessions without a usable GPU (RDP, CI).
    const D2D1_RENDER_TARGET_PROPERTIES props = D2D1::RenderTargetProperties(
        D2D1_RENDER_TARGET_TYPE_SOFTWARE, D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED), 96.0f,
        96.0f, D2D1_RENDER_TARGET_USAGE_NONE, D2D1_FEATURE_LEVEL_DEFAULT);
    const HRESULT hr = d2d_->CreateDCRenderTarget(&props, target_.put());
    if (FAILED(hr)) {
        lastError_ = "CreateDCRenderTarget failed " + hresultHex(hr);
        return false;
    }
    // ClearType needs an opaque background; layered windows get grayscale AA.
    target_->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
    target_->SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
    brush_.reset();
    return true;
}

ID2D1SolidColorBrush* Renderer::brush(const proto::Color& c) {
    if (!brush_) {
        if (FAILED(target_->CreateSolidColorBrush(toD2D(c), brush_.put()))) return nullptr;
    } else {
        brush_->SetColor(toD2D(c));
    }
    return brush_.get();
}

IDWriteTextFormat* Renderer::format(const std::wstring& family, float size, int weight, proto::Locale locale) {
    const auto key = std::make_tuple(family, static_cast<int>(std::lround(size * 64)), weight, static_cast<int>(locale));
    auto it = formats_.find(key);
    if (it != formats_.end()) return it->second.get();
    ComPtr<IDWriteTextFormat> f;
    const HRESULT hr = dwrite_->CreateTextFormat(family.c_str(), nullptr, static_cast<DWRITE_FONT_WEIGHT>(weight),
                                                 DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, size, localeName(locale), f.put());
    if (FAILED(hr)) return nullptr;
    f->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
    f->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
    IDWriteTextFormat* raw = f.get();
    formats_.emplace(key, std::move(f));
    return raw;
}

void Renderer::drawText(const std::wstring& text, const D2D1_RECT_F& box, float size, int weight, const proto::Color& color,
                        bool wrap, const std::wstring& family, proto::Locale locale, float minScale) {
    if (text.empty()) return;
    const float w = std::max(1.0f, box.right - box.left);
    const float h = std::max(1.0f, box.bottom - box.top);
    IDWriteTextFormat* fmt = format(family, size, weight, locale);
    if (fmt == nullptr) return;
    ComPtr<IDWriteTextLayout> layout;
    if (FAILED(dwrite_->CreateTextLayout(text.c_str(), static_cast<UINT32>(text.size()), fmt, w, h, layout.put()))) return;
    layout->SetWordWrapping(wrap ? DWRITE_WORD_WRAPPING_WRAP : DWRITE_WORD_WRAPPING_NO_WRAP);
    const DWRITE_TEXT_RANGE all{0, static_cast<UINT32>(text.size())};
    DWRITE_TEXT_METRICS tm{};
    if (SUCCEEDED(layout->GetMetrics(&tm)) && (tm.widthIncludingTrailingWhitespace > w || tm.height > h)) {
        // Shrink to fit (labels are short; reasons may be long), then trim with an ellipsis.
        const float scale = std::min(w / std::max(1.0f, tm.widthIncludingTrailingWhitespace), h / std::max(1.0f, tm.height));
        layout->SetFontSize(size * std::max(minScale, std::min(1.0f, scale * 0.98f)), all);
        if (SUCCEEDED(layout->GetMetrics(&tm)) && (tm.widthIncludingTrailingWhitespace > w || tm.height > h)) {
            DWRITE_TRIMMING trimming{DWRITE_TRIMMING_GRANULARITY_CHARACTER, 0, 0};
            ComPtr<IDWriteInlineObject> ellipsis;
            if (SUCCEEDED(dwrite_->CreateEllipsisTrimmingSign(fmt, ellipsis.put()))) layout->SetTrimming(&trimming, ellipsis.get());
        }
    }
    if (ID2D1SolidColorBrush* b = brush(color)) {
        target_->DrawTextLayout(D2D1::Point2F(box.left, box.top), layout.get(), b, D2D1_DRAW_TEXT_OPTIONS_CLIP);
    }
}

bool Renderer::render(const session::RenderModel& m, const coords::WheelFrame& f) {
    caption_.reset();  // a render that fails before drawing leaves no pill from the previous frame
    if (!d2d_ || !f.valid) return false;
    if (!ensureSurface(f.windowPx.width, f.windowPx.height)) return false;
    for (int attempt = 0; attempt < 2; ++attempt) {
        if (!ensureTarget()) return false;
        std::memset(bits_, 0, static_cast<size_t>(width_) * height_ * 4);
        const RECT rc{0, 0, width_, height_};
        HRESULT hr = target_->BindDC(memDC_, &rc);
        if (FAILED(hr)) {
            lastError_ = "BindDC failed " + hresultHex(hr);
            target_.reset();
            continue;
        }
        target_->BeginDraw();
        bool drawn = false;
        try {
            drawn = draw(m, f);
        } catch (...) {
            drawn = false;  // e.g. std::bad_alloc: still close the BeginDraw/EndDraw pair
            lastError_ = "exception while drawing";
        }
        hr = target_->EndDraw();
        if (hr == static_cast<HRESULT>(D2DERR_RECREATE_TARGET)) {
            target_.reset();
            continue;
        }
        if (FAILED(hr) || !drawn) {
            lastError_ = "EndDraw failed " + hresultHex(hr);
            return false;
        }
        GdiFlush();
        // Hit shape: alpha >= 1 exactly on the disc and the drawn caption pill, 0 elsewhere.
        coords::applyHitShape(static_cast<uint8_t*>(bits_), width_, height_, f, caption_ ? &*caption_ : nullptr);
        return true;
    }
    return false;
}

bool Renderer::draw(const session::RenderModel& m, const coords::WheelFrame& f) {
    const proto::WheelTokens& t = m.tokens;
    const geo::Point center = coords::drawCenterPx(f);
    const float s = static_cast<float>(f.scale);
    caption_.reset();
    // Wheel-local DIP (origin at the disc centre, y down) for everything below, the caption included.
    target_->SetTransform(D2D1::Matrix3x2F::Scale(s, s) * D2D1::Matrix3x2F::Translation(static_cast<float>(center.x), static_cast<float>(center.y)));
    target_->Clear(D2D1::ColorF(0, 0, 0, 0));

    const int count = m.neutral ? 0 : static_cast<int>(m.sectors.size());
    const layout::Layout L = layout::computeLayout(count, m.diameter, m.geometry);
    const float R = static_cast<float>(L.outerR);

    // Disc.
    if (ID2D1SolidColorBrush* b = brush(t.wheelDisc)) target_->FillEllipse(D2D1::Ellipse(D2D1::Point2F(0, 0), R, R), b);

    // Soft inner rim shading with the shadow token (an outer drop shadow would
    // need non-zero alpha outside the disc, which would make OLE treat the
    // shadow as part of the drop target).
    if (t.wheelShadow.a > 0) {
        D2D1_GRADIENT_STOP stops[2] = {{0.80f, toD2D(t.wheelShadow, 0.0f)}, {1.0f, toD2D(t.wheelShadow, 0.55f)}};
        ComPtr<ID2D1GradientStopCollection> collection;
        ComPtr<ID2D1RadialGradientBrush> radial;
        if (SUCCEEDED(target_->CreateGradientStopCollection(stops, 2, collection.put())) &&
            SUCCEEDED(target_->CreateRadialGradientBrush(D2D1::RadialGradientBrushProperties(D2D1::Point2F(0, 0), D2D1::Point2F(0, 0), R, R),
                                                         collection.get(), radial.put()))) {
            target_->FillEllipse(D2D1::Ellipse(D2D1::Point2F(0, 0), R, R), radial.get());
        }
    }

    // Sectors.
    for (int i = 0; i < count; ++i) {
        const layout::SectorShape& shape = L.sectors[static_cast<size_t>(i)];
        if (!shape.visible) continue;
        ComPtr<ID2D1PathGeometry> path;
        ComPtr<ID2D1GeometrySink> sink;
        if (FAILED(d2d_->CreatePathGeometry(path.put())) || FAILED(path->Open(sink.put()))) continue;
        sink->SetFillMode(D2D1_FILL_MODE_ALTERNATE);
        for (const layout::Figure& fig : shape.figures) {
            sink->BeginFigure(D2D1::Point2F(static_cast<float>(fig.start.x), static_cast<float>(fig.start.y)), D2D1_FIGURE_BEGIN_FILLED);
            for (const layout::Segment& seg : fig.segments) {
                const D2D1_POINT_2F to = D2D1::Point2F(static_cast<float>(seg.to.x), static_cast<float>(seg.to.y));
                if (seg.kind == layout::SegKind::Line) {
                    sink->AddLine(to);
                } else {
                    sink->AddArc(D2D1::ArcSegment(to, D2D1::SizeF(static_cast<float>(seg.radius), static_cast<float>(seg.radius)), 0.0f,
                                                  seg.clockwise ? D2D1_SWEEP_DIRECTION_CLOCKWISE : D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE,
                                                  seg.largeArc ? D2D1_ARC_SIZE_LARGE : D2D1_ARC_SIZE_SMALL));
                }
            }
            sink->EndFigure(D2D1_FIGURE_END_CLOSED);
        }
        if (FAILED(sink->Close())) continue;
        const session::SectorVisual& v = m.sectors[static_cast<size_t>(i)];
        const proto::Color& fill = m.unsupported || !v.enabled ? t.sectorDisabled
                                   : i == m.highlight         ? t.sectorActive
                                   : i == m.hover             ? t.sectorHover
                                                              : t.sector;
        if (ID2D1SolidColorBrush* b = brush(fill)) target_->FillGeometry(path.get(), b);
        if (m.highContrast) {
            if (ID2D1SolidColorBrush* b = brush(t.sectorText)) target_->DrawGeometry(path.get(), b, 1.5f);
        }
    }

    // Thin outer ring (outer edge exactly at the disc radius).
    if (L.ringWidth > 0) {
        if (ID2D1SolidColorBrush* b = brush(t.wheelRing)) {
            target_->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(0, 0), static_cast<float>(L.ringR), static_cast<float>(L.ringR)), b,
                                 static_cast<float>(L.ringWidth));
        }
    }

    // Labels and tool icons (horizontal, like the reference).
    const float labelSize = static_cast<float>(t.labelSize);
    const float iconSize = static_cast<float>(t.iconSize);
    for (int i = 0; i < count; ++i) {
        const layout::SectorShape& shape = L.sectors[static_cast<size_t>(i)];
        const session::SectorVisual& v = m.sectors[static_cast<size_t>(i)];
        if (!shape.visible) continue;
        const bool active = i == m.highlight;
        const bool dim = m.unsupported || !v.enabled;
        const proto::Color& textColor = active ? t.sectorActiveText : dim ? t.sectorDisabledText : t.sectorText;
        const proto::Color& iconColor = active ? t.sectorActiveText : dim ? t.sectorDisabledText : t.sectorIcon;
        const float cx = static_cast<float>(shape.labelCenter.x);
        const float cy = static_cast<float>(shape.labelCenter.y);
        const float maxW = static_cast<float>(std::max(24.0, shape.labelMaxWidth));
        const float lineH = labelSize * 1.35f;
        const bool icon = v.icon.has_value() && !iconFamily_.empty();
        const float gap = 3.0f;
        const float block = icon ? iconSize + gap + lineH : lineH;
        float top = cy - block / 2;
        if (icon) {
            const std::wstring glyph(1, iconGlyph(*v.icon));
            const D2D1_RECT_F ib = D2D1::RectF(cx - iconSize, top, cx + iconSize, top + iconSize);
            drawText(glyph, ib, iconSize, 400, iconColor, false, iconFamily_, m.locale, 1.0f);
            top += iconSize + gap;
        }
        const D2D1_RECT_F lb = D2D1::RectF(cx - maxW / 2, top, cx + maxW / 2, top + lineH);
        drawText(utf8ToWide(v.label), lb, labelSize, m.tokens.labelWeight, textColor, false, textFamily_, m.locale, 0.6f);
    }

    // Center capsule.
    const float cw = static_cast<float>(L.capsuleWidth);
    const float ch = static_cast<float>(L.capsuleHeight);
    if (cw > 0 && ch > 0) {
        const proto::Color& fill = m.capsuleStyle == session::CapsuleStyle::Reject ? t.capsuleReject : t.capsule;
        const D2D1_ROUNDED_RECT rr = D2D1::RoundedRect(D2D1::RectF(-cw / 2, -ch / 2, cw / 2, ch / 2), ch / 2, ch / 2);
        if (ID2D1SolidColorBrush* b = brush(fill)) target_->FillRoundedRectangle(rr, b);
        if (m.highContrast) {
            if (ID2D1SolidColorBrush* b = brush(t.wheelRing)) target_->DrawRoundedRectangle(rr, b, 1.5f);
        }
        const D2D1_RECT_F tb = D2D1::RectF(-cw / 2 + ch / 4, -ch / 2 + 2, cw / 2 - ch / 4, ch / 2 - 2);
        drawText(utf8ToWide(m.capsuleText), tb, static_cast<float>(t.capsuleTextSize), m.tokens.labelWeight, t.capsuleText, true,
                 textFamily_, m.locale, 0.55f);
    }

    drawCaption(m, f);
    return true;
}

void Renderer::drawCaption(const session::RenderModel& m, const coords::WheelFrame& f) {
    // Secondary caption (spec §8): one line in a pill in the caption strip outside
    // the ring, so the choice stays readable when the shell's drag image covers the
    // sector and the capsule. Same metrics as the macOS pill: 13 DIP text for the
    // default 16 DIP capsule text, shrunk down to 10 DIP to fit, then an ellipsis;
    // 12 DIP padding; at least 56 DIP wide.
    if (m.captionText.empty() || f.panel.captionPlacement == coords::CaptionPlacement::None) return;
    const proto::WheelTokens& t = m.tokens;
    const geo::Rect strip = coords::captionStripLocal(f);
    const float size = static_cast<float>(std::min(13.0, std::max(10.0, t.capsuleTextSize - 3)));
    const float minSize = 10.0f;
    const int weight = std::max(t.labelWeight, 600);
    const float maxW = static_cast<float>(std::max(1.0, strip.width - 2 * coords::kCaptionPadding));
    const float h = static_cast<float>(std::max(1.0, strip.height));
    std::wstring text = utf8ToWide(m.captionText);
    // One line: a line or paragraph separator (or another control character) in a
    // configured reason would start a second line despite NO_WRAP.
    for (wchar_t& c : text) {
        if (c < 0x20 || (c >= 0x7F && c <= 0x9F) || c == 0x2028 || c == 0x2029) c = L' ';
    }
    IDWriteTextFormat* fmt = format(textFamily_, size, weight, m.locale);
    if (text.empty() || fmt == nullptr) return;  // no pill drawn, none in the hit shape
    ComPtr<IDWriteTextLayout> layout;
    if (FAILED(dwrite_->CreateTextLayout(text.c_str(), static_cast<UINT32>(text.size()), fmt, maxW, h, layout.put()))) return;
    layout->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
    DWRITE_TEXT_METRICS tm{};
    if (FAILED(layout->GetMetrics(&tm))) return;
    float textW = tm.widthIncludingTrailingWhitespace;
    if (textW > maxW) {
        const DWRITE_TEXT_RANGE all{0, static_cast<UINT32>(text.size())};
        const float shrunk = std::max(minSize, size * maxW / textW * 0.98f);
        layout->SetFontSize(shrunk, all);
        if (SUCCEEDED(layout->GetMetrics(&tm))) textW = tm.widthIncludingTrailingWhitespace;
        if (textW > maxW) {
            // The ellipsis at the shrunk size (one made from the 13 DIP format would be larger than the text).
            // (Not named `small`: the Windows SDK's rpcndr.h defines `small` as a macro for `char`.)
            IDWriteTextFormat* shrunkFormat = format(textFamily_, shrunk, weight, m.locale);
            DWRITE_TRIMMING trimming{DWRITE_TRIMMING_GRANULARITY_CHARACTER, 0, 0};
            ComPtr<IDWriteInlineObject> ellipsis;
            if (SUCCEEDED(dwrite_->CreateEllipsisTrimmingSign(shrunkFormat != nullptr ? shrunkFormat : fmt, ellipsis.put()))) {
                layout->SetTrimming(&trimming, ellipsis.get());
            }
            textW = maxW;
        }
    }
    const geo::Rect pill = coords::captionPillRect(strip, textW);
    const D2D1_RECT_F pr = D2D1::RectF(static_cast<float>(pill.x), static_cast<float>(pill.y), static_cast<float>(pill.x + pill.width),
                                       static_cast<float>(pill.y + pill.height));
    const float radius = static_cast<float>(std::min(pill.width, pill.height) / 2);
    // Opaque like the macOS pill: readable over anything, and wholly inside the
    // hit shape (a release on it is our cancel by design).
    proto::Color fill = m.captionStyle == session::CapsuleStyle::Reject ? t.capsuleReject : t.capsule;
    fill.a = 255;
    if (ID2D1SolidColorBrush* b = brush(fill)) target_->FillRoundedRectangle(D2D1::RoundedRect(pr, radius, radius), b);
    if (m.highContrast) {
        // Stroked inside the pill: the hit-shape mask would cut off the outer half of a centred stroke.
        const float lw = 1.5f;
        const D2D1_RECT_F inner = D2D1::RectF(pr.left + lw / 2, pr.top + lw / 2, pr.right - lw / 2, pr.bottom - lw / 2);
        if (ID2D1SolidColorBrush* b = brush(t.wheelRing)) {
            target_->DrawRoundedRectangle(D2D1::RoundedRect(inner, radius - lw / 2, radius - lw / 2), b, lw);
        }
    }
    // The layout box is centred on the strip, like the pill; the format centres the line in it.
    if (ID2D1SolidColorBrush* b = brush(t.capsuleText)) {
        const D2D1_POINT_2F origin = D2D1::Point2F(static_cast<float>(strip.x + strip.width / 2) - maxW / 2, static_cast<float>(strip.y));
        target_->DrawTextLayout(origin, layout.get(), b, D2D1_DRAW_TEXT_OPTIONS_CLIP);
    }
    caption_ = pill;
}

}  // namespace od::win
