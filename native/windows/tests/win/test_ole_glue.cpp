// Windows-only tests of the OLE glue: the real DropTarget (IDropTarget) and the
// real session controller, driven with a fake IDataObject and the allowed-effect
// sets a drag source would pass in *pdwEffect. No window, no real drag loop
// (DoDragDrop needs a live mouse), so this runs headless in CI.
#include "win/drop_target.h"

#include <shlobj.h>

#include <algorithm>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "core/defaults.h"
#include "core/json.h"
#include "core/session.h"
#include "test_framework.h"

using namespace od;

namespace {

POINT g_cursor{0, 0};
bool fakeCursor(POINT* out) {
    *out = g_cursor;
    return true;
}

CLIPFORMAT fileDescriptorFormat() { return static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW)); }
CLIPFORMAT fileDescriptorFormatAnsi() { return static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORA)); }

/** Minimal IDataObject offering CF_HDROP (wide DROPFILES), FileGroupDescriptor(W) and/or text. */
class FakeDataObject final : public IDataObject {
public:
    std::vector<std::wstring> files;
    bool hdrop = false;
    bool fileDescriptor = false;
    bool fileDescriptorAnsi = false;
    bool text = false;
    int getDataCalls = 0;

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override {
        if (object == nullptr) return E_POINTER;
        if (IsEqualIID(riid, __uuidof(IUnknown)) || IsEqualIID(riid, __uuidof(IDataObject))) {
            *object = static_cast<IDataObject*>(this);
            AddRef();
            return S_OK;
        }
        *object = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
    ULONG STDMETHODCALLTYPE Release() override { return --refs_; }  // owned by the test (stack)

    HRESULT STDMETHODCALLTYPE GetData(FORMATETC* fe, STGMEDIUM* stg) override {
        ++getDataCalls;
        if (fe == nullptr || stg == nullptr) return E_INVALIDARG;
        if (fe->cfFormat != CF_HDROP || !hdrop || (fe->tymed & TYMED_HGLOBAL) == 0) return DV_E_FORMATETC;
        size_t chars = 1;  // final terminator
        for (const std::wstring& f : files) chars += f.size() + 1;
        const size_t bytes = sizeof(DROPFILES) + chars * sizeof(wchar_t);
        HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes);
        if (h == nullptr) return E_OUTOFMEMORY;
        auto* df = static_cast<DROPFILES*>(GlobalLock(h));
        df->pFiles = sizeof(DROPFILES);
        df->fWide = TRUE;
        auto* p = reinterpret_cast<wchar_t*>(reinterpret_cast<BYTE*>(df) + sizeof(DROPFILES));
        for (const std::wstring& f : files) {
            std::memcpy(p, f.data(), f.size() * sizeof(wchar_t));
            p += f.size();
            *p++ = L'\0';
        }
        *p = L'\0';
        GlobalUnlock(h);
        stg->tymed = TYMED_HGLOBAL;
        stg->hGlobal = h;
        stg->pUnkForRelease = nullptr;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* fe) override {
        if (fe == nullptr) return E_INVALIDARG;
        if (fe->cfFormat == CF_HDROP && hdrop) return S_OK;
        if (fe->cfFormat == fileDescriptorFormat() && fileDescriptor) return S_OK;
        if (fe->cfFormat == fileDescriptorFormatAnsi() && fileDescriptorAnsi) return S_OK;
        if (fe->cfFormat == CF_UNICODETEXT && text) return S_OK;
        return DV_E_FORMATETC;
    }
    HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC* out) override {
        if (out != nullptr) out->ptd = nullptr;
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD, IEnumFORMATETC** e) override {
        if (e != nullptr) *e = nullptr;
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override { return OLE_E_ADVISENOTSUPPORTED; }
    HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override { return OLE_E_ADVISENOTSUPPORTED; }
    HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA** e) override {
        if (e != nullptr) *e = nullptr;
        return OLE_E_ADVISENOTSUPPORTED;
    }

private:
    ULONG refs_ = 1;
};

/** DropSink + session::Host around the real controller. */
struct TestSink final : win::DropSink, session::Host {
    session::Controller ctl{*this};
    std::vector<std::string> sent;
    session::RenderModel model;
    bool visible = false;
    int depth = 0;
    int maxDepth = 0;
    int folderChecks = 0;
    int ids = 0;
    int64_t t = 1000;

    TestSink() { ctl.configure(defaults::referenceConfigure(proto::Locale::En)); }

    // session::Host
    void send(std::string line) override { sent.push_back(std::move(line)); }
    bool queryMonitors(std::vector<coords::Win32Monitor>& out) override {
        coords::Win32Monitor m;
        m.bounds = {0, 0, 1920, 1080};
        m.workArea = {0, 0, 1920, 1040};
        m.dpi = 96;
        m.primary = true;
        out = {m};
        return true;
    }
    void showWheel(const coords::WheelFrame&, const session::RenderModel& m) override {
        model = m;
        visible = true;
    }
    void updateWheel(const session::RenderModel& m) override { model = m; }
    void hideWheel(bool) override { visible = false; }
    void setPollMode(session::PollMode) override {}
    std::string newSessionId() override { return "ole-" + std::to_string(++ids); }
    void log(proto::LogLevel, const std::string&) override {}
    void checkPaths(const std::string&, const std::vector<std::string>&) override { ++folderChecks; }

    // win::DropSink
    void enterOle() override { maxDepth = std::max(maxDepth, ++depth); }
    void leaveOle() override { --depth; }
    bool wantsPayload() override { return ctl.wantsPayload(); }
    session::Effect onDragEnter(const selection::DragPayload& p, coords::PointI pt, bool copy) override { return ctl.dragEnter(p, pt, copy, t); }
    session::Effect onDragOver(coords::PointI pt, bool copy) override { return ctl.dragOver(pt, copy, t); }
    void onDragLeave(bool valid, coords::PointI pt) override { ctl.dragLeave(valid, pt, t); }
    session::Effect onDrop(const selection::DragPayload& p, coords::PointI pt, bool copy) override { return ctl.drop(p, pt, copy, t); }

    /** Press, drag, then press the modifier: the neutral wheel opens centred at (x, y). */
    void openWheel(int x, int y, uint8_t mods = proto::kModShift) {
        session::Observation o;
        o.pointerValid = true;
        o.primaryDown = true;
        o.pointer = {x - 10, y};
        o.timeMs = t;
        ctl.tick(o);
        o.pointer = {x, y};
        o.timeMs = (t += 16);
        ctl.tick(o);
        o.modifiers = mods;
        for (int i = 0; i < 5; ++i) {
            o.timeMs = (t += 16);
            ctl.tick(o);
        }
    }

    size_t count(const char* type) const {
        size_t n = 0;
        for (const std::string& line : sent) {
            json::Value v;
            json::ParseError e;
            if (json::parse(line, v, e) && v.get("type") != nullptr && v.get("type")->asString() == type) ++n;
        }
        return n;
    }
    json::Value last(const char* type) const {
        json::Value found;
        for (const std::string& line : sent) {
            json::Value v;
            json::ParseError e;
            if (json::parse(line, v, e) && v.get("type") != nullptr && v.get("type")->asString() == type) found = v;
        }
        return found;
    }
};

struct TargetRef {
    win::DropTarget* p;
    explicit TargetRef(TestSink& sink) : p(new win::DropTarget(&sink, nullptr, &fakeCursor, false)) {}
    ~TargetRef() { p->Release(); }
    win::DropTarget* operator->() const { return p; }
};

FakeDataObject pdfData() {
    FakeDataObject d;
    d.hdrop = true;
    d.files = {L"C:\\Users\\me\\Docs\\Page 001.pdf"};
    return d;
}

const POINTL kJpgSector{920, 500};  // wheel centred at (800, 500): JPG is sector 1 (right) of the PDF menu

}  // namespace

TEST_CASE("ole: the drop effect is COPY only when the source allows COPY") {
    struct Case {
        DWORD allowed;
        DWORD expected;
    };
    const Case cases[] = {
        {DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK, DROPEFFECT_COPY},
        {DROPEFFECT_COPY, DROPEFFECT_COPY},
        {DROPEFFECT_COPY | DROPEFFECT_MOVE, DROPEFFECT_COPY},  // Explorer with Shift: Move is its default, we still say Copy
        {DROPEFFECT_MOVE, DROPEFFECT_NONE},
        {DROPEFFECT_LINK, DROPEFFECT_NONE},
        {DROPEFFECT_MOVE | DROPEFFECT_LINK, DROPEFFECT_NONE},
        {DROPEFFECT_NONE, DROPEFFECT_NONE},
    };
    for (const Case& c : cases) {
        TestSink sink;
        sink.openWheel(800, 500);
        REQUIRE(sink.ctl.phase() == session::Phase::AwaitingPayload);
        FakeDataObject data = pdfData();
        TargetRef target(sink);
        g_cursor = POINT{kJpgSector.x, kJpgSector.y};
        DWORD effect = c.allowed;
        CHECK_EQ(target->DragEnter(&data, MK_LBUTTON | MK_SHIFT, kJpgSector, &effect), S_OK);
        CHECK_EQ(effect, c.expected);
        effect = c.allowed;
        CHECK_EQ(target->DragOver(MK_LBUTTON | MK_SHIFT, kJpgSector, &effect), S_OK);
        CHECK_EQ(effect, c.expected);
        CHECK((effect & (DROPEFFECT_MOVE | DROPEFFECT_LINK)) == 0);  // never Move (deletes the source) or Link
        effect = c.allowed;
        CHECK_EQ(target->Drop(&data, MK_SHIFT, kJpgSector, &effect), S_OK);
        CHECK_EQ(effect, c.expected);
        CHECK_EQ(sink.count("drop"), size_t{c.expected == DROPEFFECT_COPY ? 1u : 0u});
        if (c.expected == DROPEFFECT_NONE) CHECK_EQ(sink.last("cancelled").get("reason")->asString(), std::string("invalidPayload"));
        CHECK_EQ(sink.depth, 0);
        CHECK_EQ(sink.maxDepth, 1);
    }
}

TEST_CASE("ole: exactly one drop per session") {
    TestSink sink;
    sink.openWheel(800, 500);
    FakeDataObject data = pdfData();
    TargetRef target(sink);
    g_cursor = POINT{kJpgSector.x, kJpgSector.y};
    DWORD effect = DROPEFFECT_COPY | DROPEFFECT_MOVE;
    target->DragEnter(&data, MK_LBUTTON, kJpgSector, &effect);
    CHECK_EQ(sink.model.captionText, std::string("JPG"));  // the secondary caption repeats the armed choice
    effect = DROPEFFECT_COPY | DROPEFFECT_MOVE;
    CHECK_EQ(target->Drop(&data, 0, kJpgSector, &effect), S_OK);
    CHECK_EQ(effect, static_cast<DWORD>(DROPEFFECT_COPY));
    const json::Value drop = sink.last("drop");
    CHECK_EQ(drop.get("actionId")->asString(), std::string("convert.jpeg"));
    CHECK_EQ(drop.get("dropEffect")->asString(), std::string("copy"));
    CHECK_EQ(drop.get("files")->asArray()[0].asString(), std::string("C:\\Users\\me\\Docs\\Page 001.pdf"));
    // A second Drop / DragEnter for the same session is refused.
    effect = DROPEFFECT_COPY;
    target->Drop(&data, 0, kJpgSector, &effect);
    CHECK_EQ(effect, static_cast<DWORD>(DROPEFFECT_NONE));
    effect = DROPEFFECT_COPY;
    target->DragEnter(&data, 0, kJpgSector, &effect);
    CHECK_EQ(effect, static_cast<DWORD>(DROPEFFECT_NONE));
    CHECK_EQ(sink.count("drop"), size_t{1});
    CHECK(!sink.visible);
}

TEST_CASE("ole: CF_HDROP parsing keeps Unicode and long paths") {
    const std::wstring longDir = L"C:\\" + std::wstring(300, L'a');
    FakeDataObject data;
    data.hdrop = true;
    data.files = {
        L"C:\\Users\\\uD55C\uAE00\\Page 001.png",            // 한글
        L"D:\\\U0001F600 photos\\Holiday.PNG",               // emoji (surrogate pair)
        longDir + L"\\file.png",                             // > MAX_PATH
        L"\\\\server\\share\\scan.png",                       // UNC
    };
    const selection::DragPayload p = win::DropTarget::readPayload(&data);
    CHECK(p.hasFileList);
    CHECK(!p.badPath);
    CHECK(!p.virtualFilesOnly);
    CHECK_EQ(p.totalCount, size_t{4});
    REQUIRE(p.paths.size() == 4);
    CHECK_EQ(p.paths[0], std::string("C:\\Users\\\xED\x95\x9C\xEA\xB8\x80\\Page 001.png"));
    CHECK_EQ(p.paths[1], std::string("D:\\\xF0\x9F\x98\x80 photos\\Holiday.PNG"));
    CHECK_EQ(p.paths[2], "C:\\" + std::string(300, 'a') + "\\file.png");
    CHECK_EQ(p.paths[3], std::string("\\\\server\\share\\scan.png"));
    CHECK(!p.containsDirectory);  // no file-system calls in the callback

    // Through the target: all four paths arrive in the drop message.
    TestSink sink;
    sink.openWheel(800, 500);
    TargetRef target(sink);
    g_cursor = POINT{920, 500};  // image/png convert menu (8 sectors): this is sector 2, HEIC
    DWORD effect = DROPEFFECT_COPY;
    target->DragEnter(&data, 0, POINTL{920, 500}, &effect);
    CHECK_EQ(sink.folderChecks, 1);  // folders are checked off the UI thread
    effect = DROPEFFECT_COPY;
    target->Drop(&data, 0, POINTL{920, 500}, &effect);
    REQUIRE(sink.count("drop") == 1);
    // Keep the message alive: last() returns a temporary, and a reference into it would dangle
    // (MSVC reuses that memory at once; this read garbage there).
    const json::Value drop = sink.last("drop");
    const auto& files = drop.get("files")->asArray();
    REQUIRE(files.size() == 4);
    CHECK_EQ(files[2].asString(), p.paths[2]);
}

TEST_CASE("ole: unrepresentable and oversized file lists are refused") {
    FakeDataObject lone;
    lone.hdrop = true;
    lone.files = {std::wstring(L"C:\\a") + static_cast<wchar_t>(0xD800) + L".png"};  // unpaired surrogate
    CHECK(win::DropTarget::readPayload(&lone).badPath);

    FakeDataObject many;
    many.hdrop = true;
    for (int i = 0; i < 201; ++i) many.files.push_back(L"C:\\pics\\" + std::to_wstring(i) + L".png");
    const selection::DragPayload p = win::DropTarget::readPayload(&many);
    CHECK_EQ(p.totalCount, size_t{201});
    CHECK(p.paths.empty());

    TestSink sink;
    sink.openWheel(800, 500);
    TargetRef target(sink);
    g_cursor = POINT{920, 500};
    DWORD effect = DROPEFFECT_COPY;
    target->DragEnter(&many, 0, POINTL{920, 500}, &effect);
    CHECK_EQ(effect, static_cast<DWORD>(DROPEFFECT_NONE));
    CHECK(sink.model.unsupported);
    CHECK(win::DropTarget::readPayload(nullptr).paths.empty());
}

TEST_CASE("ole: virtual-only and non-file data are unsupported with their own text") {
    {
        TestSink sink;
        sink.openWheel(800, 500);
        FakeDataObject data;  // e.g. an Outlook attachment or a file inside a zip
        data.fileDescriptor = true;
        const selection::DragPayload p = win::DropTarget::readPayload(&data);
        CHECK(!p.hasFileList);
        CHECK(p.virtualFilesOnly);
        TargetRef target(sink);
        g_cursor = POINT{920, 500};
        DWORD effect = DROPEFFECT_COPY | DROPEFFECT_MOVE;
        target->DragEnter(&data, 0, POINTL{920, 500}, &effect);
        CHECK_EQ(effect, static_cast<DWORD>(DROPEFFECT_NONE));
        CHECK(sink.model.unsupported);
        CHECK_EQ(sink.model.capsuleText, std::string("No file on disk"));
        CHECK_EQ(sink.model.captionText, std::string("No file on disk"));  // repeated under the ring
        CHECK(sink.last("state").get("menuKey")->isNull());
        CHECK_EQ(sink.folderChecks, 0);
        effect = DROPEFFECT_COPY;
        target->Drop(&data, 0, POINTL{920, 500}, &effect);
        CHECK_EQ(effect, static_cast<DWORD>(DROPEFFECT_NONE));
        CHECK_EQ(sink.count("drop"), size_t{0});
    }
    {
        // Only the ANSI "FileGroupDescriptor" (no W form, no CF_HDROP): still virtual, not "not a file".
        FakeDataObject data;
        data.fileDescriptorAnsi = true;
        const selection::DragPayload p = win::DropTarget::readPayload(&data);
        CHECK(!p.hasFileList);
        CHECK(p.virtualFilesOnly);
        TestSink sink;
        sink.openWheel(800, 500);
        TargetRef target(sink);
        g_cursor = POINT{920, 500};
        DWORD effect = DROPEFFECT_COPY;
        target->DragEnter(&data, 0, POINTL{920, 500}, &effect);
        CHECK_EQ(effect, static_cast<DWORD>(DROPEFFECT_NONE));
        CHECK_EQ(sink.model.capsuleText, std::string("No file on disk"));
    }
    {
        TestSink sink;
        sink.openWheel(800, 500);
        FakeDataObject data;  // text or a URL from a browser
        data.text = true;
        TargetRef target(sink);
        g_cursor = POINT{920, 500};
        DWORD effect = DROPEFFECT_COPY;
        target->DragEnter(&data, 0, POINTL{920, 500}, &effect);
        CHECK_EQ(effect, static_cast<DWORD>(DROPEFFECT_NONE));
        CHECK_EQ(sink.model.capsuleText, std::string("Not a file"));
    }
}

TEST_CASE("ole: COM basics and argument checks") {
    TestSink sink;
    TargetRef target(sink);
    IUnknown* unknown = nullptr;
    CHECK_EQ(target->QueryInterface(__uuidof(IUnknown), reinterpret_cast<void**>(&unknown)), S_OK);
    REQUIRE(unknown != nullptr);
    unknown->Release();
    IDropTarget* dt = nullptr;
    CHECK_EQ(target->QueryInterface(__uuidof(IDropTarget), reinterpret_cast<void**>(&dt)), S_OK);
    REQUIRE(dt != nullptr);
    dt->Release();
    IDataObject* wrong = nullptr;
    CHECK_EQ(target->QueryInterface(__uuidof(IDataObject), reinterpret_cast<void**>(&wrong)), E_NOINTERFACE);
    CHECK(wrong == nullptr);
    FakeDataObject data = pdfData();
    CHECK_EQ(target->DragEnter(&data, 0, POINTL{0, 0}, nullptr), E_INVALIDARG);
    CHECK_EQ(target->DragOver(0, POINTL{0, 0}, nullptr), E_INVALIDARG);
    CHECK_EQ(target->Drop(&data, 0, POINTL{0, 0}, nullptr), E_INVALIDARG);
    // No session open: everything is refused, nothing is sent.
    DWORD effect = DROPEFFECT_COPY;
    target->DragEnter(&data, 0, POINTL{0, 0}, &effect);
    CHECK_EQ(effect, static_cast<DWORD>(DROPEFFECT_NONE));
    CHECK_EQ(target->DragLeave(), S_OK);
    CHECK(sink.sent.empty());
    CHECK_EQ(sink.depth, 0);
}
