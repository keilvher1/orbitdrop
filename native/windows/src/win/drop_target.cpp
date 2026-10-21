#include "win/drop_target.h"

#include <shellapi.h>
#include <shlobj.h>

#include <string>

#include "core/protocol.h"

namespace od::win {

namespace {

// CLSID_DragDropHelper (shlguid.h), defined here to avoid a link-time GUID dependency.
const CLSID kClsidDragDropHelper = {0x4657278a, 0x411b, 0x11d2, {0x83, 0x9a, 0x00, 0xc0, 0x4f, 0xd9, 0x18, 0xd0}};

CLIPFORMAT fileDescriptorFormat() {
    static const CLIPFORMAT cf = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW));
    return cf;
}

/** Holds the sink's OLE depth for the whole IDropTarget method. */
class OleGuard {
public:
    explicit OleGuard(DropSink* sink) : sink_(sink) {
        if (sink_ != nullptr) sink_->enterOle();
    }
    ~OleGuard() {
        if (sink_ != nullptr) sink_->leaveOle();
    }
    OleGuard(const OleGuard&) = delete;
    OleGuard& operator=(const OleGuard&) = delete;

private:
    DropSink* sink_;
};

}  // namespace

DropTarget::DropTarget(DropSink* sink, HWND window, CursorFn cursorFn, bool useDragImageHelper)
    : sink_(sink), window_(window), cursorFn_(cursorFn) {
    // Optional: shows the source's drag image (and drop tip) while over the wheel.
    if (useDragImageHelper) {
        CoCreateInstance(kClsidDragDropHelper, nullptr, CLSCTX_INPROC_SERVER, __uuidof(IDropTargetHelper), helper_.putVoid());
    }
}

DropTarget::~DropTarget() = default;

void DropTarget::detach() {
    sink_ = nullptr;
    helper_.reset();
}

HRESULT STDMETHODCALLTYPE DropTarget::QueryInterface(REFIID riid, void** object) {
    if (object == nullptr) return E_POINTER;
    if (IsEqualIID(riid, __uuidof(IUnknown)) || IsEqualIID(riid, __uuidof(IDropTarget))) {
        *object = static_cast<IDropTarget*>(this);
        AddRef();
        return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
}

ULONG STDMETHODCALLTYPE DropTarget::AddRef() { return static_cast<ULONG>(InterlockedIncrement(&refs_)); }

ULONG STDMETHODCALLTYPE DropTarget::Release() {
    const LONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return static_cast<ULONG>(n);
}

coords::PointI DropTarget::cursor(POINTL fallback, bool* valid) const {
    // Our process is Per-Monitor DPI Aware v2, so GetCursorPos is in physical
    // pixels. The POINTL from OLE is in the *source's* coordinate space, which
    // is virtualised when the source is not per-monitor DPI aware; prefer ours.
    POINT p;
    if (cursorFn_ != nullptr ? cursorFn_(&p) : GetCursorPos(&p) != 0) {
        if (valid) *valid = true;
        return coords::PointI{p.x, p.y};
    }
    if (valid) *valid = true;
    return coords::PointI{fallback.x, fallback.y};
}

selection::DragPayload DropTarget::readPayload(IDataObject* data) {
    selection::DragPayload p;
    if (data == nullptr) return p;
    FORMATETC fe{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
    STGMEDIUM stg{};
    if (SUCCEEDED(data->GetData(&fe, &stg))) {
        if (stg.tymed == TYMED_HGLOBAL && stg.hGlobal != nullptr) {
            const auto drop = static_cast<HDROP>(stg.hGlobal);
            const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
            p.hasFileList = true;
            p.totalCount = count;
            if (count <= proto::kMaxFiles) {
                p.paths.reserve(count);
                for (UINT i = 0; i < count; ++i) {
                    const UINT len = DragQueryFileW(drop, i, nullptr, 0);
                    if (len == 0 || len > proto::kMaxPathLength) {
                        p.badPath = true;
                        break;
                    }
                    std::wstring path(static_cast<size_t>(len) + 1, L'\0');
                    if (DragQueryFileW(drop, i, &path[0], len + 1) != len) {
                        p.badPath = true;
                        break;
                    }
                    path.resize(len);
                    bool ok = false;
                    std::string utf8 = wideToUtf8(path, &ok);
                    if (!ok || utf8.empty()) {  // unpaired surrogate: cannot be named in UTF-8 JSON
                        p.badPath = true;
                        break;
                    }
                    p.paths.push_back(std::move(utf8));
                }
            }
        }
        ReleaseStgMedium(&stg);
    } else {
        FORMATETC fd{fileDescriptorFormat(), nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
        if (data->QueryGetData(&fd) == S_OK) p.virtualFilesOnly = true;
    }
    return p;
}

HRESULT STDMETHODCALLTYPE DropTarget::DragEnter(IDataObject* data, DWORD, POINTL pt, DWORD* effect) {
    const OleGuard guard(sink_);
    if (effect == nullptr) return E_INVALIDARG;
    const DWORD allowed = *effect;
    *effect = DROPEFFECT_NONE;
    try {
        if (sink_ != nullptr) {
            selection::DragPayload payload;
            if (sink_->wantsPayload()) payload = readPayload(data);
            const session::Effect e = sink_->onDragEnter(payload, cursor(pt), (allowed & DROPEFFECT_COPY) != 0);
            *effect = e == session::Effect::Copy ? DROPEFFECT_COPY : DROPEFFECT_NONE;
        }
    } catch (...) {
        *effect = DROPEFFECT_NONE;
    }
    if (helper_) {
        POINT p{pt.x, pt.y};
        helper_->DragEnter(window_, data, &p, *effect);
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE DropTarget::DragOver(DWORD, POINTL pt, DWORD* effect) {
    const OleGuard guard(sink_);
    if (effect == nullptr) return E_INVALIDARG;
    const DWORD allowed = *effect;
    *effect = DROPEFFECT_NONE;
    try {
        if (sink_ != nullptr) {
            const session::Effect e = sink_->onDragOver(cursor(pt), (allowed & DROPEFFECT_COPY) != 0);
            *effect = e == session::Effect::Copy ? DROPEFFECT_COPY : DROPEFFECT_NONE;
        }
    } catch (...) {
        *effect = DROPEFFECT_NONE;
    }
    if (helper_) {
        POINT p{pt.x, pt.y};
        helper_->DragOver(&p, *effect);
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE DropTarget::DragLeave() {
    const OleGuard guard(sink_);
    try {
        if (sink_ != nullptr) {
            POINT p{};
            const bool valid = cursorFn_ != nullptr ? cursorFn_(&p) : GetCursorPos(&p) != 0;
            sink_->onDragLeave(valid, coords::PointI{valid ? p.x : 0, valid ? p.y : 0});
        }
    } catch (...) {
    }
    if (helper_) helper_->DragLeave();
    return S_OK;
}

HRESULT STDMETHODCALLTYPE DropTarget::Drop(IDataObject* data, DWORD, POINTL pt, DWORD* effect) {
    const OleGuard guard(sink_);
    if (effect == nullptr) return E_INVALIDARG;
    const DWORD allowed = *effect;
    *effect = DROPEFFECT_NONE;
    try {
        if (sink_ != nullptr) {
            // Copy the paths now: the data object must not be used after Drop returns.
            const selection::DragPayload payload = readPayload(data);
            const session::Effect e = sink_->onDrop(payload, cursor(pt), (allowed & DROPEFFECT_COPY) != 0);
            *effect = e == session::Effect::Copy ? DROPEFFECT_COPY : DROPEFFECT_NONE;
        }
    } catch (...) {
        *effect = DROPEFFECT_NONE;
    }
    if (helper_) {
        POINT p{pt.x, pt.y};
        helper_->Drop(data, &p, *effect);
    }
    return S_OK;
}

}  // namespace od::win
