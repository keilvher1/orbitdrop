// Small Win32 helpers shared by the helper's Windows layer.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "core/coords.h"

namespace od::win {

static_assert(sizeof(wchar_t) == 2, "Windows wchar_t is UTF-16");

/** Minimal intrusive COM pointer (no ATL/WRL dependency, works with MinGW). */
template <typename T>
class ComPtr {
public:
    ComPtr() = default;
    ComPtr(std::nullptr_t) {}
    ~ComPtr() { reset(); }
    ComPtr(const ComPtr& o) : p_(o.p_) {
        if (p_) p_->AddRef();
    }
    ComPtr(ComPtr&& o) noexcept : p_(o.p_) { o.p_ = nullptr; }
    ComPtr& operator=(ComPtr o) noexcept {
        std::swap(p_, o.p_);
        return *this;
    }
    /** Takes ownership of an already AddRef'ed pointer. */
    static ComPtr attach(T* p) {
        ComPtr c;
        c.p_ = p;
        return c;
    }
    T* get() const { return p_; }
    T* operator->() const { return p_; }
    explicit operator bool() const { return p_ != nullptr; }
    /** For out-parameters: releases the current pointer first. */
    T** put() {
        reset();
        return &p_;
    }
    void** putVoid() { return reinterpret_cast<void**>(put()); }
    void reset() {
        if (p_) {
            T* p = p_;
            p_ = nullptr;
            p->Release();
        }
    }

private:
    T* p_ = nullptr;
};

/** UTF-8 → UTF-16 (malformed input yields an empty string). */
std::wstring utf8ToWide(std::string_view s);
/** UTF-16 → UTF-8; `ok` = false (and "" returned) for unpaired surrogates. */
std::string wideToUtf8(std::wstring_view s, bool* ok = nullptr);

std::string hresultHex(HRESULT hr);
/** "10.0.22631" from RtlGetVersion (not subject to manifest-based version lies). */
std::string osVersionString();
bool isProcessElevated();
/** Effective DPI of a monitor (96 when unknown). */
UINT dpiForMonitor(HMONITOR monitor);
/** All monitors in physical pixels (requires Per-Monitor DPI awareness). */
std::vector<coords::Win32Monitor> enumerateMonitors();
/** Milliseconds since boot (monotonic). */
int64_t nowMs();
/** Seed for session ids unique across helper instances: pid + start time. */
std::string sessionIdSeed();

/** Writes text to stdout (attaching to the parent console when needed) — CLI modes only. */
void writeConsole(std::string_view text, bool toStderr = false);

}  // namespace od::win
