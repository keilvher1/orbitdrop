import { DEFAULT_WHEEL_GEOMETRY, DESIGN_TOKENS, type WheelGeometry, type WheelSector } from '@orbitdrop/contracts';
import { hitTestWheel, innerRadius, sectorOuterRadius } from '@orbitdrop/core';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useT } from '../app/env';
import { ACTION_ICONS } from '../components/ActionIcon';
import { sectorShape } from './sectorPath';
import './wheel.css';

export interface WheelProps {
  readonly sectors: readonly WheelSector[];
  /** Disc diameter in CSS px (settings.globalDrag.wheelDiameter, 320–380). */
  readonly diameter: number;
  /** Accessible name of the menu, e.g. "변환 메뉴". */
  readonly label: string;
  /** Capsule text when no sector is active (file size, like the reference). */
  readonly centerText: string;
  readonly onActivate: (sector: WheelSector, index: number) => void;
  readonly onEscape?: () => void;
  /** Called when the highlighted sector changes (pointer or keyboard). */
  readonly onActiveChange?: (index: number | null) => void;
  readonly busy?: boolean;
  readonly autoFocus?: boolean;
  /** Extra description (e.g. keyboard instructions) for the menu. */
  readonly describedBy?: string;
  readonly geometry?: WheelGeometry;
}

/**
 * Input modality: the disc focus ring is shown when focus arrived by keyboard
 * (Tab) or after a key press, not when the window auto-focused the wheel for a
 * mouse user.
 */
let keyboardModality = false;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.metaKey && !event.ctrlKey) keyboardModality = true;
    },
    true,
  );
  window.addEventListener(
    'pointerdown',
    () => {
      keyboardModality = false;
    },
    true,
  );
}

const ICON_SIZE = DESIGN_TOKENS.font.wheelIconSize;
const LABEL_SIZE = DESIGN_TOKENS.font.wheelLabelSize;

/** Rough rendered width of a label in em (bold system font) for fitting it into a sector. */
export function estimateLabelEm(label: string): number {
  let em = 0;
  for (const ch of label) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xac00 && code <= 0xd7a3) em += 0.98;
    else if (ch === ' ') em += 0.3;
    else if (/[A-Z0-9]/.test(ch)) em += 0.68;
    else em += 0.58;
  }
  return em;
}

/**
 * Font size that fits a label into its sector: the chord at the label radius
 * (minus the gap and some padding) divided by the estimated label width.
 * Never larger than the token size, never below 11 px.
 */
export function labelFontSize(label: string, labelRadius: number, count: number, gap: number, base: number): number {
  const half = Math.min(80, 180 / Math.max(1, count)) * (Math.PI / 180);
  const available = 2 * labelRadius * Math.sin(half) - gap - 16;
  const em = estimateLabelEm(label) + 0.03 * label.length;
  const fitted = em > 0 ? available / em : base;
  return Math.max(11, Math.min(base, Math.floor(fitted * 10) / 10));
}

/**
 * Radial menu drawn in SVG from the shared geometry (contracts DEFAULT_WHEEL_GEOMETRY)
 * and hit-tested with core `hitTestWheel`, i.e. exactly like the native helpers.
 *
 * Keyboard: the menu is one tab stop (aria-activedescendant pattern).
 * ArrowRight/ArrowDown = clockwise, ArrowLeft/ArrowUp = counter-clockwise,
 * Home/End = first/last. Disabled sectors are reachable (their reason is
 * announced) but cannot be activated. Enter/Space activates, Esc closes, Tab
 * leaves the wheel (to the mode toggle that follows it).
 */
export function Wheel({
  sectors,
  diameter,
  label,
  centerText,
  onActivate,
  onEscape,
  onActiveChange,
  busy = false,
  autoFocus = false,
  describedBy,
  geometry = DEFAULT_WHEEL_GEOMETRY,
}: WheelProps) {
  const t = useT();
  const baseId = useId().replace(/:/g, '');
  const menuRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const count = sectors.length;

  const R = sectorOuterRadius(diameter, geometry);
  const r = innerRadius(diameter, geometry);
  const labelRadius = (R + r) / 2;
  const shapes = useMemo(
    () =>
      sectors.map((_, index) =>
        sectorShape({
          index,
          count,
          innerRadius: r,
          outerRadius: R,
          gap: geometry.sectorGap,
          cornerRadius: geometry.sectorCornerRadius,
          startAngleDeg: geometry.startAngleDeg,
        }),
      ),
    [sectors, count, r, R, geometry],
  );

  // Reset the highlight when the menu changes (e.g. mode toggle).
  useEffect(() => {
    setActive(null);
    setAnnouncement('');
  }, [sectors]);

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    if (autoFocus) menuRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const announce = useCallback(
    (index: number) => {
      const sector = sectors[index];
      if (sector === undefined) return;
      setAnnouncement(
        sector.enabled
          ? t('wheel.announce', { label: sector.label })
          : t('wheel.announceDisabled', { label: sector.label, reason: sector.reason ?? t('wheel.unavailable') }),
      );
    },
    [sectors, t],
  );

  const activate = useCallback(
    (index: number) => {
      const sector = sectors[index];
      if (sector === undefined || busy) return;
      if (!sector.enabled) {
        announce(index);
        return;
      }
      onActivate(sector, index);
    },
    [sectors, busy, announce, onActivate],
  );

  const moveTo = (index: number) => {
    setKeyboard(true);
    setActive(index);
    // aria-activedescendant already announces the item (with its reason); the live region only speaks when a
    // disabled item is activated. Cleared here so the same explanation is read again next time.
    setAnnouncement('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') setFocusRing(true);
    if (event.key === 'Escape') {
      if (onEscape) {
        event.preventDefault();
        onEscape();
      }
      return;
    }
    if (count === 0) return;
    const current = active;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        moveTo(current === null ? 0 : (current + 1) % count);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        moveTo(current === null ? count - 1 : (current - 1 + count) % count);
        break;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        break;
      case 'End':
        event.preventDefault();
        moveTo(count - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (current !== null) activate(current);
        break;
      default:
        break;
    }
  };

  const indexAt = (event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const k = diameter / rect.width;
    const dx = (event.clientX - (rect.left + rect.width / 2)) * k;
    const dy = (event.clientY - (rect.top + rect.height / 2)) * k;
    const hit = hitTestWheel(dx, dy, count, diameter, geometry);
    return hit.zone === 'sector' ? hit.index : null;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    const index = indexAt(event);
    setKeyboard(false);
    setActive(index);
  };

  const onPointerLeave = () => {
    if (!keyboard) setActive(null);
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    // Keyboard "clicks" (detail 0) are handled in onKeyDown.
    if (event.detail === 0) return;
    const index = indexAt(event);
    if (index === null) return;
    setActive(index);
    activate(index);
  };

  const activeSector = active === null ? undefined : sectors[active];
  let capsuleText = centerText;
  let capsuleTone: 'normal' | 'reject' | 'busy' = 'normal';
  if (busy) {
    capsuleText = t('wheel.busy');
    capsuleTone = 'busy';
  } else if (activeSector !== undefined) {
    if (activeSector.enabled) capsuleText = activeSector.label;
    else {
      capsuleText = activeSector.reason ?? t('wheel.unavailable');
      capsuleTone = 'reject';
    }
  }

  const half = diameter / 2;
  const capsuleMaxWidth = Math.max(geometry.capsuleWidth, 2 * r - 10);
  const itemId = (index: number) => `${baseId}-item-${index}`;
  const reasonId = (index: number) => `${baseId}-reason-${index}`;
  const describedByIds = [describedBy].filter(Boolean).join(' ') || undefined;

  return (
    <div className="wheel" style={{ width: diameter, height: diameter }} data-keyboard={keyboard} data-focus-ring={focusRing} data-busy={busy}>
      <div
        ref={menuRef}
        className="wheel-hit"
        role="menu"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={active === null ? undefined : itemId(active)}
        aria-describedby={describedByIds}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onClick={onClick}
        onFocus={() => setFocusRing(keyboardModality)}
        onPointerDown={() => setFocusRing(false)}
        onBlur={() => {
          if (keyboard) setActive(null);
          setKeyboard(false);
          setFocusRing(false);
        }}
      >
        <svg className="wheel-svg" width={diameter} height={diameter} viewBox={`${-half} ${-half} ${diameter} ${diameter}`} role="none" focusable="false">
          <circle className="wheel-disc" r={half - geometry.ringWidth / 2} strokeWidth={geometry.ringWidth} />
          {sectors.map((sector, index) => {
            const shape = shapes[index];
            if (shape === undefined) return null;
            const Icon = sector.icon === null ? null : ACTION_ICONS[sector.icon];
            const fontSize = labelFontSize(sector.label, labelRadius, count, geometry.sectorGap, LABEL_SIZE);
            const isActive = index === active;
            return (
              <g
                key={sector.actionId}
                id={itemId(index)}
                className="wheel-sector"
                role="menuitem"
                aria-label={sector.label}
                aria-disabled={sector.enabled ? undefined : true}
                aria-describedby={sector.enabled ? undefined : reasonId(index)}
                data-enabled={sector.enabled}
                data-active={isActive}
                data-action={sector.actionId}
              >
                <path d={shape.path} />
                <g transform={`translate(${shape.labelPoint.x.toFixed(2)} ${shape.labelPoint.y.toFixed(2)})`} aria-hidden="true">
                  {Icon ? (
                    <g className="wheel-icon" transform={`translate(${-ICON_SIZE / 2} ${-ICON_SIZE - 3})`}>
                      <Icon size={ICON_SIZE} strokeWidth={2} />
                    </g>
                  ) : null}
                  <text className="wheel-text" textAnchor="middle" dominantBaseline="central" y={Icon ? 10 : 0} style={{ fontSize }}>
                    {sector.label}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>
        <div className="wheel-capsule" data-tone={capsuleTone} style={{ maxWidth: capsuleMaxWidth, minWidth: Math.min(geometry.capsuleWidth, capsuleMaxWidth), minHeight: geometry.capsuleHeight }} aria-hidden="true">
          <span className="wheel-capsule-text">{capsuleText}</span>
        </div>
      </div>
      <div hidden>
        {sectors.map((sector, index) =>
          sector.enabled ? null : (
            <span key={sector.actionId} id={reasonId(index)}>
              {sector.reason ?? t('wheel.unavailable')}
            </span>
          ),
        )}
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
