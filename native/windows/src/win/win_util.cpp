#include "win/win_util.h"

#include <shellscalingapi.h>

#include <cstdio>

namespace od::win {

std::wstring utf8ToWide(std::string_view s) {
    if (s.empty()) return std::wstring();
    const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring out(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), &out[0], n);
    return out;
}

std::string wideToUtf8(std::wstring_view s, bool* ok) {
    if (ok) *ok = true;
    if (s.empty()) return std::string();
    // WC_ERR_INVALID_CHARS: fail on unpaired surrogates instead of writing U+FFFD
    // (a replaced character would name a different file).
    const int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
    if (n <= 0) {
        if (ok) *ok = false;
        return std::string();
    }
    std::string out(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), &out[0], n, nullptr, nullptr);
    return out;
}

std::string hresultHex(HRESULT hr) {
    char buf[16];
    std::snprintf(buf, sizeof buf, "0x%08lX", static_cast<unsigned long>(hr));
    return buf;
}

std::string osVersionString() {
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    RTL_OSVERSIONINFOW info{};
    info.dwOSVersionInfoSize = sizeof info;
    if (HMODULE ntdll = GetModuleHandleW(L"ntdll.dll")) {
        const auto fn = reinterpret_cast<RtlGetVersionFn>(reinterpret_cast<void*>(GetProcAddress(ntdll, "RtlGetVersion")));
        if (fn != nullptr && fn(&info) == 0) {
            char buf[64];
            std::snprintf(buf, sizeof buf, "%lu.%lu.%lu", info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber);
            return buf;
        }
    }
    return "unknown";
}

namespace {

/** Mandatory integrity level (SECURITY_MANDATORY_*_RID) of a process; 0 when unknown. */
DWORD integrityLevelOf(HANDLE process) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return 0;
    DWORD level = 0;
    DWORD size = 0;
    GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);  // fails with the size needed
    if (size >= sizeof(TOKEN_MANDATORY_LABEL)) {
        std::vector<BYTE> buffer(size);
        if (GetTokenInformation(token, TokenIntegrityLevel, buffer.data(), size, &size)) {
            const PSID sid = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(buffer.data())->Label.Sid;
            if (sid != nullptr && IsValidSid(sid) && *GetSidSubAuthorityCount(sid) > 0) {
                level = *GetSidSubAuthority(sid, static_cast<DWORD>(*GetSidSubAuthorityCount(sid) - 1));
            }
        }
    }
    CloseHandle(token);
    return level;
}

}  // namespace

bool shellDragsBlockedByIntegrity() {
    // UIPI drops window messages, and with them OLE drag-and-drop, from a lower
    // integrity level to a higher one. TokenIsElevated alone is not the test: it
    // is also true for every administrator process when UAC is off, or for the
    // built-in Administrator, where Explorer runs at the same level and drags work.
    const DWORD self = integrityLevelOf(GetCurrentProcess());
    DWORD shell = 0;
    DWORD shellPid = 0;
    const HWND desktop = GetShellWindow();
    if (desktop != nullptr && GetWindowThreadProcessId(desktop, &shellPid) != 0 && shellPid != 0) {
        if (HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, shellPid)) {
            shell = integrityLevelOf(process);
            CloseHandle(process);
        }
    }
    if (self != 0 && shell != 0) return self > shell;
    // No shell to compare with: blocked when this is the elevated half of a UAC split token.
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    TOKEN_ELEVATION_TYPE type = TokenElevationTypeDefault;
    DWORD size = 0;
    const bool ok = GetTokenInformation(token, TokenElevationType, &type, sizeof type, &size) != 0;
    CloseHandle(token);
    return ok && type == TokenElevationTypeFull;
}

UINT dpiForMonitor(HMONITOR monitor) {
    UINT x = 96;
    UINT y = 96;
    if (monitor == nullptr || FAILED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &x, &y)) || x == 0) return 96;
    return x;
}

namespace {

BOOL CALLBACK collectMonitor(HMONITOR monitor, HDC, LPRECT, LPARAM param) {
    auto* out = reinterpret_cast<std::vector<coords::Win32Monitor>*>(param);
    MONITORINFOEXW mi{};
    mi.cbSize = sizeof mi;
    if (!GetMonitorInfoW(monitor, &mi)) return TRUE;
    coords::Win32Monitor m;
    m.id = wideToUtf8(mi.szDevice);
    m.bounds = geo::Rect{static_cast<double>(mi.rcMonitor.left), static_cast<double>(mi.rcMonitor.top),
                         static_cast<double>(mi.rcMonitor.right - mi.rcMonitor.left),
                         static_cast<double>(mi.rcMonitor.bottom - mi.rcMonitor.top)};
    m.workArea = geo::Rect{static_cast<double>(mi.rcWork.left), static_cast<double>(mi.rcWork.top),
                           static_cast<double>(mi.rcWork.right - mi.rcWork.left), static_cast<double>(mi.rcWork.bottom - mi.rcWork.top)};
    m.dpi = dpiForMonitor(monitor);
    m.primary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
    out->push_back(m);
    return TRUE;
}

}  // namespace

std::vector<coords::Win32Monitor> enumerateMonitors() {
    std::vector<coords::Win32Monitor> out;
    EnumDisplayMonitors(nullptr, nullptr, collectMonitor, reinterpret_cast<LPARAM>(&out));
    return out;
}

int64_t nowMs() { return static_cast<int64_t>(GetTickCount64()); }

std::string sessionIdSeed() {
    FILETIME ft{};
    GetSystemTimeAsFileTime(&ft);
    const uint64_t t = (static_cast<uint64_t>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
    char buf[48];
    std::snprintf(buf, sizeof buf, "w%lx-%llx", static_cast<unsigned long>(GetCurrentProcessId()),
                  static_cast<unsigned long long>(t & 0xFFFFFFFFFFFFull));
    return buf;
}

void writeConsole(std::string_view text, bool toStderr) {
    HANDLE h = GetStdHandle(toStderr ? STD_ERROR_HANDLE : STD_OUTPUT_HANDLE);
    bool owned = false;
    if (h == nullptr || h == INVALID_HANDLE_VALUE) {
        // GUI-subsystem process started from a console: attach to it for CLI output.
        if (AttachConsole(ATTACH_PARENT_PROCESS)) {
            h = CreateFileW(L"CONOUT$", GENERIC_WRITE, FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
            owned = h != INVALID_HANDLE_VALUE;
        }
    }
    if (h == nullptr || h == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    WriteFile(h, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
    if (owned) CloseHandle(h);
}

}  // namespace od::win
