import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrbitError } from '@orbitdrop/contracts';
import { IMAGEIO_HELPER_ENV, decodeWithImageIO, encodeWithImageIO, probeImageIO } from '../src/codecs/imageio';
import { runConvert } from '../src/convert';
import { probeEngines } from '../src/probe';
import { REPO_ROOT, listFiles, makeCtx, makeFixtureDir, makeJob } from './helpers/convert-fixtures';

/**
 * The ImageIO bridge is tested against a fake helper that implements the CLI
 * contract from docs/architecture.md ("Shared paths"), so spawning, argument
 * passing, temp files, timeouts, cancellation and error mapping are covered on
 * every machine. The real macOS helper (built by the macos-helper workstream)
 * is exercised only when its binary exists.
 */

const FAKE_HELPER = `
const fs = require('node:fs');
const [, , mode, ...rest] = process.argv;
const behaviour = process.env.FAKE_IMAGEIO_MODE || 'ok';
if (mode !== 'imageio') process.exit(64);
if (behaviour === 'hang') setInterval(() => {}, 1000);
else if (behaviour === 'fail') { process.stderr.write('simulated failure\\n'); process.exit(3); }
else if (rest[0] === '--probe') {
  process.stdout.write('helper log line\\n' + JSON.stringify({ decode: ['heic', 'heif', 'png'], encode: ['heic'] }) + '\\n');
} else if (rest[0] === '--encode') {
  // --encode heic --quality Q in.png --out out.heic
  const [, format, , quality, input, , output] = rest;
  fs.writeFileSync(output, Buffer.concat([Buffer.from('FAKE' + format.toUpperCase() + ' q=' + quality + '\\n'), fs.readFileSync(input)]));
} else if (rest[0] === '--decode') {
  // --decode in --out out.png
  const [, input, , output] = rest;
  const data = fs.readFileSync(input);
  const nl = data.indexOf(10);
  if (data.subarray(0, 8).toString() === 'FAKEHEIC') fs.writeFileSync(output, data.subarray(nl + 1));
  else if (process.env.FAKE_IMAGEIO_SAMPLE_PNG) fs.copyFileSync(process.env.FAKE_IMAGEIO_SAMPLE_PNG, output);
  else { process.stderr.write('cannot decode\\n'); process.exit(2); }
} else process.exit(64);
`;

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof OrbitError ? e.code : `not-an-OrbitError: ${String(e)}`),
  );
}

async function imageioTempDirs(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n.startsWith('orbitdrop-imageio-'));
}

const REAL_TMP = tmpdir();

/**
 * Hermetic temp folders: other test files run (fake or real) ImageIO helpers in
 * parallel, so nothing here looks at the shared OS temp folder. Each test gets
 * its own TMPDIR (os.tmpdir() reads it on every call, and the bridge creates
 * its work folders there); after each test that folder must hold no
 * `orbitdrop-imageio-*` leftovers — including after timeouts and cancellation.
 */
function hermeticTmp(): { root: () => string; current: () => string } {
  let root = '';
  let current = '';
  let saved: string | undefined;
  beforeAll(async () => {
    root = await mkdtemp(join(REAL_TMP, 'orbitdrop-imageio-test-'));
  });
  beforeEach(async () => {
    current = await mkdtemp(join(root, 't-'));
    saved = process.env.TMPDIR;
    process.env.TMPDIR = current;
    expect(tmpdir()).toBe(current);
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    expect(await imageioTempDirs(current)).toEqual([]);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root: () => root, current: () => current };
}

const ENV_KEYS = ['FAKE_IMAGEIO_SAMPLE_PNG', 'FAKE_IMAGEIO_MODE', IMAGEIO_HELPER_ENV] as const;

describe.skipIf(process.platform === 'win32')('ImageIO helper bridge (fake helper)', () => {
  const tmp = hermeticTmp();
  let dir: string;
  let helper: string;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmp.root(), 'fake-helper-'));
    helper = join(dir, 'OrbitDropHelper');
    await writeFile(helper, `#!${process.execPath}\n${FAKE_HELPER}`);
    await chmod(helper, 0o755);
    const sample = join(dir, 'sample.png');
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#3366cc' } }).png().toFile(sample);
    process.env.FAKE_IMAGEIO_SAMPLE_PNG = sample;
  });

  afterEach(() => {
    delete process.env.FAKE_IMAGEIO_MODE;
    delete process.env[IMAGEIO_HELPER_ENV];
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('probes the helper (JSON on the last line) and round-trips through temp files it cleans up', async () => {
    // The fake helper is a Node script: starting it can take longer than the real helper's 3 s
    // probe budget when the whole suite runs in parallel (seen once under load), so allow more.
    expect(await probeImageIO({ helperPath: helper, timeoutMs: 20_000 })).toEqual({ decode: ['heic', 'heif', 'png'], encode: ['heic'] });
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const heic = await encodeWithImageIO(png, 'heic', 70, { helperPath: helper });
    expect(heic.subarray(0, 16).toString()).toBe('FAKEHEIC q=0.70\n');
    const back = await decodeWithImageIO(heic, { helperPath: helper });
    expect(await sharp(back).metadata()).toMatchObject({ format: 'png', width: 20, height: 10 });
    expect(await imageioTempDirs(tmp.current())).toEqual([]);
  });

  it('maps helper problems to error codes', async () => {
    expect(await codeOf(probeImageIO({ helperPath: join(dir, 'missing') }))).toBe('ENGINE_UNAVAILABLE');
    const notExecutable = join(dir, 'plain.txt');
    await writeFile(notExecutable, 'x');
    expect(await codeOf(probeImageIO({ helperPath: notExecutable }))).toBe('ENGINE_UNAVAILABLE');

    process.env.FAKE_IMAGEIO_MODE = 'fail';
    expect(await codeOf(probeImageIO({ helperPath: helper }))).toBe('ENGINE_UNAVAILABLE');
    expect(await codeOf(decodeWithImageIO(Buffer.from('x'), { helperPath: helper }))).toBe('IMAGE_CORRUPT');
    expect(await codeOf(encodeWithImageIO(Buffer.from('x'), 'heic', 50, { helperPath: helper }))).toBe('INTERNAL');

    process.env.FAKE_IMAGEIO_MODE = 'hang';
    const started = Date.now();
    expect(await codeOf(probeImageIO({ helperPath: helper, timeoutMs: 400 }))).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await codeOf(decodeWithImageIO(Buffer.from('x'), { helperPath: helper, timeoutMs: 400 }))).toBe('TIMEOUT');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(await codeOf(decodeWithImageIO(Buffer.from('x'), { helperPath: helper, signal: controller.signal }))).toBe('CANCELLED');
    // afterEach checks that the timed-out and cancelled calls removed their work folders too.
  });

  it('probeEngines reports HEIC through the helper (measured with a real round trip)', async () => {
    const probe = await probeEngines({ refresh: true, imageIOHelper: helper });
    expect(probe.formats.heic).toMatchObject({ input: true, output: true, inputEngine: 'imageio', outputEngine: 'imageio' });
    process.env.FAKE_IMAGEIO_MODE = 'fail';
    const broken = await probeEngines({ refresh: true, imageIOHelper: helper });
    expect(broken.formats.heic).toMatchObject({ input: false, output: false });
    expect(broken.errors.some((e) => e.startsWith('heic:'))).toBe(true);
    delete process.env.FAKE_IMAGEIO_MODE;
    await probeEngines({ refresh: true, imageIOHelper: null });
  });

  it('convert.heic and HEIC input go through the helper named by ORBITDROP_IMAGEIO_HELPER', async () => {
    process.env[IMAGEIO_HELPER_ENV] = helper;
    const fx = await makeFixtureDir(['photo.jpg']);
    try {
      expect(fx.dir.startsWith(tmp.current())).toBe(true);
      const toHeic = await runConvert(makeJob('convert.heic', [await fx.input('photo.jpg')]), makeCtx().ctx);
      const heicPath = toHeic.outputs[0]!.path;
      expect(heicPath).toBe(join(fx.dir, 'photo.heic'));
      expect((await readFile(heicPath)).subarray(0, 15).toString()).toBe('FAKEHEIC q=0.70');

      const input = { fileId: 'heic1', path: heicPath, displayName: 'photo.heic', sourceDir: fx.dir, format: 'heic' as const, bytes: (await readFile(heicPath)).length };
      const toPng = await runConvert(makeJob('convert.png', [input]), makeCtx().ctx);
      expect(await sharp(toPng.outputs[0]!.path).metadata()).toMatchObject({ format: 'png', width: 320, height: 240 });
      expect(await listFiles(fx.dir)).toEqual(['photo.heic', 'photo.jpg', 'photo.png']);
    } finally {
      await fx.cleanup();
    }
  });
});

const realHelper = ['arm64', 'x64'].map((arch) => join(REPO_ROOT, 'apps', 'desktop', 'resources', 'helper', `darwin-${arch}`, 'OrbitDropHelper')).find((p) => existsSync(p));

describe.skipIf(process.platform !== 'darwin' || !realHelper)('ImageIO helper bridge (real macOS helper)', () => {
  hermeticTmp();

  it('convert.heic writes a real HEVC HEIC; HEIC input converts back upright (EXIF-rotated source)', async () => {
    const saved = process.env[IMAGEIO_HELPER_ENV];
    process.env[IMAGEIO_HELPER_ENV] = realHelper!;
    const fx = await makeFixtureDir(['exif-orientation-6.jpg']);
    try {
      const toHeic = await runConvert(makeJob('convert.heic', [await fx.input('exif-orientation-6.jpg')]), makeCtx().ctx);
      const heicPath = toHeic.outputs[0]!.path;
      expect(heicPath).toBe(join(fx.dir, 'exif-orientation-6.heic'));
      // sharp's libheif can read HEIC headers (not pixels): proves it is a real HEVC HEIC, upright.
      expect(await sharp(heicPath).metadata()).toMatchObject({ format: 'heif', compression: 'hevc', width: 30, height: 60 });

      const heicInput = { fileId: 'h', path: heicPath, displayName: 'exif-orientation-6.heic', sourceDir: fx.dir, format: 'heic' as const, bytes: (await readFile(heicPath)).length };
      const toPng = await runConvert(makeJob('convert.png', [heicInput]), makeCtx().ctx);
      const png = toPng.outputs[0]!.path;
      expect(await sharp(png).metadata()).toMatchObject({ format: 'png', width: 30, height: 60 });
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
      expect(at(15, 5)[0]).toBeGreaterThan(180); // red on top
      expect(at(15, 55)[2]).toBeGreaterThan(180); // blue at the bottom
    } finally {
      if (saved === undefined) delete process.env[IMAGEIO_HELPER_ENV];
      else process.env[IMAGEIO_HELPER_ENV] = saved;
      await fx.cleanup();
    }
  });

  it('encodes a real HEIC and decodes it back', async () => {
    const caps = await probeImageIO({ helperPath: realHelper! });
    expect(caps.decode).toContain('heic');
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#2266aa' } }).png().toBuffer();
    if (caps.encode.includes('heic')) {
      const heic = await encodeWithImageIO(png, 'heic', 80, { helperPath: realHelper! });
      const meta = await sharp(heic).metadata();
      expect(meta).toMatchObject({ format: 'heif', compression: 'hevc', width: 64, height: 48 });
      const back = await decodeWithImageIO(heic, { helperPath: realHelper! });
      expect(await sharp(back).metadata()).toMatchObject({ format: 'png', width: 64, height: 48 });
    }
  });
});
