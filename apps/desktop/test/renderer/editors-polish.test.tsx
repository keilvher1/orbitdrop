// @vitest-environment jsdom
import './setup';
import type { EstimateOutcome, EstimateRequest, JobSnapshot, SelectedFile, ThumbnailRequest, ThumbnailResponse } from '@orbitdrop/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranslator } from '../../src/renderer/src/i18n/catalog';
import { AdjustEditor } from '../../src/renderer/src/views/editor/adjust/AdjustEditor';
import { CompressEditor } from '../../src/renderer/src/views/editor/compress/CompressEditor';
import { summarizeEstimates } from '../../src/renderer/src/views/editor/compress/useBatchEstimates';
import { PdfOrderEditor, fitThumbnail, thumbnailEdge } from '../../src/renderer/src/views/editor/pdf/PdfOrderEditor';
import koErrors from '../../src/shared/locales/ko/errors.json';
import { createFakeOrbit, deferred, renderWithEnv, sampleEditorContext, sampleImageInfo, sampleJob } from './helpers';

const t = createTranslator('ko');

const imageFiles = (n: number, bytes: (i: number) => number = () => 1_000_000): SelectedFile[] =>
  Array.from({ length: n }, (_, i) => ({ fileId: `f${i + 1}`, name: `IMG_${i + 1}.jpg`, ext: '.jpg', format: 'jpeg', kind: 'image', bytes: bytes(i) }));

// ------------------------------------------------------------------ PDF order thumbnails

/** A controllable IntersectionObserver: tests decide which observed elements are "visible". */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element): void {
    this.observed.add(element);
  }
  unobserve(element: Element): void {
    this.observed.delete(element);
  }
  disconnect(): void {
    this.observed.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  show(elements: readonly Element[]): void {
    const entries = elements.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry);
    act(() => this.callback(entries, this as unknown as IntersectionObserver));
  }
}

describe('PdfOrderEditor thumbnails', () => {
  const files = imageFiles(4);
  const defaults = { flattenBackground: '#FFFFFF', keepMetadata: false, pageSize: 'image', marginPt: 0, pageSeparator: 'marker', order: files.map((f) => f.fileId) };
  const rows = () => screen.getAllByRole('listitem');
  const cellOf = (row: HTMLElement) => row.querySelector('.pdf-thumb') as HTMLElement;

  afterEach(() => {
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
    FakeIntersectionObserver.instances = [];
  });

  it('asks only for visible rows, once per file, and shows each image fitted into its box', async () => {
    (window as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
    const orbit = createFakeOrbit();
    const answers = new Map<string, ReturnType<typeof deferred<ThumbnailResponse>>>();
    orbit.getEditorThumbnail.mockImplementation((request: ThumbnailRequest) => {
      const d = deferred<ThumbnailResponse>();
      answers.set(request.fileId, d);
      return d.promise;
    });
    renderWithEnv(<PdfOrderEditor ctx={sampleEditorContext('convert.pdf', { files, defaults })} title="PDF로 변환" />, { orbit });
    const observer = FakeIntersectionObserver.instances[0]!;
    expect(observer.options.root).toBe(screen.getByRole('list'));
    expect(observer.options.rootMargin).toMatch(/px/);
    expect(orbit.getEditorThumbnail).not.toHaveBeenCalled();
    // Rows 1 and 2 scroll into view.
    observer.show([cellOf(rows()[0]!), cellOf(rows()[1]!)]);
    expect(orbit.getEditorThumbnail.mock.calls.map(([r]) => r.fileId)).toEqual(['f1', 'f2']);
    expect(orbit.getEditorThumbnail.mock.calls[0]![0]).toMatchObject({ editorId: 'ed1', maxEdge: thumbnailEdge(window.devicePixelRatio) });
    expect(cellOf(rows()[0]!).querySelector('img')).toBeNull(); // placeholder icon while loading
    await act(async () => answers.get('f1')!.resolve({ fileId: 'f1', url: 'orbit-preview://p/AAAAAAAAAAAAAAAAAAAAAAAA', width: 80, height: 40 }));
    const img = cellOf(rows()[0]!).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('orbit-preview://p/AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(img.getAttribute('alt')).toBe(''); // decorative: the row is labelled by page and name
    expect([img.style.width, img.style.height]).toEqual(['40px', '20px']);
    expect(cellOf(rows()[0]!).getAttribute('data-thumb')).toBe('ready');

    // Reordering keeps the thumbnails: no new requests.
    await userEvent.setup().click(screen.getByRole('button', { name: t('pdf.moveDown', { name: 'IMG_1.jpg' }) }));
    expect(rows()[1]!.querySelector('.pdf-name')?.textContent).toBe('IMG_1.jpg');
    expect(cellOf(rows()[1]!).querySelector('img')?.getAttribute('src')).toBe('orbit-preview://p/AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(orbit.getEditorThumbnail).toHaveBeenCalledTimes(2);
  });

  it('without IntersectionObserver asks for every row; a failure keeps the icon; a broken image is asked for once more', async () => {
    const orbit = createFakeOrbit();
    orbit.getEditorThumbnail.mockImplementation(async (request: ThumbnailRequest) => {
      if (request.fileId === 'f2') throw new Error('IMAGE_CORRUPT: damaged');
      return { fileId: request.fileId, url: `orbit-preview://p/${request.fileId}AAAAAAAAAAAAAAAAAAAA`, width: 40, height: 30 };
    });
    renderWithEnv(<PdfOrderEditor ctx={sampleEditorContext('convert.pdf', { files, defaults })} title="PDF로 변환" />, { orbit });
    await waitFor(() => expect(orbit.getEditorThumbnail).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(cellOf(rows()[1]!).getAttribute('data-thumb')).toBe('failed'));
    expect(cellOf(rows()[1]!).querySelector('img')).toBeNull();
    const img = await waitFor(() => {
      const found = cellOf(rows()[0]!).querySelector('img');
      if (!found) throw new Error('no image yet');
      return found;
    });
    // The token expired (404): one more request, then the icon if it fails again.
    fireEvent.error(img);
    await waitFor(() => expect(orbit.getEditorThumbnail.mock.calls.filter(([r]) => r.fileId === 'f1')).toHaveLength(2));
    fireEvent.error(cellOf(rows()[0]!).querySelector('img')!);
    await waitFor(() => expect(cellOf(rows()[0]!).getAttribute('data-thumb')).toBe('failed'));
    expect(orbit.getEditorThumbnail.mock.calls.filter(([r]) => r.fileId === 'f1')).toHaveLength(2);
  });

  it('drops answers that arrive after the editor closed', async () => {
    const orbit = createFakeOrbit();
    const late = deferred<ThumbnailResponse>();
    orbit.getEditorThumbnail.mockImplementation(() => late.promise);
    const view = renderWithEnv(<PdfOrderEditor ctx={sampleEditorContext('convert.pdf', { files: files.slice(0, 2), defaults: { ...defaults, order: ['f1', 'f2'] } })} title="PDF로 변환" />, { orbit });
    await waitFor(() => expect(orbit.getEditorThumbnail).toHaveBeenCalled());
    view.unmount();
    await act(async () => late.resolve({ fileId: 'f1', url: 'orbit-preview://p/x', width: 1, height: 1 }));
  });

  it('helpers: request size in device pixels (≤ 160) and fitting into the 40 px box', () => {
    expect(thumbnailEdge(1)).toBe(40);
    expect(thumbnailEdge(2)).toBe(80);
    expect(thumbnailEdge(3)).toBe(80); // capped at 2×
    expect(thumbnailEdge(Number.NaN)).toBe(40);
    expect(fitThumbnail(80, 40)).toEqual({ width: 40, height: 20 });
    expect(fitThumbnail(20, 30)).toEqual({ width: 20, height: 30 }); // never enlarged
  });
});

// ------------------------------------------------------------------ batch Compress

const COMPRESS_DEFAULTS = { format: 'input', quality: 75, maxEdge: null, pngMode: 'palette', keepMetadata: false };

function batchSetup(estimates: (request: EstimateRequest) => Promise<EstimateOutcome> | EstimateOutcome, files = imageFiles(3, (i) => [1_000_000, 2_000_000, 500_000][i] ?? 1)) {
  const orbit = createFakeOrbit({ requestEstimate: async (request) => estimates(request) });
  const ctx = sampleEditorContext('tool.compress', { files, defaults: COMPRESS_DEFAULTS });
  const view = renderWithEnv(<CompressEditor ctx={ctx} title="이미지 압축" />, { orbit });
  return { ...view, orbit, files };
}

const ok = (request: EstimateRequest, bytes: number): EstimateOutcome => ({ ok: true, seq: request.seq, fileId: request.fileId, estimatedBytes: bytes, outputFormat: 'jpeg' });

describe('CompressEditor with several files', () => {
  it('estimates every file with one seq after the options settle and shows honest totals', async () => {
    const sizes: Record<string, number> = { f1: 600_000, f2: 900_000, f3: 250_000 };
    const { orbit } = batchSetup((request) => ok(request, sizes[request.fileId]!));
    expect(screen.getByText(t('compress.previewOf', { name: 'IMG_1.jpg' }))).toBeTruthy();
    expect(orbit.requestEstimate).not.toHaveBeenCalled(); // debounced
    await waitFor(() => expect(orbit.requestEstimate).toHaveBeenCalledTimes(3), { timeout: 2000 });
    const seqs = new Set(orbit.requestEstimate.mock.calls.map(([r]) => r.seq));
    expect(seqs.size).toBe(1);
    expect(orbit.requestEstimate.mock.calls.map(([r]) => r.fileId)).toEqual(['f1', 'f2', 'f3']);
    expect(orbit.requestEstimate.mock.calls[0]![0].options).toEqual(COMPRESS_DEFAULTS);
    await screen.findByText('1.8 MB'); // 600 KB + 900 KB + 250 KB
    expect(screen.getByText('3.5 MB')).toBeTruthy(); // input total
    expect(screen.getByText(t('compress.batchSmaller', { percent: 50 }))).toBeTruthy();
    const list = screen.getByRole('list', { name: t('compress.perFile') });
    expect(within(list).getAllByRole('listitem').map((li) => li.querySelector('.compress-estimate-name')?.textContent)).toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_3.jpg']);
    expect(within(list).getByText('2 MB → 900 KB')).toBeTruthy();
    expect(screen.queryByText(/성공/)).toBeNull();
  });

  it('marks files that would not shrink and never presents them as a success', async () => {
    batchSetup((request) => ok(request, request.fileId === 'f3' ? 520_000 : 400_000));
    const warning = await screen.findByText(t.plural('compress.someNotSmaller', 1), {}, { timeout: 2000 });
    expect(warning.closest('.notice')?.getAttribute('data-tone')).toBe('warning');
    const row = screen.getByText('IMG_3.jpg').closest('li')!;
    expect(row.getAttribute('data-tone')).toBe('warning');
    expect(within(row).getByText(t('compress.fileNotSmaller'))).toBeTruthy();
    expect(screen.queryByText(/합계 \d+% 작아질/)).toBeNull();
  });

  it('a total that does not shrink is a warning', async () => {
    batchSetup((request) => ok(request, 3_000_000));
    expect(await screen.findByText(t('compress.batchNotSmaller'), {}, { timeout: 2000 })).toBeTruthy();
  });

  it('shows progress until every file is estimated, and a failed file without a total', async () => {
    const answers = new Map<string, ReturnType<typeof deferred<EstimateOutcome>>>();
    batchSetup((request) => {
      const d = deferred<EstimateOutcome>();
      answers.set(request.fileId, d);
      return d.promise;
    });
    await waitFor(() => expect(answers.size).toBe(3), { timeout: 2000 });
    await act(async () => answers.get('f1')!.resolve({ ok: true, seq: 1, fileId: 'f1', estimatedBytes: 100_000 }));
    expect(screen.getByText(t('compress.estimateProgress', { done: 1, total: 3 }))).toBeTruthy();
    await act(async () => answers.get('f2')!.resolve({ ok: false, seq: 1, fileId: 'f2', error: { code: 'IMAGE_CORRUPT', message: 'bad', retryable: false } }));
    await act(async () => answers.get('f3')!.resolve({ ok: true, seq: 1, fileId: 'f3', estimatedBytes: 100_000 }));
    const failedRow = screen.getByText('IMG_2.jpg').closest('li')!;
    expect(failedRow.getAttribute('data-tone')).toBe('danger');
    expect(within(failedRow).getByText(t('compress.estimateFailed'))).toBeTruthy();
    expect(failedRow.textContent).toContain(koErrors['error.IMAGE_CORRUPT']);
    expect(screen.queryByText(t('compress.estimateProgress', { done: 3, total: 3 }))).toBeNull();
    expect(screen.queryByText(/합계 \d+% 작아질/)).toBeNull(); // no total claim while one failed
  });

  it('a change of options starts a new seq; answers of the old one are ignored', async () => {
    const pending: { request: EstimateRequest; d: ReturnType<typeof deferred<EstimateOutcome>> }[] = [];
    const { orbit } = batchSetup((request) => {
      const d = deferred<EstimateOutcome>();
      pending.push({ request, d });
      return d.promise;
    });
    await waitFor(() => expect(pending).toHaveLength(3), { timeout: 2000 });
    const firstSeq = pending[0]!.request.seq;
    fireEvent.change(screen.getByRole('slider', { name: t('compress.quality') }), { target: { value: '40' } });
    await waitFor(() => expect(pending).toHaveLength(6), { timeout: 2000 });
    const secondSeq = pending[3]!.request.seq;
    expect(secondSeq).toBeGreaterThan(firstSeq);
    expect(pending[3]!.request.options).toMatchObject({ quality: 40 });
    // A late answer for the old options must not show up.
    await act(async () => pending[0]!.d.resolve({ ok: true, seq: firstSeq, fileId: 'f1', estimatedBytes: 1 }));
    expect(screen.queryByText('1 B → ', { exact: false })).toBeNull();
    for (const { request, d } of pending.slice(3)) await act(async () => d.resolve(ok(request, 100_000)));
    expect(await screen.findByText('300 KB')).toBeTruthy();
    expect(orbit.requestEstimate).toHaveBeenCalledTimes(6);
  });

  it('after compressing shows final sizes next to the estimates and a total once all are done', async () => {
    let listener: ((jobs: readonly JobSnapshot[]) => void) | null = null;
    const files = imageFiles(2, () => 1_000_000);
    const orbit = createFakeOrbit({
      requestEstimate: async (request) => ok(request, request.fileId === 'f1' ? 400_000 : 1_200_000),
      commitEditor: async () => ({ kind: 'jobs' as const, jobIds: ['j1', 'j2'] }),
      onJobsChanged: (next) => {
        listener = next;
        return () => undefined;
      },
    });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { files, defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });
    await screen.findByText('1.6 MB', {}, { timeout: 2000 });
    await userEvent.setup().click(screen.getByRole('button', { name: t('compress.run') }));
    await screen.findByText(t('compress.results'));
    expect(screen.getByText(t('compress.resultEstimate', { size: '400 KB' }))).toBeTruthy();
    expect(screen.getByText(t('compress.resultEstimate', { size: '1.2 MB' }))).toBeTruthy();
    const done = (jobId: string, name: string, bytes: number) =>
      sampleJob({ jobId, actionId: 'tool.compress', inputName: name, state: 'completed', inputBytes: 1_000_000, outputs: [{ outputId: `o-${jobId}`, name, dirDisplay: 'Pictures', format: 'jpeg', bytes }], ...(bytes >= 1_000_000 ? { warnings: [{ code: 'OUTPUT_LARGER_THAN_INPUT' as const }] } : {}) });
    act(() => listener?.([done('j1', 'IMG_1.jpg', 400_000)]));
    expect(screen.queryByText(/합계 .* → /)).toBeNull(); // not all done yet
    act(() => listener?.([done('j1', 'IMG_1.jpg', 400_000), done('j2', 'IMG_2.jpg', 1_200_000)]));
    const total = await screen.findByText(t('compress.resultTotal', { input: '2 MB', output: '1.6 MB' }), { exact: false });
    expect(total.closest('[data-tone]')?.getAttribute('data-tone')).toBe('good');
    expect(screen.getByText(t('compress.resultNotSmaller', { percent: 20 }))).toBeTruthy(); // the larger file is still a warning
  });

  it('summaries count failures and not-smaller files exactly', () => {
    const files = imageFiles(3, () => 100);
    const summary = summarizeEstimates(
      files,
      new Map([
        ['f1', { status: 'ok' as const, bytes: 50 }],
        ['f2', { status: 'ok' as const, bytes: 100 }],
        ['f3', { status: 'pending' as const, previous: 10 }],
      ]),
    );
    expect(summary).toEqual({ total: 3, done: 2, complete: false, failed: 0, inputBytes: 300, estimatedBytes: null, notSmaller: 1 });
  });
});

// ------------------------------------------------------------------ 'keep input format' resolution

describe("what 'original format' resolves to", () => {
  it('Compress: a GIF is saved as PNG (reported by the processor), with the PNG controls', async () => {
    const image = sampleImageInfo({ format: 'gif', width: 320, height: 200, orientedWidth: 320, orientedHeight: 200, bytes: 50_000 });
    const files: SelectedFile[] = [{ fileId: 'f1', name: 'anim.gif', ext: '.gif', format: 'gif', kind: 'image', bytes: 50_000 }];
    const orbit = createFakeOrbit({
      requestPreview: async (request) => ({ ok: true as const, seq: request.seq, url: 'data:image/png;base64,', width: 320, height: 200, estimatedBytes: 30_000, outputFormat: 'png' as const }),
    });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { image, files, defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });
    expect(await screen.findByText(t('editor.format.resolved', { from: 'GIF', to: 'PNG' }))).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: t('compress.pngMode') })).toBeTruthy();
  });

  it('Adjust: the note and the output name follow the reported format', async () => {
    const image = sampleImageInfo({ format: 'gif', width: 300, height: 200, orientedWidth: 300, orientedHeight: 200 });
    const files: SelectedFile[] = [{ fileId: 'f1', name: 'sticker.gif', ext: '.gif', format: 'gif', kind: 'image', bytes: 10_000 }];
    const orbit = createFakeOrbit({
      requestPreview: async (request) => ({ ok: true as const, seq: request.seq, url: 'data:image/png;base64,', width: 300, height: 200, outputFormat: 'png' as const }),
    });
    const defaults = { rotate: 0, flipH: false, flipV: false, brightness: 0, contrast: 0, saturation: 0, outputFormat: 'input' };
    renderWithEnv(<AdjustEditor ctx={sampleEditorContext('tool.edit', { image, files, defaults })} title="이미지 편집" />, { orbit });
    expect(await screen.findByText(t('editor.format.resolved', { from: 'GIF', to: 'PNG' }))).toBeTruthy();
    expect(screen.getByText(t('editor.outputName', { name: 'sticker Edited.png' }))).toBeTruthy();
  });

  it('no note when the format is kept', async () => {
    const orbit = createFakeOrbit({
      requestPreview: async (request) => ({ ok: true as const, seq: request.seq, url: 'data:image/png;base64,', width: 400, height: 300, estimatedBytes: 1000, outputFormat: 'jpeg' as const }),
    });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });
    await waitFor(() => expect(orbit.requestPreview).toHaveBeenCalled());
    await screen.findByText('1 KB');
    expect(screen.queryByText(/원본 형식으로 저장하면/)).toBeNull();
  });
});
