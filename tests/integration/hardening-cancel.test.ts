/**
 * Cancellation fuzz (hardening pass): every action is aborted at many points — before it
 * starts, after fixed and proportional delays, from inside each progress callback and right
 * at the moment an output is committed. After each run: no `.orbitdrop.*` temp file is left,
 * every file the job left behind was reported through onCommitted, a finished job's outputs
 * exist and decode, a cancelled job leaves nothing, and nothing rejects unhandled.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS, type ActionId, type FileFormat, type ProcessorInput, type ProcessorResult } from '@orbitdrop/contracts';
import { isTempFileName } from '@orbitdrop/core/node';
import { runJob } from '@orbitdrop/processors';

const settings = { pdfDpi: 150, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 } as const;

type Trigger = { kind: 'delay'; ms: number } | { kind: 'progress'; n: number } | { kind: 'commit' };

interface Outcome {
  readonly state: 'done' | 'CANCELLED' | string;
  readonly outputs: readonly string[];
  readonly committed: readonly string[];
  readonly progressEvents: number;
  readonly ms: number;
}

async function runWith(actionId: ActionId, inputs: ProcessorInput[], options: unknown, outputDir: string, trigger: Trigger | null): Promise<Outcome> {
  const controller = new AbortController();
  const committed: string[] = [];
  let progressEvents = 0;
  let timer: NodeJS.Timeout | undefined;
  if (trigger?.kind === 'delay') timer = setTimeout(() => controller.abort(), trigger.ms);
  const started = Date.now();
  let state = 'done';
  let outputs: string[] = [];
  try {
    const result: ProcessorResult = await runJob(
      { jobId: `cx-${randomUUID().slice(0, 8)}`, actionId, inputs, options, outputDir, settings, limits: DEFAULT_PROCESSING_LIMITS },
      {
        signal: controller.signal,
        onProgress: () => {
          progressEvents += 1;
          if (trigger?.kind === 'progress' && progressEvents === trigger.n) controller.abort();
        },
        onCommitted: (output) => {
          committed.push(output.path);
          if (trigger?.kind === 'commit') controller.abort();
        },
      },
    );
    outputs = result.outputs.map((o) => o.path);
  } catch (error) {
    state = (error as { code?: string }).code ?? 'THROW';
  } finally {
    clearTimeout(timer);
  }
  return { state, outputs, committed, progressEvents, ms: Date.now() - started };
}

async function inputOf(path: string, format: FileFormat): Promise<ProcessorInput> {
  return { fileId: `c${randomUUID().slice(0, 8)}`, path, displayName: basename(path), sourceDir: dirname(path), format, bytes: 1 };
}

describe('cancellation fuzz over every action', () => {
  let dir: string;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-hard-cancel-'));
    const w = 480;
    const h = 320;
    const noise = Buffer.alloc(w * h * 3);
    let s = 7;
    for (let i = 0; i < noise.length; i += 1) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (s >> 16) & 255;
    }
    await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toFile(join(dir, 'photo.jpg'));
    await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).ensureAlpha(0.5).png().toFile(join(dir, 'alpha.png'));
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 4; n += 1) doc.addPage([612, 792]).drawText(`Cancellation page ${n}`, { x: 72, y: 700, size: 24, font });
    await writeFile(join(dir, 'doc.pdf'), await doc.save());
  });
  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    await rm(dir, { recursive: true, force: true });
  });

  const jobs: [ActionId, string[], FileFormat, unknown][] = [
    ['convert.png', ['photo.jpg'], 'jpeg', {}],
    ['convert.jpeg', ['alpha.png'], 'png', {}],
    ['convert.webp', ['photo.jpg'], 'jpeg', {}],
    ['convert.jpeg', ['doc.pdf'], 'pdf', {}],
    ['convert.png', ['doc.pdf'], 'pdf', {}],
    ['convert.txt', ['doc.pdf'], 'pdf', {}],
    ['convert.docx', ['doc.pdf'], 'pdf', {}],
    ['convert.docx', ['photo.jpg'], 'jpeg', {}],
    ['convert.pdf', ['photo.jpg', 'alpha.png'], 'jpeg', {}],
    ['tool.crop', ['photo.jpg'], 'jpeg', { rect: { x: 10, y: 10, width: 300, height: 200 } }],
    ['tool.addBackground', ['photo.jpg'], 'jpeg', { background: { kind: 'preset', presetId: 'ember' }, padding: 30, cornerRadius: 20, shadow: 30, ratio: '1:1', maxEdge: 800, format: 'png', quality: 90 }],
    ['tool.compress', ['photo.jpg'], 'jpeg', { quality: 60 }],
    ['tool.metadata', ['photo.jpg'], 'jpeg', { mode: 'strip', outputFormat: 'png' }],
    ['tool.edit', ['photo.jpg'], 'jpeg', { rotate: 90, brightness: 10 }],
    ['tool.annotate', ['photo.jpg'], 'jpeg', { shapes: [{ id: 't', type: 'text', x: 20, y: 20, text: '한글 text', color: '#FF0000', fontSize: 40 }] }],
    ['tool.redact', ['alpha.png'], 'png', { regions: [{ id: 'r', rect: { x: 0, y: 0, width: 200, height: 150 }, style: 'mosaic' }] }],
  ];

  it.each(jobs.map((job, i) => [`${job[0]} ${job[1].join('+')}`, i] as const))('%s', async (_label, index) => {
    const [actionId, files, format, options] = jobs[index]!;
    const sub = join(dir, `job-${index}`);
    await mkdir(sub);
    const inputs = await Promise.all(files.map((f) => inputOf(join(dir, f), f.endsWith('.png') ? 'png' : f.endsWith('.pdf') ? 'pdf' : format)));
    // One clean run measures the duration and the number of progress events.
    const clean = await runWith(actionId, inputs, options, sub, null);
    expect(clean.state).toBe('done');
    const triggers: Trigger[] = [
      { kind: 'delay', ms: 0 },
      ...[1, 2, 4, 8].map((ms) => ({ kind: 'delay' as const, ms })),
      ...Array.from({ length: 10 }, (_, k) => ({ kind: 'delay' as const, ms: Math.round((clean.ms * (k + 1)) / 9) })),
      ...Array.from({ length: clean.progressEvents }, (_, k) => ({ kind: 'progress' as const, n: k + 1 })),
      { kind: 'commit' },
    ];
    for (const trigger of triggers) {
      const before = new Set(await readdir(sub));
      const outcome = await runWith(actionId, inputs, options, sub, trigger);
      const label = `${JSON.stringify(trigger)} → ${outcome.state}`;
      const added = (await readdir(sub)).filter((n) => !before.has(n));
      expect(added.filter((n) => isTempFileName(n) || n.startsWith('.orbitdrop')), label).toEqual([]);
      const left = added.map((n) => join(sub, n));
      expect(['done', 'CANCELLED'], label).toContain(outcome.state);
      for (const file of left) expect(outcome.committed, `${label}: ${basename(file)} not reported`).toContain(file);
      if (outcome.state === 'done') {
        expect(outcome.outputs.length, label).toBeGreaterThan(0);
        expect([...left].sort(), label).toEqual([...outcome.outputs].sort());
        for (const out of outcome.outputs) {
          if (/\.(png|jpe?g|webp)$/i.test(out)) expect((await sharp(out).metadata()).width, label).toBeGreaterThan(0);
        }
      } else {
        expect(left, label).toEqual([]);
      }
    }
    expect(unhandled).toEqual([]);
  });
});
