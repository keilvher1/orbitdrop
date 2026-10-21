// @vitest-environment jsdom
import './setup';
import { BACKGROUND_PRESETS, CompositionSpecSchema, CropOptionsSchema, DEFAULT_SETTINGS } from '@orbitdrop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { presetBackgroundStyle } from '../../src/renderer/src/views/editor/background/backgroundCss';
import { BackgroundEditor, readCompositionDefaults, sliderRanges } from '../../src/renderer/src/views/editor/background/BackgroundEditor';
import { CropEditor } from '../../src/renderer/src/views/editor/crop/CropEditor';
import { createFakeOrbit, renderWithEnv, sampleEditorContext, sampleImageInfo } from './helpers';

const pageInfo = sampleImageInfo({ width: 2550, height: 3300, orientedWidth: 2550, orientedHeight: 3300, orientation: 1 });

function cropCtx() {
  return sampleEditorContext('tool.crop', {
    image: pageInfo,
    files: [{ fileId: 'f1', name: 'Page 001.jpg', ext: '.jpg', format: 'jpeg', kind: 'image', bytes: 1_200_000 }],
    defaults: { rect: { x: 0, y: 0, width: 2550, height: 3300 }, aspect: 'free', outputFormat: 'input', flattenBackground: '#FFFFFF', unknownField: 1 },
  });
}

describe('Crop editor', () => {
  it('starts from the defaults and shows W/H in output pixels', () => {
    renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    expect((screen.getByLabelText('너비') as HTMLInputElement).value).toBe('2550');
    expect((screen.getByLabelText('높이') as HTMLInputElement).value).toBe('3300');
    expect(screen.getByText('원본 옆에 ‘Page 001 Cropped.jpg’(으)로 저장됩니다.')).toBeTruthy();
  });

  it('1:1 preset → 2550×2550, W/H stay in sync both ways, Apply commits the source-pixel rect', async () => {
    const { orbit } = renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: '1:1' }));
    const w = screen.getByLabelText('너비') as HTMLInputElement;
    const h = screen.getByLabelText('높이') as HTMLInputElement;
    expect([w.value, h.value]).toEqual(['2550', '2550']);
    await user.clear(w);
    await user.type(w, '1000');
    expect(h.value).toBe('1000');
    await user.click(screen.getByRole('button', { name: '적용' }));
    await waitFor(() => expect(orbit.commitEditor).toHaveBeenCalledTimes(1));
    const request = orbit.commitEditor.mock.calls[0]![0];
    expect(request.editorId).toBe('ed1');
    // Strict schema: no unknown fields leak through from ctx.defaults.
    const options = CropOptionsSchema.parse(request.options);
    expect(options).toEqual({ rect: { x: 775, y: 1150, width: 1000, height: 1000 }, aspect: '1:1', outputFormat: 'input', flattenBackground: '#FFFFFF' });
    await waitFor(() => expect(orbit.closeWindow).toHaveBeenCalled());
  });

  it('validates W/H: integers only, 1..source, ratio limits — Apply disabled while invalid', async () => {
    renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    const user = userEvent.setup();
    const w = screen.getByLabelText('너비') as HTMLInputElement;
    const apply = screen.getByRole('button', { name: '적용' }) as HTMLButtonElement;
    await user.clear(w);
    await user.type(w, '12a');
    expect(screen.getByRole('alert').textContent).toContain('정수를 입력하세요.');
    expect(apply.disabled).toBe(true);
    await user.clear(w);
    await user.type(w, '0');
    expect(screen.getByRole('alert').textContent).toContain('1–2550 사이의 값을 입력하세요.');
    await user.clear(w);
    await user.type(w, '9999');
    expect(screen.getByRole('alert').textContent).toContain('1–2550');
    await user.clear(w);
    await user.type(w, '1200');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(apply.disabled).toBe(false);
    // 16:9 on a 2550×3300 page: the height limit is 1434 px for the full width.
    await user.click(screen.getByRole('radio', { name: '16:9' }));
    const h = screen.getByLabelText('높이') as HTMLInputElement;
    await user.clear(h);
    await user.type(h, '2000');
    expect(screen.getByRole('alert').textContent).toContain('이 비율에서는 최대 1434px입니다.');
  });

  it('keyboard: arrows move the selection, Option/Alt+arrows resize it', async () => {
    renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    const user = userEvent.setup();
    const w = screen.getByLabelText('너비') as HTMLInputElement;
    await user.clear(w);
    await user.type(w, '1000');
    const selection = screen.getByRole('group', { name: /자르기 영역/ });
    selection.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(Number(w.value)).toBeGreaterThan(1000);
    const before = Number(w.value);
    await user.keyboard('{ArrowLeft}');
    expect(Number(w.value)).toBe(before);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toMatch(/px, 위치/);
  });

  it('Esc in a W/H field first reverts the edit, then (untouched) cancels the editor', async () => {
    const { orbit } = renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    const user = userEvent.setup();
    const w = screen.getByLabelText('너비') as HTMLInputElement;
    await user.clear(w);
    await user.type(w, '1000');
    await user.keyboard('{Escape}');
    expect(w.value).toBe('2550');
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
  });

  it('Reset restores the defaults; Esc cancels without writing', async () => {
    const { orbit } = renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: '4:3' }));
    expect((screen.getByLabelText('높이') as HTMLInputElement).value).toBe('1913');
    await user.click(screen.getByRole('button', { name: '초기화' }));
    expect((screen.getByLabelText('높이') as HTMLInputElement).value).toBe('3300');
    expect(screen.getByRole('radio', { name: '자유' }).getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Escape}');
    expect(orbit.cancelEditor).toHaveBeenCalledWith('ed1');
    expect(orbit.closeWindow).toHaveBeenCalled();
    expect(orbit.commitEditor).not.toHaveBeenCalled();
  });
});

describe('Add Background editor', () => {
  const oriented = { width: 2550, height: 2550 };
  const defaults = readCompositionDefaults(
    { background: { kind: 'preset', presetId: 'ember' }, padding: 192, cornerRadius: 72, shadow: 48, ratio: 'auto', maxEdge: 2400, format: 'png', quality: 92 },
    DEFAULT_SETTINGS,
    oriented,
  );

  it('reads defaults safely and derives slider ranges from the output size', () => {
    expect(CompositionSpecSchema.parse(defaults)).toEqual(defaults);
    const fallback = readCompositionDefaults({ padding: 'x', ratio: 'weird', background: { kind: 'preset', presetId: 'nope' } }, DEFAULT_SETTINGS, oriented);
    expect(fallback.background).toEqual({ kind: 'preset', presetId: BACKGROUND_PRESETS[0]!.id });
    expect(fallback.ratio).toBe('auto');
    expect(fallback.maxEdge).toBe(2400);
    expect(fallback.padding).toBe(192); // 8 % of min(maxEdge, long edge)
    expect(sliderRanges(oriented, 2400)).toEqual({ padding: 1200, cornerRadius: 1200, shadow: 240 });
    expect(sliderRanges({ width: 800, height: 200 }, 2400)).toEqual({ padding: 400, cornerRadius: 100, shadow: 80 });
  });

  it('renders preset swatches from the preset layers (top layer first, radial radius in px)', () => {
    const ember = BACKGROUND_PRESETS.find((p) => p.id === 'ember')!;
    const style = presetBackgroundStyle(ember, 28, 28);
    expect(style.backgroundColor).toBe('#F4503A');
    const layers = String(style.backgroundImage).split(/,\s*(?=radial|linear)/);
    expect(layers).toHaveLength(3);
    expect(layers[0]).toContain('circle 19.6px at 85% 95%'); // last preset layer is painted on top
    const peach = presetBackgroundStyle(BACKGROUND_PRESETS.find((p) => p.id === 'peach')!, 28, 28);
    expect(peach.backgroundImage).toBe('linear-gradient(160deg, #FFFFFF 0%, #FFC9A8 100%)');
  });

  it('previews through the processor, explains padding growth and saves exactly the CompositionSpec', async () => {
    const orbit = createFakeOrbit();
    orbit.requestPreview.mockImplementation(async (request) => ({
      ok: true,
      seq: request.seq,
      url: 'orbit-preview://p/abc',
      width: 400,
      height: 225,
      outputWidth: 2400,
      outputHeight: 1350,
      layout: {
        canvas: { width: 2400, height: 1350 },
        content: { x: 675, y: 0, width: 1050, height: 1050 },
        contentScale: 0.41,
        cornerRadius: 72,
        shadow: null,
        margins: { top: 150, right: 675, bottom: 150, left: 675 },
        paddingExpandedByRatio: true,
        paddingExpandedByShadow: false,
      },
    }));
    const ctx = sampleEditorContext('tool.addBackground', { image: sampleImageInfo({ width: 2550, height: 2550, orientedWidth: 2550, orientedHeight: 2550 }), defaults });
    renderWithEnv(<BackgroundEditor ctx={ctx} title="배경 추가" />, { orbit });
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: '16:9' }));
    expect(await screen.findByText('선택한 비율에 맞추느라 한쪽 여백이 설정값보다 넓어졌습니다.')).toBeTruthy();
    await waitFor(() => expect(orbit.requestPreview).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ ratio: '16:9' }) })));
    expect(await screen.findByText('출력 2400 × 1350 px')).toBeTruthy();
    expect((await screen.findByAltText('처리 결과 미리보기')).getAttribute('src')).toBe('orbit-preview://p/abc');

    const swatches = screen.getByRole('radiogroup', { name: '배경' });
    await user.click(within(swatches).getByRole('radio', { name: '복숭아 그라디언트' }));
    const padding = screen.getByRole('spinbutton', { name: '여백' });
    await user.clear(padding);
    await user.type(padding, '300{Enter}');

    await user.click(screen.getByRole('button', { name: '배경과 함께 저장' }));
    await waitFor(() => expect(orbit.commitEditor).toHaveBeenCalledTimes(1));
    const options = orbit.commitEditor.mock.calls[0]![0].options;
    expect(CompositionSpecSchema.parse(options)).toEqual({ ...defaults, background: { kind: 'preset', presetId: 'peach' }, padding: 300, ratio: '16:9' });
  });

  it('picks a background image through main and selects it', async () => {
    const orbit = createFakeOrbit();
    orbit.pickBackgroundImage.mockResolvedValue({ fileId: 'bg1', name: 'beach.jpg' });
    const ctx = sampleEditorContext('tool.addBackground', { defaults });
    renderWithEnv(<BackgroundEditor ctx={ctx} title="배경 추가" />, { orbit });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '배경 이미지 고르기…' }));
    const image = await screen.findByRole('radio', { name: '배경 이미지: beach.jpg' });
    expect(image.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('button', { name: '배경과 함께 저장' }));
    await waitFor(() => expect(orbit.commitEditor).toHaveBeenCalled());
    expect(orbit.commitEditor.mock.calls[0]![0].options).toMatchObject({ background: { kind: 'image', fileId: 'bg1' } });
  });

  it('arrow keys move through the swatches like radio buttons', async () => {
    const ctx = sampleEditorContext('tool.addBackground', { defaults });
    renderWithEnv(<BackgroundEditor ctx={ctx} title="배경 추가" />);
    const user = userEvent.setup();
    const group = screen.getByRole('radiogroup', { name: '배경' });
    const first = within(group).getByRole('radio', { name: '노을 그라디언트' });
    expect(first.getAttribute('aria-checked')).toBe('true');
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: '복숭아 그라디언트' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('복숭아 그라디언트');
  });

  it('shows JPEG quality only for JPEG output', async () => {
    const ctx = sampleEditorContext('tool.addBackground', { defaults });
    renderWithEnv(<BackgroundEditor ctx={ctx} title="배경 추가" />);
    expect(screen.queryByRole('spinbutton', { name: '품질' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('radio', { name: 'JPEG' }));
    expect(screen.getByRole('spinbutton', { name: '품질' })).toBeTruthy();
    expect(screen.getByText('JPEG는 투명도를 담을 수 없어 불투명한 배경으로 저장됩니다.')).toBeTruthy();
  });
});
