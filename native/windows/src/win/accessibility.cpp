#include "win/accessibility.h"

#include <oleauto.h>

namespace od::win {

namespace {

/** UIA entry points, loaded once from System32 (Windows 10 1709+ for notifications). */
struct UiaApi {
    using ReturnRawElementProviderFn = LRESULT(WINAPI*)(HWND, WPARAM, LPARAM, IRawElementProviderSimple*);
    using HostProviderFromHwndFn = HRESULT(WINAPI*)(HWND, IRawElementProviderSimple**);
    using RaiseNotificationEventFn = HRESULT(WINAPI*)(IRawElementProviderSimple*, NotificationKind, NotificationProcessing, BSTR, BSTR);
    using DisconnectProviderFn = HRESULT(WINAPI*)(IRawElementProviderSimple*);
    using ClientsAreListeningFn = BOOL(WINAPI*)();

    ReturnRawElementProviderFn returnRawElementProvider = nullptr;
    HostProviderFromHwndFn hostProviderFromHwnd = nullptr;
    RaiseNotificationEventFn raiseNotificationEvent = nullptr;
    DisconnectProviderFn disconnectProvider = nullptr;
    ClientsAreListeningFn clientsAreListening = nullptr;
};

template <typename T>
T load(HMODULE m, const char* name) {
    return reinterpret_cast<T>(reinterpret_cast<void*>(GetProcAddress(m, name)));
}

const UiaApi& uia() {
    static const UiaApi api = [] {
        UiaApi a;
        HMODULE m = LoadLibraryExW(L"uiautomationcore.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (m == nullptr) return a;
        a.returnRawElementProvider = load<UiaApi::ReturnRawElementProviderFn>(m, "UiaReturnRawElementProvider");
        a.hostProviderFromHwnd = load<UiaApi::HostProviderFromHwndFn>(m, "UiaHostProviderFromHwnd");
        a.raiseNotificationEvent = load<UiaApi::RaiseNotificationEventFn>(m, "UiaRaiseNotificationEvent");
        a.disconnectProvider = load<UiaApi::DisconnectProviderFn>(m, "UiaDisconnectProvider");
        a.clientsAreListening = load<UiaApi::ClientsAreListeningFn>(m, "UiaClientsAreListening");
        return a;
    }();
    return api;
}

}  // namespace

WheelAccessible::WheelAccessible(HWND hwnd) : hwnd_(hwnd) {}

WheelAccessible::~WheelAccessible() = default;

HRESULT STDMETHODCALLTYPE WheelAccessible::QueryInterface(REFIID riid, void** object) {
    if (object == nullptr) return E_POINTER;
    if (IsEqualIID(riid, __uuidof(IUnknown)) || IsEqualIID(riid, __uuidof(IRawElementProviderSimple))) {
        *object = static_cast<IRawElementProviderSimple*>(this);
        AddRef();
        return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
}

ULONG STDMETHODCALLTYPE WheelAccessible::AddRef() { return static_cast<ULONG>(InterlockedIncrement(&refs_)); }

ULONG STDMETHODCALLTYPE WheelAccessible::Release() {
    const LONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return static_cast<ULONG>(n);
}

HRESULT STDMETHODCALLTYPE WheelAccessible::get_ProviderOptions(ProviderOptions* options) {
    if (options == nullptr) return E_POINTER;
    // UseComThreading: UIA calls us on our own STA (UI) thread.
    *options = static_cast<ProviderOptions>(ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading);
    return S_OK;
}

HRESULT STDMETHODCALLTYPE WheelAccessible::GetPatternProvider(PATTERNID, IUnknown** provider) {
    if (provider == nullptr) return E_POINTER;
    *provider = nullptr;
    return S_OK;
}

HRESULT STDMETHODCALLTYPE WheelAccessible::GetPropertyValue(PROPERTYID propertyId, VARIANT* value) {
    if (value == nullptr) return E_POINTER;
    value->vt = VT_EMPTY;
    const auto bstr = [&](const std::wstring& s) {
        value->vt = VT_BSTR;
        value->bstrVal = SysAllocString(s.c_str());
        if (value->bstrVal == nullptr) value->vt = VT_EMPTY;
    };
    switch (propertyId) {
        case UIA_NamePropertyId:
            bstr(current_.empty() ? baseName_ : baseName_ + L": " + current_);
            break;
        case UIA_LocalizedControlTypePropertyId:
            bstr(controlType_);
            break;
        case UIA_AutomationIdPropertyId:
            bstr(L"OrbitDropWheel");
            break;
        case UIA_ControlTypePropertyId:
            value->vt = VT_I4;
            value->lVal = UIA_PaneControlTypeId;
            break;
        case UIA_IsKeyboardFocusablePropertyId:
            value->vt = VT_BOOL;
            value->boolVal = VARIANT_FALSE;
            break;
        default:
            break;  // VT_EMPTY: let the host provider answer
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE WheelAccessible::get_HostRawElementProvider(IRawElementProviderSimple** provider) {
    if (provider == nullptr) return E_POINTER;
    *provider = nullptr;
    if (hwnd_ == nullptr || uia().hostProviderFromHwnd == nullptr) return S_OK;
    return uia().hostProviderFromHwnd(hwnd_, provider);
}

void WheelAccessible::setNames(const std::wstring& name, const std::wstring& controlType) {
    baseName_ = name;
    controlType_ = controlType;
}

void WheelAccessible::announce(const std::wstring& text, bool force) {
    if (text.empty() || hwnd_ == nullptr || (!force && text == current_)) return;
    current_ = text;
    // MSAA clients: the window title is the accessible name.
    SetWindowTextW(hwnd_, (baseName_ + L": " + text).c_str());
    NotifyWinEvent(EVENT_OBJECT_NAMECHANGE, hwnd_, OBJID_CLIENT, CHILDID_SELF);
    const UiaApi& api = uia();
    if (api.raiseNotificationEvent == nullptr) return;
    if (api.clientsAreListening != nullptr && !api.clientsAreListening()) return;
    BSTR display = SysAllocString(text.c_str());
    BSTR activity = SysAllocString(L"OrbitDropWheel");
    if (display != nullptr && activity != nullptr) {
        // MostRecent: rapid pointer moves only speak the latest sector.
        api.raiseNotificationEvent(this, NotificationKind_Other, NotificationProcessing_MostRecent, display, activity);
    }
    SysFreeString(display);
    SysFreeString(activity);
}

LRESULT WheelAccessible::handleGetObject(WPARAM wp, LPARAM lp) {
    if (static_cast<LONG>(lp) != static_cast<LONG>(UiaRootObjectId) || uia().returnRawElementProvider == nullptr) return 0;
    return uia().returnRawElementProvider(hwnd_, wp, lp, this);
}

void WheelAccessible::disconnect() {
    const UiaApi& api = uia();
    if (hwnd_ != nullptr && api.returnRawElementProvider != nullptr) api.returnRawElementProvider(hwnd_, 0, 0, nullptr);
    if (api.disconnectProvider != nullptr) api.disconnectProvider(this);
    hwnd_ = nullptr;
}

}  // namespace od::win
