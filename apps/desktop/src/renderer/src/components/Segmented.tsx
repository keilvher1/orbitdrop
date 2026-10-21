import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedOption<V extends string> {
  readonly value: V;
  readonly label: ReactNode;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
}

export interface SegmentedProps<V extends string> {
  readonly label: string;
  readonly options: readonly SegmentedOption<V>[];
  readonly value: V;
  readonly onChange: (value: V) => void;
  readonly size?: 'normal' | 'large';
  readonly id?: string;
  readonly disabled?: boolean;
}

/**
 * Segmented control implemented as an ARIA radio group: one tab stop (the
 * checked option), arrow keys move the selection, Home/End jump to the ends,
 * disabled options are skipped.
 */
export function Segmented<V extends string>({ label, options, value, onChange, size = 'normal', id, disabled = false }: SegmentedProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const move = (from: number, step: number): number => {
    const n = options.length;
    for (let k = 1; k <= n; k += 1) {
      const index = (((from + step * k) % n) + n) % n;
      if (!options[index]?.disabled) return index;
    }
    return from;
  };

  const select = (index: number) => {
    const option = options[index];
    if (option === undefined || option.disabled || disabled) return;
    onChange(option.value);
    refs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = move(selectedIndex, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = move(selectedIndex, -1);
        break;
      case 'Home':
        next = move(-1, 1);
        break;
      case 'End':
        next = move(options.length, -1);
        break;
      default:
        return;
    }
    event.preventDefault();
    select(next);
  };

  return (
    <div className="seg" role="radiogroup" aria-label={label} id={id} data-size={size} onKeyDown={onKeyDown} aria-disabled={disabled || undefined}>
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            className="seg-option"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            tabIndex={checked ? 0 : -1}
            disabled={disabled || option.disabled}
            onClick={() => select(index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
