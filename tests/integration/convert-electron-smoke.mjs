#!/usr/bin/env node
// Proves that sharp + @napi-rs/canvas + pdf.js (+ pdf-lib, docx) load and
// convert under Electron's Node, bundled the way electron-vite bundles the
// processor host (CJS, @orbitdrop/* inlined, runtime dependencies external),
// including PDF.js' CCITT, JBIG2 and JPEG 2000 decoders (the wasm ones must be
// read and instantiated in every mode, app.asar included):
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
//   memory   (opt-in, not in the default set) generates a large PDF (CONVERT_MEMORY_MB,
//            default 200; or measures CONVERT_MEMORY_INPUT) and converts it to TXT and JPG in a
//            utilityProcess started with --expose-gc, sampling the process RSS (convert-memory-entry.ts)
//
// Prints one JSON summary line `CONVERT_ELECTRON_SMOKE {...}` and exits 0 when all modes pass.
// Runtime dependencies resolve through a `node_modules` symlink to the repo's
// node_modules placed next to the bundle (utility processes ignore NODE_PATH).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = join(ROOT, 'tests', 'integration', 'convert-smoke-entry.ts');
const MEMORY_ENTRY = join(ROOT, 'tests', 'integration', 'convert-memory-entry.ts');

/**
 * The Electron executable itself (Electron.app/Contents/MacOS/Electron, electron.exe), as the
 * electron package resolves it — downloading the runtime on first use, like its launcher does.
 * Not node_modules/.bin/electron: on Windows that is a .cmd script, which Node refuses to spawn
 * without a shell (EINVAL, CVE-2024-27980), and the launcher's extra process would outlive a kill.
 */
export function electronBinary() {
  try {
    const bin = createRequire(join(ROOT, 'package.json'))('electron');
    return typeof bin === 'string' && existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** Bundle the entry to CJS with rolldown (the bundler of electron-vite 6 / Vite 8). */
export async function bundleEntry(outFile, entry = ENTRY) {
  const { rolldown } = await import(pathToFileURL(join(ROOT, 'node_modules', 'rolldown', 'dist', 'index.mjs')).href);
  const build = await rolldown({
    input: entry,
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
  const script = path.join(__dirname, process.env.CONVERT_SMOKE_SCRIPT || 'smoke.cjs');
  const execArgv = process.env.CONVERT_SMOKE_EXEC_ARGV ? JSON.parse(process.env.CONVERT_SMOKE_EXEC_ARGV) : [];
  const child = utilityProcess.fork(script, [], { stdio: 'pipe', env: process.env, execArgv, serviceName: 'convert-smoke' });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  // Exit once the child's output has been passed on: on Windows its 'exit' arrives before the last
  // data on its stdout pipe, and exiting right away lost the CONVERT_SMOKE line (exit 0, no output).
  let exitCode = null;
  let openStreams = 2;
  const finish = () => {
    if (exitCode !== null && openStreams === 0) process.stdout.write('', () => app.exit(exitCode));
  };
  child.stdout.on('end', () => { openStreams -= 1; finish(); });
  child.stderr.on('end', () => { openStreams -= 1; finish(); });
  child.on('exit', (code) => {
    exitCode = code ?? 1;
    finish();
    setTimeout(() => app.exit(exitCode), 10000); // the pipes never closed
  });
});
app.on('window-all-closed', () => {});
`;

/**
 * A PDF of about `megabytes` MiB: pages that each hold a ~2 MiB noise JPEG (incompressible) and a
 * line of text, written by pdf-lib in this (orchestrator) process.
 */
export async function makeLargePdf(path, megabytes) {
  const req = (await import('node:module')).createRequire(join(ROOT, 'packages', 'processors', 'package.json'));
  const sharp = req('sharp');
  const { PDFDocument, StandardFonts } = req('pdf-lib');
  const side = 1400;
  const noise = Buffer.alloc(side * side * 3);
  let x = 0x9e3779b9;
  for (let i = 0; i < noise.length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    noise[i] = x & 0xff;
  }
  const jpeg = await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  const pages = Math.max(1, Math.ceil((megabytes * 1024 * 1024) / jpeg.length));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n += 1) {
    const image = await doc.embedJpg(jpeg);
    const page = doc.addPage([612, 792]);
    page.drawImage(image, { x: 36, y: 100, width: 540, height: 540 });
    page.drawText(`Large PDF page ${n}`, { x: 36, y: 720, size: 18, font });
  }
  const bytes = await doc.save({ useObjectStreams: false });
  await writeFile(path, bytes);
  return { pages, bytes: bytes.length, mb: Math.round(bytes.length / 1048576) };
}

function runProcess(command, args, env, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('CONVERT_SMOKE '));
      let result = null;
      try {
        result = line ? JSON.parse(line.slice('CONVERT_SMOKE '.length)) : null;
      } catch {
        result = null;
      }
      const tail = (text) => text.split(/\r?\n/).filter(Boolean).slice(-8);
      resolvePromise({ code, signal, result, stderr: tail(stderr), stdout: tail(stdout.replace(/^CONVERT_SMOKE .*$/m, '')) });
    });
  });
}

export async function runConvertSmoke(modes = ['node', 'utility', 'asar'], { timeoutMs = 120_000 } = {}) {
  const electron = electronBinary();
  if (!electron) return { ok: false, error: 'electron binary not found (node_modules/electron)' };
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
    // CCITT/JBIG2/JPX PDFs the entry renders to prove PDF.js finds its wasm decoders in each mode.
    baseEnv.CONVERT_SMOKE_FIXTURES = join(ROOT, 'tests', 'fixtures', 'static');

    for (const mode of modes) {
      let outcome;
      if ((mode === 'node' || mode === 'utility' || mode === 'memory') && !existsSync(join(appDir, 'node_modules'))) {
        await symlink(join(ROOT, 'node_modules'), join(appDir, 'node_modules'), linkType);
      }
      if (mode === 'memory') {
        // CONVERT_MEMORY_INPUT measures an existing PDF instead (e.g. a 14 400 pt page).
        const pdfPath = process.env.CONVERT_MEMORY_INPUT ?? join(work, 'big.pdf');
        summary.memoryPdf = process.env.CONVERT_MEMORY_INPUT ? { path: pdfPath } : await makeLargePdf(pdfPath, Number(process.env.CONVERT_MEMORY_MB ?? 200));
        await bundleEntry(join(appDir, 'memory.cjs'), MEMORY_ENTRY);
        outcome = await runProcess(
          electron,
          [appDir],
          {
            ...baseEnv,
            CONVERT_SMOKE_SCRIPT: 'memory.cjs',
            CONVERT_SMOKE_EXEC_ARGV: JSON.stringify(['--expose-gc']),
            CONVERT_MEMORY_PDF: pdfPath,
            CONVERT_MEMORY_ACTIONS: process.env.CONVERT_MEMORY_ACTIONS ?? 'convert.txt,convert.jpeg',
          },
          Math.max(timeoutMs, 600_000),
        );
      } else if (mode === 'node') {
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
      summary.modes[mode] = {
        passed,
        exitCode: outcome.code,
        ...(outcome.result ?? {}),
        ...(passed ? {} : { signal: outcome.signal, stderr: outcome.stderr, stdout: outcome.stdout, resultOk: outcome.result?.ok ?? null }),
      };
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
