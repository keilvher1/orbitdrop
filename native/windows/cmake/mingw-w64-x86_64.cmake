# CMake toolchain file: cross compile for Windows x64 with MinGW-w64
# (Homebrew `mingw-w64` on macOS, `mingw-w64` packages on Linux).
#
# Override the compiler prefix with the MINGW_PREFIX environment variable, e.g.
#   MINGW_PREFIX=x86_64-w64-mingw32-posix   (Debian/Ubuntu posix-thread variant)
#
# The output is a compile check: binaries built this way are not verified on
# Windows (scripts/build-native-win.mjs labels them accordingly).
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(_orbitdrop_mingw_prefix "$ENV{MINGW_PREFIX}")
if(NOT _orbitdrop_mingw_prefix)
  set(_orbitdrop_mingw_prefix "x86_64-w64-mingw32")
endif()

find_program(CMAKE_C_COMPILER NAMES ${_orbitdrop_mingw_prefix}-gcc REQUIRED)
find_program(CMAKE_CXX_COMPILER NAMES ${_orbitdrop_mingw_prefix}-g++ REQUIRED)
find_program(CMAKE_RC_COMPILER NAMES x86_64-w64-mingw32-windres ${_orbitdrop_mingw_prefix}-windres REQUIRED)

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
