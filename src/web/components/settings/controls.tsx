/**
 * Form controls for the Settings page. All are keyboard accessible and built on native inputs
 * (radios/checkboxes) so arrow keys, Space and screen readers work without extra code.
 */
import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Badge } from '../../ui';
import './controls.css';

// ---------------------------------------------------------------------------
// Section card
// ---------------------------------------------------------------------------

export function SectionCard({
  id,
  title,
  description,
  badge,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `${id}-title`;
  return (
    <section id={id} className="panel st-card" aria-labelledby={headingId}>
      <header className="st-card-header">
        <h2 id={headingId} tabIndex={-1}>
          {title}
        </h2>
        {badge}
      </header>
      {description ? <p className="st-card-desc muted">{description}</p> : null}
      <div className="st-card-body">{children}</div>
    </section>
  );
}

/** A labelled row: label + hint on the left, control on the right (stacks on narrow screens). */
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
  wide,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`st-row ${wide ? 'st-row-wide' : ''}`}>
      <div className="st-row-text">
        {htmlFor ? (
          <label className="st-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="st-row-label">{label}</span>
        )}
        {hint ? <span className="st-row-hint">{hint}</span> : null}
      </div>
      <div className="st-row-control">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle (switch)
// ---------------------------------------------------------------------------

export const Toggle = memo(function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={`st-row st-toggle-row ${disabled ? 'is-disabled' : ''}`}>
      <div className="st-row-text">
        <label className="st-row-label" htmlFor={id}>
          {label}
        </label>
        {hint ? (
          <span className="st-row-hint" id={hintId}>
            {hint}
          </span>
        ) : null}
      </div>
      <div className="st-row-control">
        <span className="st-switch">
          <input
            id={id}
            type="checkbox"
            role="switch"
            checked={checked}
            disabled={disabled}
            aria-describedby={hint ? hintId : undefined}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="st-switch-track" aria-hidden>
            <span className="st-switch-thumb" />
          </span>
        </span>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Radio cards
// ---------------------------------------------------------------------------

export interface RadioCardOption<T extends string> {
  value: T;
  title: string;
  subtitle?: string;
  description?: ReactNode;
  badge?: ReactNode;
}

export function RadioCards<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: RadioCardOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="st-radio-cards" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <label key={o.value} className={`st-radio-card ${selected ? 'is-selected' : ''}`}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={selected}
              onChange={() => onChange(o.value)}
              className="st-radio-card-input"
            />
            <span className="st-radio-card-dot" aria-hidden />
            <span className="st-radio-card-text">
              <span className="st-radio-card-title">
                {o.title}
                {o.badge}
              </span>
              {o.subtitle ? <span className="st-radio-card-subtitle">{o.subtitle}</span> : null}
              {o.description ? <span className="st-radio-card-desc">{o.description}</span> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented control (small radio group)
// ---------------------------------------------------------------------------

export function Segmented<T extends string | number>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="st-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={String(o.value)} className={`st-segment ${o.value === value ? 'is-selected' : ''}`} title={o.title}>
          <input type="radio" name={name} checked={o.value === value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text / number inputs with a local draft
// ---------------------------------------------------------------------------

/**
 * Text input that keeps its own draft while focused, so a save round trip (which may normalize the value,
 * e.g. trim it or reject an empty required string) never overwrites what the user is typing.
 */
export function TextSetting({
  id,
  value,
  onCommit,
  placeholder,
  validate,
  required,
  mono,
  maxLength = 500,
  ariaDescribedBy,
}: {
  id: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  /** Return an error message to block saving. */
  validate?: (value: string) => string | null;
  required?: boolean;
  mono?: boolean;
  maxLength?: number;
  ariaDescribedBy?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const check = (v: string): string | null => {
    if (required && !v.trim()) return 'Required';
    return validate ? validate(v) : null;
  };

  const errorId = `${id}-error`;
  return (
    <div className="st-input-wrap">
      <input
        id={id}
        type="text"
        className={mono ? 'mono' : undefined}
        value={draft}
        placeholder={placeholder}
        maxLength={maxLength}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errorId : null, ariaDescribedBy ?? null].filter(Boolean).join(' ') || undefined}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          if (check(draft)) {
            setDraft(value);
            setError(null);
          }
        }}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          const err = check(v);
          setError(err);
          if (!err && v.trim() !== value) onCommit(v.trim());
        }}
      />
      {error ? (
        <span className="st-input-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function NumberSetting({
  id,
  value,
  onCommit,
  min,
  max,
  step = 1,
  integer,
  prefix,
  suffix,
  ariaDescribedBy,
}: {
  id: string;
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  prefix?: string;
  suffix?: string;
  ariaDescribedBy?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const parse = (raw: string): number | string => {
    if (raw.trim() === '') return 'Enter a number';
    const n = Number(raw);
    if (!Number.isFinite(n)) return 'Enter a number';
    if (integer && !Number.isInteger(n)) return 'Whole numbers only';
    if (n < min || n > max) return `Between ${min} and ${max}`;
    return n;
  };

  const errorId = `${id}-error`;
  return (
    <div className="st-input-wrap">
      <div className="st-number">
        {prefix ? <span className="st-affix">{prefix}</span> : null}
        <input
          id={id}
          type="number"
          inputMode={integer ? 'numeric' : 'decimal'}
          min={min}
          max={max}
          step={step}
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error ? errorId : null, ariaDescribedBy ?? null].filter(Boolean).join(' ') || undefined}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            setDraft(String(value));
            setError(null);
          }}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            const parsed = parse(raw);
            if (typeof parsed === 'string') {
              setError(parsed);
              return;
            }
            setError(null);
            if (parsed !== value) onCommit(parsed);
          }}
        />
        {suffix ? <span className="st-affix">{suffix}</span> : null}
      </div>
      {error ? (
        <span className="st-input-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function PhaseBadge({ children }: { children: ReactNode }) {
  return <Badge tone="accent">{children}</Badge>;
}

/** Thin progress bar (used for the monthly AI budget). */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const tone = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'ok';
  return (
    <div
      className={`st-meter st-meter-${tone}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
    >
      <span className="st-meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
