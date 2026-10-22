// @vitest-environment jsdom
import './setup';
import type { JobSnapshot, SelectedFile } from '@orbitdrop/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../src/renderer/src/i18n/catalog';
import { AdjustEditor, rotateBy, rotatedSize } from '../../src/renderer/src/views/editor/adjust/AdjustEditor';
import { CompressEditor, compressDefaults, effectiveFormat } from '../../src/renderer/src/views/editor/compress/CompressEditor';
import { MetadataEditor, bitDepthLabel, colorSpaceLabel } from '../../src/renderer/src/views/editor/metadata/MetadataEditor';
import { PdfOrderEditor, initialOrder, marginChoiceFor, moveItem, pdfOptions } from '../../src/renderer/src/views/editor/pdf/PdfOrderEditor';
import { createFakeOrbit, renderWithEnv, sampleEditorContext, sampleImageInfo, sampleJob } from './helpers';

const t = createTranslator('ko');

const COMPRESS_DEFAULTS = { format: 'input', quality: 75, maxEdge: null, pngMode: 'palette', keepMetadata: false };

function previewWith(estimatedBytes: number) {
  return async (request: { seq: number }) => ({ ok: true as const, seq: request.seq, url: 'data:image/png;base64,', width: 400, height: 300, estimatedBytes });
}

describe('CompressEditor', () => {
  it('warns (and never claims success) when the estimate is not smaller than the input', async () => {
    const orbit = createFakeOrbit({ requestPreview: previewWith(1_500_000) });
    const ctx = sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS });
    renderWithEnv(<CompressEditor ctx={ctx} title="이미지 압축" />, { orbit });

    expect(await screen.findByText(t('compress.notSmaller'))).toBeTruthy();
    expect(screen.queryByText(/작아질 것으로/)).toBeNull();
    expect(screen.queryByText(/성공/)).toBeNull();
    expect(screen.getByText('+22%')).toBeTruthy();
    expect(orbit.requestPreview).toHaveBeenCalledWith(expect.objectContaining({ editorId: 'ed1', options: COMPRESS_DEFAULTS }));
  });

  it('shows the expected reduction when the estimate is smaller', async () => {
    const orbit = createFakeOrbit({ requestPreview: previewWith(600_000) });
    const ctx = sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS });
    renderWithEnv(<CompressEditor ctx={ctx} title="이미지 압축" />, { orbit });

    expect(await screen.findByText(t('compress.smaller', { percent: 51 }))).toBeTruthy();
    expect(screen.queryByText(t('compress.notSmaller'))).toBeNull();
    expect(screen.getByText('600 KB')).toBeTruthy();
  });

  it('offers PNG mode instead of quality for PNG output and only downscaling presets', async () => {
    const image = sampleImageInfo({ format: 'png', orientedWidth: 2000, orientedHeight: 1000, width: 2000, height: 1000, hasAlpha: true });
    const ctx = sampleEditorContext('tool.compress', { image, defaults: COMPRESS_DEFAULTS });
    const { orbit } = renderWithEnv(<CompressEditor ctx={ctx} title="이미지 압축" />);

    expect(screen.getByRole('radiogroup', { name: t('compress.pngMode') })).toBeTruthy();
    expect(screen.queryByRole('slider', { name: t('compress.quality') })).toBeNull();
    const edges = screen.getByRole('radiogroup', { name: t('compress.maxEdge') });
    const labels = Array.from(edges.querySelectorAll('[role="radio"]')).map((el) => el.textContent);
    expect(labels).toEqual([t('compress.maxEdge.none'), '1920', '1280', t('compress.maxEdge.customLabel')]);
    expect(screen.getByRole('radio', { name: '1920px' })).toBeTruthy();

    await userEvent.setup().click(screen.getByRole('radio', { name: '1280px' }));
    await waitFor(() => expect(orbit.requestPreview).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ maxEdge: 1280 }) })));
  });

  it('after compressing follows the job and reports the real final size', async () => {
    let listener: ((jobs: readonly JobSnapshot[]) => void) | null = null;
    const orbit = createFakeOrbit({
      requestPreview: previewWith(500_000),
      commitEditor: async () => ({ kind: 'jobs' as const, jobIds: ['job1'] }),
      onJobsChanged: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      listJobs: async () => [sampleJob({ jobId: 'job1', actionId: 'tool.compress', state: 'running' })],
    });
    const ctx = sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS });
    const user = userEvent.setup();
    renderWithEnv(<CompressEditor ctx={ctx} title="이미지 압축" />, { orbit });

    await user.click(screen.getByRole('button', { name: t('compress.run') }));
    expect(orbit.commitEditor).toHaveBeenCalledWith({ editorId: 'ed1', options: COMPRESS_DEFAULTS });
    expect(await screen.findByText(t('compress.results'))).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(orbit.closeWindow).not.toHaveBeenCalled();

    act(() => {
      listener?.([
        sampleJob({
          jobId: 'job1',
          actionId: 'tool.compress',
          state: 'completed',
          inputBytes: 1_000_000,
          outputs: [{ outputId: 'o1', name: 'photo Compressed.jpg', dirDisplay: 'Pictures', format: 'jpeg', bytes: 600_000 }],
        }),
        sampleJob({ jobId: 'other', state: 'completed' }),
      ]);
    });
    expect(await screen.findByText(t('compress.resultSmaller', { percent: 40 }))).toBeTruthy();
    expect(screen.getByText('1 MB → 600 KB')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: t('jobs.reveal.darwin') }));
    expect(orbit.revealOutput).toHaveBeenCalledWith('o1');
    await user.click(screen.getByRole('button', { name: t('jobs.open') }));
    expect(orbit.openOutput).toHaveBeenCalledWith('o1');
    await user.click(screen.getByRole('button', { name: t('common.close') }));
    expect(orbit.closeWindow).toHaveBeenCalled();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
  });

  it('reports a larger result as a warning, not a success', async () => {
    let listener: ((jobs: readonly JobSnapshot[]) => void) | null = null;
    const orbit = createFakeOrbit({
      requestPreview: previewWith(500_000),
      commitEditor: async () => ({ kind: 'jobs' as const, jobIds: ['job1'] }),
      onJobsChanged: (next) => {
        listener = next;
        return () => undefined;
      },
    });
    const ctx = sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS });
    renderWithEnv(<CompressEditor ctx={ctx} title="이미지 압축" />, { orbit });
    await userEvent.setup().click(screen.getByRole('button', { name: t('compress.run') }));
    await screen.findByText(t('compress.results'));

    act(() => {
      listener?.([
        sampleJob({
          jobId: 'job1',
          actionId: 'tool.compress',
          state: 'completed',
          inputBytes: 1_000_000,
          outputs: [{ outputId: 'o1', name: 'photo Compressed.jpg', dirDisplay: 'Pictures', format: 'jpeg', bytes: 1_100_000 }],
          warnings: [{ code: 'OUTPUT_LARGER_THAN_INPUT' }],
        }),
      ]);
    });
    expect(await screen.findByText(t('compress.resultNotSmaller', { percent: 10 }))).toBeTruthy();
    expect(screen.queryByText(/줄었습니다/)).toBeNull();
  });

  it('shows a localized error for a failed job', async () => {
    let listener: ((jobs: readonly JobSnapshot[]) => void) | null = null;
    const orbit = createFakeOrbit({
      commitEditor: async () => ({ kind: 'jobs' as const, jobIds: ['job1'] }),
      onJobsChanged: (next) => {
        listener = next;
        return () => undefined;
      },
    });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });
    await userEvent.setup().click(screen.getByRole('button', { name: t('compress.run') }));
    await screen.findByText(t('compress.results'));
    act(() => {
      listener?.([sampleJob({ jobId: 'job1', actionId: 'tool.compress', state: 'failed', error: { code: 'DISK_FULL', message: 'full', retryable: true } })]);
    });
    expect(await screen.findByText(t('error.DISK_FULL'))).toBeTruthy();
  });

  it('keeps the editor open with the error when main rejects the commit', async () => {
    const orbit = createFakeOrbit({
      commitEditor: async () => ({ kind: 'rejected' as const, error: { code: 'INVALID_OPTIONS', message: 'bad', retryable: false } }),
    });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { defaults: COMPRESS_DEFAULTS })} title="이미지 압축" />, { orbit });
    await userEvent.setup().click(screen.getByRole('button', { name: t('compress.run') }));
    expect(await screen.findByText(t('error.INVALID_OPTIONS'))).toBeTruthy();
    expect(screen.queryByText(t('compress.results'))).toBeNull();
    expect(orbit.closeWindow).not.toHaveBeenCalled();
  });

  it('normalises defaults: no upscaling max edge, valid enums', () => {
    expect(compressDefaults({ maxEdge: 5000, format: 'gif', quality: 300 }, 4032)).toEqual({ format: 'input', quality: 100, maxEdge: null, pngMode: 'palette', keepMetadata: false });
    expect(compressDefaults({ maxEdge: 1920, format: 'webp' }, 4032)).toMatchObject({ maxEdge: 1920, format: 'webp' });
    expect(effectiveFormat('input', 'png')).toBe('png');
    expect(effectiveFormat('webp', 'png')).toBe('webp');
  });
});

describe('MetadataEditor', () => {
  const info = sampleImageInfo({
    width: 3024,
    height: 4032,
    orientedWidth: 4032,
    orientedHeight: 3024,
    orientation: 6,
    exif: { make: 'Apple', model: 'iPhone 17', fNumber: 1.8, iso: 64, gps: { latitude: 37.5, longitude: 127 }, other: [{ tag: 'Artist', value: 'Kim' }] },
  });

  it('shows the inspected fields, warns about GPS and commits the chosen ICC policy', async () => {
    const orbit = createFakeOrbit({ inspectImage: async () => info });
    const ctx = sampleEditorContext('tool.metadata', { defaults: { mode: 'strip', iccPolicy: 'convertToSrgb', outputFormat: 'input' } });
    const user = userEvent.setup();
    renderWithEnv(<MetadataEditor ctx={ctx} title="메타데이터" />, { orbit });

    expect(await screen.findByText(t('meta.gpsWarning'))).toBeTruthy();
    expect(orbit.inspectImage).toHaveBeenCalledWith('ed1');
    expect(screen.getByText('Apple iPhone 17')).toBeTruthy();
    expect(screen.getByText('f/1.8')).toBeTruthy();
    expect(screen.getByText(t('meta.oriented', { width: 4032, height: 3024 }))).toBeTruthy();
    expect(screen.getByText('Artist')).toBeTruthy();
    expect(screen.getByText('Display P3')).toBeTruthy();

    expect((screen.getByLabelText(t('meta.icc.convert')) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByLabelText(t('meta.icc.keep')));
    await user.click(screen.getByRole('button', { name: t('meta.strip') }));
    expect(orbit.commitEditor).toHaveBeenCalledWith({ editorId: 'ed1', options: { mode: 'strip', iccPolicy: 'keep', outputFormat: 'input' } });
    await waitFor(() => expect(orbit.closeWindow).toHaveBeenCalled());
  });

  it('has no GPS warning without location data and reports inspect failures', async () => {
    const orbit = createFakeOrbit({ inspectImage: async () => Promise.reject(new Error('IMAGE_CORRUPT: broken')) });
    renderWithEnv(<MetadataEditor ctx={sampleEditorContext('tool.metadata')} title="메타데이터" />, { orbit });
    expect(await screen.findByText(t('error.IMAGE_CORRUPT'))).toBeTruthy();
    expect(screen.queryByText(t('meta.gpsWarning'))).toBeNull();
  });

  it('labels colour spaces and bit depths', () => {
    expect(colorSpaceLabel('srgb', t)).toBe('sRGB');
    expect(colorSpaceLabel('b-w', t)).toBe(t('meta.grayscale'));
    expect(colorSpaceLabel(null, t)).toBe(t('meta.unknown'));
    expect(bitDepthLabel('uchar', t)).toBe(t('meta.bits', { bits: 8 }));
    expect(bitDepthLabel('float', t)).toBe(t('meta.bitsFloat', { bits: 32 }));
  });
});

describe('AdjustEditor', () => {
  const defaults = { rotate: 0, flipH: false, flipV: false, brightness: 0, contrast: 0, saturation: 0, outputFormat: 'input' };

  it('rotates, flips and adjusts, then commits exactly those options', async () => {
    const ctx = sampleEditorContext('tool.edit', { defaults });
    const user = userEvent.setup();
    const { orbit } = renderWithEnv(<AdjustEditor ctx={ctx} title="이미지 편집" />);

    await user.click(screen.getByRole('button', { name: t('adjust.rotateRight') }));
    await user.click(screen.getByRole('button', { name: t('adjust.rotateRight') }));
    await user.click(screen.getByRole('button', { name: t('adjust.rotateLeft') }));
    const flipH = screen.getByRole('button', { name: t('adjust.flipH') });
    await user.click(flipH);
    expect(flipH.getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByRole('slider', { name: t('adjust.brightness') }), { target: { value: '25' } });
    expect(screen.getByText(t('editor.outputSize', { width: 3024, height: 4032 }))).toBeTruthy();

    await waitFor(() =>
      expect(orbit.requestPreview).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ rotate: 90, flipH: true, brightness: 25 }) })),
    );
    await user.click(screen.getByRole('button', { name: t('common.apply') }));
    expect(orbit.commitEditor).toHaveBeenCalledWith({
      editorId: 'ed1',
      options: { rotate: 90, flipH: true, flipV: false, brightness: 25, contrast: 0, saturation: 0, outputFormat: 'input' },
    });
  });

  it('Reset returns to the neutral state', async () => {
    const user = userEvent.setup();
    renderWithEnv(<AdjustEditor ctx={sampleEditorContext('tool.edit', { defaults })} title="이미지 편집" />);
    const reset = screen.getByRole('button', { name: t('common.reset') });
    // Unavailable but focusable (aria-disabled) while there is nothing to reset.
    expect(reset.getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('button', { name: t('adjust.flipV') }));
    expect(reset.hasAttribute('aria-disabled')).toBe(false);
    await user.click(reset);
    expect(screen.getByRole('button', { name: t('adjust.flipV') }).getAttribute('aria-pressed')).toBe('false');
  });

  it('rotation helpers stay within 0/90/180/270 and swap sizes', () => {
    expect(rotateBy(0, -90)).toBe(270);
    expect(rotateBy(270, 90)).toBe(0);
    expect(rotatedSize(400, 300, 90)).toEqual({ width: 300, height: 400 });
    expect(rotatedSize(400, 300, 180)).toEqual({ width: 400, height: 300 });
  });
});

describe('PdfOrderEditor', () => {
  const files: SelectedFile[] = [
    { fileId: 'f1', name: 'a.jpg', ext: '.jpg', format: 'jpeg', kind: 'image', bytes: 1000 },
    { fileId: 'f2', name: 'b.png', ext: '.png', format: 'png', kind: 'image', bytes: 2000 },
    { fileId: 'f3', name: 'c.webp', ext: '.webp', format: 'webp', kind: 'image', bytes: 3000 },
  ];
  const defaults = { flattenBackground: '#FFFFFF', keepMetadata: false, pageSize: 'image', marginPt: 0, pageSeparator: 'marker', order: ['f1', 'f2', 'f3'] };
  const names = () => screen.getAllByRole('listitem').map((row) => row.querySelector('.pdf-name')?.textContent);

  it('reorders with the buttons and Alt+arrows, announces moves and commits the order', async () => {
    const ctx = sampleEditorContext('convert.pdf', { files, defaults });
    const user = userEvent.setup();
    const { orbit } = renderWithEnv(<PdfOrderEditor ctx={ctx} title="PDF로 변환" />);
    expect(names()).toEqual(['a.jpg', 'b.png', 'c.webp']);
    // The first row cannot move up (aria-disabled: still focusable, pressing it changes nothing).
    const upFirst = screen.getByRole('button', { name: t('pdf.moveUp', { name: 'a.jpg' }) });
    expect(upFirst.getAttribute('aria-disabled')).toBe('true');
    await user.click(upFirst);
    expect(names()).toEqual(['a.jpg', 'b.png', 'c.webp']);

    await user.click(screen.getByRole('button', { name: t('pdf.moveDown', { name: 'a.jpg' }) }));
    expect(names()).toEqual(['b.png', 'a.jpg', 'c.webp']);

    const cRow = screen.getAllByRole('listitem')[2]!;
    cRow.focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(names()).toEqual(['b.png', 'c.webp', 'a.jpg']);
    expect(document.activeElement?.querySelector('.pdf-name')?.textContent).toBe('c.webp');
    expect(screen.getByText(t('pdf.moved', { name: 'c.webp', position: 2 }))).toBeTruthy();

    // Plain arrows move focus between rows without reordering.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.querySelector('.pdf-name')?.textContent).toBe('a.jpg');
    expect(names()).toEqual(['b.png', 'c.webp', 'a.jpg']);

    await user.click(screen.getByRole('radio', { name: 'A4' }));
    await user.click(screen.getByRole('radio', { name: t('pdf.margin.narrow') }));
    await user.click(screen.getByRole('button', { name: t('pdf.create') }));
    expect(orbit.commitEditor).toHaveBeenCalledWith({
      editorId: 'ed1',
      options: { flattenBackground: '#FFFFFF', keepMetadata: false, pageSeparator: 'marker', pageSize: 'a4', marginPt: 18, order: ['f2', 'f3', 'f1'] },
    });
  });

  it('falls back to the selection order when the default order does not match the files', () => {
    expect(initialOrder(files, { order: ['f1', 'f2'] })).toEqual(['f1', 'f2', 'f3']);
    expect(initialOrder(files, { order: ['f3', 'f1', 'f2'] })).toEqual(['f3', 'f1', 'f2']);
    expect(initialOrder(files, { order: ['f3', 'f3', 'f2'] })).toEqual(['f1', 'f2', 'f3']);
  });

  it('helpers: moveItem, margin mapping and strict options', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(marginChoiceFor(20)).toBe('narrow');
    expect(marginChoiceFor(100)).toBe('normal');
    const options = pdfOptions({ ...defaults, junk: 1, dpi: 300, quality: 80 }, 'letter', 36, ['f3', 'f2', 'f1']);
    expect(options).toEqual({
      flattenBackground: '#FFFFFF',
      keepMetadata: false,
      pageSeparator: 'marker',
      quality: 80,
      dpi: 300,
      pageSize: 'letter',
      marginPt: 36,
      order: ['f3', 'f2', 'f1'],
    });
  });
});
