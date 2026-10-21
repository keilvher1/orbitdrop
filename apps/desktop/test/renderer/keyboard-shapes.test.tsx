// @vitest-environment jsdom
import './setup';
import type { AnnotationShape, RedactRegion } from '@orbitdrop/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AnnotateEditor } from '../../src/renderer/src/views/editor/annotate/AnnotateEditor';
import { resizeShape } from '../../src/renderer/src/views/editor/annotate/annotateModel';
import { RedactEditor } from '../../src/renderer/src/views/editor/redact/RedactEditor';
import { createFakeOrbit, renderWithEnv, sampleEditorContext } from './helpers';

/**
 * Keyboard-only creation (no pointer): the "add" buttons insert a centred
 * shape or region, selected, with focus on the canvas; the arrow keys move it
 * (Shift ×10) and Alt/Option+arrows resize it. The 4032×3024 sample image is
 * shown at 464×348, so one arrow press is round(4032 / 464) = 9 source px.
 */

const STEP = 9;

function annotate() {
  const orbit = createFakeOrbit();
  const ctx = sampleEditorContext('tool.annotate', { defaults: { shapes: [], outputFormat: 'input' } });
  renderWithEnv(<AnnotateEditor ctx={ctx} title="주석 달기" />, { orbit });
  return { orbit, user: userEvent.setup(), surface: screen.getByRole('application', { name: '주석 캔버스' }) };
}

const committed = (orbit: ReturnType<typeof createFakeOrbit>) =>
  (orbit.commitEditor.mock.calls.at(-1)?.[0] as { options: { shapes?: AnnotationShape[]; regions?: RedactRegion[] } }).options;

describe('Annotate without a pointer', () => {
  it('adds a centred rectangle, moves it with the arrow keys and resizes it with Option+arrows', async () => {
    const { orbit, user, surface } = annotate();
    await user.click(screen.getByRole('button', { name: '사각형 추가' }));
    expect(screen.getByText('주석 1개')).toBeTruthy();
    expect(document.activeElement).toBe(surface);
    expect(screen.getByText(/사각형을 가운데에 추가했습니다\. 방향키로 옮기고 Option\+방향키로 크기를 바꿉니다\./)).toBeTruthy();
    expect(surface.getAttribute('aria-describedby')?.split(' ')).toHaveLength(2); // pointer help + keyboard help

    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    const inserted = committed(orbit).shapes![0] as Extract<AnnotationShape, { type: 'rect' }>;
    expect(inserted.type).toBe('rect');
    // Centred on the 4032×3024 image (within a pixel of rounding).
    expect(Math.abs(inserted.x + inserted.width / 2 - 2016)).toBeLessThanOrEqual(5);
    expect(Math.abs(inserted.y + inserted.height / 2 - 1512)).toBeLessThanOrEqual(5);
    expect(inserted.width).toBeGreaterThan(inserted.height);
  });

  it('arrow keys move the inserted shape, Shift moves ten times as far, Option+arrows change its size', async () => {
    const { orbit, user, surface } = annotate();
    // A refused first save keeps the editor open: it records the shape as inserted.
    orbit.commitEditor.mockResolvedValueOnce({ kind: 'rejected', error: { code: 'INTERNAL', message: 'not now', retryable: false } });
    await user.click(screen.getByRole('button', { name: '사각형 추가' }));
    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    const start = committed(orbit).shapes![0] as Extract<AnnotationShape, { type: 'rect' }>;
    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    fireEvent.keyDown(surface, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(surface, { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(surface, { key: 'ArrowUp', altKey: true });
    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    const moved = committed(orbit).shapes![0] as Extract<AnnotationShape, { type: 'rect' }>;
    expect([moved.x - start.x, moved.y - start.y]).toEqual([STEP, 10 * STEP]);
    expect([moved.width - start.width, moved.height - start.height]).toEqual([STEP, -STEP]);
  });

  it('adds an arrow whose tip Option+arrows move, and text typed into a centred box', async () => {
    const { orbit, user, surface } = annotate();
    await user.click(screen.getByRole('button', { name: '화살표 추가' }));
    expect(screen.getByText(/화살표를 가운데에 추가했습니다/)).toBeTruthy();
    fireEvent.keyDown(surface, { key: 'ArrowLeft', altKey: true });

    await user.click(screen.getByRole('button', { name: '텍스트 추가' }));
    const box = await screen.findByRole('textbox', { name: '주석 텍스트' });
    expect(document.activeElement).toBe(box);
    (box as HTMLTextAreaElement).value = '확인 필요';
    fireEvent.input(box);
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '주석 텍스트' })).toBeNull());
    // The new text is selected and the canvas has focus: Option+↑ makes it larger.
    expect(document.activeElement).toBe(surface);
    fireEvent.keyDown(surface, { key: 'ArrowUp', altKey: true });
    expect(screen.getByText('주석 2개')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    const [arrow, text] = committed(orbit).shapes!;
    expect(arrow).toMatchObject({ type: 'arrow' });
    if (arrow?.type !== 'arrow' || text?.type !== 'text') throw new Error('unexpected shapes');
    expect(arrow.x2).toBeLessThan(2016 + 600); // tip moved left from its default position
    expect(text).toMatchObject({ text: '확인 필요' });
    expect(text.fontSize).toBe(Math.round(24 * (4032 / 464)) + STEP); // default 24 view px, then one Option+↑
    expect(Math.abs(text.y + text.fontSize * 0.6 - 1512)).toBeLessThan(text.fontSize);
  });

  it('resizeShape keeps shapes valid', () => {
    const rect = { id: 'r1', type: 'rect', x: 10, y: 10, width: 5, height: 5, color: '#000000', strokeWidth: 2 } as const;
    expect(resizeShape(rect, -20, 3)).toMatchObject({ width: 1, height: 8 });
    const arrow = { id: 'w1', type: 'arrow', x1: 0, y1: 0, x2: 1, y2: 0, color: '#000000', strokeWidth: 2 } as const;
    expect(resizeShape(arrow, -1, 0)).toBe(arrow); // a tip on the tail would be no arrow
    const text = { id: 't1', type: 'text', x: 0, y: 0, text: 'a', color: '#000000', fontSize: 6, bold: true } as const;
    expect(resizeShape(text, 0, 5)).toBe(text); // already at the minimum size
    expect(resizeShape(text, 4, 0)).toMatchObject({ fontSize: 10 });
  });
});

describe('Redact without a pointer', () => {
  it('adds a centred region, then moves and resizes it with the keyboard', async () => {
    const orbit = createFakeOrbit();
    const ctx = sampleEditorContext('tool.redact', { defaults: { regions: [], outputFormat: 'input' } });
    renderWithEnv(<RedactEditor ctx={ctx} title="정보 가리기" />, { orbit });
    const user = userEvent.setup();
    const surface = screen.getByRole('application', { name: '가리기 캔버스' });
    orbit.commitEditor.mockResolvedValueOnce({ kind: 'rejected', error: { code: 'INTERNAL', message: 'not now', retryable: false } });
    await user.click(screen.getByRole('button', { name: '영역 추가' }));
    expect(screen.getByText('영역 1개')).toBeTruthy();
    expect(document.activeElement).toBe(surface);
    expect(screen.getByText(/가릴 영역을 가운데에 추가했습니다/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '가려서 저장' }));
    const start = committed(orbit).regions![0]!.rect;
    expect(Math.abs(start.x + start.width / 2 - 2016)).toBeLessThanOrEqual(5);
    expect(Math.abs(start.y + start.height / 2 - 1512)).toBeLessThanOrEqual(5);

    fireEvent.keyDown(surface, { key: 'ArrowLeft' });
    fireEvent.keyDown(surface, { key: 'ArrowRight', altKey: true });
    await user.click(screen.getByRole('button', { name: '가려서 저장' }));
    const moved = committed(orbit).regions![0]!.rect;
    expect(moved.x).toBe(start.x - STEP);
    expect(moved.width).toBe(start.width + STEP);
  });
});
