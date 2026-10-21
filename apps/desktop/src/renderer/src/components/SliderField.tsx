import { useId, type CSSProperties } from 'react';
import { NumberInput } from './NumberInput';

export interface SliderFieldProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** The text field may accept a wider range than the slider covers. */
  readonly inputMax?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  /** Spoken value, e.g. "608 px". */
  readonly valueText?: string;
}

/** Label · range slider · numeric field · unit, in one row (as in the reference editors). */
export function SliderField({ label, value, min, max, inputMax, step = 1, unit, onChange, disabled, valueText }: SliderFieldProps) {
  const id = useId();
  const sliderValue = Math.min(max, Math.max(min, value));
  return (
    <div className="slider-field">
      <label className="field-label" htmlFor={`${id}-range`}>
        {label}
      </label>
      <input
        id={`${id}-range`}
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={sliderValue}
        style={{ '--fill': `${max > min ? ((sliderValue - min) / (max - min)) * 100 : 0}%` } as CSSProperties}
        disabled={disabled}
        aria-valuetext={valueText ?? (unit ? `${value} ${unit}` : String(value))}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="slider-value">
        <NumberInput value={value} min={min} max={inputMax ?? max} step={step} onCommit={onChange} ariaLabel={label} disabled={disabled} />
        {unit ? (
          <span className="unit" aria-hidden="true">
            {unit}
          </span>
        ) : null}
      </span>
    </div>
  );
}
