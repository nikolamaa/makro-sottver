/**
 * "Insert variable" popover: filterable list of STANDARD_VARIABLES plus custom names.
 * Typing "name|fallback" inserts {{name|fallback}}. Keyboard: ↑/↓ move, Enter inserts, Esc closes.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { STANDARD_VARIABLES } from '../../../shared/types';
import { Kbd } from '../../ui';
import { SAMPLE_VALUES } from './model';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Option {
  name: string;
  custom: boolean;
}

export function VariableMenu({
  open,
  onOpenChange,
  onInsert,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean, restoreFocus?: boolean) => void;
  onInsert: (token: string) => void;
  disabled?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = 'lib-varmenu-list';

  const { name: typedName, fallback } = useMemo(() => {
    const [n = '', ...rest] = filter.split('|');
    return { name: n.trim().toLowerCase(), fallback: rest.length ? rest.join('|').replace(/[{}]/g, '').trim() : null };
  }, [filter]);

  const options = useMemo<Option[]>(() => {
    const std: Option[] = STANDARD_VARIABLES.filter((v) => !typedName || v.includes(typedName)).map((v) => ({ name: v, custom: false }));
    const isStandard = (STANDARD_VARIABLES as readonly string[]).includes(typedName);
    if (typedName && NAME_RE.test(typedName) && !isStandard) std.push({ name: typedName, custom: true });
    return std;
  }, [typedName]);

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setActive(0);
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false, false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, options.length - 1)));
  }, [options.length]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const pick = (opt: Option | undefined) => {
    if (!opt) return;
    onInsert(fallback !== null && fallback !== '' ? `{{${opt.name}|${fallback}}}` : `{{${opt.name}}}`);
    onOpenChange(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (options.length ? (a + 1) % options.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (options.length ? (a - 1 + options.length) % options.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onOpenChange(false);
    } else if (e.key === 'Tab') {
      onOpenChange(false, false);
    }
  };

  return (
    <div className="lib-varmenu-wrap" ref={rootRef}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        Insert variable <Kbd combo="alt+i" />
      </button>
      {open ? (
        <div className="lib-varmenu" role="dialog" aria-label="Insert variable">
          <input
            autoFocus
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Filter, or type a custom name"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
            aria-label="Variable name"
            spellCheck={false}
            autoComplete="off"
          />
          <ul id={listId} role="listbox" className="lib-varmenu-list" aria-label="Variables">
            {options.map((o, i) => (
              <li
                key={`${o.name}-${o.custom ? 'c' : 's'}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'is-active' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                <code>{`{{${o.name}${fallback ? `|${fallback}` : ''}}}`}</code>
                <span className="muted small">{o.custom ? 'custom variable' : SAMPLE_VALUES[o.name]}</span>
              </li>
            ))}
            {options.length === 0 ? <li className="muted small lib-varmenu-empty">Use letters, digits and _ only.</li> : null}
          </ul>
          <div className="lib-varmenu-hint small muted">
            Tip: <code>name|fallback</code> inserts text used when the value is unknown, e.g. <code>{'{{user|there}}'}</code>.
          </div>
        </div>
      ) : null}
    </div>
  );
}
