// @vitest-environment jsdom
import './setup';
import type { AnnotationShape } from '@orbitdrop/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AnnotateEditor } from '../../src/renderer/src/views/editor/annotate/AnnotateEditor';
import {
  ANNOTATION_LIMITS,
  HISTORY_LIMIT,
  SHAPE_ID_PATTERN,
  addShape,
  arrowFromDrag,
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  distanceToSegment,
  fontSizeToSource,
  hitTestShapes,
  moveShape,
  newShapeId,
  normalizeText,
  rectFromDrag,
  redo,
  removeShape,
  replacePresent,
  sourceToUi,
  strokeToSource,
  textBox,
  textShapeAt,
  undo,
  updateShape,
  withStyle,
} from '../../src/renderer/src/views/editor/annotate/annotateModel';
import { editorMapping } from '../../src/renderer/src/views/editor/crop/cropMath';
import { createFakeOrbit, renderWithEnv, sampleEditorContext } from './helpers';

// An EXIF-rotated phone photo (oriented 4032×3024) shown in the 464 px wide editor stage.
const mapping = editorMapping({ width: 4032, height: 3024 }, { width: 464, height: 400 });
const style = { color: '#F2552C', strokeWidth: strokeToSource(4, mapping), fontSize: fontSizeToSource(24, mapping) };

describe('undo/redo history', () => {
  it('commits, undoes and redoes', () => {
    let h = createHistory<readonly number[]>([]);
    expect(canUndo(h)).toBe(false);
    h = commitHistory(h, [1]);
    h = commitHistory(h, [1, 2]);
    expect(h.present).toEqual([1, 2]);
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
    h = undo(h);
    expect(h.present).toEqual([1]);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toEqual([1, 2]);
    expect(canRedo(h)).toBe(false);
  });

  it('a new commit after undo clears the redo stack', () => {
    let h = createHistory<readonly number[]>([]);
    h = commitHistory(h, [1]);
    h = commitHistory(h, [1, 2]);
    h = undo(h);
    h = commitHistory(h, [1, 3]);
    expect(h.present).toEqual([1, 3]);
    expect(canRedo(h)).toBe(false);
    expect(redo(h)).toBe(h);
    expect(undo(h).present).toEqual([1]);
  });

  it('undo/redo at the ends and committing the same value are no-ops', () => {
    const empty = createHistory<readonly number[]>([]);
    expect(undo(empty)).toBe(empty);
    expect(redo(empty)).toBe(empty);
    expect(commitHistory(empty, empty.present)).toBe(empty);
  });

  it(`keeps at most ${HISTORY_LIMIT} undo steps`, () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 50; i += 1) h = commitHistory(h, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(50);
    let steps = 0;
    while (canUndo(h)) {
      h = undo(h);
      steps += 1;
    }
    expect(steps).toBe(HISTORY_LIMIT);
    expect(h.present).toBe(50);
  });

  it('replacePresent changes the present without a new undo step', () => {
    let h = commitHistory(createHistory(0), 1);
    h = replacePresent(h, 2);
    h = replacePresent(h, 3);
    expect(h.present).toBe(3);
    expect(h.past).toEqual([0]);
  });
});

describe('shape coordinates (view px → oriented source px)', () => {
  it('shows the 4032×3024 image at 464×348', () => {
    expect(mapping.view).toEqual({ width: 464, height: 348 });
  });

  it('stores stroke width and font size in source px so the result looks like the preview', () => {
    expect(style.strokeWidth).toBe(35); // 4 view px × 8.69
    expect(style.fontSize).toBe(209); // 24 view px × 8.69
    expect(sourceToUi(35, mapping)).toBeCloseTo(4.03, 2);
    expect(strokeToSource(1000, mapping)).toBe(ANNOTATION_LIMITS.strokeWidth.max);
    expect(fontSizeToSource(0.1, mapping)).toBe(ANNOTATION_LIMITS.fontSize.min);
  });

  it('creates a rect from a drag in any direction', () => {
    const rect = rectFromDrag({ x: 174, y: 174 }, { x: 58, y: 87 }, mapping, style, 'r1');
    expect(rect).toEqual({ id: 'r1', type: 'rect', x: 504, y: 756, width: 1008, height: 756, color: '#F2552C', strokeWidth: 35 });
  });

  it('clamps rects to the image', () => {
    const rect = rectFromDrag({ x: -20, y: -20 }, { x: 600, y: 500 }, mapping, style, 'r2');
    expect(rect).toMatchObject({ x: 0, y: 0, width: 4032, height: 3024 });
  });

  it('keeps the arrow direction (tail at the drag start) and rejects zero-length arrows', () => {
    expect(arrowFromDrag({ x: 174, y: 174 }, { x: 58, y: 87 }, mapping, style, 'w1')).toEqual({
      id: 'w1',
      type: 'arrow',
      x1: 1512,
      y1: 1512,
      x2: 504,
      y2: 756,
      color: '#F2552C',
      strokeWidth: 35,
    });
    expect(arrowFromDrag({ x: 58, y: 87 }, { x: 58.01, y: 87 }, mapping, style)).toBeNull();
  });

  it('places text with its top-left at the click point and normalises it', () => {
    expect(textShapeAt({ x: 58, y: 87 }, '안녕\r\n하세요  \n', mapping, style, 't1')).toEqual({
      id: 't1',
      type: 'text',
      x: 504,
      y: 756,
      text: '안녕\n하세요',
      color: '#F2552C',
      fontSize: 209,
      bold: true,
    });
    expect(textShapeAt({ x: 1, y: 1 }, '  \n ', mapping, style)).toBeNull();
    expect(normalizeText('a'.repeat(3000))).toHaveLength(ANNOTATION_LIMITS.textLength);
  });
});

describe('shape editing helpers', () => {
  const rect: AnnotationShape = { id: 'a', type: 'rect', x: 100, y: 100, width: 200, height: 200, color: '#000000', strokeWidth: 4 };
  const arrow: AnnotationShape = { id: 'b', type: 'arrow', x1: 0, y1: 0, x2: 1000, y2: 0, color: '#000000', strokeWidth: 10 };
  const text: AnnotationShape = { id: 'c', type: 'text', x: 0, y: 0, text: 'AB', color: '#000000', fontSize: 100, bold: true };

  it('moves every shape type by whole pixels', () => {
    expect(moveShape(rect, 10.4, -5.6)).toMatchObject({ x: 110, y: 94 });
    expect(moveShape(arrow, 3, 4)).toMatchObject({ x1: 3, y1: 4, x2: 1003, y2: 4 });
    expect(moveShape(text, -1, 2)).toMatchObject({ x: -1, y: 2 });
    expect(moveShape(rect, 0.2, 0.3)).toBe(rect);
  });

  it('applies only the style fields that fit the shape type', () => {
    expect(withStyle(rect, { color: '#FFFFFF', strokeWidth: 9, fontSize: 50 })).toMatchObject({ color: '#FFFFFF', strokeWidth: 9 });
    expect(withStyle(text, { strokeWidth: 9, fontSize: 50 })).toEqual({ ...text, fontSize: 50 });
    expect(withStyle(rect, { strokeWidth: 4 })).toBe(rect);
  });

  it('adds, updates and removes by id; respects the 500-shape limit', () => {
    let list: readonly AnnotationShape[] = [];
    list = addShape(list, rect);
    list = addShape(list, arrow);
    expect(updateShape(list, 'a', (s) => moveShape(s, 1, 1))[0]).toMatchObject({ x: 101 });
    expect(updateShape(list, 'zz', (s) => moveShape(s, 1, 1))).toBe(list);
    expect(removeShape(list, 'a').map((s) => s.id)).toEqual(['b']);
    expect(removeShape(list, 'zz')).toBe(list);
    const full = Array.from({ length: ANNOTATION_LIMITS.maxShapes }, (_, i) => ({ ...rect, id: `s${i}` }));
    expect(addShape(full, text)).toBe(full);
  });

  it('generates unique ids that match the contracts Id pattern', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newShapeId('t')));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(SHAPE_ID_PATTERN);
  });

  it('hit-tests the topmost shape first', () => {
    const below: AnnotationShape = { ...rect, id: 'below' };
    const above: AnnotationShape = { ...rect, id: 'above', x: 150, y: 150 };
    expect(hitTestShapes([below, above], { x: 160, y: 160 }, 5, 'sans-serif')?.id).toBe('above');
    expect(hitTestShapes([below, above], { x: 120, y: 120 }, 5, 'sans-serif')?.id).toBe('below');
    expect(hitTestShapes([below, above], { x: 900, y: 900 }, 5, 'sans-serif')).toBeNull();
  });

  it('hit-tests arrows along the shaft and the head', () => {
    expect(hitTestShapes([arrow], { x: 500, y: 8 }, 5, 'sans-serif')?.id).toBe('b');
    expect(hitTestShapes([arrow], { x: 500, y: 30 }, 5, 'sans-serif')).toBeNull();
    // Head: length max(4 × 10, 10) = 40, half width 20.
    expect(hitTestShapes([arrow], { x: 985, y: 18 }, 3, 'sans-serif')?.id).toBe('b');
    expect(distanceToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('hit-tests text by its box (measured when a canvas is available)', () => {
    expect(textBox(text as Extract<AnnotationShape, { type: 'text' }>, 'sans-serif')).toEqual({ x: 0, y: 0, width: 124, height: 100 });
    expect(hitTestShapes([text], { x: 60, y: 50 }, 0, 'sans-serif')?.id).toBe('c');
    expect(hitTestShapes([text], { x: 300, y: 50 }, 0, 'sans-serif')).toBeNull();
    const measurer = { font: '', measureText: (s: string) => ({ width: s.length * 10 }) };
    expect(hitTestShapes([text], { x: 15, y: 50 }, 0, 'sans-serif', measurer)?.id).toBe('c');
    expect(hitTestShapes([text], { x: 60, y: 50 }, 0, 'sans-serif', measurer)).toBeNull();
    const twoLines = { ...text, text: 'A\nB' } as Extract<AnnotationShape, { type: 'text' }>;
    expect(textBox(twoLines, 'sans-serif', measurer).height).toBe(225); // (1 × 1.25 + 1) × 100
  });
});

// ------------------------------------------------------------------ component

function setup() {
  const orbit = createFakeOrbit();
  const ctx = sampleEditorContext('tool.annotate', { defaults: { shapes: [], outputFormat: 'input' } });
  const view = renderWithEnv(<AnnotateEditor ctx={ctx} title="주석 달기" />, { orbit });
  const surface = screen.getByRole('application', { name: '주석 캔버스' });
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 464,
    bottom: 348,
    width: 464,
    height: 348,
    toJSON: () => ({}),
  } as DOMRect);
  return { ...view, orbit, surface, user: userEvent.setup() };
}

function drag(surface: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: to.x, clientY: to.y });
}

const committedShapes = (orbit: ReturnType<typeof createFakeOrbit>) => {
  const request = orbit.commitEditor.mock.calls.at(-1)?.[0] as { options: { shapes: AnnotationShape[]; outputFormat: string } } | undefined;
  return request?.options;
};

describe('AnnotateEditor', () => {
  it('draws a rectangle in source pixels and commits it', async () => {
    const { surface, user, orbit } = setup();
    const save = screen.getByRole('button', { name: '주석 저장' });
    expect(save).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('radio', { name: '사각형' }));
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    expect(screen.getByText('주석 1개')).toBeTruthy();
    expect(save).toHaveProperty('disabled', false);
    await user.click(save);
    expect(orbit.commitEditor).toHaveBeenCalledTimes(1);
    expect(orbit.commitEditor.mock.calls[0]?.[0]).toMatchObject({ editorId: 'ed1' });
    const options = committedShapes(orbit);
    expect(options?.outputFormat).toBe('input');
    expect(options?.shapes).toHaveLength(1);
    expect(options?.shapes[0]).toMatchObject({ type: 'rect', x: 504, y: 756, width: 1008, height: 756, color: '#F2552C', strokeWidth: 35 });
    expect(options?.shapes[0]?.id).toMatch(SHAPE_ID_PATTERN);
  });

  it('a click without a drag does not create a shape', async () => {
    const { surface, user } = setup();
    await user.click(screen.getByRole('radio', { name: '화살표' }));
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 101, clientY: 100 });
    expect(screen.getByText('주석 0개')).toBeTruthy();
  });

  it('supports Undo/Redo with ⌘Z / ⇧⌘Z and Ctrl+Z / Ctrl+Y', async () => {
    const { surface, user } = setup();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 }); // default tool: arrow
    expect(screen.getByText('주석 1개')).toBeTruthy();
    await user.keyboard('{Meta>}z{/Meta}');
    expect(screen.getByText('주석 0개')).toBeTruthy();
    await user.keyboard('{Meta>}{Shift>}z{/Shift}{/Meta}');
    expect(screen.getByText('주석 1개')).toBeTruthy();
    await user.keyboard('{Control>}z{/Control}');
    expect(screen.getByText('주석 0개')).toBeTruthy();
    await user.keyboard('{Control>}y{/Control}');
    expect(screen.getByText('주석 1개')).toBeTruthy();
    // Buttons mirror the history.
    expect(screen.getByRole('button', { name: '다시 실행' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: '실행 취소' }));
    expect(screen.getByText('주석 0개')).toBeTruthy();
  });

  it('moves a selected shape with the select tool and deletes it with Delete', async () => {
    const { surface, user, orbit } = setup();
    await user.click(screen.getByRole('radio', { name: '사각형' }));
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    await user.click(screen.getByRole('radio', { name: '선택' }));
    drag(surface, { x: 100, y: 120 }, { x: 158, y: 120 }); // +58 view px = +504 source px
    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    expect(committedShapes(orbit)?.shapes[0]).toMatchObject({ x: 1008, y: 756 });

    surface.focus();
    await user.keyboard('{Delete}');
    expect(screen.getByText('주석 0개')).toBeTruthy();
  });

  it('commits Korean text only after the IME composition ends', async () => {
    const { surface, user, orbit } = setup();
    await user.click(screen.getByRole('radio', { name: '텍스트' }));
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 58, clientY: 87 });
    expect(screen.queryByRole('textbox', { name: '주석 텍스트' })).toBeNull();
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 58, clientY: 87 });
    const box = await screen.findByRole('textbox', { name: '주석 텍스트' });
    expect(document.activeElement).toBe(box);
    fireEvent.compositionStart(box);
    (box as HTMLTextAreaElement).value = '한글';
    fireEvent.input(box);
    // Enter that confirms the composition must not commit the text.
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    expect(screen.getByRole('textbox', { name: '주석 텍스트' })).toBeTruthy();
    expect(screen.getByText('주석 0개')).toBeTruthy();
    fireEvent.compositionEnd(box);
    // Shift+Enter is a newline, not a commit.
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(screen.getByRole('textbox', { name: '주석 텍스트' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '주석 텍스트' })).toBeNull());
    expect(screen.getByText('주석 1개')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    expect(committedShapes(orbit)?.shapes[0]).toMatchObject({ type: 'text', x: 504, y: 756, text: '한글', fontSize: 209, bold: true, color: '#F2552C' });
  });

  it('a press outside the text box confirms the text without opening a new one', async () => {
    const { surface, user } = setup();
    await user.click(screen.getByRole('radio', { name: '텍스트' }));
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 20, clientY: 20 });
    const box = await screen.findByRole('textbox', { name: '주석 텍스트' });
    (box as HTMLTextAreaElement).value = 'Hello';
    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 200, clientY: 200 });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '주석 텍스트' })).toBeNull());
    expect(screen.getByText('주석 1개')).toBeTruthy();
  });

  it('Escape cancels the text box without closing the editor', async () => {
    const { surface, user, orbit } = setup();
    await user.click(screen.getByRole('radio', { name: '텍스트' }));
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 20, clientY: 20 });
    const box = await screen.findByRole('textbox', { name: '주석 텍스트' });
    (box as HTMLTextAreaElement).value = 'draft';
    fireEvent.keyDown(box, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '주석 텍스트' })).toBeNull());
    expect(screen.getByText('주석 0개')).toBeTruthy();
    expect(orbit.closeWindow).not.toHaveBeenCalled();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
  });

  it('changing the colour applies to the selected shape', async () => {
    const { surface, user, orbit } = setup();
    await user.click(screen.getByRole('radio', { name: '사각형' }));
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    await user.click(screen.getByRole('radio', { name: '색상 #1E88E5' }));
    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    expect(committedShapes(orbit)?.shapes[0]).toMatchObject({ color: '#1E88E5' });
  });

  it('a colour change is one undo step (undo restores the colour, not the shape)', async () => {
    const { surface, user, orbit } = setup();
    await user.click(screen.getByRole('radio', { name: '사각형' }));
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    await user.click(screen.getByRole('radio', { name: '색상 #1E88E5' }));
    await user.click(screen.getByRole('button', { name: '실행 취소' }));
    expect(screen.getByText('주석 1개')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    expect(committedShapes(orbit)?.shapes).toHaveLength(1);
    expect(committedShapes(orbit)?.shapes[0]).toMatchObject({ color: '#F2552C' });
  });
});
