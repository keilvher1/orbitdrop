// @vitest-environment jsdom
import './setup';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorFrame, type EditorCommit } from '../../src/renderer/src/views/editor/EditorFrame';
import { EditorView } from '../../src/renderer/src/views/editor/EditorView';
import { MIN_STAGE_HEIGHT, STAGE_PADDING, StageBudgetProvider, stageBudget, usePreviewBox } from '../../src/renderer/src/views/editor/editorKit';
import { createFakeOrbit, renderWithEnv, sampleEditorContext } from './helpers';

/**
 * Editors must fit the work area: seen in the macOS 14 VM (1440×900, Dock shown), the Add Background
 * editor grew by one row when a background image was chosen and its Save button ended up below the
 * window's bottom edge. StageBudgetProvider (around every editor in EditorView) measures the panel and
 * shrinks the image stage to fit; the footer is sticky as a last resort.
 */

const commit: EditorCommit = {
  busy: false,
  error: null,
  clearError: () => undefined,
  commit: async () => null,
  cancel: () => undefined,
  closeAfterSave: { current: false },
};

/** Shaped like the real editors: usePreviewBox in the editor's own body, the stage inside EditorFrame. */
function FakeEditor({ reserved }: { readonly reserved: number }) {
  const box = usePreviewBox(reserved, 340);
  return (
    <EditorFrame title="T" commit={commit} primaryLabel="Save" onPrimary={() => undefined}>
      <div className="stage" style={{ height: box.height + 2 * STAGE_PADDING }}>
        <span data-testid="box">{`${box.width}x${box.height}`}</span>
      </div>
    </EditorFrame>
  );
}

function rect(height: number): DOMRect {
  return { width: 520, height, x: 0, y: 0, top: 0, left: 0, right: 520, bottom: height, toJSON: () => ({}) } as DOMRect;
}

function layout(workArea: number, panel: number, stage: number): void {
  vi.spyOn(window.screen, 'availHeight', 'get').mockReturnValue(workArea);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('stage')) return rect(stage);
    if (this.classList.contains('editor-view')) return rect(panel);
    return rect(0);
  });
}

describe('stageBudget', () => {
  it('is the work area minus the window margins and everything in the panel except the stage', () => {
    // 797 px work area, panel 900 tall of which the stage is 364: the rest (536) + margins (16) leave 245.
    expect(stageBudget(797, 900, 364)).toBe(245);
    // Independent of the stage's own height: shrinking the stage changes panel and stage by the same amount.
    expect(stageBudget(797, 900 - 119, 364 - 119)).toBe(245);
  });
});

describe('StageBudgetProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shrinks the preview box of an editor whose panel would be taller than the work area', () => {
    layout(797, 900, 364);
    renderWithEnv(
      <StageBudgetProvider>
        <FakeEditor reserved={300} />
      </StageBudgetProvider>,
    );
    // Budget 245 for the stage element → box height 245 − 24 = 221.
    expect(screen.getByTestId('box').textContent).toBe(`${520 - 2 * 16 - 2 * STAGE_PADDING}x221`);
  });

  it('never goes below the minimum stage height, and leaves a fitting panel alone', () => {
    layout(500, 1200, 364);
    const tiny = renderWithEnv(
      <StageBudgetProvider>
        <FakeEditor reserved={300} />
      </StageBudgetProvider>,
    );
    expect(screen.getByTestId('box').textContent?.endsWith(`x${MIN_STAGE_HEIGHT}`)).toBe(true);
    tiny.unmount();
    vi.restoreAllMocks();

    layout(1400, 700, 364);
    renderWithEnv(
      <StageBudgetProvider>
        <FakeEditor reserved={300} />
      </StageBudgetProvider>,
    );
    expect(screen.getByTestId('box').textContent?.endsWith('x340')).toBe(true);
  });

  it('keeps the footer with the primary button sticky at the bottom of the window', () => {
    renderWithEnv(
      <EditorFrame title="T" commit={commit} primaryLabel="Save" onPrimary={() => undefined}>
        <p>body</p>
      </EditorFrame>,
    );
    const footer = screen.getByRole('button', { name: 'Save' }).closest('footer');
    expect(footer?.classList.contains('editor-footer')).toBe(true);
  });

  it('is wired around the real editors (EditorView): the Add Background stage shrinks on a short work area', async () => {
    // The per-editor estimate alone (900 − 470 − 60) would allow the full 340 px stage; the measured
    // panel says otherwise: 900 − 16 − (1100 − 364) < 180, so the stage drops to its minimum.
    layout(900, 1100, 364);
    const orbit = createFakeOrbit({ getEditor: async () => sampleEditorContext('tool.addBackground') });
    const { container } = renderWithEnv(<EditorView editorId="ed1" />, { orbit });
    await waitFor(() => expect((container.querySelector('.stage-canvas') as HTMLElement | null)?.style.height).toBeTruthy());
    const canvas = container.querySelector('.stage-canvas') as HTMLElement;
    expect(Number.parseFloat(canvas.style.height)).toBeLessThanOrEqual(MIN_STAGE_HEIGHT);
  });
});
