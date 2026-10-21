import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write JSON atomically: a temp file in the same folder is written, flushed
 * and renamed over the target, so a crash never leaves a half-written file.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await open(temp, 'w', 0o600);
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export type ReadJsonResult = { readonly kind: 'missing' } | { readonly kind: 'ok'; readonly value: unknown } | { readonly kind: 'corrupt' };

export async function readJson(file: string): Promise<ReadJsonResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'corrupt' };
  }
}

/** Serializes async tasks (one at a time, in call order). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves when everything queued so far has finished. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
