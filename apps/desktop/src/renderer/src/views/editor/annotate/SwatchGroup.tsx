import { Pipette } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import './SwatchGroup.css';

export interface SwatchGroupProps {
  readonly label: string;
  readonly colors: readonly string[];
  readonly value: string;
  readonly onChange: (color: string) => void;
  /** Accessible name of a preset swatch, e.g. "Colour #F2552C". */
  readonly optionLabel: (color: string) => string;
  readonly customLabel: string;
  readonly disabled?: boolean;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Colour swatches as an ARIA radio group (one tab stop, arrow keys move) plus a
 * custom colour picker. The custom swatch shows the current colour when it is
 * not one of the presets.
 */
export function SwatchGroup({ label, colors, value, onChange, optionLabel, customLabel, disabled = false }: SwatchGroupProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const presetIndex = colors.findIndex((c) => same(c, value));
  const isCustom = presetIndex < 0;
  const focusIndex = isCustom ? 0 : presetIndex;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 || disabled) return;
    if (!(event.target instanceof HTMLButtonElement)) return;
    event.preventDefault();
    const from = presetIndex < 0 ? (step > 0 ? -1 : 0) : presetIndex;
    const next = (((from + step) % colors.length) + colors.length) % colors.length;
    const color = colors[next];
    if (color === undefined) return;
    onChange(color);
    refs.current[next]?.focus();
  };

  return (
    <div className="swatch-grid" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {colors.map((color, index) => (
        <button
          key={color}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="radio"
          className="swatch"
          style={{ background: color }}
          aria-checked={index === presetIndex}
          aria-label={optionLabel(color)}
          title={color}
          tabIndex={index === focusIndex ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(color)}
        />
      ))}
      <label
        className="swatch swatch-icon"
        title={customLabel}
        data-checked={isCustom}
        style={isCustom ? { background: value, color: 'transparent' } : undefined}
      >
        <Pipette size={14} aria-hidden="true" />
        <input type="color" aria-label={customLabel} value={value.length === 7 ? value : '#000000'} disabled={disabled} onChange={(event) => onChange(event.target.value.toUpperCase())} />
      </label>
    </div>
  );
}
