// @vitest-environment jsdom
import './setup';
import { DEFAULT_SETTINGS, type Settings, type SubmitActionResult } from '@orbitdrop/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DropZoneView } from '../../src/renderer/src/views/dropzone/DropZoneView';
import { PickerView } from '../../src/renderer/src/views/picker/PickerView';
import { createFakeOrbit, deferred, renderWithEnv, sampleMenu, sampleSelection } from './helpers';

/** The wheel is mounted before its menu arrives; wait for the sectors too. */
async function loadedWheel(name?: string) {
  const menu = name ? await screen.findByRole('menu', { name }) : await screen.findByRole('menu');
  await within(menu).findAllByRole('menuitem');
  return menu;
}

describe('Picker window', () => {
  it('shows the file summary and the convert wheel, runs the chosen action and closes', async () => {
    const { orbit } = renderWithEnv(<PickerView selectionId="sel1" initialMode="convert" />);
    const menu = await loadedWheel('변환 메뉴');
    expect(screen.getByText('photo.jpg · 1.2 MB')).toBeTruthy();
    // JPG convert menu: PNG, WEBP, HEIC(disabled), TIFF, AVIF, BMP(disabled), PDF, DOCX
    expect(screen.getAllByRole('menuitem').map((i) => i.getAttribute('aria-label'))).toEqual(['PNG', 'WEBP', 'HEIC', 'TIFF', 'AVIF', 'BMP', 'PDF', 'DOCX']);
    const user = userEvent.setup();
    menu.focus();
    await user.keyboard('{ArrowRight}{Enter}');
    await waitFor(() => expect(orbit.submitAction).toHaveBeenCalledWith({ selectionId: 'sel1', actionId: 'convert.png' }));
    await waitFor(() => expect(orbit.closeWindow).toHaveBeenCalledTimes(1));
  });

  it('also closes when main opened an editor', async () => {
    const orbit = createFakeOrbit();
    orbit.submitAction.mockResolvedValue({ kind: 'editor', editorId: 'ed9' });
    renderWithEnv(<PickerView selectionId="sel1" initialMode="tools" />, { orbit });
    const menu = await loadedWheel('도구 메뉴');
    const user = userEvent.setup();
    menu.focus();
    await user.keyboard('{End}{ArrowLeft}{Enter}'); // CROP
    await waitFor(() => expect(orbit.submitAction).toHaveBeenCalledWith({ selectionId: 'sel1', actionId: 'tool.crop' }));
    await waitFor(() => expect(orbit.closeWindow).toHaveBeenCalled());
  });

  it('keeps the window open and shows a localized error when main rejects', async () => {
    const orbit = createFakeOrbit();
    orbit.submitAction.mockResolvedValue({ kind: 'rejected', error: { code: 'TOO_MANY_FILES', message: 'x', retryable: false } });
    renderWithEnv(<PickerView selectionId="sel1" initialMode="convert" />, { orbit });
    const menu = await loadedWheel();
    const user = userEvent.setup();
    menu.focus();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(await screen.findByText('한 번에 처리할 수 있는 파일 수를 넘었습니다.')).toBeTruthy();
    expect(orbit.closeWindow).not.toHaveBeenCalled();
    // The wheel is usable again.
    expect(menu.getAttribute('aria-busy')).toBeNull();
  });

  it('toggles between convert and tools; Tab goes from the wheel to the toggle, which keeps focus', async () => {
    const { orbit } = renderWithEnv(<PickerView selectionId="sel1" initialMode="convert" />);
    const menu = await loadedWheel('변환 메뉴');
    const user = userEvent.setup();
    menu.focus();
    await user.tab();
    const convertRadio = screen.getByRole('radio', { name: '변환' });
    expect(document.activeElement).toBe(convertRadio);
    await user.keyboard('{ArrowRight}');
    await loadedWheel('도구 메뉴');
    expect(orbit.getMenu).toHaveBeenLastCalledWith('sel1', 'tools');
    // The reloaded wheel must not grab focus: the toggle keeps it, so ← switches back.
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: '도구' }));
    await user.keyboard('{ArrowLeft}');
    await loadedWheel('변환 메뉴');
    expect(document.activeElement).toBe(convertRadio);
    expect(convertRadio.getAttribute('aria-checked')).toBe('true');
  });

  it('a language change reloads the menu without moving focus off the wheel', async () => {
    const orbit = createFakeOrbit();
    let push: ((settings: Settings) => void) | undefined;
    orbit.onSettingsChanged.mockImplementation((listener) => {
      push = listener;
      return () => undefined;
    });
    renderWithEnv(<PickerView selectionId="sel1" initialMode="tools" />, { orbit });
    const menu = await loadedWheel('도구 메뉴');
    menu.focus();
    orbit.getMenu.mockImplementation(async (_id, mode) => sampleMenu(mode, 'image/jpeg', 'en'));
    await act(async () => push?.({ ...DEFAULT_SETTINGS, locale: 'en' }));
    const english = await loadedWheel('Tools menu');
    expect(english).toBe(menu);
    expect(document.activeElement).toBe(menu);
    expect(screen.getAllByRole('menuitem')[0]?.getAttribute('aria-label')).toBe('COMPRESS');
  });

  it('disables the tools mode for PDFs (no image tools)', async () => {
    const orbit = createFakeOrbit();
    orbit.getSelection.mockResolvedValue(sampleSelection({ files: [{ fileId: 'p', name: 'Page 001.pdf', ext: '.pdf', format: 'pdf', kind: 'pdf', bytes: 1000 }], menuKey: 'pdf' }));
    orbit.getMenu.mockImplementation(async (_id, mode) => sampleMenu(mode, 'pdf'));
    renderWithEnv(<PickerView selectionId="sel1" initialMode="tools" />, { orbit });
    await loadedWheel('변환 메뉴');
    expect(screen.getAllByRole('menuitem').map((i) => i.getAttribute('aria-label'))).toEqual(['DOCX', 'JPG', 'PNG', 'TXT']);
    expect((screen.getByRole('radio', { name: '도구' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains unsupported selections file by file', async () => {
    const orbit = createFakeOrbit();
    orbit.getSelection.mockResolvedValue(
      sampleSelection({
        files: [
          { fileId: 'a', name: 'archive.zip', ext: '.zip', format: null, kind: null, bytes: 10, problem: { code: 'UNSUPPORTED_FORMAT', message: 'zip' } },
          { fileId: 'b', name: 'Photos', ext: '', format: null, kind: null, bytes: 0, problem: { code: 'NOT_A_FILE', message: 'dir' } },
        ],
        menuKey: null,
      }),
    );
    renderWithEnv(<PickerView selectionId="sel1" initialMode="convert" />, { orbit });
    expect(await screen.findByText('처리할 수 없는 파일입니다')).toBeTruthy();
    expect(screen.getByText('archive.zip')).toBeTruthy();
    expect(screen.getByText('지원하지 않는 파일 형식입니다.')).toBeTruthy();
    expect(screen.getByText('폴더나 특수 항목은 처리할 수 없습니다. 파일을 선택하세요.')).toBeTruthy();
    expect(orbit.getMenu).not.toHaveBeenCalled();
  });

  it('notes files that will be skipped and Esc closes the window', async () => {
    const orbit = createFakeOrbit();
    orbit.getSelection.mockResolvedValue(
      sampleSelection({
        files: [
          { fileId: 'f1', name: 'photo.jpg', ext: '.jpg', format: 'jpeg', kind: 'image', bytes: 1_000_000 },
          { fileId: 'f2', name: 'notes.zip', ext: '.zip', format: null, kind: null, bytes: 10, problem: { code: 'UNSUPPORTED_FORMAT', message: 'zip' } },
        ],
      }),
    );
    renderWithEnv(<PickerView selectionId="sel1" initialMode="convert" />, { orbit });
    await screen.findByRole('menu');
    expect(screen.getByText('1개 파일은 처리할 수 없어 제외됩니다.')).toBeTruthy();
    await userEvent.setup().keyboard('{Escape}');
    expect(orbit.closeWindow).toHaveBeenCalled();
  });
});

function dropFiles(target: Element, files: File[], types: string[] = ['Files']) {
  fireEvent.dragEnter(target, { dataTransfer: { types, files } });
  fireEvent.dragOver(target, { dataTransfer: { types, files, dropEffect: 'none' } });
  fireEvent.drop(target, { dataTransfer: { types, files } });
}

describe('Drop Zone window', () => {
  it('registers dropped files with main and shows the wheel', async () => {
    const { orbit, container } = renderWithEnv(<DropZoneView />);
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    dropFiles(container.querySelector('.dropzone-view')!, [file]);
    await waitFor(() => expect(orbit.registerDroppedFiles).toHaveBeenCalledWith([file]));
    expect(await screen.findByRole('menu', { name: '변환 메뉴' })).toBeTruthy();
  });

  it('asks for files when something else is dropped', async () => {
    const { orbit, container } = renderWithEnv(<DropZoneView />);
    dropFiles(container.querySelector('.dropzone-view')!, [], ['text/plain']);
    expect(await screen.findByText('파일만 놓을 수 있습니다.')).toBeTruthy();
    expect(orbit.registerDroppedFiles).not.toHaveBeenCalled();
  });

  it('shows why files are unsupported', async () => {
    const orbit = createFakeOrbit();
    orbit.registerDroppedFiles.mockResolvedValue(
      sampleSelection({ files: [{ fileId: 'a', name: 'movie.mov', ext: '.mov', format: null, kind: null, bytes: 1, problem: { code: 'UNSUPPORTED_FORMAT', message: 'mov' } }], menuKey: null }),
    );
    const { container } = renderWithEnv(<DropZoneView />, { orbit });
    dropFiles(container.querySelector('.dropzone-view')!, [new File(['x'], 'movie.mov')]);
    expect(await screen.findByText('movie.mov')).toBeTruthy();
    expect(screen.getByText('처리할 수 없는 파일입니다')).toBeTruthy();
  });

  it('opens files with the dialog, runs an action and offers to show the jobs', async () => {
    const orbit = createFakeOrbit();
    orbit.openFileDialog.mockResolvedValue(sampleSelection());
    renderWithEnv(<DropZoneView />, { orbit });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '파일 열기…' }));
    const menu = await loadedWheel('변환 메뉴');
    menu.focus();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(await screen.findByText('작업을 시작했습니다.')).toBeTruthy();
    // The wheel is gone; focus lands on a stable control instead of <body>.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '파일 열기…' }));
    await user.click(screen.getByRole('button', { name: '작업 보기' }));
    expect(orbit.openWindow).toHaveBeenCalledWith('jobs');
    // The drop zone itself stays open.
    expect(orbit.closeWindow).not.toHaveBeenCalled();
  });

  it('Back returns to the drop target and moves focus to "파일 열기…"', async () => {
    const orbit = createFakeOrbit();
    orbit.openFileDialog.mockResolvedValue(sampleSelection());
    renderWithEnv(<DropZoneView />, { orbit });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '파일 열기…' }));
    await loadedWheel();
    const back = screen.getByRole('button', { name: '다른 파일 고르기' });
    back.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '파일 열기…' }));
    // Esc from the wheel does the same.
    await user.click(screen.getByRole('button', { name: '파일 열기…' }));
    const menu = await loadedWheel();
    menu.focus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '파일 열기…' }));
  });

  it('a submit that resolves after Back + another file does not remove the new wheel', async () => {
    const orbit = createFakeOrbit();
    const pending = deferred<SubmitActionResult>();
    orbit.submitAction.mockImplementation(() => pending.promise);
    orbit.openFileDialog.mockResolvedValueOnce(sampleSelection()).mockResolvedValueOnce(sampleSelection({ selectionId: 'sel2' }));
    renderWithEnv(<DropZoneView />, { orbit });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '파일 열기…' }));
    const menu = await loadedWheel();
    menu.focus();
    await user.keyboard('{ArrowRight}{Enter}');
    await waitFor(() => expect(orbit.submitAction).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '다른 파일 고르기' }));
    await user.click(screen.getByRole('button', { name: '파일 열기…' }));
    await loadedWheel();
    await act(async () => {
      pending.resolve({ kind: 'jobs', jobIds: ['j1'] });
      await Promise.resolve();
    });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.queryByText('작업을 시작했습니다.')).toBeNull();
  });

  it('overlapping drops: the latest drop wins even if an older one resolves later', async () => {
    const orbit = createFakeOrbit();
    const first = deferred<ReturnType<typeof sampleSelection>>();
    const second = deferred<ReturnType<typeof sampleSelection>>();
    orbit.registerDroppedFiles.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const { container } = renderWithEnv(<DropZoneView />, { orbit });
    const zone = container.querySelector('.dropzone-view')!;
    dropFiles(zone, [new File(['a'], 'a.jpg')]);
    dropFiles(zone, [new File(['b'], 'b.pdf')]);
    await act(async () => {
      second.resolve(
        sampleSelection({ selectionId: 'sel-b', files: [{ fileId: 'b', name: 'b.pdf', ext: '.pdf', format: 'pdf', kind: 'pdf', bytes: 10 }], menuKey: 'pdf' }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve(sampleSelection({ selectionId: 'sel-a' }));
      await Promise.resolve();
    });
    await loadedWheel('변환 메뉴');
    await waitFor(() => expect(orbit.getMenu).toHaveBeenCalled());
    expect(orbit.getMenu.mock.calls.every(([selectionId]) => selectionId === 'sel-b')).toBe(true);
    expect(screen.getByText('b.pdf · 10 B')).toBeTruthy();
  });

  it('shows a localized error when registration fails', async () => {
    const orbit = createFakeOrbit();
    orbit.registerDroppedFiles.mockRejectedValue(new Error('CLOUD_PLACEHOLDER: not downloaded'));
    const { container } = renderWithEnv(<DropZoneView />, { orbit });
    dropFiles(container.querySelector('.dropzone-view')!, [new File(['x'], 'a.jpg')]);
    expect(await screen.findByText('아직 내려받지 않은 클라우드 파일입니다. 먼저 내려받은 뒤 다시 시도하세요.')).toBeTruthy();
  });
});
