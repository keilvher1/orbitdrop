#pragma once

#include <string>
#include <vector>

#include "win/win_util.h"

namespace od::win {

/** `--render-snapshot` CLI mode (see snapshot.cpp). Returns the process exit code. */
int runSnapshot(const std::vector<std::wstring>& args);

}  // namespace od::win
