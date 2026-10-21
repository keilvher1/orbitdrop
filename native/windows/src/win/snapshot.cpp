// --render-snapshot: renders one wheel state to a PNG without any drag.
//
//   OrbitDropHelper.exe --render-snapshot out.png [--menu pdf|image/jpeg|images|mixed|…]
//       [--mode convert|tools] [--highlight N] [--state neutral|active|unsupported|folder|virtual|nonfile]
//       [--files N] [--scale 1.5 | --dpi 144] [--theme light|dark|high-contrast]
//       [--locale ko|en] [--disable N[,M…]] [--config configure.json]
//
// The wheel state is produced by the real session controller (scripted press,
// drag, modifier, DragEnter and DragOver), so snapshots show exactly what a
// drag would show; rendering is the same Direct2D path as the live window.
// Prints one JSON line with the result to stdout. Exit code 0 on success.
#include "win/snapshot.h"

#include <wincodec.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <sstream>
#include <variant>

#include "core/defaults.h"
#include "core/json.h"
#include "core/protocol.h"
#include "core/session.h"
#include "core/wheel_layout.h"
#include "win/renderer.h"

namespace od::win {

namespace {

// GUIDs from wincodec.h, defined here to avoid a link-time dependency.
const CLSID kClsidWicImagingFactory = {0xcacaf262, 0x9370, 0x4615, {0xa1, 0x3b, 0x9f, 0x55, 0x39, 0xda, 0x4c, 0x0a}};
const GUID kPixelFormat32bppBGRA = {0x6fddc324, 0x4e03, 0x4bfe, {0xb1, 0x85, 0x3d, 0x77, 0x76, 0x8d, 0xc9, 0x0f}};
const GUID kPixelFormat32bppPBGRA = {0x6fddc324, 0x4e03, 0x4bfe, {0xb1, 0x85, 0x3d, 0x77, 0x76, 0x8d, 0xc9, 0x10}};
const GUID kContainerFormatPng = {0x1b7cfaf4, 0x713f, 0x473c, {0xbb, 0xcd, 0x61, 0x37, 0x42, 0x5f, 0xae, 0xaf}};

struct SnapshotHost : session::Host {
    std::vector<coords::Win32Monitor> monitors;
    coords::WheelFrame frame;
    session::RenderModel model;
    bool shown = false;
    void send(std::string) override {}
    bool queryMonitors(std::vector<coords::Win32Monitor>& out) override {
        out = monitors;
        return true;
    }
    void showWheel(const coords::WheelFrame& f, const session::RenderModel& m) override {
        frame = f;
        model = m;
        shown = true;
    }
    void updateWheel(const session::RenderModel& m) override { model = m; }
    void hideWheel(bool) override {}
    void setPollMode(session::PollMode) override {}
    std::string newSessionId() override { return "snapshot-1"; }
    void log(proto::LogLevel, const std::string&) override {}
};

bool writePng(const std::wstring& path, const Renderer& r, std::string& error) {
    ComPtr<IWICImagingFactory> wic;
    HRESULT hr = CoCreateInstance(kClsidWicImagingFactory, nullptr, CLSCTX_INPROC_SERVER, __uuidof(IWICImagingFactory), wic.putVoid());
    ComPtr<IWICBitmap> bitmap;
    ComPtr<IWICFormatConverter> converter;
    ComPtr<IWICStream> stream;
    ComPtr<IWICBitmapEncoder> encoder;
    ComPtr<IWICBitmapFrameEncode> frame;
    if (SUCCEEDED(hr)) {
        hr = wic->CreateBitmapFromMemory(static_cast<UINT>(r.width()), static_cast<UINT>(r.height()), kPixelFormat32bppPBGRA,
                                         static_cast<UINT>(r.stride()), static_cast<UINT>(r.stride() * r.height()),
                                         const_cast<BYTE*>(r.pixels()), bitmap.put());
    }
    if (SUCCEEDED(hr)) hr = wic->CreateFormatConverter(converter.put());
    if (SUCCEEDED(hr)) {
        // PNG stores straight alpha: un-premultiply.
        hr = converter->Initialize(bitmap.get(), kPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom);
    }
    if (SUCCEEDED(hr)) hr = wic->CreateStream(stream.put());
    if (SUCCEEDED(hr)) hr = stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE);
    if (SUCCEEDED(hr)) hr = wic->CreateEncoder(kContainerFormatPng, nullptr, encoder.put());
    if (SUCCEEDED(hr)) hr = encoder->Initialize(stream.get(), WICBitmapEncoderNoCache);
    if (SUCCEEDED(hr)) hr = encoder->CreateNewFrame(frame.put(), nullptr);
    if (SUCCEEDED(hr)) hr = frame->Initialize(nullptr);
    if (SUCCEEDED(hr)) hr = frame->SetSize(static_cast<UINT>(r.width()), static_cast<UINT>(r.height()));
    WICPixelFormatGUID format = kPixelFormat32bppBGRA;
    if (SUCCEEDED(hr)) hr = frame->SetPixelFormat(&format);
    if (SUCCEEDED(hr)) hr = frame->WriteSource(converter.get(), nullptr);
    if (SUCCEEDED(hr)) hr = frame->Commit();
    if (SUCCEEDED(hr)) hr = encoder->Commit();
    if (FAILED(hr)) error = "WIC PNG encoding failed " + hresultHex(hr);
    return SUCCEEDED(hr);
}

int fail(const std::string& message) {
    json::Writer w;
    w.beginObject();
    w.key("ok");
    w.boolean(false);
    w.key("error");
    w.str(message);
    w.endObject();
    writeConsole(w.text() + "\n");
    return 1;
}

/** A file name with an extension that maps to `key` in the configuration. */
std::string sampleFile(const proto::Configure& cfg, proto::MenuKey key, size_t index) {
    for (const auto& [ext, k] : cfg.extensions) {
        if (k == key) return "C:\\OrbitDrop snapshot\\file" + std::to_string(index + 1) + ext;
    }
    return "C:\\OrbitDrop snapshot\\file" + std::to_string(index + 1) + ".bin";
}

}  // namespace

int runSnapshot(const std::vector<std::wstring>& args) {
    std::string out;
    std::string menu = "pdf";
    std::string mode = "convert";
    std::string state = "active";
    std::string theme = "light";
    std::string locale = "en";
    std::string configPath;
    std::string disable;
    int highlight = -1;
    long files = 1;
    double scale = 1.0;
    for (size_t i = 0; i < args.size(); ++i) {
        const std::string a = wideToUtf8(args[i]);
        const auto next = [&](std::string& dst) {
            if (i + 1 < args.size()) dst = wideToUtf8(args[++i]);
        };
        std::string v;
        if (a == "--render-snapshot") next(out);
        else if (a == "--menu") next(menu);
        else if (a == "--mode") next(mode);
        else if (a == "--state") next(state);
        else if (a == "--theme") next(theme);
        else if (a == "--locale") next(locale);
        else if (a == "--config") next(configPath);
        else if (a == "--disable") next(disable);
        else if (a == "--highlight") { next(v); highlight = std::atoi(v.c_str()); }
        else if (a == "--files") { next(v); files = std::strtol(v.c_str(), nullptr, 10); }
        else if (a == "--scale") { next(v); scale = std::atof(v.c_str()); }
        else if (a == "--dpi") { next(v); scale = std::atof(v.c_str()) / 96.0; }
        else return fail("unknown argument: " + a);
    }
    if (out.empty()) return fail("--render-snapshot needs an output path");
    if (!(scale >= 0.5 && scale <= 4.0)) return fail("--scale must be between 0.5 and 4");
    if (files < 1 || files > 500) return fail("--files must be between 1 and 500");
    const auto menuKey = proto::parseMenuKey(menu);
    if (!menuKey) return fail("unknown --menu " + menu);
    const auto wheelMode = proto::parseWheelMode(mode);
    if (!wheelMode) return fail("--mode must be convert or tools");
    const auto loc = proto::parseLocale(locale);
    if (!loc) return fail("--locale must be ko or en");
    const defaults::Theme th = theme == "dark" ? defaults::Theme::Dark
                               : theme == "high-contrast" ? defaults::Theme::HighContrast
                                                          : defaults::Theme::Light;

    std::shared_ptr<proto::Configure> cfg;
    if (!configPath.empty()) {
        HANDLE f = CreateFileW(utf8ToWide(configPath).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        if (f == INVALID_HANDLE_VALUE) return fail("cannot open --config file");
        std::string text;
        char buf[65536];
        DWORD got = 0;
        while (ReadFile(f, buf, sizeof buf, &got, nullptr) && got > 0 && text.size() < proto::kMaxLineBytes + 2) text.append(buf, got);
        CloseHandle(f);
        while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) text.pop_back();
        proto::ParseResult r = proto::parseMainToHelper(text);
        if (!r.ok()) return fail("--config is not a valid configure message: " + r.failure.detail);
        const auto* c = std::get_if<std::shared_ptr<const proto::Configure>>(&*r.message);
        if (c == nullptr) return fail("--config must contain a configure message");
        cfg = std::make_shared<proto::Configure>(**c);
        cfg->enabled = true;
    } else {
        cfg = defaults::referenceConfigure(*loc, th);
    }
    if (!disable.empty()) {
        std::stringstream ss(disable);
        std::string item;
        while (std::getline(ss, item, ',')) {
            const size_t idx = static_cast<size_t>(std::strtoul(item.c_str(), nullptr, 10));
            for (auto& m : cfg->menus) {
                if (m.key != *menuKey) continue;
                auto& list = *wheelMode == proto::WheelMode::Convert ? m.convert : m.tools;
                if (idx < list.size()) {
                    list[idx].enabled = false;
                    list[idx].reason = *loc == proto::Locale::Ko ? "\xEC\x9D\xB4 \xEB\xB9\x8C\xEB\x93\x9C\xEC\x97\x90\xEC\x84\x9C \xEC\x82\xAC\xEC\x9A\xA9\xED\x95\xA0 \xEC\x88\x98 \xEC\x97\x86\xEC\x9D\x8C"  // 이 빌드에서 사용할 수 없음
                                                                 : "Not available in this build";
                }
            }
        }
    }

    // Scripted session on a virtual monitor.
    SnapshotHost host;
    coords::Win32Monitor mon;
    mon.bounds = geo::Rect{0, 0, 4000, 3000};
    mon.workArea = mon.bounds;
    mon.dpi = 96 * scale;
    mon.primary = true;
    host.monitors = {mon};
    session::Controller ctl(host);
    ctl.configure(cfg);
    const coords::PointI center{2000, 1500};
    session::Observation o;
    o.timeMs = 1000;
    o.pointerValid = true;
    o.primaryDown = true;
    o.pointer = coords::PointI{center.x - 20, center.y};
    ctl.tick(o);
    o.timeMs += 16;
    o.pointer = center;
    ctl.tick(o);
    o.modifiers = *wheelMode == proto::WheelMode::Convert ? cfg->convertModifiers : cfg->toolsModifiers;
    for (int k = 0; k < 8; ++k) {
        o.timeMs += 16;
        ctl.tick(o);
    }
    if (!host.shown) return fail("the scripted session did not open the wheel");

    if (state != "neutral") {
        selection::DragPayload payload;
        payload.hasFileList = true;
        if (state == "unsupported") {
            payload.paths = {"C:\\OrbitDrop snapshot\\notes.txt"};
        } else if (state == "folder") {
            payload.paths = {"C:\\OrbitDrop snapshot\\Photos"};  // the folder check reports a directory below
        } else if (state == "virtual") {
            payload.hasFileList = false;  // e.g. an e-mail attachment: FileGroupDescriptorW only
            payload.virtualFilesOnly = true;
        } else if (state == "nonfile") {
            payload.hasFileList = false;  // text or a URL
        } else {
            // 'images' needs two image formats and 'mixed' a PDF plus an image.
            const bool multiFormat = *menuKey == proto::MenuKey::Images || *menuKey == proto::MenuKey::Mixed;
            const long n = multiFormat ? std::max(files, 2L) : files;
            for (long k = 0; k < n; ++k) {
                proto::MenuKey key = *menuKey;
                if (key == proto::MenuKey::Images) key = k % 2 == 0 ? proto::MenuKey::ImageJpeg : proto::MenuKey::ImagePng;
                if (key == proto::MenuKey::Mixed) key = k % 2 == 0 ? proto::MenuKey::Pdf : proto::MenuKey::ImagePng;
                payload.paths.push_back(sampleFile(*cfg, key, static_cast<size_t>(k)));
            }
        }
        payload.totalCount = payload.paths.size();
        ctl.dragEnter(payload, center, true, o.timeMs);
        if (state == "folder") ctl.fileInfo(ctl.sessionId(), true);
        const size_t count = host.model.sectors.size();
        if (highlight >= 0 && static_cast<size_t>(highlight) < count) {
            const layout::Layout L = layout::computeLayout(static_cast<int>(count), host.frame.diameter, cfg->geometry);
            const layout::Vec2 c = L.sectors[static_cast<size_t>(highlight)].labelCenter;
            const coords::PointI p{static_cast<int32_t>(std::lround(host.frame.centerPhysical.x + c.x * host.frame.scale)),
                                   static_cast<int32_t>(std::lround(host.frame.centerPhysical.y + c.y * host.frame.scale))};
            ctl.dragOver(p, true, o.timeMs + 16);
        }
    }

    const HRESULT co = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    std::string error;
    bool ok = false;
    {
        Renderer renderer;
        if (!renderer.init(error)) {
            error = "renderer: " + error;
        } else if (!renderer.render(host.model, host.frame)) {
            error = "render failed: " + renderer.lastError();
        } else {
            ok = writePng(utf8ToWide(out), renderer, error);
        }
        if (ok) {
            json::Writer w;
            w.beginObject();
            w.key("ok");
            w.boolean(true);
            w.key("out");
            w.str(out);
            w.key("width");
            w.integer(renderer.width());
            w.key("height");
            w.integer(renderer.height());
            w.key("scale");
            w.number(host.frame.scale);
            w.key("sectors");
            w.integer(static_cast<int64_t>(host.model.sectors.size()));
            w.key("highlight");
            w.integer(host.model.highlight);
            w.key("capsule");
            w.str(host.model.capsuleText);
            w.key("textFont");
            w.str(wideToUtf8(renderer.textFamily()));
            w.key("iconFont");
            w.str(wideToUtf8(renderer.iconFamily()));
            w.endObject();
            writeConsole(w.text() + "\n");
        }
        renderer.release();
    }
    if (SUCCEEDED(co)) CoUninitialize();
    return ok ? 0 : fail(error);
}

}  // namespace od::win
