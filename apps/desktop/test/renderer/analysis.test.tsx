// @vitest-environment jsdom
import './setup';
import { ANTHROPIC_KEYS_URL, DEFAULT_SETTINGS, type AnalysisStatus, type Settings } from '@orbitdrop/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ActionIcon, ACTION_ICONS } from '../../src/renderer/src/components/ActionIcon';
import { PickerView } from '../../src/renderer/src/views/picker/PickerView';
import { SettingsView } from '../../src/renderer/src/views/settings/SettingsView';
import { createFakeOrbit, renderWithEnv, sampleMenu, sampleSelection } from './helpers';

/** A fake key in the real format (valid nowhere). */
const KEY = `sk-ant-api03-${'R'.repeat(86)}9xYz`;

const enabledSettings: Settings = { ...DEFAULT_SETTINGS, analysis: { enabled: true, instruction: '' } };

async function openAnalysisTab(options: { settings?: Settings; orbit?: ReturnType<typeof createFakeOrbit> } = {}) {
  const orbit = options.orbit ?? createFakeOrbit();
  if (options.settings) await orbit.updateSettings(options.settings);
  orbit.updateSettings.mockClear();
  const view = renderWithEnv(<SettingsView />, { orbit, ...(options.settings ? { settings: options.settings } : {}) });
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'Claude 분석' }));
  return { ...view, orbit, user };
}

describe('Settings › Claude 분석', () => {
  it('is a tab between 접근성 and 정보; off by default, with what is sent, what it costs and how the key is kept', async () => {
    const { orbit } = await openAnalysisTab();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['일반', '변환·저장', '드래그', '처리', '접근성', 'Claude 분석', '정보']);
    const panel = screen.getByRole('tabpanel');
    const enable = within(panel).getByRole('checkbox', { name: 'Claude 분석 사용' }) as HTMLInputElement;
    expect(enable.checked).toBe(false);
    const privacy = within(panel).getByRole('region', { name: '보내는 내용과 비용' });
    const items = within(privacy)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/Anthropic API로 보내지고 Anthropic의 API 약관에 따라 처리됩니다.*긴 변 1568px 이하로 줄인 사본.*PDF는 파일 그대로.*파일 이름·추가 요청·보고서 언어/);
    expect(items[1]).toMatch(/이 키의 Anthropic 계정에 청구됩니다/);
    expect(items[2]).toMatch(/‘Claude 분석’에 파일을 놓기 전에는 아무것도 보내지 않습니다/);
    expect(items[3]).toMatch(/암호화해 이 컴퓨터에 저장.*설정·로그·작업 기록에는 남기지 않습니다/);
    expect(await within(panel).findByText('키 없음')).toBeTruthy();
    expect(within(panel).getByText(/모델: Claude Opus 5\.5 · 보고서는 앱 언어\(한국어\)로 작성됩니다\./)).toBeTruthy();
    expect(orbit.getAnalysisStatus).toHaveBeenCalled();
    // Without a key there is nothing to check or delete; an empty field cannot be saved.
    expect((within(panel).getByRole('button', { name: '연결 확인' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel).getByRole('button', { name: '키 삭제…' }) as HTMLButtonElement).disabled).toBe(true);
    // Save stays focusable (aria-disabled) so focus does not drop to the page when a save empties the field.
    const save = within(panel).getByRole('button', { name: '저장' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await userEvent.setup().click(save);
    expect(orbit.saveAnalysisKey).not.toHaveBeenCalled();
  });

  it('turning it on is a settings change; it then says what is missing', async () => {
    const { orbit, user } = await openAnalysisTab();
    await user.click(screen.getByRole('checkbox', { name: 'Claude 분석 사용' }));
    expect(orbit.updateSettings).toHaveBeenCalledWith({ analysis: { enabled: true } });
    expect(await screen.findByText('API 키를 저장하면 휠에 ‘Claude 분석’이 나타납니다.')).toBeTruthy();
  });

  it('a key that is not one is refused in the page — nothing is sent to main', async () => {
    const { orbit, user } = await openAnalysisTab();
    const field = screen.getByLabelText('Anthropic API 키') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    await user.type(field, 'not-a-key');
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('sk-ant-로 시작하는 Anthropic API 키 전체를 붙여 넣으세요.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain(screen.getByText('sk-ant-로 시작하는 Anthropic API 키 전체를 붙여 넣으세요.').id);
    expect(document.activeElement).toBe(field);
    expect(orbit.saveAnalysisKey).not.toHaveBeenCalled();
  });

  it('saving sends the trimmed key once, then forgets it: the page shows only "저장됨 · …9xYz"', async () => {
    const { orbit, user, container } = await openAnalysisTab({ settings: enabledSettings });
    const field = screen.getByLabelText('Anthropic API 키') as HTMLInputElement;
    await user.click(field);
    await user.paste(`  ${KEY}\n`);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(orbit.saveAnalysisKey).toHaveBeenCalledWith(KEY));
    expect(await screen.findByText('키를 암호화해 저장했습니다.')).toBeTruthy();
    expect(screen.getByText('저장됨 · …9xYz')).toBeTruthy();
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field); // saved with Enter: focus stays in the field
    expect(container.innerHTML).not.toContain(KEY);
    expect(container.innerHTML).not.toContain(KEY.slice(13, 40));
    expect(await screen.findByText('휠의 도구 메뉴에 ‘Claude 분석’이 있습니다. PDF는 도구 메뉴에 이 항목만 나옵니다.')).toBeTruthy();
    expect(orbit.saveAnalysisKey).toHaveBeenCalledTimes(1);
  });

  it('main refusing the key (e.g. no encryption here) is shown as its localized error', async () => {
    const orbit = createFakeOrbit();
    orbit.saveAnalysisKey.mockRejectedValueOnce(new Error('ANALYSIS_KEY_STORAGE_UNAVAILABLE: The OS cannot encrypt the key on this computer'));
    const { user } = await openAnalysisTab({ orbit });
    await user.click(screen.getByLabelText('Anthropic API 키'));
    await user.paste(KEY);
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/운영체제의 보안 저장소로 API 키를 암호화하거나 읽을 수 없습니다/)).toBeTruthy();
    expect(screen.getByText('키 없음')).toBeTruthy();
  });

  it('when the OS cannot encrypt, it says so and saving is not possible', async () => {
    const orbit = createFakeOrbit();
    const status: AnalysisStatus = { enabled: true, hasKey: false, keyHint: null, encryptionAvailable: false, available: false };
    orbit.getAnalysisStatus.mockResolvedValue(status);
    const { user } = await openAnalysisTab({ orbit, settings: enabledSettings });
    expect(await screen.findByText(/키를 암호화할 수 없어 키를 저장할 수 없습니다/)).toBeTruthy();
    await user.click(screen.getByLabelText('Anthropic API 키'));
    await user.paste(KEY);
    const save = screen.getByRole('button', { name: '저장' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await user.click(save);
    expect(orbit.saveAnalysisKey).not.toHaveBeenCalled();
  });

  it('"연결 확인" shows the answer: connected, or why not', async () => {
    const orbit = createFakeOrbit();
    await orbit.saveAnalysisKey(KEY);
    orbit.saveAnalysisKey.mockClear();
    const { user } = await openAnalysisTab({ orbit, settings: enabledSettings });
    const check = await screen.findByRole('button', { name: '연결 확인' });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    await user.click(check);
    expect(await screen.findByText('연결됨: Anthropic이 이 키를 받아들였습니다.')).toBeTruthy();
    orbit.testAnalysisKey.mockResolvedValueOnce({ ok: false, error: { code: 'ANALYSIS_AUTH_FAILED', message: 'The API refused the key', retryable: false } });
    await user.click(check);
    expect(await screen.findByText(/Anthropic이 API 키를 거부했습니다/)).toBeTruthy();
    expect(orbit.testAnalysisKey).toHaveBeenCalledTimes(2);
    expect(orbit.saveAnalysisKey).not.toHaveBeenCalled();
  });

  it('deleting asks first (in the window); cancelling keeps the key', async () => {
    const orbit = createFakeOrbit();
    await orbit.saveAnalysisKey(KEY);
    const { user } = await openAnalysisTab({ orbit, settings: enabledSettings });
    expect(await screen.findByText('저장됨 · …9xYz')).toBeTruthy();
    const remove = screen.getByRole('button', { name: '키 삭제…' });
    await user.click(remove);
    let dialog = screen.getByRole('alertdialog', { name: 'API 키를 삭제할까요?' });
    await user.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(orbit.deleteAnalysisKey).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(remove);
    await user.click(remove);
    dialog = screen.getByRole('alertdialog', { name: 'API 키를 삭제할까요?' });
    await user.click(within(dialog).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(orbit.deleteAnalysisKey).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('키를 삭제했습니다.')).toBeTruthy();
    expect(screen.getByText('키 없음')).toBeTruthy();
  });

  it('the standing request is saved after typing stops (and on blur), up to 1000 characters', async () => {
    const { orbit, user } = await openAnalysisTab({ settings: enabledSettings });
    const box = screen.getByLabelText('추가 요청 (선택)') as HTMLTextAreaElement;
    expect(box.maxLength).toBe(1000);
    await user.type(box, '표의 합계를 확인해 줘');
    expect(screen.getByText('12/1000자')).toBeTruthy();
    await user.tab();
    await waitFor(() => expect(orbit.updateSettings).toHaveBeenCalledWith({ analysis: { instruction: '표의 합계를 확인해 줘' } }));
    const calls = orbit.updateSettings.mock.calls.filter(([patch]) => (patch as { analysis?: { instruction?: string } }).analysis?.instruction !== undefined);
    expect(calls).toHaveLength(1);
  });

  it('opens the API key page of the Anthropic Console (allowlisted) in the browser', async () => {
    const { orbit, user } = await openAnalysisTab();
    await user.click(screen.getByRole('button', { name: 'Anthropic 콘솔에서 API 키 만들기' }));
    expect(orbit.openExternal).toHaveBeenCalledWith(ANTHROPIC_KEYS_URL);
    expect(ANTHROPIC_KEYS_URL).toBe('https://platform.claude.com/settings/keys');
  });

  it('is English with an English UI', async () => {
    const orbit = createFakeOrbit();
    const en: Settings = { ...DEFAULT_SETTINGS, locale: 'en' };
    await orbit.updateSettings(en);
    renderWithEnv(<SettingsView />, { orbit, settings: en });
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Claude Analysis' }));
    expect(screen.getByRole('checkbox', { name: 'Use Claude analysis' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'What is sent, and what it costs' })).toBeTruthy();
    expect(screen.getByLabelText('Anthropic API key')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check Connection' })).toBeTruthy();
    expect(await screen.findByText('No key')).toBeTruthy();
  });
});

describe('the picker with Claude analysis', () => {
  const pdfSelection = sampleSelection({ selectionId: 'sel-pdf', files: [{ fileId: 'f1', name: 'report.pdf', ext: '.pdf', format: 'pdf', kind: 'pdf', bytes: 2048 }], menuKey: 'pdf' });

  it('a PDF has no tools wheel while analysis is unavailable (no status request either when it is off)', async () => {
    const orbit = createFakeOrbit({ getSelection: async () => pdfSelection, getMenu: async (_id, mode) => sampleMenu(mode, 'pdf') });
    renderWithEnv(<PickerView selectionId="sel-pdf" initialMode="convert" />, { orbit });
    const tools = await screen.findByRole('radio', { name: '도구' });
    expect(tools.getAttribute('aria-disabled') === 'true' || (tools as HTMLButtonElement).disabled).toBe(true);
    expect(orbit.getAnalysisStatus).not.toHaveBeenCalled();
  });

  it('available: the PDF gets a tools wheel with "Claude 분석"; opened on the tools wheel it goes there once known', async () => {
    const orbit = createFakeOrbit({
      getSelection: async () => pdfSelection,
      getMenu: async (_id, mode) => (mode === 'tools' ? { key: 'pdf', mode, sectors: [{ actionId: 'tool.analyze', label: 'Claude 분석', icon: 'analyze', enabled: true, batch: true }] } : sampleMenu(mode, 'pdf')),
    });
    await orbit.updateSettings({ analysis: { enabled: true } });
    await orbit.saveAnalysisKey(KEY);
    renderWithEnv(<PickerView selectionId="sel-pdf" initialMode="tools" />, { orbit, settings: enabledSettings });
    const menu = await screen.findByRole('menu', { name: '도구 메뉴' });
    const items = await within(menu).findAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['Claude 분석']);
    const user = userEvent.setup();
    menu.focus();
    await user.keyboard('{Home}{Enter}');
    await waitFor(() => expect(orbit.submitAction).toHaveBeenCalledWith({ selectionId: 'sel-pdf', actionId: 'tool.analyze' }));
  });

  it('turning analysis off while a PDF shows its tools wheel goes back to convert', async () => {
    const orbit = createFakeOrbit({
      getSelection: async () => pdfSelection,
      getMenu: async (_id, mode) => (mode === 'tools' ? { key: 'pdf', mode, sectors: [{ actionId: 'tool.analyze', label: 'Claude 분석', icon: 'analyze', enabled: true, batch: true }] } : sampleMenu(mode, 'pdf')),
    });
    let push: ((settings: Settings) => void) | undefined;
    orbit.onSettingsChanged.mockImplementation((listener) => {
      push = listener;
      return () => undefined;
    });
    await orbit.updateSettings({ analysis: { enabled: true } });
    await orbit.saveAnalysisKey(KEY);
    renderWithEnv(<PickerView selectionId="sel-pdf" initialMode="tools" />, { orbit, settings: enabledSettings });
    await screen.findByRole('menu', { name: '도구 메뉴' });
    await act(async () => push?.({ ...DEFAULT_SETTINGS }));
    expect(await screen.findByRole('menu', { name: '변환 메뉴' })).toBeTruthy();
  });

  it('the analyze icon is a sparkles glyph like the other tool icons', () => {
    expect(ACTION_ICONS.analyze).toBeTruthy();
    const { container } = renderWithEnv(<ActionIcon icon="analyze" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('class')).toContain('lucide-sparkles');
  });
});
