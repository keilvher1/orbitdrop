// UI Automation for the wheel window.
//
// The wheel never takes focus (it must not end the source's drag), so screen
// readers would not otherwise notice it. A minimal server-side UIA provider
// gives the window a name ("OrbitDrop wheel") and, whenever the selectable
// sector under the pointer (or the centre text) changes, raises a UIA
// notification event that Narrator speaks without focus, plus an MSAA name
// change for older clients. UIA functions are loaded on demand from
// uiautomationcore.dll, so the import table does not change.
#pragma once

#include "win/win_util.h"

#include <ole2.h>
#include <uiautomation.h>

#include <string>

namespace od::win {

class WheelAccessible final : public IRawElementProviderSimple {
public:
    explicit WheelAccessible(HWND hwnd);
    WheelAccessible(const WheelAccessible&) = delete;
    WheelAccessible& operator=(const WheelAccessible&) = delete;

    // IUnknown
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;

    // IRawElementProviderSimple
    HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions* options) override;
    HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID patternId, IUnknown** provider) override;
    HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID propertyId, VARIANT* value) override;
    HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple** provider) override;

    /** Window name and localized control type (from the configure locale). */
    void setNames(const std::wstring& name, const std::wstring& controlType);
    /** Speaks `text` (UIA notification) when it differs from the last announcement. */
    void announce(const std::wstring& text, bool force = false);
    /** WM_GETOBJECT: returns the provider for UiaRootObjectId, else 0. */
    LRESULT handleGetObject(WPARAM wp, LPARAM lp);
    /** Before the window is destroyed. */
    void disconnect();

private:
    ~WheelAccessible();

    volatile LONG refs_ = 1;
    HWND hwnd_;
    std::wstring baseName_ = L"OrbitDrop";
    std::wstring controlType_ = L"radial menu";
    std::wstring current_;  // last announced text
};

}  // namespace od::win
