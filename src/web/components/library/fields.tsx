/** Small editor field widgets: category picker (with inline create), tags (comma separated -> chips), intents. */
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { INTENT_LABELS, type Category, type Id, type Intent } from '../../../shared/types';
import { api } from '../../api';
import { actions } from '../../store';
import { Button, Spinner, toast } from '../../ui';
import { ALL_INTENTS, LIMITS, errorMessage, parseTags } from './model';

const CATEGORY_COLORS = ['#4f7cff', '#19a974', '#e8a33d', '#d64550', '#8b5cf6', '#0ea5e9', '#f97316', '#14b8a6', '#ec4899', '#64748b'];
const NEW_CATEGORY = '__new__';

/** Label + control + hint/error wrapper with explicit ids (works with any control, unlike a wrapping <label>). */
export function FieldShell({
  id,
  label,
  hint,
  error,
  warning,
  aside,
  className = '',
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  warning?: string | null;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`lib-field ${className}`}>
      <div className="lib-field-top">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        {aside ? <span className="lib-field-aside">{aside}</span> : null}
      </div>
      {children}
      {error ? (
        <span className="lib-field-msg lib-field-error" id={`${id}-msg`} role="alert">
          {error}
        </span>
      ) : warning ? (
        <span className="lib-field-msg lib-field-warning" id={`${id}-msg`}>
          {warning}
        </span>
      ) : hint ? (
        <span className="field-hint" id={`${id}-msg`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function CategoryPicker({
  value,
  categories,
  onChange,
  disabled,
}: {
  value: Id | null;
  categories: Category[];
  onChange: (id: Id | null) => void;
  disabled?: boolean;
}) {
  const id = 'lib-field-category';
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sorted = useMemo(
    () => [...categories].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
    [categories],
  );
  const current = value ? categories.find((c) => c.id === value) : undefined;

  const cancel = () => {
    setCreating(false);
    setName('');
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  };

  const create = async () => {
    const n = name.trim();
    if (!n || busy) return;
    const existing = categories.find((c) => c.name.trim().toLowerCase() === n.toLowerCase());
    if (existing) {
      onChange(existing.id);
      cancel();
      return;
    }
    setBusy(true);
    try {
      const maxSort = categories.reduce((m, c) => Math.max(m, c.sort), 0);
      const created = await api('POST /api/categories', {
        body: { name: n.slice(0, 80), color: CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length], sort: maxSort + 1 },
      });
      await actions.refreshCategories();
      onChange(created.id);
      toast(`Category "${created.name}" created`, 'success');
      cancel();
    } catch (err) {
      toast(errorMessage(err), 'danger');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void create();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  return (
    <FieldShell id={creating ? `${id}-new` : id} label="Category">
      {creating ? (
        <div className="lib-newcat">
          <input
            id={`${id}-new`}
            ref={inputRef}
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="New category name"
            disabled={busy}
          />
          <Button size="sm" variant="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? <Spinner label="Creating category" /> : null}
            Create
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="lib-select-dot">
          <span className="lib-dot" style={{ background: current?.color ?? 'transparent' }} data-empty={current ? undefined : ''} aria-hidden />
          <select
            id={id}
            value={value ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value;
              if (v === NEW_CATEGORY) setCreating(true);
              else onChange(v || null);
            }}
          >
            <option value="">No category</option>
            {sorted.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {value && !current ? <option value={value}>(deleted category)</option> : null}
            <option value={NEW_CATEGORY}>New category…</option>
          </select>
        </div>
      )}
    </FieldShell>
  );
}

export function TagsField({
  value,
  onChange,
  disabled,
  error,
}: {
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const id = 'lib-field-tags';
  const tags = useMemo(() => parseTags(value), [value]);
  const remove = (tag: string) => onChange(tags.filter((t) => t !== tag).join(', '));
  return (
    <FieldShell
      id={id}
      label="Tags"
      error={error}
      aside={<span className="muted small">{tags.length ? `${tags.length}/${LIMITS.tags}` : 'comma separated'}</span>}
    >
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="crypto, withdrawal, btc"
        readOnly={disabled}
        autoComplete="off"
        aria-describedby={error ? `${id}-msg` : undefined}
      />
      <div className="lib-chips" aria-label="Tags">
        {tags.map((t) => (
          <span key={t.toLowerCase()} className="lib-tag">
            {t}
            {disabled ? null : (
              // Not a tab stop: keyboard users edit the comma separated text directly.
              <button type="button" tabIndex={-1} className="lib-tag-x" aria-label={`Remove tag ${t}`} onClick={() => remove(t)}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
    </FieldShell>
  );
}

/** Toggle chips for intents. Roving focus: one tab stop, arrow keys move, Space/Enter toggles. */
export function IntentPicker({
  value,
  onChange,
  disabled,
  error,
}: {
  value: Intent[];
  onChange: (intents: Intent[]) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const labelId = useId();
  const [focusIdx, setFocusIdx] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = useMemo(() => new Set(value), [value]);

  const toggle = (intent: Intent) => {
    if (selected.has(intent)) onChange(value.filter((i) => i !== intent));
    else onChange([...value, intent]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ALL_INTENTS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ALL_INTENTS.length) % ALL_INTENTS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ALL_INTENTS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setFocusIdx(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="lib-field">
      <div className="lib-field-top">
        <span className="field-label" id={labelId}>
          Intents
        </span>
        <span className="lib-field-aside muted small">
          {value.length}/{LIMITS.intents} · what customer requests this macro answers
        </span>
      </div>
      <div className="lib-intents" role="group" aria-labelledby={labelId} id="lib-field-intents">
        {ALL_INTENTS.map((intent, i) => (
          <button
            key={intent}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            className="lib-chip"
            aria-pressed={selected.has(intent)}
            tabIndex={i === focusIdx ? 0 : -1}
            disabled={disabled}
            onFocus={() => setFocusIdx(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={() => toggle(intent)}
          >
            {INTENT_LABELS[intent]}
          </button>
        ))}
      </div>
      {error ? (
        <span className="lib-field-msg lib-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
