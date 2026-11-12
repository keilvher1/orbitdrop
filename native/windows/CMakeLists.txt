# OrbitDrop Windows drag helper (C++17, Win32/OLE/Direct2D) and its portable core.
#
#   Windows (MSVC, static CRT):  cmake --preset msvc-x64 && cmake --build --preset msvc-x64-release
#                                ctest --preset msvc-x64-release
#   macOS/Linux portable tests:  cmake --preset host-tests && cmake --build --preset host-tests
#                                ctest --preset host-tests
#   MinGW-w64 cross compile:     cmake --preset mingw-x64 && cmake --build --preset mingw-x64
#                                (compile check only; the result is NOT verified on Windows)
#
# Or use scripts/build-native-win.mjs from the repository root.
cmake_minimum_required(VERSION 3.21)

project(OrbitDropHelper VERSION 0.1.0 DESCRIPTION "OrbitDrop native drag helper (Windows)" LANGUAGES CXX)

option(ORBITDROP_BUILD_TESTS "Build the portable core unit tests" ON)
option(ORBITDROP_BUILD_HELPER "Build the Win32 helper executable (Windows targets only)" ${WIN32})
option(ORBITDROP_STATIC_RUNTIME "Link the C/C++ runtime statically (MSVC /MT, MinGW -static)" ON)
option(ORBITDROP_WARNINGS_AS_ERRORS "Treat compiler warnings as errors" OFF)
option(ORBITDROP_SANITIZE "Build host tests with AddressSanitizer + UBSan (GCC/Clang)" OFF)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

get_filename_component(ORBITDROP_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

# Static CRT for MSVC: the helper must run without the VC++ redistributable.
if(MSVC AND ORBITDROP_STATIC_RUNTIME)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

# ------------------------------------------------------------------ common flags
add_library(orbitdrop_flags INTERFACE)
if(MSVC)
  # /fp:precise: no FMA contraction, so the JavaScript-compatible math in
  # src/core/jsmath.cpp rounds exactly like the reference (explicit std::fma only).
  # /guard:cf on every compile unit, the static core library included: Control
  # Flow Guard only checks indirect calls in objects compiled with it (the
  # session controller calls its Host through virtual functions).
  target_compile_options(orbitdrop_flags INTERFACE /W4 /permissive- /utf-8 /EHsc /fp:precise /Zc:__cplusplus /bigobj /guard:cf)
  target_compile_definitions(orbitdrop_flags INTERFACE _CRT_SECURE_NO_WARNINGS)
  # Warnings policy: MSVC builds at /W4 but warnings are not fatal by default:
  # this code has only been compiled by GCC/Clang so far (-Werror there), and
  # the first MSVC CI run must still produce an artifact. Turn on
  # ORBITDROP_WARNINGS_AS_ERRORS in the msvc presets once CI shows a clean log.
  if(ORBITDROP_WARNINGS_AS_ERRORS)
    target_compile_options(orbitdrop_flags INTERFACE /WX)
  endif()
else()
  target_compile_options(orbitdrop_flags INTERFACE -Wall -Wextra -Wshadow -ffp-contract=off)
  if(ORBITDROP_WARNINGS_AS_ERRORS)
    target_compile_options(orbitdrop_flags INTERFACE -Werror)
  endif()
  if(ORBITDROP_SANITIZE AND NOT WIN32)
    # UBSan findings abort the run (by default it prints and carries on, so a
    # test run could pass with undefined behaviour in the log).
    target_compile_options(orbitdrop_flags INTERFACE -fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer)
    target_link_options(orbitdrop_flags INTERFACE -fsanitize=address,undefined -fno-sanitize-recover=undefined)
  endif()
endif()

# ------------------------------------------------------------------ portable core (no Windows headers)
add_library(orbitdrop_core STATIC
  src/core/coords.cpp
  src/core/defaults.cpp
  src/core/geometry.cpp
  src/core/helper_core.cpp
  src/core/jsmath.cpp
  src/core/json.cpp
  src/core/protocol.cpp
  src/core/selection.cpp
  src/core/session.cpp
  src/core/text_wrap.cpp
  src/core/utf.cpp
  src/core/wheel_layout.cpp
)
target_include_directories(orbitdrop_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(orbitdrop_core PRIVATE orbitdrop_flags)
target_compile_definitions(orbitdrop_core PUBLIC ORBITDROP_HELPER_VERSION="${PROJECT_VERSION}")
if(NOT MSVC)
  target_compile_options(orbitdrop_core PRIVATE -Wnon-virtual-dtor)
endif()

# ------------------------------------------------------------------ unit tests
if(ORBITDROP_BUILD_TESTS)
  add_executable(orbitdrop-core-tests
    tests/test_main.cpp
    tests/test_coords.cpp
    tests/test_defaults.cpp
    tests/test_geometry.cpp
    tests/test_golden.cpp
    tests/test_helper_core.cpp
    tests/test_jsmath.cpp
    tests/test_json.cpp
    tests/test_layout.cpp
    tests/test_protocol.cpp
    tests/test_selection.cpp
    tests/test_session.cpp
    tests/test_text_wrap.cpp
    tests/test_utf.cpp
  )
  target_link_libraries(orbitdrop-core-tests PRIVATE orbitdrop_core orbitdrop_flags)
  target_compile_definitions(orbitdrop-core-tests PRIVATE
    OD_REPO_FIXTURES_DIR="${ORBITDROP_REPO_ROOT}/tests/fixtures"
    OD_TEST_DATA_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  if(MINGW AND ORBITDROP_STATIC_RUNTIME)
    target_link_options(orbitdrop-core-tests PRIVATE -static)
  endif()

  # Developer tool: rasterises the wheel layout to a PNG (no fonts) for visual checks.
  add_executable(orbitdrop-layout-preview tests/tools/layout_preview.cpp)
  target_link_libraries(orbitdrop-layout-preview PRIVATE orbitdrop_core orbitdrop_flags)
  if(MINGW AND ORBITDROP_STATIC_RUNTIME)
    target_link_options(orbitdrop-layout-preview PRIVATE -static)
  endif()

  # Developer tool: exposes the C++ protocol parser/serializers to
  # tests/tools/protocol-parity.mjs (zod schema cross-check, run with npx tsx).
  add_executable(orbitdrop-protocol-tool tests/tools/protocol_tool.cpp)
  target_link_libraries(orbitdrop-protocol-tool PRIVATE orbitdrop_core orbitdrop_flags)
  if(MINGW AND ORBITDROP_STATIC_RUNTIME)
    target_link_options(orbitdrop-protocol-tool PRIVATE -static)
  endif()

  enable_testing()
  if(NOT CMAKE_CROSSCOMPILING OR CMAKE_CROSSCOMPILING_EMULATOR)
    add_test(NAME core-tests COMMAND orbitdrop-core-tests --require-golden)
  endif()
endif()

# ------------------------------------------------------------------ Win32 helper
if(ORBITDROP_BUILD_HELPER)
  if(NOT WIN32)
    message(FATAL_ERROR "ORBITDROP_BUILD_HELPER requires a Windows target (MSVC or the MinGW-w64 toolchain file)")
  endif()
  enable_language(RC)

  # Version resource (+ the manifest for MinGW) generated with the project version.
  set(ORBITDROP_MANIFEST_PATH "${CMAKE_CURRENT_SOURCE_DIR}/res/OrbitDropHelper.manifest")
  set(ORBITDROP_RC_FILE "${CMAKE_CURRENT_BINARY_DIR}/OrbitDropHelper.rc")
  configure_file(res/OrbitDropHelper.rc.in "${ORBITDROP_RC_FILE}" @ONLY)

  add_executable(OrbitDropHelper WIN32
    src/win/accessibility.cpp
    src/win/app.cpp
    src/win/drop_target.cpp
    src/win/folder_check.cpp
    src/win/main.cpp
    src/win/renderer.cpp
    src/win/snapshot.cpp
    src/win/stdio_channel.cpp
    src/win/wheel_window.cpp
    src/win/win_util.cpp
    "${ORBITDROP_RC_FILE}"
  )
  target_link_libraries(OrbitDropHelper PRIVATE
    orbitdrop_core orbitdrop_flags
    ole32 oleaut32 uuid shell32 user32 gdi32 shcore d2d1 dwrite windowscodecs wtsapi32 advapi32)
  target_compile_definitions(OrbitDropHelper PRIVATE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX WINVER=0x0A00 _WIN32_WINNT=0x0A00)
  set_target_properties(OrbitDropHelper PROPERTIES OUTPUT_NAME "OrbitDropHelper")

  if(ORBITDROP_BUILD_TESTS)
    # OLE glue tests (Windows only): the real DropTarget and session controller
    # with a fake IDataObject — effects, one drop per session, CF_HDROP parsing,
    # virtual and non-file data. Headless, no window or real drag needed.
    add_executable(orbitdrop-ole-tests
      tests/test_main.cpp
      tests/win/test_ole_glue.cpp
      src/win/drop_target.cpp
      src/win/win_util.cpp
    )
    target_include_directories(orbitdrop-ole-tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/tests")
    target_link_libraries(orbitdrop-ole-tests PRIVATE
      orbitdrop_core orbitdrop_flags ole32 oleaut32 uuid shell32 user32 gdi32 shcore advapi32)
    target_compile_definitions(orbitdrop-ole-tests PRIVATE
      UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX WINVER=0x0A00 _WIN32_WINNT=0x0A00
      OD_REPO_FIXTURES_DIR="${ORBITDROP_REPO_ROOT}/tests/fixtures"
      OD_TEST_DATA_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
    if(MINGW AND ORBITDROP_STATIC_RUNTIME)
      target_link_options(orbitdrop-ole-tests PRIVATE -static)
    endif()
    if(NOT CMAKE_CROSSCOMPILING OR CMAKE_CROSSCOMPILING_EMULATOR)
      add_test(NAME ole-glue-tests COMMAND orbitdrop-ole-tests)
    endif()
  endif()

  if(MSVC)
    # CMake passes .manifest sources to the manifest tool/linker, which merge
    # res/OrbitDropHelper.msvc.manifest (PerMonitorV2 DPI awareness, long paths,
    # Win10/11 compatibility) with the default asInvoker trustInfo and embed it.
    target_sources(OrbitDropHelper PRIVATE res/OrbitDropHelper.msvc.manifest)
    # ASLR, DEP and the CFG table (the compile side is in orbitdrop_flags).
    target_link_options(OrbitDropHelper PRIVATE /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /guard:cf)
  else()
    # MinGW: windres embeds the manifest as RT_MANIFEST #1; Unicode entry point.
    set_source_files_properties("${ORBITDROP_RC_FILE}" PROPERTIES COMPILE_DEFINITIONS ORBITDROP_RC_EMBED_MANIFEST)
    target_link_options(OrbitDropHelper PRIVATE -municode -Wl,--dynamicbase -Wl,--nxcompat -Wl,--high-entropy-va)
    if(ORBITDROP_STATIC_RUNTIME)
      target_link_options(OrbitDropHelper PRIVATE -static -static-libgcc -static-libstdc++)
    endif()
  endif()
endif()
