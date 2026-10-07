import { useId, type CSSProperties, type ReactNode } from "react";
import type { TextureLimit } from "../../shared/contracts.ts";
import { formatPixels } from "../lib/format.ts";
import { SIZE_CHOICES } from "../lib/options.ts";

/** Native radios styled as a segmented control: arrow keys and focus come for free. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string; disabled?: boolean }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="segmented" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label key={option.value} title={option.title}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="field field-switch" data-disabled={disabled || undefined}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function SizeSelect({
  label,
  value,
  sourceSize,
  onChange,
  disabled,
}: {
  label: string;
  value: TextureLimit;
  sourceSize: number | null;
  onChange(value: TextureLimit): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="field field-inline">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value) as TextureLimit)}
      >
        {SIZE_CHOICES.map((size) => {
          let text = size === 0 ? "Original" : formatPixels(size);
          if (size === 0 && sourceSize) text = `Original (${formatPixels(sourceSize)})`;
          else if (size !== 0 && sourceSize && size >= sourceSize)
            text = `${text}, same as original`;
          return (
            <option key={size} value={size}>
              {text}
            </option>
          );
        })}
      </select>
    </div>
  );
}

export function RangeField({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="field field-range" data-disabled={disabled || undefined}>
      <div className="field-row">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <output htmlFor={id} className="field-value">
          {display}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ "--fill": `${fill}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
