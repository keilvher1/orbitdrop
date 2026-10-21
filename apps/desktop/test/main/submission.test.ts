import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, OrbitError, type FileFormat, type ProcessorJob, type ProcessorResult, type Settings } from '@orbitdrop/contracts';
import { EditorSessions, type EditorSession } from '../../src/main/editor/sessions';
import { OutputRegistry } from '../../src/main/files/outputs';
import { FileRegistry } from '../../src/main/files/registry';
import { HistoryStore } from '../../src/main/history/store';
import { JobManager } from '../../src/main/jobs/manager';
import { SubmissionService } from '../../src/main/jobs/submission';
import { PreviewStore } from '../../src/main/preview/store';
import { deferred, fakeValidator, imageInfo, snapshotWith, waitFor, type Deferred } from './helpers';

const FILES: Record<string, FileFormat> = {
  '/in/a.png': 'png',
  '/in/b.jpg': 'jpeg',
  '/in/c.webp': 'webp',
  '/in/doc.pdf': 'pdf',
  '/in/d.png': 'png',
  '/in/e.heic': 'heic',
};

interface Options {
  readonly settings?: Partial<Settings>;
  readonly snapshot?: ReturnType<typeof snapshotWith>;
  readonly chooseDir?: string | null;
  /** Folder dialog stand-in (default: resolves `chooseDir` or '/chosen'). */
  readonly dialog?: () => Promise<string | null>;
  readonly run?: (job: ProcessorJob) => Promise<ProcessorResult>;
}

function setup(options: Options = {}) {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const snapshot = options.snapshot ?? snapshotWith();
  const files = new FileRegistry({ validate: fakeValidator(FILES), snapshot: () => snapshot });
  const ran: ProcessorJob[] = [];
  const jobs = new JobManager({
    run: async (job) => {
      ran.push(job);
      return options.run ? options.run(job) : { outputs: [], warnings: [] };
    },
    settings: () => settings,
    outputs: new OutputRegistry(),
    history: new HistoryStore('/nonexistent-orbitdrop-test-dir'),
  });
  const pool = {
    preview: vi.fn(async () => ({ data: new Uint8Array(1), mime: 'image/png' as const, width: 1, height: 1, sourceWidth: 1, sourceHeight: 1 })),
    cancelPreview: vi.fn(),
    inspect: vi.fn(async () => imageInfo(400, 300)),
  };
  const editors = new EditorSessions({ pool, store: new PreviewStore(), settings: () => settings });
  const opened: EditorSession[] = [];
  const chooseOutputDir = vi.fn(options.dialog ?? (async () => (options.chooseDir === undefined ? '/chosen' : options.chooseDir)));
  const submission = new SubmissionService({
    files,
    capabilities: async () => snapshot,
    settings: () => settings,
    jobs,
    editors,
    chooseOutputDir,
    openEditor: (session) => opened.push(session),
  });
  return { files, jobs, editors, submission, ran, opened, chooseOutputDir };
}

const ctx = { source: 'test', sessionId: null } as const;

describe('submitAction', () => {
  it('converts every file with its own job in one batch', async () => {
    const { files, jobs, submission } = setup();
    const selection = await files.registerPaths(['/in/a.png', '/in/c.webp'], 'dropZone');
    const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'convert.jpeg' }, ctx);
    expect(result.kind).toBe('jobs');
    if (result.kind !== 'jobs') return;
    expect(result.jobIds).toHaveLength(2);
    const snapshots = await Promise.all(result.jobIds.map((id) => jobs.waitFor(id)));
    expect(snapshots.map((s) => s.inputName)).toEqual(['a.png', 'c.webp']);
    expect(snapshots[0]!.batchId).not.toBeNull();
    expect(snapshots[0]!.batchId).toBe(snapshots[1]!.batchId);
  });

  it('skips files already in the target format with a warning instead of failing the batch', async () => {
    const { files, jobs, submission, ran } = setup();
    const selection = await files.registerPaths(['/in/a.png', '/in/b.jpg'], 'dropZone');
    const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'convert.png' }, ctx);
    if (result.kind !== 'jobs') throw new Error(`expected jobs, got ${result.kind}`);
    const snapshots = await Promise.all(result.jobIds.map((id) => jobs.waitFor(id)));
    expect(snapshots.map((s) => [s.inputName, s.state, s.warnings.map((w) => w.code)])).toEqual([
      ['b.jpg', 'completed', []],
      ['a.png', 'completed', ['SKIPPED_SAME_FORMAT']],
    ]);
    expect(ran.map((j) => j.inputs[0]!.displayName)).toEqual(['b.jpg']);
  });

  it('opens an editor for tools, with the files and origin of the selection', async () => {
    const { files, submission, opened } = setup();
    const selection = await files.registerPaths(['/in/b.jpg'], 'globalDrag');
    const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.crop' }, { source: 'globalDrag', sessionId: 'sess_1' });
    expect(result.kind).toBe('editor');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.inputs.map((i) => i.displayName)).toEqual(['b.jpg']);
    expect(opened[0]!.origin).toEqual({ source: 'globalDrag', sessionId: 'sess_1' });
  });

  it('rejects several files for a single-file tool, and unsupported or disabled actions', async () => {
    const { files, submission } = setup({ snapshot: snapshotWith({ noOutput: ['webp'] }) });
    const two = await files.registerPaths(['/in/a.png', '/in/b.jpg'], 'dropZone');
    expect(await submission.submit({ selectionId: two.selectionId, actionId: 'tool.crop' }, ctx)).toMatchObject({ kind: 'rejected', error: { code: 'TOO_MANY_FILES' } });
    const pdf = await files.registerPaths(['/in/doc.pdf'], 'dropZone');
    expect(await submission.submit({ selectionId: pdf.selectionId, actionId: 'tool.crop' }, ctx)).toMatchObject({ kind: 'rejected', error: { code: 'UNSUPPORTED_FORMAT' } });
    const png = await files.registerPaths(['/in/d.png'], 'dropZone');
    expect(await submission.submit({ selectionId: png.selectionId, actionId: 'convert.webp' }, ctx)).toMatchObject({ kind: 'rejected', error: { code: 'ENGINE_UNAVAILABLE' } });
    expect(await submission.submit({ selectionId: 'sel_unknown', actionId: 'convert.jpeg' }, ctx)).toMatchObject({ kind: 'rejected' });
  });

  it('files this build cannot read are flagged in the selection and refused', async () => {
    const { files, submission } = setup();
    const selection = await files.registerPaths(['/in/e.heic'], 'dropZone');
    expect(selection.files[0]!.problem?.code).toBe('UNSUPPORTED_FORMAT');
    expect(selection.menuKey).toBeNull();
    expect(await submission.submit({ selectionId: selection.selectionId, actionId: 'convert.jpeg' }, ctx)).toMatchObject({ kind: 'rejected', error: { code: 'UNSUPPORTED_FORMAT' } });
  });

  it('validates options against the action schema', async () => {
    const { files, submission } = setup();
    const selection = await files.registerPaths(['/in/a.png'], 'dropZone');
    const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'convert.jpeg', options: { quality: 500 } }, ctx);
    expect(result).toMatchObject({ kind: 'rejected', error: { code: 'INVALID_OPTIONS' } });
  });

  it("asks for a folder when output.location is 'ask' and stops when the dialog is cancelled", async () => {
    const asked = setup({ settings: { output: { ...DEFAULT_SETTINGS.output, location: 'ask' } } });
    const selection = await asked.files.registerPaths(['/in/a.png'], 'dropZone');
    const result = await asked.submission.submit({ selectionId: selection.selectionId, actionId: 'convert.jpeg' }, { ...ctx, windowId: 7 });
    if (result.kind !== 'jobs') throw new Error('expected jobs');
    await asked.jobs.waitFor(result.jobIds[0]!);
    expect(asked.ran[0]!.outputDir).toBe('/chosen');
    expect(asked.chooseOutputDir).toHaveBeenCalledWith({ windowId: 7, reason: 'ask' });

    const cancelled = setup({ settings: { output: { ...DEFAULT_SETTINGS.output, location: 'ask' } }, chooseDir: null });
    const again = await cancelled.files.registerPaths(['/in/a.png'], 'dropZone');
    expect(await cancelled.submission.submit({ selectionId: again.selectionId, actionId: 'convert.jpeg' }, ctx)).toMatchObject({ kind: 'rejected', error: { code: 'CANCELLED' } });
    expect(cancelled.ran).toHaveLength(0);
  });
});

describe('commitEditor', () => {
  it('images → PDF: several images open the order editor and commit one merged job in the confirmed order', async () => {
    const { files, jobs, submission, opened, ran } = setup();
    const selection = await files.registerPaths(['/in/a.png', '/in/b.jpg', '/in/c.webp'], 'dropZone');
    const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'convert.pdf' }, ctx);
    expect(result.kind).toBe('editor');
    const session = opened[0]!;
    const [a, b, c] = session.files.map((f) => f.fileId);
    const committed = await submission.commitEditor({ editorId: session.editorId, options: { order: [c, a, b], pageSize: 'a4' } }, ctx);
    if (committed.kind !== 'jobs') throw new Error('expected jobs');
    expect(committed.jobIds).toHaveLength(1);
    await jobs.waitFor(committed.jobIds[0]!);
    expect(ran[0]!.inputs.map((i) => i.displayName)).toEqual(['c.webp', 'a.png', 'b.jpg']);
    expect(ran[0]!.options).toMatchObject({ pageSize: 'a4', order: [c, a, b] });
    // a second Apply returns the same jobs instead of writing twice
    expect(await submission.commitEditor({ editorId: session.editorId, options: { order: [c, a, b] } }, ctx)).toEqual(committed);
  });

  it('rejects a crop outside the image and an incomplete order', async () => {
    const { files, submission, opened } = setup();
    const one = await files.registerPaths(['/in/b.jpg'], 'dropZone');
    await submission.submit({ selectionId: one.selectionId, actionId: 'tool.crop' }, ctx);
    const crop = opened[0]!;
    expect(await submission.commitEditor({ editorId: crop.editorId, options: { rect: { x: 300, y: 0, width: 200, height: 100 } } }, ctx)).toMatchObject({
      kind: 'rejected',
      error: { code: 'INVALID_OPTIONS' },
    });
    const committed = await submission.commitEditor({ editorId: crop.editorId, options: { rect: { x: 100, y: 0, width: 300, height: 300 }, aspect: '1:1' } }, ctx);
    expect(committed.kind).toBe('jobs');

    const many = await files.registerPaths(['/in/a.png', '/in/d.png'], 'dropZone');
    await submission.submit({ selectionId: many.selectionId, actionId: 'convert.pdf' }, ctx);
    const pdf = opened[1]!;
    expect(await submission.commitEditor({ editorId: pdf.editorId, options: { order: [pdf.files[0]!.fileId] } }, ctx)).toMatchObject({ error: { code: 'INVALID_OPTIONS' } });
  });
});

describe('closing editors', () => {
  it('closing or cancelling an editor after commit leaves the committed jobs running to completion', async () => {
    const gates: Deferred<ProcessorResult>[] = [];
    const { files, jobs, editors, submission, opened } = setup({
      run: () => {
        const gate = deferred<ProcessorResult>();
        gates.push(gate);
        return gate.promise;
      },
    });
    // Compress keeps its window open after commit to show the final size; the user then closes it.
    const selection = await files.registerPaths(['/in/a.png', '/in/b.jpg'], 'dropZone');
    expect((await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.compress' }, ctx)).kind).toBe('editor');
    const session = opened[0]!;
    const committed = await submission.commitEditor({ editorId: session.editorId, options: { format: 'jpeg', quality: 60 } }, ctx);
    if (committed.kind !== 'jobs') throw new Error('expected jobs');
    expect(committed.jobIds).toHaveLength(2);
    await waitFor(() => gates.length === 2, 1000, 'both jobs running');

    editors.dispose(session.editorId); // what closing the editor window does (closeWindow / cancelEditor)
    expect(editors.get(session.editorId)).toBeUndefined();
    for (const id of committed.jobIds) expect(jobs.get(id)?.snapshot.state).toBe('running');

    for (const gate of gates) gate.resolve({ outputs: [], warnings: [] });
    const finished = await Promise.all(committed.jobIds.map((id) => jobs.waitFor(id)));
    expect(finished.map((j) => j.state)).toEqual(['completed', 'completed']);
  });
});

describe('cancelling a commit', () => {
  it('closing the editor while the commit waits for the folder dialog submits nothing', async () => {
    const dialog = deferred<string | null>();
    const { files, editors, submission, opened, ran, jobs } = setup({
      settings: { output: { ...DEFAULT_SETTINGS.output, location: 'ask' } },
      dialog: () => dialog.promise,
    });
    const selection = await files.registerPaths(['/in/b.jpg'], 'dropZone');
    await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.crop' }, ctx);
    const session = opened[0]!;
    const commit = submission.commitEditor({ editorId: session.editorId, options: { rect: { x: 0, y: 0, width: 300, height: 300 } } }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    editors.dispose(session.editorId); // user clicked × ("Cancel and close") while "Saving…" was shown
    dialog.resolve('/chosen');
    expect(await commit).toMatchObject({ kind: 'rejected', error: { code: 'CANCELLED' } });
    expect(ran).toHaveLength(0);
    expect(jobs.list()).toHaveLength(0);
  });

  it('a double click on Apply asks for one folder and writes once', async () => {
    const dialog = deferred<string | null>();
    let dialogs = 0;
    const { files, submission, opened, jobs } = setup({
      settings: { output: { ...DEFAULT_SETTINGS.output, location: 'ask' } },
      dialog: () => {
        dialogs += 1;
        return dialog.promise;
      },
    });
    const selection = await files.registerPaths(['/in/b.jpg'], 'dropZone');
    await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.crop' }, ctx);
    const editorId = opened[0]!.editorId;
    const options = { rect: { x: 0, y: 0, width: 300, height: 300 } };
    const first = submission.commitEditor({ editorId, options }, ctx);
    const second = submission.commitEditor({ editorId, options }, ctx);
    dialog.resolve('/chosen');
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(dialogs).toBe(1);
    expect(jobs.list()).toHaveLength(1);
  });
});

describe('retryElsewhere', () => {
  it('a double click opens one folder dialog and resubmits once', async () => {
    let first = true;
    const dialog = deferred<string | null>();
    let dialogs = 0;
    const { files, jobs, submission } = setup({
      run: async () => {
        if (first) {
          first = false;
          throw new OrbitError('OUTPUT_DIR_NOT_WRITABLE', 'Output folder is not writable');
        }
        return { outputs: [], warnings: [] };
      },
      dialog: () => {
        dialogs += 1;
        return dialog.promise;
      },
    });
    const selection = await files.registerPaths(['/in/a.png'], 'dropZone');
    const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'convert.jpeg' }, ctx);
    if (result.kind !== 'jobs') throw new Error('expected jobs');
    await jobs.waitFor(result.jobIds[0]!);
    const a = submission.retryElsewhere(result.jobIds[0]!, ctx);
    const b = submission.retryElsewhere(result.jobIds[0]!, ctx);
    dialog.resolve('/elsewhere');
    expect(await a).toEqual(await b);
    expect(dialogs).toBe(1);
    expect(jobs.list().filter((j) => j.inputName === 'a.png')).toHaveLength(2); // the failed one + one retry
  });

  it('re-runs a job that could not write its output in a folder the user picks', async () => {
    let first = true;
    const { files, jobs, submission, ran, chooseOutputDir } = setup({
      run: async () => {
        if (first) {
          first = false;
          throw new OrbitError('OUTPUT_DIR_NOT_WRITABLE', 'Output folder is not writable');
        }
        return { outputs: [], warnings: [] };
      },
    });
    const selection = await files.registerPaths(['/in/a.png'], 'dropZone');
    const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'convert.jpeg' }, ctx);
    if (result.kind !== 'jobs') throw new Error('expected jobs');
    const failed = await jobs.waitFor(result.jobIds[0]!);
    expect(failed.error?.code).toBe('OUTPUT_DIR_NOT_WRITABLE');
    const retried = await submission.retryElsewhere(failed.jobId, { ...ctx, windowId: 3 });
    if (!retried || retried.kind !== 'jobs') throw new Error('expected jobs');
    expect((await jobs.waitFor(retried.jobIds[0]!)).state).toBe('completed');
    expect(ran[1]!.outputDir).toBe('/chosen');
    expect(chooseOutputDir).toHaveBeenCalledWith({ windowId: 3, reason: 'retry' });
  });

  it('refuses jobs that did not fail with a folder problem and returns null when the dialog is cancelled', async () => {
    const ok = setup();
    const selection = await ok.files.registerPaths(['/in/a.png'], 'dropZone');
    const result = await ok.submission.submit({ selectionId: selection.selectionId, actionId: 'convert.jpeg' }, ctx);
    if (result.kind !== 'jobs') throw new Error('expected jobs');
    await ok.jobs.waitFor(result.jobIds[0]!);
    expect(await ok.submission.retryElsewhere(result.jobIds[0]!, ctx)).toMatchObject({ kind: 'rejected' });

    const cancelled = setup({
      chooseDir: null,
      run: async () => {
        throw new OrbitError('OUTPUT_DIR_NOT_WRITABLE', 'no');
      },
    });
    const sel = await cancelled.files.registerPaths(['/in/a.png'], 'dropZone');
    const res = await cancelled.submission.submit({ selectionId: sel.selectionId, actionId: 'convert.jpeg' }, ctx);
    if (res.kind !== 'jobs') throw new Error('expected jobs');
    await cancelled.jobs.waitFor(res.jobIds[0]!);
    expect(await cancelled.submission.retryElsewhere(res.jobIds[0]!, ctx)).toBeNull();
  });
});
