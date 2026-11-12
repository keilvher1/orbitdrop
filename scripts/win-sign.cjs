// electron-builder custom Windows signing hook (win.signtoolOptions.sign in apps/desktop/electron-builder.yml,
// through the shim apps/desktop/build/win-sign.cjs).
//
// electron-builder calls it for every file it would sign: OrbitDrop.exe (right after editing its version
// resources), resources\helper\OrbitDropHelper.exe (when copying the extra resources), the NSIS uninstaller
// (<installer>__uninstaller.exe, before it is packed into the installer) and the installer itself — once per
// signing hash; the OrbitDrop-specific work happens on the first call (configuration.isNest is false).
//
//  1. OrbitDrop.exe: the ProductVersion string becomes the release version. electron-builder writes the
//     four-part form there (1.0.1.0) while the installer, the uninstaller and the helper say 1.0.1; SignPath
//     Foundation wants one product version on every signed file (scripts/win-files.mjs checks all four).
//  2. The uninstaller: when ORBITDROP_SIGNED_UNINSTALLER is set (the SignPath "installer" stage of
//     scripts/package.mjs), it is replaced by that signed copy, after checking that the copy is exactly
//     this file plus a signature (NSIS regenerates the same uninstaller from the same script). The final
//     uninstaller is copied to ORBITDROP_UNINSTALLER_COPY: package.mjs reads its version information, and
//     the SignPath "prepare" stage sends that copy to be signed.
//  3. Every call is recorded in ORBITDROP_SIGN_LOG (JSON lines), so the build report shows what
//     electron-builder wanted signed.
//  4. Signing: with a certificate (WIN_CSC_LINK / CSC_LINK) exactly what electron-builder does by itself
//     (signtool, every hash); without one nothing is signed here — an unsigned build, or SignPath signs the
//     files afterwards (.github/workflows/release.yml, docs/packaging.md).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const UNINSTALLER = /__uninstaller\.exe$/i;
const log = (msg) => console.log(`  • [win-sign] ${msg}`);

/** resedit, the copy electron-builder edits the version resources with. */
function resedit() {
  return createRequire(require.resolve('app-builder-lib/package.json'))('resedit');
}

/** Sets the ProductVersion string of every language block to `version` (the numeric fields stay). */
function setProductVersionString(file, version) {
  const { NtExecutable, NtExecutableResource, Resource } = resedit();
  const exe = NtExecutable.from(fs.readFileSync(file));
  const res = NtExecutableResource.from(exe);
  const [info] = Resource.VersionInfo.fromEntries(res.entries);
  if (!info) throw new Error(`${path.basename(file)} has no version information`);
  const languages = info.getAllLanguagesForStringValues();
  if (languages.length === 0) throw new Error(`${path.basename(file)} has no version strings`);
  for (const language of languages) info.setStringValues(language, { ProductVersion: version });
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function injectSignedUninstaller(file, signedCopy) {
  const { signatureAddedOnly } = await import(pathToFileURL(path.join(__dirname, 'win-files.mjs')).href);
  const match = signatureAddedOnly(fs.readFileSync(file), fs.readFileSync(signedCopy));
  if (!match.ok) {
    throw new Error(`the signed uninstaller (${signedCopy}) is not the uninstaller NSIS generated now plus a signature: ${match.reason}`);
  }
  fs.copyFileSync(signedCopy, file);
  log(`uninstaller: the signed copy goes into the installer (sha256 ${sha256(file).slice(0, 16)}…)`);
}

async function sign(configuration, packager) {
  const file = configuration.path;
  const name = path.basename(file);
  if (!configuration.isNest) {
    const env = process.env;
    const mainExe = `${packager.appInfo.productFilename}.exe`;
    if (name.toLowerCase() === mainExe.toLowerCase() && !/[\\/]resources[\\/]/i.test(file)) {
      setProductVersionString(file, packager.appInfo.version);
      log(`${name}: ProductVersion ${packager.appInfo.version}`);
    }
    if (UNINSTALLER.test(name)) {
      if (env.ORBITDROP_SIGNED_UNINSTALLER) await injectSignedUninstaller(file, env.ORBITDROP_SIGNED_UNINSTALLER);
      if (env.ORBITDROP_UNINSTALLER_COPY) {
        fs.mkdirSync(path.dirname(env.ORBITDROP_UNINSTALLER_COPY), { recursive: true });
        fs.copyFileSync(file, env.ORBITDROP_UNINSTALLER_COPY);
      }
    }
    if (env.ORBITDROP_SIGN_LOG) {
      const entry = { name: UNINSTALLER.test(name) ? 'uninstaller' : name, file, certificate: Boolean(configuration.cscInfo) };
      fs.appendFileSync(env.ORBITDROP_SIGN_LOG, `${JSON.stringify(entry)}\n`);
    }
  }
  if (configuration.cscInfo) {
    const manager = await packager.signingManager.value;
    return manager.doSign(configuration, packager);
  }
  return undefined;
}

module.exports = sign;
module.exports.sign = sign;
module.exports.setProductVersionString = setProductVersionString;
