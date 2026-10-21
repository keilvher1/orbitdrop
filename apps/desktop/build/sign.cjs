// electron-builder custom macOS signing hook (mac.sign in electron-builder.yml).
//
// Same as electron-builder's default (@electron/osx-sign signAsync with its options, retried on
// transient failures such as the timestamp server), except for the native drag helper under
// Contents/Resources/helper/: it gets the hardened runtime and NO entitlements
// (build/entitlements.helper.plist is an empty dictionary) instead of Electron's inherited
// entitlements. osx-sign requests a secure timestamp (--timestamp) for every file whenever a real
// identity is used, so a Developer ID build signs the helper with Developer ID + hardened
// runtime + secure timestamp; local ad-hoc builds use the same layout without a timestamp.
'use strict';

const path = require('node:path');

const HELPER_ENTITLEMENTS = path.join(__dirname, 'entitlements.helper.plist');

function isDragHelper(appPath, file) {
  const rel = path.relative(appPath, file).split(path.sep).join('/');
  return rel.startsWith('Contents/Resources/helper/');
}

async function signOrbitDrop(opts) {
  const { signAsync } = require('@electron/osx-sign');
  const base = opts.optionsForFile;
  const options = {
    ...opts,
    optionsForFile: (file) => {
      const perFile = base ? base(file) : {};
      return isDragHelper(opts.app, file) ? { ...perFile, entitlements: HELPER_ENTITLEMENTS, hardenedRuntime: true } : perFile;
    },
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await signAsync(options);
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`  ⚠ [sign] attempt ${attempt} failed (${err.message.split('\n')[0]}); retrying in ${5 * attempt}s`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

module.exports = signOrbitDrop;
module.exports.sign = signOrbitDrop;
module.exports.isDragHelper = isDragHelper;
