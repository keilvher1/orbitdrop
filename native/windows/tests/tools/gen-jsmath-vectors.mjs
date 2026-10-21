#!/usr/bin/env node
// Regenerates native/windows/tests/data/jsmath-vectors.txt: Math.atan2 / Math.hypot
// results of the running Node (V8) as exact IEEE-754 bit patterns.
//
//   node native/windows/tests/tools/gen-jsmath-vectors.mjs [count]
//
// Line format: "<op> <yHex> <xHex> <resultHex>" with op a = atan2(y, x), h = hypot(y, x).
//
// NOTE: V8 compiles fdlibm's atan with the platform C++ compiler. The committed
// vectors come from Node 24 on darwin-arm64, whose clang fuses the polynomial
// multiply-adds (FMA); src/core/jsmath.cpp reproduces that with explicit
// std::fma. Node builds for x86-64 (no FMA) differ in the last ulp for ~0.04 %
// of random inputs, so regenerate on arm64 (or compare only geometry results).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'jsmath-vectors.txt');
const count = Number(process.argv[2] ?? 3000);

const buf = new ArrayBuffer(8);
const f64 = new Float64Array(buf);
const u64 = new BigUint64Array(buf);
const hex = (d) => {
  f64[0] = d;
  return u64[0].toString(16).padStart(16, '0');
};
let seed = 20261021;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const fromBits = () => {
  u64[0] = (BigInt(Math.floor(rnd() * 2 ** 32)) << 32n) | BigInt(Math.floor(rnd() * 2 ** 32));
  return f64[0];
};

const lines = [
  `# Math.atan2 / Math.hypot from Node ${process.version} (${process.platform}-${process.arch}), V8 ${process.versions.v8}`,
];
const emit = (y, x) => {
  lines.push(`a ${hex(y)} ${hex(x)} ${hex(Math.atan2(y, x))}`);
  lines.push(`h ${hex(y)} ${hex(x)} ${hex(Math.hypot(y, x))}`);
};
const specials = [0, -0, 1, -1, 0.5, -0.5, 1e-300, -1e-300, 1e300, -1e300, Infinity, -Infinity, NaN, 2 ** -1074, 64.8, 180, 120];
for (const y of specials) for (const x of specials) emit(y, x);
for (let i = 0; i < count; i += 1) {
  switch (i % 5) {
    case 0:
      emit((rnd() - 0.5) * 800, (rnd() - 0.5) * 800);
      break;
    case 1:
      emit(Math.round((rnd() - 0.5) * 800) / 1.5, Math.round((rnd() - 0.5) * 800) / 1.25);
      break;
    case 2: {
      const r = rnd() * 300;
      const t = rnd() * 2 * Math.PI;
      emit(r * Math.sin(t), r * Math.cos(t));
      break;
    }
    case 3:
      emit(fromBits(), fromBits());
      break;
    default:
      emit((rnd() - 0.5) * 3, (rnd() - 0.5) * 3);
  }
}
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`wrote ${lines.length - 1} vectors to ${out}`);
