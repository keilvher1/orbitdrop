import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface NumberInputProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  /** Called with a clamped integer when the user commits (Enter, blur, arrow keys). */
  readonly onCommit: (value: number) => void;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly describedBy?: string;
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Integer text field. Typing is free-form; the value is parsed, clamped and
 * committed on Enter/blur. ArrowUp/ArrowDown step by `step` (×10 with Shift).
 * Escape restores the last committed value.
 */
export function NumberInput({ value, min, max, step = 1, onCommit, ariaLabel, id, className, disabled, describedBy }: NumberInputProps) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number.parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const next = clampInt(parsed, min, max);
    setText(String(next));
    if (next !== value) onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(text);
    } else if (event.key === 'Escape') {
      if (text !== String(value)) {
        event.preventDefault();
        event.stopPropagation();
        setText(String(value));
      }
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
      const base = Number.parseFloat(text);
      const next = clampInt((Number.isFinite(base) ? base : value) + delta, min, max);
      setText(String(next));
      if (next !== value) onCommit(next);
    }
  };

  return (
    <input
      id={id}
      className={`text-input num-input ${className ?? ''}`}
      type="text"
      inputMode="numeric"
      role="spinbutton"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-describedby={describedBy}
      value={text}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit(text);
      }}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}
