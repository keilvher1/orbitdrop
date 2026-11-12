// Reference configuration mirroring the contracts defaults (design tokens,
// DEFAULT_WHEEL_GEOMETRY, menu orders, action labels, format extensions).
//
// Used only where no `configure` message exists: `--render-snapshot`, unit
// tests and the layout preview tool. At runtime main's `configure` message is
// authoritative (it also carries the capability-based enabled flags).
#pragma once

#include <memory>
#include <string>

#include "core/protocol.h"

namespace od::defaults {

enum class Theme { Light, Dark, HighContrast };

proto::WheelTokens tokens(Theme theme, bool reduceMotion = false);

/**
 * All MENU_KEYS with every sector enabled, labels in `locale`. `analysis` adds the opt-in Claude
 * analysis sector (tool.analyze) to every tools menu: last after the image tools, and the only
 * sector of the PDF and mixed tools menus, which are empty without it.
 */
std::shared_ptr<proto::Configure> referenceConfigure(proto::Locale locale = proto::Locale::En, Theme theme = Theme::Light,
                                                     bool analysis = false);

/** Serialises a Configure as a `configure` protocol line (tests, tooling). */
std::string configureToJson(const proto::Configure& cfg);

}  // namespace od::defaults
