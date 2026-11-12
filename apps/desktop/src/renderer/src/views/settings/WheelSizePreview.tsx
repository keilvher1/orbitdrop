import { ACTIONS, DEFAULT_WHEEL_GEOMETRY, DESIGN_TOKENS, WHEEL_DIAMETER_RANGE, baseMenuOrder } from '@orbitdrop/contracts';
import { innerRadius, sectorOuterRadius } from '@orbitdrop/core';
import { useId, useMemo } from 'react';
import { useEnv } from '../../app/env';
import { labelFontSize } from '../../wheel/Wheel';
import { capsulePath, sectorShape } from '../../wheel/sectorPath';
import { wheelAlwaysOpaque, wheelOpacityFactor, wheelOpacityStyle } from '../../wheel/wheelOpacity';
import '../../wheel/wheel.css';

/** On-screen size of the preview relative to the real wheel. */
export const WHEEL_PREVIEW_SCALE = 0.45;
/** Room around the largest wheel (dashed limit ring, disc shadow), in DIP. */
const MARGIN = 12;
/** Fixed drawing box in DIP: the largest wheel plus the margin, so dragging never changes the layout. */
const BOX = WHEEL_DIAMETER_RANGE.max + 2 * MARGIN;
/** Sample menu: a JPG's convert menu (8 sectors, like the reference recording), first sector highlighted. */
const SAMPLE_ACTIONS = baseMenuOrder('image/jpeg', 'convert');
const HIGHLIGHT = 0;
const LABEL_SIZE = DESIGN_TOKENS.font.wheelLabelSize;
const CAPSULE_TEXT_SIZE = DESIGN_TOKENS.font.capsuleSize;
/** Backdrop: a file list (rows with an icon, a name and a size) like the Finder/Explorer window the wheel opens over. */
const ROW = 36;
const ROW_NAME_LENGTHS = [0.62, 0.45, 0.78, 0.38, 0.56, 0.7, 0.48, 0.84, 0.4, 0.6, 0.72];

/** Diameter the preview draws: the setting's range, whole DIP. */
export function previewDiameter(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WHEEL_GEOMETRY.diameter;
  return Math.min(WHEEL_DIAMETER_RANGE.max, Math.max(WHEEL_DIAMETER_RANGE.min, Math.round(value)));
}

/**
 * Live preview of the global-drag wheel's size and opacity (Settings › 드래그). The wheel is
 * drawn in real DIP with the same geometry and sector path code as the wheel
 * itself (contracts DEFAULT_WHEEL_GEOMETRY, core innerRadius /
 * sectorOuterRadius, sectorShape) and the wheel's CSS (token colours, the
 * wheel opacity, the high-contrast sector outline, forced colours); the SVG
 * viewBox scales it to WHEEL_PREVIEW_SCALE inside a box sized for the largest
 * wheel. Dashed rings mark the smallest and largest diameter. Behind the wheel
 * a stand-in file list shows how much of a Finder/Explorer window the opacity
 * lets through (not drawn where the wheel is always opaque: high contrast,
 * forced colours). Purely visual (aria-hidden): the sliders next to it announce
 * the values.
 */
export function WheelSizePreview({ diameter, opacity = 100 }: { readonly diameter: number; readonly opacity?: number }) {
  const { t, appearance } = useEnv();
  const titleId = useId();
  const captionId = useId();
  const g = DEFAULT_WHEEL_GEOMETRY;
  const d = previewDiameter(diameter);
  const opacityFactor = wheelOpacityFactor(opacity, appearance);
  const backdrop = !wheelAlwaysOpaque(appearance);
  const R = sectorOuterRadius(d, g);
  const r = innerRadius(d, g);
  const count = SAMPLE_ACTIONS.length;
  const shapes = useMemo(
    () =>
      SAMPLE_ACTIONS.map((_, index) =>
        sectorShape({ index, count, innerRadius: r, outerRadius: R, gap: g.sectorGap, cornerRadius: g.sectorCornerRadius, startAngleDeg: g.startAngleDeg }),
      ),
    [count, r, R, g],
  );
  const labelRadius = (R + r) / 2;
  const size = Math.round(BOX * WHEEL_PREVIEW_SCALE);
  // One screen pixel in drawing units, for hairline strokes and dashes.
  const px = 1 / WHEEL_PREVIEW_SCALE;

  return (
    <figure className="wheel-preview" aria-labelledby={titleId} aria-describedby={captionId}>
      <div className="wheel-preview-stage" style={{ width: size, height: size }}>
        <svg
          className="wheel-preview-svg"
          width={size}
          height={size}
          viewBox={`${-BOX / 2} ${-BOX / 2} ${BOX} ${BOX}`}
          aria-hidden="true"
          focusable="false"
          data-diameter={d}
          data-opacity={Math.round(opacityFactor * 100)}
          style={wheelOpacityStyle(opacityFactor)}
        >
          {backdrop ? (
            <g className="wheel-preview-backdrop">
              <rect className="wheel-preview-backdrop-window" x={-BOX / 2} y={-BOX / 2} width={BOX} height={BOX} rx={18} strokeWidth={px} />
              {ROW_NAME_LENGTHS.map((length, row) => {
                const middle = -BOX / 2 + row * ROW + ROW / 2;
                return (
                  <g key={row}>
                    {/* Odd rows only: the first and last rows stay clear of the window's rounded corners. */}
                    {row % 2 === 1 ? <rect className="wheel-preview-backdrop-stripe" x={-BOX / 2} y={middle - ROW / 2} width={BOX} height={ROW} /> : null}
                    <rect className="wheel-preview-backdrop-icon" x={-BOX / 2 + 16} y={middle - 11} width={22} height={22} rx={5} />
                    <rect className="wheel-preview-backdrop-text" x={-BOX / 2 + 50} y={middle - 5} width={Math.round(length * 230)} height={10} rx={5} />
                    <rect className="wheel-preview-backdrop-text" x={BOX / 2 - 86} y={middle - 5} width={66} height={10} rx={5} />
                  </g>
                );
              })}
            </g>
          ) : null}
          <circle className="wheel-disc" r={d / 2 - g.ringWidth / 2} strokeWidth={g.ringWidth} />
          {/* Above the disc, below the sectors: the inner limit only shows between sectors once the wheel is larger. */}
          {[WHEEL_DIAMETER_RANGE.min, WHEEL_DIAMETER_RANGE.max].map((limit) => (
            <circle key={limit} className="wheel-preview-limit" r={limit / 2} strokeWidth={px} strokeDasharray={`${3 * px} ${3 * px}`} data-limit={limit} />
          ))}
          {SAMPLE_ACTIONS.map((actionId, index) => {
            const shape = shapes[index];
            if (shape === undefined) return null;
            const label = ACTIONS[actionId].wheelLabel[t.locale];
            return (
              <g key={actionId} className="wheel-sector" data-enabled="true" data-active={index === HIGHLIGHT}>
                <path d={shape.path} />
                <text
                  className="wheel-text"
                  x={shape.labelPoint.x.toFixed(2)}
                  y={shape.labelPoint.y.toFixed(2)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  style={{ fontSize: labelFontSize(label, labelRadius, count, g.sectorGap, LABEL_SIZE) }}
                >
                  {label}
                </text>
              </g>
            );
          })}
          <path className="wheel-preview-capsule" d={capsulePath(g.capsuleWidth, g.capsuleHeight)} />
          <text className="wheel-preview-capsule-text" textAnchor="middle" dominantBaseline="central" style={{ fontSize: CAPSULE_TEXT_SIZE }}>
            {`${d} ${t('common.px')}`}
          </text>
        </svg>
      </div>
      <figcaption className="wheel-preview-text">
        <span id={titleId} className="settings-label">
          {t('settings.wheelPreview')}
        </span>
        <span id={captionId} className="settings-hint">
          {t('settings.wheelPreviewCaption', { percent: Math.round(WHEEL_PREVIEW_SCALE * 100) })}
        </span>
      </figcaption>
    </figure>
  );
}
