#!/usr/bin/env node
// Shared wheel geometry and menus for the Windows GUI driver, taken from the contracts the app and
// both native helpers use (so the driver aims at sectors with the same numbers the helper draws).
//
//   node --import tsx tests/windows-gui/geometry.mjs <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { ACTIONS, DEFAULT_WHEEL_GEOMETRY, baseMenuOrder, defaultSettingsFor } from '../../packages/contracts/src/index.ts';

// A first run on Windows starts from these settings (main: firstRunSettings → defaultSettingsFor(process.platform)),
// in the OS language: Korean → ko, anything else → en. The driver tells which one the app chose from its window titles.
const DEFAULT_SETTINGS = defaultSettingsFor('win32');
const LOCALES = ['ko', 'en'];
// Format labels (DOCX, JPG, …) are the same in both languages.
const menu = (key, mode) => baseMenuOrder(key, mode).map((actionId) => ({ actionId, label: ACTIONS[actionId].wheelLabel.en }));
// The centre texts main sends in `configure.strings` (the helper also puts the current one in the wheel window's title).
const messages = (locale) => JSON.parse(readFileSync(new URL(`../../apps/desktop/src/shared/locales/${locale}/main.json`, import.meta.url), 'utf8'));
for (const id of [...baseMenuOrder('pdf', 'convert'), ...baseMenuOrder('image/jpeg', 'convert')]) {
  if (ACTIONS[id].wheelLabel.ko !== ACTIONS[id].wheelLabel.en) throw new Error(`${id}: the wheel label differs between languages`);
}

const data = {
  source: "packages/contracts (DEFAULT_WHEEL_GEOMETRY, defaultSettingsFor('win32'), baseMenuOrder)",
  locales: LOCALES,
  // What main sends in `configure` for default settings (apps/desktop/src/main/helper/configure.ts).
  geometry: { ...DEFAULT_WHEEL_GEOMETRY, diameter: DEFAULT_SETTINGS.globalDrag.wheelDiameter },
  modifiers: { convert: DEFAULT_SETTINGS.globalDrag.convertModifiers, tools: DEFAULT_SETTINGS.globalDrag.toolsModifiers },
  // Caption strip beside the disc: native/windows/src/core/coords.h kCaptionGap / kCaptionHeight (DIP).
  captionStrip: { gap: 6, height: 26 },
  menus: {
    pdf: menu('pdf', 'convert'),
    'image/jpeg': menu('image/jpeg', 'convert'),
  },
  // Per language: centre texts, and the start of the first-run welcome window's title (main: windowTitle → 'window.welcome').
  strings: Object.fromEntries(
    LOCALES.map((locale) => {
      const m = messages(locale);
      return [locale, { dropHint: m['helper.dropHint'], unsupportedNonFile: m['helper.unsupportedNonFile'], welcomeTitle: m['window.welcome'] }];
    }),
  ),
};

const out = process.argv[2];
const json = `${JSON.stringify(data, null, 2)}\n`;
if (out) writeFileSync(out, json);
else process.stdout.write(json);
