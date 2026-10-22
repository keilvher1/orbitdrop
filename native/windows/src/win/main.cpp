// OrbitDropHelper.exe — native drag helper for OrbitDrop on Windows.
//
// GUI-subsystem process spawned by the Electron main process with piped
// stdio. Speaks the NDJSON helper protocol v1 on stdin/stdout
// (packages/contracts/src/helper-protocol.ts) and exits after hiding any wheel
// when stdin reaches EOF.
//
//   OrbitDropHelper.exe                       helper mode (stdio pipes required)
//   OrbitDropHelper.exe --version             print the version
//   OrbitDropHelper.exe --render-snapshot …   render a wheel state to PNG (see snapshot.cpp)
#include "win/win_util.h"

#include <shellapi.h>

#include <string>
#include <vector>

#include "win/app.h"
#include "win/snapshot.h"

#ifndef ORBITDROP_HELPER_VERSION
#define ORBITDROP_HELPER_VERSION "0.0.0"
#endif

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::vector<std::wstring> args;
    if (argv != nullptr) {
        for (int i = 1; i < argc; ++i) args.emplace_back(argv[i]);
        LocalFree(argv);
    }
    for (const std::wstring& a : args) {
        if (a == L"--version") {
            od::win::writeConsole(std::string(ORBITDROP_HELPER_VERSION) + "\n");
            return 0;
        }
        if (a == L"--help" || a == L"-h" || a == L"/?") {
            od::win::writeConsole(
                "OrbitDropHelper " ORBITDROP_HELPER_VERSION "\n"
                "  (no arguments)          helper mode: NDJSON protocol v1 on stdin/stdout\n"
                "  --version               print the version\n"
                "  --render-snapshot OUT.png [--menu KEY] [--mode convert|tools] [--highlight N]\n"
                "        [--state neutral|active|unsupported|folder|cloud|virtual|nonfile] [--files N] [--scale S | --dpi N]\n"
                "        [--theme light|dark|high-contrast] [--locale ko|en] [--disable N,..] [--config FILE]\n");
            return 0;
        }
        if (a == L"--render-snapshot") return od::win::runSnapshot(args);
    }
    if (!args.empty()) {
        od::win::writeConsole("unknown arguments; see --help\n", true);
        return 2;
    }
    od::win::App app(instance);
    return app.run();
}
