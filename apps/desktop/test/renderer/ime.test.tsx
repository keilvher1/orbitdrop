// @vitest-environment jsdom
import './setup';
import { CropOptionsSchema } from '@orbitdrop/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import koUi from '../../src/shared/locales/ko/ui.json';
import { isImeKey, useEscapeKey } from '../../src/renderer/src/app/useEscapeKey';
import { NumberInput, parseTypedNumber } from '../../src/renderer/src/components/NumberInput';
import { CropEditor } from '../../src/renderer/src/views/editor/crop/CropEditor';
import { parseDimension } from '../../src/renderer/src/views/editor/crop/cropMath';
import { SettingsView } from '../../src/renderer/src/views/settings/SettingsView';
import { createFakeOrbit, renderWithEnv, sampleEditorContext, sampleImageInfo } from './helpers';

/**
 * Korean (any IME) input: while a composition is open, Enter / Escape /
 * arrows belong to the IME — they must not commit, revert, step, close the
 * editor or run shortcuts. Engines report such keys with `isComposing`, or
 * only with keyCode 229 (e.g. the keydown that ends a Hangul syllable).
 * Full-width digits typed through an IME are numbers like any other.
 */

const composing = [
  { label: 'isComposing', init: { isComposing: true } },
  { label: 'keyCode 229', init: { keyCode: 229 } },
] as const;

function Spin({ onCommit, initial = 100 }: { readonly onCommit: (value: number) => void; readonly initial?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <NumberInput
      value={value}
      min={0}
      max={500}
      ariaLabel="여백"
      onCommit={(next) => {
        setValue(next);
        onCommit(next);
      }}
    />
  );
}

describe('isImeKey', () => {
  it('recognises composing keys by isComposing or keyCode 229', () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe('NumberInput (slider px fields, Settings and Compress numbers)', () => {
  it.each(composing)('Enter, Escape and arrows during a composition ($label) do nothing', ({ init }) => {
    const onCommit = vi.fn();
    render(<Spin onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton', { name: '여백' }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '12ㅇ' } });
    for (const key of ['Enter', 'Escape', 'ArrowUp', 'ArrowDown']) {
      const notCancelled = fireEvent.keyDown(input, { key, ...init });
      expect(notCancelled, key).toBe(true); // left to the IME
    }
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('12ㅇ'); // not reverted while composing
    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(120);
  });

  it('full-width digits commit as numbers; text, empty and out-of-range input never commits nonsense', () => {
    const onCommit = vi.fn();
    render(<Spin onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton', { name: '여백' }) as HTMLInputElement;
    const commit = (text: string) => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: 'Enter' });
    };
    commit('１２０'); // full-width (IME) digits
    expect(onCommit).toHaveBeenLastCalledWith(120);
    commit('２,０００'); // clamped to the maximum
    expect(onCommit).toHaveBeenLastCalledWith(500);
    commit('－５'); // full-width minus: clamped to the minimum
    expect(onCommit).toHaveBeenLastCalledWith(0);
    onCommit.mockClear();
    for (const text of ['', '   ', '여백', 'abc']) {
      commit(text);
      expect(input.value, text).toBe('0'); // back to the last committed value
    }
    expect(onCommit).not.toHaveBeenCalled();
    expect(parseTypedNumber('１ ２３')).toBe(123);
  });
});

function cropCtx() {
  return sampleEditorContext('tool.crop', {
    image: sampleImageInfo({ width: 2000, height: 1000, orientedWidth: 2000, orientedHeight: 1000, orientation: 1 }),
    defaults: { rect: { x: 0, y: 0, width: 2000, height: 1000 }, aspect: 'free' },
  });
}

describe('Crop W/H fields', () => {
  it.each(composing)('Enter and Escape during a composition ($label) neither confirm nor revert nor close the editor', ({ init }) => {
    const { orbit } = renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    const w = screen.getByLabelText(koUi['common.width']) as HTMLInputElement;
    fireEvent.focus(w);
    fireEvent.compositionStart(w);
    fireEvent.change(w, { target: { value: '12ㅇ' } });
    expect(screen.getByRole('alert').textContent).toContain(koUi['crop.error.notInteger']);
    fireEvent.keyDown(w, { key: 'Enter', ...init });
    expect(w.value).toBe('12ㅇ'); // still editing: nothing confirmed or overwritten
    fireEvent.keyDown(w, { key: 'Escape', ...init });
    expect(w.value).toBe('12ㅇ'); // not reverted
    expect(orbit.cancelEditor).not.toHaveBeenCalled(); // the window-level Esc did not close the editor
    expect(orbit.closeWindow).not.toHaveBeenCalled();
    fireEvent.compositionEnd(w);
    fireEvent.keyDown(w, { key: 'Escape' }); // a real Escape reverts the edit
    expect(w.value).toBe('2000');
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
  });

  it('full-width digits are accepted and applied; nothing is written before Apply', async () => {
    const { orbit } = renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    const w = screen.getByLabelText(koUi['common.width']) as HTMLInputElement;
    fireEvent.focus(w);
    fireEvent.change(w, { target: { value: '１２００' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.keyDown(w, { key: 'Enter' });
    expect(orbit.commitEditor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: koUi['common.apply'] }));
    await waitFor(() => expect(orbit.commitEditor).toHaveBeenCalledTimes(1));
    expect(CropOptionsSchema.parse(orbit.commitEditor.mock.calls[0]![0].options).rect).toEqual({ x: 400, y: 0, width: 1200, height: 1000 });
  });

  it('parseDimension: full-width digits are numbers, everything invalid is reported', () => {
    const bounds = { width: 2000, height: 1000 };
    expect(parseDimension('１２００', 'width', 'free', bounds)).toEqual({ ok: true, value: 1200 });
    expect(parseDimension('1,200', 'width', 'free', bounds)).toEqual({ ok: true, value: 1200 });
    for (const text of ['', '0', '-5', '－５', '12.5', '1e3', '천', '12ㅇ']) {
      const result = parseDimension(text, 'width', 'free', bounds);
      expect(result.ok, text).toBe(false);
    }
    expect(parseDimension('99999', 'width', 'free', bounds)).toEqual({ ok: false, error: { kind: 'range', max: 2000 } });
  });
});

describe('window-level keys', () => {
  it('useEscapeKey ignores an Escape that belongs to the IME', () => {
    const handler = vi.fn();
    function Probe() {
      useEscapeKey(handler);
      return null;
    }
    render(<Probe />);
    fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 });
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    expect(handler).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('⌘Enter during a composition does not run the primary action', async () => {
    const { orbit } = renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true, keyCode: 229 });
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true, isComposing: true });
    expect(orbit.commitEditor).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(orbit.commitEditor).toHaveBeenCalledTimes(1));
  });
});

describe('Settings › General: startup notices', () => {
  it('lists the files main reset at startup, with the name of the kept copy', async () => {
    const orbit = createFakeOrbit();
    orbit.getAppInfo.mockResolvedValue({
      name: 'OrbitDrop',
      version: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      electron: '44.9.0',
      chrome: '152',
      node: '24',
      packaged: false,
      locale: 'ko',
      notices: [
        { code: 'settingsReset', backup: 'settings.corrupt-1.json' },
        { code: 'historyReset', backup: null },
      ],
    });
    renderWithEnv(<SettingsView />, { orbit });
    expect(await screen.findByText(koUi['settings.notice.settingsReset'].replace('{file}', 'settings.corrupt-1.json'))).toBeTruthy();
    expect(screen.getByText(koUi['settings.notice.historyReset.noBackup'])).toBeTruthy();
  });

  it('shows nothing when startup went fine', async () => {
    const orbit = createFakeOrbit();
    renderWithEnv(<SettingsView />, { orbit });
    await waitFor(() => expect(orbit.getAppInfo).toHaveBeenCalled());
    expect(screen.queryByText(/읽을 수 없어/)).toBeNull();
  });
});
