// OLE IDropTarget registered on the wheel window (RegisterDragDrop).
//
// DragEnter reads CF_HDROP (DragQueryFileW) into owned UTF-8 strings and
// detects virtual files (CFSTR_FILEDESCRIPTORW/A without CF_HDROP); DragOver
// hit-tests and sets *pdwEffect; Drop copies the paths again before returning
// (the IDataObject is never kept). The effect is DROPEFFECT_COPY only when the
// source allows it, else DROPEFFECT_NONE — never MOVE or LINK.
// IDropTargetHelper keeps the shell drag image visible over the wheel.
// All calls arrive on the UI (STA) thread and only copy data: no file-system
// calls run here (folders are detected off the UI thread, see folder_check.h;
// main validates every dropped path anyway).
#pragma once

#include "win/win_util.h"

#include <ole2.h>
#include <shobjidl.h>

#include "core/coords.h"
#include "core/selection.h"
#include "core/session.h"

namespace od::win {

/** Receiver of drop events (the App, which forwards to the session controller). */
class DropSink {
public:
    virtual ~DropSink() = default;
    /** Bracket every IDropTarget method (including IDataObject::GetData and the
     *  IDropTargetHelper calls, whose COM wait loops may dispatch sent messages):
     *  window operations requested inside are deferred until OLE has returned. */
    virtual void enterOle() = 0;
    virtual void leaveOle() = 0;
    virtual bool wantsPayload() = 0;
    virtual session::Effect onDragEnter(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed) = 0;
    virtual session::Effect onDragOver(coords::PointI pointer, bool copyAllowed) = 0;
    virtual void onDragLeave(bool pointerValid, coords::PointI pointer) = 0;
    virtual session::Effect onDrop(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed) = 0;
};

class DropTarget final : public IDropTarget {
public:
    /** Where the pointer is, in physical screen pixels (default: GetCursorPos). */
    using CursorFn = bool (*)(POINT* out);

    /** `useDragImageHelper` = false skips IDropTargetHelper (unit tests). */
    DropTarget(DropSink* sink, HWND window, CursorFn cursorFn = nullptr, bool useDragImageHelper = true);
    DropTarget(const DropTarget&) = delete;
    DropTarget& operator=(const DropTarget&) = delete;

    /** Stops forwarding (the sink is going away); OLE may still hold references. */
    void detach();

    // IUnknown
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;

    // IDropTarget
    HRESULT STDMETHODCALLTYPE DragEnter(IDataObject* data, DWORD keyState, POINTL pt, DWORD* effect) override;
    HRESULT STDMETHODCALLTYPE DragOver(DWORD keyState, POINTL pt, DWORD* effect) override;
    HRESULT STDMETHODCALLTYPE DragLeave() override;
    HRESULT STDMETHODCALLTYPE Drop(IDataObject* data, DWORD keyState, POINTL pt, DWORD* effect) override;

    /** Copies the file list out of a data object (exposed for diagnostics). */
    static selection::DragPayload readPayload(IDataObject* data);

private:
    ~DropTarget();
    coords::PointI cursor(POINTL fallback, bool* valid = nullptr) const;

    volatile LONG refs_ = 1;
    DropSink* sink_;
    HWND window_;
    CursorFn cursorFn_;
    ComPtr<IDropTargetHelper> helper_;
};

}  // namespace od::win
