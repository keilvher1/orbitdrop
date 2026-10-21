import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommittedOutput, ProcessorJob } from '@orbitdrop/contracts';
import { runJob } from '../src';
import { OutputLedger } from '../src/convert/common';
import { inputFor, jobFor, makeTempDir, removeDir, writeFixture } from './helpers/tools-fixtures';

/**
 * Every committed output is reported through ProcessorRunContext.onCommitted
 * (path + device/inode/size), so main can remove it again when the worker
 * dies before the job ends. Covers the convert ledger and the tools' writer.
 */

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('committed');
});
afterEach(async () => {
  await removeDir(dir);
});

async function identity(path: string): Promise<Omit<CommittedOutput, 'path'>> {
  const info = await stat(path);
  return { dev: info.dev, ino: info.ino, size: info.size };
}

describe('commit reports', () => {
  it('OutputLedger reports each commit with the identity a rollback checks', async () => {
    const reported: CommittedOutput[] = [];
    const ledger = new OutputLedger((output) => reported.push(output));
    const signal = new AbortController().signal;
    const a = await ledger.commit(dir, 'page-p001.png', 'job_x', new Uint8Array([1, 2, 3]), signal, { format: 'png' });
    const b = await ledger.commit(dir, 'page-p002.png', 'job_x', new Uint8Array([4, 5]), signal, { format: 'png' });
    expect(reported).toEqual([
      { path: a.path, ...(await identity(a.path)) },
      { path: b.path, ...(await identity(b.path)) },
    ]);
    expect(reported.map((r) => r.size)).toEqual([3, 2]);
    // Without a listener the ledger works as before.
    const quiet = new OutputLedger();
    expect((await quiet.commit(dir, 'q.png', 'job_y', new Uint8Array([9]), signal, { format: 'png' })).bytes).toBe(1);
  });

  it('a tool job reports its output before it resolves', async () => {
    const source = await writeFixture(dir, 'photo.png', await sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } }).png().toBuffer());
    const job: ProcessorJob = jobFor('tool.crop', await inputFor(source), { rect: { x: 0, y: 0, width: 20, height: 30 }, aspect: 'free', outputFormat: 'input', flattenBackground: '#FFFFFF' });
    const reported: CommittedOutput[] = [];
    const result = await runJob(job, { signal: new AbortController().signal, onProgress: () => undefined, onCommitted: (output) => reported.push(output) });
    const output = result.outputs[0]!;
    expect(output.path).toBe(join(dir, 'photo Cropped.png'));
    expect(reported).toEqual([{ path: output.path, ...(await identity(output.path)) }]);
  });

  it('a multi-page PDF → PNG job reports every page', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i += 1) doc.addPage([72, 72]);
    const pdf = await writeFixture(dir, 'report.pdf', await doc.save());
    const input = await inputFor(pdf);
    const job: ProcessorJob = { ...jobFor('tool.crop', input, {}), actionId: 'convert.png', options: { dpi: 150 } };
    const reported: CommittedOutput[] = [];
    const result = await runJob(job, { signal: new AbortController().signal, onProgress: () => undefined, onCommitted: (output) => reported.push(output) });
    expect(result.outputs).toHaveLength(3);
    expect(reported.map((r) => r.path).sort()).toEqual(result.outputs.map((o) => o.path).sort());
  });
});
