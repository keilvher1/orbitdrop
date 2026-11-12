// TEMPORARY diagnostics for the ci/windows branch (removed before merging): measures on the
// Windows runner what the Windows fixes rely on. Never fails; prints facts.
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const req = createRequire(join(root, 'packages', 'processors', 'package.json'));
const section = (title) => console.log(`\n=== ${title}`);
const attempt = (fn) => {
  try {
    const value = fn();
    return value === undefined ? 'ok' : `ok ${String(value).slice(0, 120)}`;
  } catch (error) {
    return `${error.code ?? 'ERR'} ${String(error.message).split('\n')[0].slice(0, 140)}`;
  }
};

section('os');
console.log(os.type(), os.release(), os.version(), os.arch(), '| tmpdir', os.tmpdir(), '| realpath', attempt(() => realpathSync.native(os.tmpdir())));

const base = mkdtempSync(join(os.tmpdir(), 'od-diag-'));
try {
  section('long names and paths (Node fs)');
  console.log('300-unit name lstat     :', attempt(() => lstatSync(join(base, `${'a'.repeat(296)}.png`))));
  console.log('256-unit name lstat     :', attempt(() => lstatSync(join(base, `${'a'.repeat(252)}.png`))));
  console.log('255-unit name write     :', attempt(() => writeFileSync(join(base, `${'a'.repeat(251)}.png`), 'x')));
  console.log('255 Hangul name write   :', attempt(() => writeFileSync(join(base, `${'가'.repeat(251)}.png`), 'x')));
  console.log('256 Hangul name write   :', attempt(() => writeFileSync(join(base, `${'가'.repeat(252)}.png`), 'x')));
  console.log('6,000-unit path lstat   :', attempt(() => lstatSync(join(base, ...Array(30).fill('b'.repeat(200)), 'x.png'))));
  console.log('34,000-unit path lstat  :', attempt(() => lstatSync(join(base, ...Array(170).fill('b'.repeat(200)), 'x.png'))));

  section('sharp / libvips');
  const sharp = req('sharp');
  console.log('versions', JSON.stringify(sharp.versions));
  const longDir = join(base, 'c'.repeat(200));
  mkdirSync(longDir);
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } }).png().toBuffer();
  writeFileSync(join(longDir, `${'d'.repeat(100)}.png`), png);
  console.log('sharp(path > MAX_PATH)  :', await sharp(join(longDir, `${'d'.repeat(100)}.png`)).metadata().then((m) => `ok ${m.width}`, (e) => `ERR ${e.message.split('\n')[0]}`));
  const arith = join(root, 'tests', 'fixtures', 'static', 'jpeg-arithmetic.jpg');
  console.log('arithmetic JPEG decode  :', await sharp(readFileSync(arith)).raw().toBuffer().then((b) => `ok ${b.length}`, (e) => `ERR ${e.message.replace(/\n/g, ' | ')}`));

  section('folder ACL deny (WD,AD) for Everyone');
  const ro = join(base, 'ro');
  mkdirSync(ro);
  writeFileSync(join(ro, 'settings.json'), '{ broken');
  const deny = spawnSync('icacls', [ro, '/deny', '*S-1-1-0:(WD,AD)'], { encoding: 'utf8' });
  console.log('icacls deny             :', deny.status, `${deny.stdout ?? ""}${deny.stderr ?? ""}`.trim().split('\n')[0]);
  console.log('create file (wx)        :', attempt(() => closeSync(openSync(join(ro, 'probe'), 'wx'))));
  console.log('mkdir child             :', attempt(() => mkdirSync(join(ro, 'child'))));
  console.log('rename inside folder    :', attempt(() => renameSync(join(ro, 'settings.json'), join(ro, 'settings.corrupt-1.json'))));
  console.log('read existing file      :', attempt(() => readFileSync(join(ro, 'settings.json'), 'utf8')));
  console.log('rewrite existing file   :', attempt(() => writeFileSync(join(ro, 'settings.json'), '{ broken')));
  const allow = spawnSync('icacls', [ro, '/remove:d', '*S-1-1-0'], { encoding: 'utf8' });
  console.log('icacls remove:d         :', allow.status, `${allow.stdout ?? ""}${allow.stderr ?? ""}`.trim().split('\n')[0]);
  console.log('create file after       :', attempt(() => closeSync(openSync(join(ro, 'probe2'), 'wx'))));

  section('@napi-rs/canvas fonts');
  const { createCanvas, GlobalFonts } = req('@napi-rs/canvas');
  const families = GlobalFonts.families.map((f) => f.family);
  console.log('families', families.length, JSON.stringify(families.filter((f) => /gothic|malgun|gulim|batang|dotum|nanum|cjk|yahei|simsun|meiryo|^yu |^segoe ui$|^arial$|^times new roman$/i.test(f)).slice(0, 40)));
  const ink = (css, text) => {
    const ctx = createCanvas(96, 48).getContext('2d');
    ctx.fillStyle = '#000';
    ctx.font = `36px ${css}`;
    ctx.textBaseline = 'top';
    ctx.fillText(text, 4, 4);
    const d = ctx.getImageData(0, 0, 96, 48).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n += 1;
    return n;
  };
  for (const css of [
    'sans-serif',
    'serif',
    '"g_d0_f1", sans-serif',
    '"g_d0_f1", serif',
    '"Arial"',
    '"Segoe UI"',
    '"Malgun Gothic"',
    '"g_d0_f1", sans-serif, "Malgun Gothic"',
    '"g_d0_f1", serif, "Malgun Gothic"',
    '"Arial", "Malgun Gothic"',
  ]) {
    console.log(css.padEnd(42), 'hangul', String(ink(css, '한글')).padStart(4), 'latin', String(ink(css, 'Ab')).padStart(4), 'missing', String(ink(css, '\u{10FFFD}')).padStart(4));
  }
} finally {
  spawnSync('icacls', [join(base, 'ro'), '/remove:d', '*S-1-1-0']);
  rmSync(base, { recursive: true, force: true });
}
