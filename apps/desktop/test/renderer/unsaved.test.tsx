// @vitest-environment jsdom
import './setup';
import type { SubmitActionResult } from '@orbitdrop/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import koUi from '../../src/shared/locales/ko/ui.json';
import { AnnotateEditor } from '../../src/renderer/src/views/editor/annotate/AnnotateEditor';
import { CropEditor } from '../../src/renderer/src/views/editor/crop/CropEditor';
import { RedactEditor } from '../../src/renderer/src/views/editor/redact/RedactEditor';
import { createFakeOrbit, deferred, renderWithEnv, requestOsClose, sampleEditorContext, type FakeOrbit } from './helpers';

/**
 * Closing Annotate / Redact with unsaved shapes or regions (× or Esc) asks in
 * an in-window dialog first; nothing else about closing an editor changes.
 */

const TITLE = koUi['editor.unsaved.title'];
const KEEP = koUi['editor.unsaved.keep'];
const DISCARD = koUi['editor.unsaved.discard'];
const CLOSE = koUi['common.cancelAndClose'];

function stage(surface: HTMLElement): void {
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
}

function drag(surface: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
  fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: to.x, clientY: to.y });
}

function annotate(orbit: FakeOrbit = createFakeOrbit()) {
  const ctx = sampleEditorContext('tool.annotate', { defaults: { shapes: [], outputFormat: 'input' } });
  const view = renderWithEnv(<AnnotateEditor ctx={ctx} title="주석 달기" />, { orbit });
  const surface = screen.getByRole('application', { name: '주석 캔버스' });
  stage(surface);
  return { ...view, orbit, surface, user: userEvent.setup() };
}

function redact(orbit: FakeOrbit = createFakeOrbit()) {
  const ctx = sampleEditorContext('tool.redact', { defaults: { regions: [], outputFormat: 'input' } });
  const view = renderWithEnv(<RedactEditor ctx={ctx} title="정보 가리기" />, { orbit });
  const surface = screen.getByRole('application', { name: '가리기 캔버스' });
  stage(surface);
  return { ...view, orbit, surface, user: userEvent.setup() };
}

const dialog = () => screen.getByRole('alertdialog', { name: TITLE });
const editorRoot = () => document.querySelector('.editor-view') as HTMLElement;

describe('Annotate: closing with unsaved annotations', () => {
  it('Esc asks first (after a first Esc deselects); Esc in the dialog keeps editing and gives focus back', async () => {
    const { surface, user, orbit } = annotate();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 }); // arrow, selected, canvas focused
    expect(document.activeElement).toBe(surface);

    await user.keyboard('{Escape}'); // the canvas uses the first Esc to drop the selection
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.keyboard('{Escape}');

    const confirm = screen.getByRole('alertdialog', { name: TITLE, description: koUi['annotate.unsaved'] });
    expect(confirm.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: KEEP }));
    expect(editorRoot().hasAttribute('inert')).toBe(true);
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
    expect(orbit.closeWindow).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(editorRoot().hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(surface);
    expect(screen.getByText('주석 1개')).toBeTruthy();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
    expect(orbit.closeWindow).not.toHaveBeenCalled();
  });

  it('× asks; "close without saving" cancels the editor and closes the window', async () => {
    const { surface, user, orbit } = annotate();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    await user.click(screen.getByRole('button', { name: CLOSE }));
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole('button', { name: DISCARD }));
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
    expect(orbit.commitEditor).not.toHaveBeenCalled();
  });

  it('keeps the keyboard inside the dialog: Tab cycles, editor shortcuts and keys never reach the editor', async () => {
    const { surface, user, orbit } = annotate();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 }); // the new arrow stays selected
    const close = screen.getByRole('button', { name: CLOSE });
    await user.click(close);
    const confirm = dialog();
    const keep = within(confirm).getByRole('button', { name: KEEP });
    const discard = within(confirm).getByRole('button', { name: DISCARD });

    expect(document.activeElement).toBe(keep);
    await user.tab();
    expect(document.activeElement).toBe(discard);
    await user.tab();
    expect(document.activeElement).toBe(keep);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(discard);

    await user.keyboard('{Meta>}z{/Meta}'); // undo must not touch the shapes underneath
    expect(screen.getByText('주석 1개')).toBeTruthy();
    confirm.focus();
    await user.keyboard('{Meta>}{Enter}{/Meta}'); // nor may ⌘Enter save
    expect(orbit.commitEditor).not.toHaveBeenCalled();
    fireEvent.keyDown(surface, { key: 'Delete', code: 'Delete' }); // a key aimed at the (inert) canvas
    expect(screen.getByText('주석 1개')).toBeTruthy();
    expect(dialog()).toBe(confirm);

    // Focus fell to <body>: Esc still means "keep editing", and focus returns to ×.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(close);
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
  });

  it('Enter activates the focused choice and a press on the backdrop changes nothing', async () => {
    const { surface, user, orbit } = annotate();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    await user.click(screen.getByRole('button', { name: CLOSE }));
    const backdrop = dialog().parentElement as HTMLElement;
    expect(fireEvent.mouseDown(backdrop)).toBe(false); // default prevented: focus stays in the dialog
    fireEvent.click(backdrop);
    expect(dialog()).toBeTruthy();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();

    await user.keyboard('{Enter}'); // "keep editing" has focus
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: CLOSE }));
    await user.tab();
    await user.keyboard('{Enter}'); // "close without saving"
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('a text box with typed, unconfirmed text counts as unsaved work', async () => {
    const { surface, user, orbit } = annotate();
    await user.click(screen.getByRole('radio', { name: '텍스트' }));
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 40, clientY: 40 });
    const box = await screen.findByRole('textbox', { name: '주석 텍스트' });
    (box as HTMLTextAreaElement).value = '초안';
    fireEvent.input(box);
    expect(screen.getByText('주석 0개')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: CLOSE })); // no focus move: the draft is still open
    expect(dialog()).toBeTruthy();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
  });

  it('with nothing to lose, Esc closes right away (no dialog)', async () => {
    const { user, orbit } = annotate();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('with nothing to lose, × closes right away (no dialog)', async () => {
    const { user, orbit } = annotate();
    await user.click(screen.getByRole('button', { name: CLOSE }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('after undoing the last shape there is nothing to confirm', async () => {
    const { surface, user, orbit } = annotate();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    await user.click(screen.getByRole('button', { name: '실행 취소' }));
    expect(screen.getByText('주석 0개')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: CLOSE }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
  });

  it('while saving, Esc and × do nothing — no dialog, no cancel', async () => {
    const pending = deferred<SubmitActionResult>();
    const orbit = createFakeOrbit({ commitEditor: () => pending.promise });
    const { surface, user } = annotate(orbit);
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    expect(orbit.commitEditor).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: CLOSE })).toHaveProperty('disabled', true);
    surface.blur();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
    pending.resolve({ kind: 'jobs', jobIds: ['job1'] });
    await vi.waitFor(() => expect(orbit.closeWindow).toHaveBeenCalledTimes(1));
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
  });
});

describe('OS-level close (close button, ⌘W, Alt+F4) with unsaved work', () => {
  const lastGuard = (orbit: FakeOrbit) => orbit.setCloseGuard.mock.calls.at(-1)?.[0];

  it('the window reports its close guard: on with unsaved shapes, off when nothing is left, off on unmount', async () => {
    const { surface, user, orbit, unmount } = annotate();
    expect(lastGuard(orbit)).toBe(false);
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    expect(lastGuard(orbit)).toBe(true);
    await user.click(screen.getByRole('button', { name: '실행 취소' }));
    expect(lastGuard(orbit)).toBe(false);
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    expect(lastGuard(orbit)).toBe(true);
    unmount();
    expect(lastGuard(orbit)).toBe(false);
    expect(orbit.onCloseRequested).toHaveBeenCalled();
  });

  it('a held-back OS close asks exactly like ×: one dialog however often it comes; keep editing keeps everything', async () => {
    const { surface, user, orbit } = annotate();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    act(() => requestOsClose(orbit));
    const confirm = screen.getByRole('alertdialog', { name: TITLE, description: koUi['annotate.unsaved'] });
    const keep = within(confirm).getByRole('button', { name: KEEP });
    expect(document.activeElement).toBe(keep);
    act(() => requestOsClose(orbit)); // ⌘W again while it asks
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(document.activeElement).toBe(keep);
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
    expect(orbit.closeWindow).not.toHaveBeenCalled();

    await user.click(keep);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(surface); // focus back where it was
    expect(screen.getByText('주석 1개')).toBeTruthy();
    expect(lastGuard(orbit)).toBe(true); // still guarded
  });

  it('"close without saving" after an OS close cancels the editor and closes the window (main lets that close through)', async () => {
    const { surface, user, orbit } = redact();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    act(() => requestOsClose(orbit));
    await user.click(within(dialog()).getByRole('button', { name: DISCARD }));
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
    expect(orbit.commitEditor).not.toHaveBeenCalled();
  });

  it('while saving, the window stays guarded and an OS close does nothing; it closes itself once the save went through', async () => {
    const pending = deferred<SubmitActionResult>();
    const orbit = createFakeOrbit({ commitEditor: () => pending.promise });
    const { surface, user } = annotate(orbit);
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    await user.click(screen.getByRole('button', { name: '주석 저장' }));
    expect(lastGuard(orbit)).toBe(true);
    act(() => requestOsClose(orbit));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
    pending.resolve({ kind: 'jobs', jobIds: ['job1'] });
    await vi.waitFor(() => expect(orbit.closeWindow).toHaveBeenCalledTimes(1));
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
  });

  it('without unsaved work a (racing) close request closes right away, like ×', () => {
    const { orbit } = annotate();
    expect(lastGuard(orbit)).toBe(false); // main does not hold such a close back
    act(() => requestOsClose(orbit));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('an editor without unsaved work is guarded while it saves, so an OS close cannot drop an Apply in flight', async () => {
    const pending = deferred<SubmitActionResult>();
    const orbit = createFakeOrbit({ commitEditor: () => pending.promise });
    const ctx = sampleEditorContext('tool.crop');
    renderWithEnv(<CropEditor ctx={ctx} title="자르기" />, { orbit });
    expect(lastGuard(orbit)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: koUi['common.apply'] }));
    await vi.waitFor(() => expect(orbit.commitEditor).toHaveBeenCalledTimes(1));
    expect(lastGuard(orbit)).toBe(true);
    act(() => requestOsClose(orbit));
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
    pending.resolve({ kind: 'jobs', jobIds: ['job1'] });
    await vi.waitFor(() => expect(orbit.closeWindow).toHaveBeenCalledTimes(1));
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
  });
});

describe('Redact: closing with unsaved regions', () => {
  it('Esc asks (after a first Esc deselects); keep editing keeps the regions', async () => {
    const { surface, user, orbit } = redact();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    expect(screen.getByText('영역 1개')).toBeTruthy();
    expect(document.activeElement).toBe(surface);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.keyboard('{Escape}');
    const confirm = screen.getByRole('alertdialog', { name: TITLE, description: koUi['redact.unsaved'] });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: KEEP }));
    await user.click(within(confirm).getByRole('button', { name: KEEP }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(surface);
    expect(screen.getByText('영역 1개')).toBeTruthy();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
    expect(orbit.closeWindow).not.toHaveBeenCalled();
  });

  it('× → "close without saving" cancels the editor; keys aimed at the canvas meanwhile are ignored', async () => {
    const { surface, user, orbit } = redact();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 }); // the new region is selected
    await user.click(screen.getByRole('button', { name: CLOSE }));
    fireEvent.keyDown(surface, { key: 'Delete', code: 'Delete' });
    fireEvent.keyDown(surface, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(screen.getByText('영역 1개')).toBeTruthy();
    await user.click(within(dialog()).getByRole('button', { name: DISCARD }));
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('with no regions, × closes right away', async () => {
    const { user, orbit } = redact();
    await user.click(screen.getByRole('button', { name: CLOSE }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
  });
});
