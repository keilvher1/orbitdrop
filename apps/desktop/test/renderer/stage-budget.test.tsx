// @vitest-environment jsdom
import './setup';
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorFrame, type EditorCommit } from '../../src/renderer/src/views/editor/EditorFrame';
import { MIN_STAGE_HEIGHT, STAGE_PADDING, stageBudget, usePreviewBox } from '../../src/renderer/src/views/editor/editorKit';
import { renderWithEnv } from './helpers';

/**
 * Editors must fit the work area: seen in the macOS 14 VM (1440×900, Dock shown), the Add Background
 * editor grew by one row when a background image was chosen and its Save button ended up below the
 * window's bottom edge. EditorFrame measures the panel and shrinks the image stage to fit; the
 * footer is sticky as a last resort.
 */

const commit: EditorCommit = {
  busy: false,
  error: null,
  clearError: () => undefined,
  commit: async () => null,
  cancel: () => undefined,
  closeAfterSave: { current: false },
};

function Box({ reserved }: { readonly reserved: number }) {
  const box = usePreviewBox(reserved, 340);
  return (
    <div className="stage" data-testid="stage" style={{ height: box.height + 2 * STAGE_PADDING }}>
      <span data-testid="box">{`${box.width}x${box.height}`}</span>
    </div>
  );
}

function rect(height: number): DOMRect {
  return { width: 520, height, x: 0, y: 0, top: 0, left: 0, right: 520, bottom: height, toJSON: () => ({}) } as DOMRect;
}

describe('stageBudget', () => {
  it('is the work area minus the window margins and everything in the panel except the stage', () => {
    // 797 px work area, panel 900 tall of which the stage is 364: the rest (536) + margins (16) leave 245.
    expect(stageBudget(797, 900, 364)).toBe(245);
    // Independent of the stage's own height: shrinking the stage changes panel and stage by the same amount.
    expect(stageBudget(797, 900 - 119, 364 - 119)).toBe(245);
  });
});

describe('EditorFrame stage budget', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shrinks the preview box when the panel would be taller than the work area', () => {
    vi.spyOn(window.screen, 'availHeight', 'get').mockReturnValue(797);
    // Panel 900 px tall (too tall), stage 364 px (340 + 2 × 12 padding).
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('stage') ? rect(364) : rect(900);
    });
    renderWithEnv(
      <EditorFrame title="T" commit={commit} primaryLabel="Save" onPrimary={() => undefined}>
        <Box reserved={300} />
      </EditorFrame>,
    );
    // Budget 245 for the stage element → box height 245 − 24 = 221.
    expect(screen.getByTestId('box').textContent).toBe(`${520 - 2 * 16 - 2 * STAGE_PADDING}x221`);
  });

  it('never goes below the minimum stage height, and leaves a fitting panel alone', () => {
    vi.spyOn(window.screen, 'availHeight', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('stage') ? rect(364) : rect(1200);
    });
    const tiny = renderWithEnv(
      <EditorFrame title="T" commit={commit} primaryLabel="Save" onPrimary={() => undefined}>
        <Box reserved={300} />
      </EditorFrame>,
    );
    expect(screen.getByTestId('box').textContent?.endsWith(`x${MIN_STAGE_HEIGHT}`)).toBe(true);
    tiny.unmount();

    vi.spyOn(window.screen, 'availHeight', 'get').mockReturnValue(1400);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('stage') ? rect(364) : rect(700);
    });
    renderWithEnv(
      <EditorFrame title="T" commit={commit} primaryLabel="Save" onPrimary={() => undefined}>
        <Box reserved={300} />
      </EditorFrame>,
    );
    act(() => undefined);
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
});
