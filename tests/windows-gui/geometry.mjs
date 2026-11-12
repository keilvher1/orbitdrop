#!/usr/bin/env node
// Shared wheel geometry and menus for the Windows GUI driver, taken from the contracts the app and
// both native helpers use (so the driver aims at sectors with the same numbers the helper draws).
//
//   node --import tsx tests/windows-gui/geometry.mjs <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { ACTIONS, DEFAULT_WHEEL_GEOMETRY, baseMenuOrder, defaultSettingsFor } from '../../packages/contracts/src/index.ts';

// A first run on Windows starts from these settings (main: defaultSettingsFor(process.platform)).
const DEFAULT_SETTINGS = defaultSettingsFor('win32');
const locale = DEFAULT_SETTINGS.locale;
const menu = (key, mode) => baseMenuOrder(key, mode).map((actionId) => ({ actionId, label: ACTIONS[actionId].wheelLabel[locale] }));
// The centre texts main sends in `configure.strings` (the helper also puts the current one in the wheel window's title).
const messages = JSON.parse(readFileSync(new URL(`../../apps/desktop/src/shared/locales/${locale}/main.json`, import.meta.url), 'utf8'));

const data = {
  source: "packages/contracts (DEFAULT_WHEEL_GEOMETRY, defaultSettingsFor('win32'), baseMenuOrder)",
  locale,
  // What main sends in `configure` for default settings (apps/desktop/src/main/helper/configure.ts).
  geometry: { ...DEFAULT_WHEEL_GEOMETRY, diameter: DEFAULT_SETTINGS.globalDrag.wheelDiameter },
  modifiers: { convert: DEFAULT_SETTINGS.globalDrag.convertModifiers, tools: DEFAULT_SETTINGS.globalDrag.toolsModifiers },
  // Caption strip beside the disc: native/windows/src/core/coords.h kCaptionGap / kCaptionHeight (DIP).
  captionStrip: { gap: 6, height: 26 },
  menus: {
    pdf: menu('pdf', 'convert'),
    'image/jpeg': menu('image/jpeg', 'convert'),
  },
  strings: {
    dropHint: messages['helper.dropHint'],
    unsupportedNonFile: messages['helper.unsupportedNonFile'],
    // Title of the first-run welcome window (main: windowTitle → 'window.welcome').
    welcomeTitle: messages['window.welcome'],
  },
};

const out = process.argv[2];
const json = `${JSON.stringify(data, null, 2)}\n`;
if (out) writeFileSync(out, json);
else process.stdout.write(json);
