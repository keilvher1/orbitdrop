// @vitest-environment jsdom
import './setup';
import type { PreviewRequestIpc, RedactRegion } from '@orbitdrop/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SHAPE_ID_PATTERN } from '../../src/renderer/src/views/editor/annotate/annotateModel';
import { RedactEditor } from '../../src/renderer/src/views/editor/redact/RedactEditor';
import { createFakeOrbit, renderWithEnv, sampleEditorContext } from './helpers';

const MOSAIC_NOTE = '모자이크는 정보를 완전히 지운다고 보장하지 않습니다. 민감한 정보에는 단색 가림을 쓰세요.';

function setup() {
  const orbit = createFakeOrbit();
  // Oriented 4032×3024 photo, shown at 464×348 in the editor stage.
  const ctx = sampleEditorContext('tool.redact', { defaults: { regions: [], outputFormat: 'input' } });
  const view = renderWithEnv(<RedactEditor ctx={ctx} title="정보 가리기" />, { orbit });
  const surface = screen.getByRole('application', { name: '가리기 캔버스' });
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
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: to.x, clientY: to.y });
}

const committedRegions = (orbit: ReturnType<typeof createFakeOrbit>) =>
  (orbit.commitEditor.mock.calls.at(-1)?.[0] as { options: { regions: RedactRegion[]; outputFormat: string } } | undefined)?.options;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RedactEditor', () => {
  it('turns a drag into a region in oriented source pixels and commits it', async () => {
    const { surface, user, orbit } = setup();
    const save = screen.getByRole('button', { name: '가려서 저장' });
    // Unavailable but focusable (aria-disabled): pressing it does nothing.
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await user.click(save);
    expect(orbit.commitEditor).not.toHaveBeenCalled();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    expect(screen.getByText('영역 1개')).toBeTruthy();
    expect(save.hasAttribute('aria-disabled')).toBe(false);
    await user.click(save);
    const options = committedRegions(orbit);
    expect(options?.outputFormat).toBe('input');
    expect(options?.regions).toHaveLength(1);
    expect(options?.regions[0]).toMatchObject({
      rect: { x: 504, y: 756, width: 1008, height: 756 },
      style: 'solid',
      color: '#000000',
      blockSize: 16,
    });
    expect(options?.regions[0]?.id).toMatch(SHAPE_ID_PATTERN);
  });

  it('drags from right-bottom to left-top too, and a plain click adds nothing', () => {
    const { surface } = setup();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 301, clientY: 300 });
    expect(screen.getByText('영역 0개')).toBeTruthy();
    drag(surface, { x: 174, y: 174 }, { x: 58, y: 87 });
    expect(screen.getByText('영역 1개')).toBeTruthy();
  });

  it('shows the mosaic warning only while a region uses mosaic', async () => {
    const { surface, user, orbit } = setup();
    expect(screen.queryByText(MOSAIC_NOTE)).toBeNull();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    expect(screen.queryByText(MOSAIC_NOTE)).toBeNull();
    await user.click(screen.getByRole('radio', { name: '모자이크' }));
    expect(screen.getByText(MOSAIC_NOTE)).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: '단색 가림' }));
    expect(screen.queryByText(MOSAIC_NOTE)).toBeNull();
    await user.click(screen.getByRole('radio', { name: '모자이크' }));
    await user.click(screen.getByRole('button', { name: '가려서 저장' }));
    expect(committedRegions(orbit)?.regions[0]).toMatchObject({ style: 'mosaic', blockSize: 16 });
  });

  it('requests processor previews only while there is at least one region', async () => {
    const { surface, user, orbit } = setup();
    await sleep(150);
    expect(orbit.requestPreview).not.toHaveBeenCalled();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    await waitFor(() => expect(orbit.requestPreview).toHaveBeenCalled());
    const request = orbit.requestPreview.mock.calls.at(-1)?.[0] as PreviewRequestIpc;
    expect(request.editorId).toBe('ed1');
    expect(request.seq).toBeGreaterThan(0);
    expect((request.options as { regions: RedactRegion[] }).regions).toHaveLength(1);

    const calls = orbit.requestPreview.mock.calls.length;
    surface.focus();
    await user.keyboard('{Delete}');
    expect(screen.getByText('영역 0개')).toBeTruthy();
    await sleep(150);
    expect(orbit.requestPreview.mock.calls.length).toBe(calls);
  });

  it('moves the selected region with the arrow keys and lists regions', async () => {
    const { surface, user, orbit } = setup();
    drag(surface, { x: 58, y: 87 }, { x: 174, y: 174 });
    const item = screen.getByRole('button', { name: /영역 1/ });
    expect(item.getAttribute('aria-pressed')).toBe('true');
    surface.focus();
    await user.keyboard('{ArrowRight}');
    await user.click(screen.getByRole('button', { name: '가려서 저장' }));
    // One view px ≈ 9 source px (4032 / 464 rounded).
    expect(committedRegions(orbit)?.regions[0]?.rect).toMatchObject({ x: 513, y: 756 });
  });
});
