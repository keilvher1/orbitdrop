#!/usr/bin/env node
// Proves that sharp + @napi-rs/canvas + pdf.js (+ pdf-lib, docx) load and
// convert under Electron's Node, bundled the way electron-vite bundles the
// processor host (CJS, @orbitdrop/* inlined, runtime dependencies external):
//
//   node tests/integration/convert-electron-smoke.mjs [node|utility|asar ...]
//
//   node     ELECTRON_RUN_AS_NODE=1 electron bundle.cjs        (process.type undefined)
//   utility  Electron main → utilityProcess.fork(bundle.cjs)    (process.type 'utility',
//            where pdf.js does NOT consider itself "Node")
//   asar     like utility, but bundle + pdfjs-dist packed in an app.asar (no asarUnpack),
//            to show whether pdfjs-dist must be unpacked when packaged
//   asar-native  like asar, plus sharp/@img/* and @napi-rs/* inside the archive with only
//            their native binaries (*.node, *.dylib, *.so, *.dll) unpacked — the
//            electron-builder layout with asarUnpack for native files
//
// Prints one JSON summary line `CONVERT_ELECTRON_SMOKE {...}` and exits 0 when all modes pass.
// Runtime dependencies resolve through a `node_modules` symlink to the repo's
// node_modules placed next to the bundle (utility processes ignore NODE_PATH).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = join(ROOT, 'tests', 'integration', 'convert-smoke-entry.ts');

export function electronBinary() {
  const bin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  return existsSync(bin) ? bin : null;
}

/** Bundle the entry to CJS with rolldown (the bundler of electron-vite 6 / Vite 8). */
export async function bundleEntry(outFile) {
  const { rolldown } = await import(pathToFileURL(join(ROOT, 'node_modules', 'rolldown', 'dist', 'index.mjs')).href);
  const build = await rolldown({
    input: ENTRY,
    platform: 'node',
    cwd: join(ROOT, 'tests', 'integration'),
    // Like electron-vite: workspace packages are bundled, dependencies stay external.
    external: (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('@orbitdrop/') && !/^[A-Za-z]:[\\/]/.test(id),
    logLevel: 'silent',
  });
  await build.write({ file: outFile, format: 'cjs' });
  await build.close();
  const code = await readFile(outFile, 'utf8');
  return {
    bytes: code.length,
    // How the bundler handled the constructs the PDF engine relies on.
    importMetaUrlPolyfilled: !code.includes('import.meta.url'),
    keepsDynamicImport: /\bimport\(/.test(code),
    requiresExternals: ['sharp', 'pdf-lib', 'docx', '@napi-rs/canvas'].filter((m) => code.includes(`require("${m}")`)),
  };
}

const ELECTRON_MAIN = `
const { app, utilityProcess } = require('electron');
const path = require('node:path');
if (process.platform === 'darwin' && app.dock) app.dock.hide();
app.whenReady().then(() => {
  const script = path.join(__dirname, 'smoke.cjs');
  const child = utilityProcess.fork(script, [], { stdio: 'pipe', env: process.env, serviceName: 'convert-smoke' });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', (code) => app.exit(code ?? 1));
});
app.on('window-all-closed', () => {});
`;

function runProcess(command, args, env, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('CONVERT_SMOKE '));
      let result = null;
      try {
        result = line ? JSON.parse(line.slice('CONVERT_SMOKE '.length)) : null;
      } catch {
        result = null;
      }
      resolvePromise({ code, result, stderr: stderr.split(/\r?\n/).filter(Boolean).slice(-8) });
    });
  });
}

export async function runConvertSmoke(modes = ['node', 'utility', 'asar'], { timeoutMs = 120_000 } = {}) {
  const electron = electronBinary();
  if (!electron) return { ok: false, error: 'electron binary not found (node_modules/.bin/electron)' };
  const work = await mkdtemp(join(tmpdir(), 'orbitdrop-electron-smoke-'));
  const summary = { ok: true, bundle: null, modes: {} };
  try {
    const appDir = join(work, 'app');
    await mkdir(appDir, { recursive: true });
    summary.bundle = await bundleEntry(join(appDir, 'smoke.cjs'));
    await writeFile(join(appDir, 'main.cjs'), ELECTRON_MAIN);
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'orbitdrop-convert-smoke', version: '0.0.0', main: 'main.cjs' }));
    const baseEnv = { ...process.env };
    delete baseEnv.ELECTRON_RUN_AS_NODE;
    delete baseEnv.NODE_PATH;
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    delete baseEnv.ORBITDROP_IMAGEIO_HELPER;

    for (const mode of modes) {
      let outcome;
      if ((mode === 'node' || mode === 'utility') && !existsSync(join(appDir, 'node_modules'))) {
        await symlink(join(ROOT, 'node_modules'), join(appDir, 'node_modules'), linkType);
      }
      if (mode === 'node') {
        outcome = await runProcess(electron, [join(appDir, 'smoke.cjs')], { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs);
      } else if (mode === 'utility') {
        outcome = await runProcess(electron, [appDir], baseEnv, timeoutMs);
      } else if (mode === 'asar' || mode === 'asar-native') {
        // app.asar = bundle + Electron main + a real copy of pdfjs-dist (nothing unpacked)
        // [+ sharp, @img/*, @napi-rs/* with only native binaries unpacked]. Everything
        // else resolves from <work>/node_modules (symlink), outside the archive.
        const stage = join(work, `${mode}-stage`);
        await mkdir(join(stage, 'node_modules'), { recursive: true });
        for (const file of ['smoke.cjs', 'main.cjs', 'package.json']) await cp(join(appDir, file), join(stage, file));
        const packed = mode === 'asar' ? ['pdfjs-dist'] : ['pdfjs-dist', 'sharp', '@img', '@napi-rs'];
        for (const pkg of packed) {
          await cp(join(ROOT, 'node_modules', pkg), join(stage, 'node_modules', pkg), { recursive: true, dereference: true, filter: (src) => !src.includes(`${sep}.bin`) });
        }
        if (!existsSync(join(work, 'node_modules'))) await symlink(join(ROOT, 'node_modules'), join(work, 'node_modules'), linkType);
        const { createPackageWithOptions } = await import(pathToFileURL(join(ROOT, 'node_modules', '@electron', 'asar', 'lib', 'asar.js')).href);
        const asarPath = join(work, `${mode}.asar`);
        await createPackageWithOptions(stage, asarPath, mode === 'asar' ? {} : { unpack: '**/*.{node,dylib,so,dll}' });
        outcome = await runProcess(electron, [asarPath], baseEnv, timeoutMs);
      } else {
        throw new Error(`unknown mode ${mode}`);
      }
      const passed = outcome.code === 0 && outcome.result?.ok === true;
      summary.modes[mode] = { passed, exitCode: outcome.code, ...(outcome.result ?? {}), ...(passed ? {} : { stderr: outcome.stderr }) };
      summary.ok &&= passed;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const modes = process.argv.slice(2);
  const summary = await runConvertSmoke(modes.length > 0 ? modes : undefined);
  console.log(`CONVERT_ELECTRON_SMOKE ${JSON.stringify(summary)}`);
  process.exit(summary.ok ? 0 : 1);
}
