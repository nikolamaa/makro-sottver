/**
 * Facts table: atomic claims of the macro (key, statement, value, source, evidence, status).
 * Facts are edited in the draft and saved together with the macro (MacroInput.facts, existing ids kept).
 */
import { Fragment, memo, useCallback, useState, type KeyboardEvent } from 'react';
import type { FactStatus } from '../../../shared/types';
import { matchCombo } from '../../hotkeys';
import { Badge, Button, Kbd } from '../../ui';
import { EditIcon, ExternalIcon, PlusIcon, TrashIcon } from './Icons';
import {
  FACT_STATUSES,
  FACT_STATUS_META,
  LIMITS,
  blankFact,
  formatDateTime,
  hostOf,
  isHttpUrl,
  patchFact,
  validateFact,
  type FactDraft,
} from './model';

type FactPatch = Parameters<typeof patchFact>[1];

interface EditingState {
  uid: string;
  /** Fact before editing started; null when the fact was just added (Cancel removes it). */
  snapshot: FactDraft | null;
}

const COLS = 7;

export function FactsEditor({
  facts,
  onChange,
  readOnly,
  showErrors,
}: {
  facts: FactDraft[];
  onChange: (updater: (facts: FactDraft[]) => FactDraft[]) => void;
  readOnly?: boolean;
  showErrors?: boolean;
}) {
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const add = () => {
    const f = blankFact();
    onChange((list) => [...list, f]);
    setEditing({ uid: f.uid, snapshot: null });
  };

  const startEdit = useCallback((f: FactDraft) => setEditing({ uid: f.uid, snapshot: f }), []);

  const remove = useCallback(
    (uid: string) => {
      onChange((list) => list.filter((f) => f.uid !== uid));
      setEditing((e) => (e?.uid === uid ? null : e));
    },
    [onChange],
  );

  const patch = useCallback(
    (uid: string, p: FactPatch) => onChange((list) => list.map((f) => (f.uid === uid ? patchFact(f, p) : f))),
    [onChange],
  );

  const done = () => {
    if (!editing) return;
    const uid = editing.uid;
    const f = facts.find((x) => x.uid === uid);
    // An untouched new fact is simply dropped.
    if (f && !f.key.trim() && !f.statement.trim() && !f.value.trim() && !f.sourceUrl.trim() && !f.evidenceQuote.trim()) remove(uid);
    setEditing(null);
    requestAnimationFrame(() => document.getElementById(`lib-fact-edit-${uid}`)?.focus());
  };

  const cancel = () => {
    if (!editing) return;
    const { uid, snapshot } = editing;
    if (snapshot) onChange((list) => list.map((f) => (f.uid === uid ? snapshot : f)));
    else onChange((list) => list.filter((f) => f.uid !== uid));
    setEditing(null);
    requestAnimationFrame(() => document.getElementById(`lib-fact-edit-${uid}`)?.focus());
  };

  const toggleQuote = useCallback((uid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const factErrors = showErrors ? facts.flatMap((f, i) => validateFact(f, i)) : [];

  const counts = facts.reduce<Partial<Record<FactStatus, number>>>((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <section className="lib-facts" aria-labelledby="lib-facts-title">
      <div className="lib-section-head">
        <h3 id="lib-facts-title">
          Facts <span className="muted">({facts.length})</span>
        </h3>
        <span className="row-wrap">
          {FACT_STATUSES.filter((s) => counts[s]).map((s) => (
            <Badge key={s} tone={FACT_STATUS_META[s].tone}>
              {counts[s]} {FACT_STATUS_META[s].label.toLowerCase()}
            </Badge>
          ))}
        </span>
        <span className="spacer" />
        {readOnly ? null : (
          <Button size="sm" onClick={add} disabled={facts.length >= LIMITS.facts}>
            <PlusIcon /> Add fact
          </Button>
        )}
      </div>
      <p className="muted small lib-section-hint">
        Atomic claims this reply makes (limits, fees, times, rules), each with a source link and the exact quote that proves it.
        MacroPilot re-checks them against the source and warns when one becomes outdated.
      </p>

      {factErrors.length ? (
        <ul className="lib-fact-errors" role="alert">
          {factErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      {facts.length === 0 ? (
        <div className="lib-facts-empty muted small">No facts yet.</div>
      ) : (
        <div className="lib-table-wrap">
          <table className="lib-table">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Statement</th>
                <th scope="col">Value</th>
                <th scope="col">Source</th>
                <th scope="col">Evidence</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="lib-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {facts.map((f, i) =>
                editing?.uid === f.uid && !readOnly ? (
                  <FactForm key={f.uid} fact={f} index={i} onPatch={patch} onDone={done} onCancel={cancel} isNew={!editing.snapshot} />
                ) : (
                  <FactRow
                    key={f.uid}
                    fact={f}
                    index={i}
                    readOnly={readOnly}
                    expanded={expanded.has(f.uid)}
                    invalid={!!showErrors && validateFact(f, i).length > 0}
                    onEdit={startEdit}
                    onRemove={remove}
                    onToggleQuote={toggleQuote}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const FactRow = memo(function FactRow({
  fact: f,
  index,
  readOnly,
  expanded,
  invalid,
  onEdit,
  onRemove,
  onToggleQuote,
}: {
  fact: FactDraft;
  index: number;
  readOnly?: boolean;
  expanded: boolean;
  invalid: boolean;
  onEdit: (f: FactDraft) => void;
  onRemove: (uid: string) => void;
  onToggleQuote: (uid: string) => void;
}) {
  const meta = FACT_STATUS_META[f.status];
  const url = f.sourceUrl.trim();
  const quote = f.evidenceQuote.trim();
  const checked = f.original?.lastCheckedAt;
  return (
    <Fragment>
      <tr className={invalid ? 'is-invalid' : undefined}>
        <td>
          <code className="lib-fact-key">{f.key.trim() || '—'}</code>
        </td>
        <td className="lib-fact-statement">{f.statement.trim() || <span className="error">Statement missing</span>}</td>
        <td className="lib-fact-value">{f.value.trim() || <span className="muted">—</span>}</td>
        <td className="lib-fact-source">
          {url ? (
            isHttpUrl(url) ? (
              <a href={url} target="_blank" rel="noreferrer noopener" title={url}>
                {hostOf(url)}
                <ExternalIcon />
              </a>
            ) : (
              <span className="error" title={url}>
                Invalid URL
              </span>
            )
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>
          {quote ? (
            <button
              type="button"
              className="lib-linkbtn"
              aria-expanded={expanded}
              aria-controls={`lib-fact-quote-${f.uid}`}
              onClick={() => onToggleQuote(f.uid)}
            >
              {expanded ? 'Hide quote' : 'Show quote'}
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>
          <span
            title={
              f.statusAuto
                ? 'Reset to Unchecked because the fact changed. It is re-checked after saving.'
                : checked
                  ? `Last checked ${formatDateTime(checked)}`
                  : 'Not checked yet'
            }
          >
            <Badge tone={meta.tone}>
              {meta.label}
              {f.statusAuto ? '*' : ''}
            </Badge>
          </span>
        </td>
        <td className="lib-fact-actions">
          {readOnly ? null : (
            <>
              <button
                type="button"
                className="icon-btn lib-icon-btn"
                id={`lib-fact-edit-${f.uid}`}
                aria-label={`Edit fact ${index + 1}`}
                title="Edit"
                onClick={() => onEdit(f)}
              >
                <EditIcon />
              </button>
              <button
                type="button"
                className="icon-btn lib-icon-btn lib-icon-danger"
                aria-label={`Remove fact ${index + 1}`}
                title="Remove"
                onClick={() => onRemove(f.uid)}
              >
                <TrashIcon />
              </button>
            </>
          )}
        </td>
      </tr>
      {quote && expanded ? (
        <tr className="lib-fact-quote-row">
          <td colSpan={COLS} id={`lib-fact-quote-${f.uid}`}>
            <blockquote className="lib-quote">“{quote}”</blockquote>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
});

function FactForm({
  fact: f,
  index,
  isNew,
  onPatch,
  onDone,
  onCancel,
}: {
  fact: FactDraft;
  index: number;
  isNew: boolean;
  onPatch: (uid: string, p: FactPatch) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const base = `lib-fact-${f.uid}`;
  // "Statement is required" is only reported on save / in the table, not while the agent is still typing.
  const errors = validateFact(f, index).filter((e) => !/statement is required/.test(e));
  const urlInvalid = !!f.sourceUrl.trim() && !isHttpUrl(f.sourceUrl.trim());
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (matchCombo('mod+enter', e.nativeEvent)) {
      e.preventDefault();
      onDone();
    }
  };
  return (
    <tr className="lib-fact-editing">
      <td colSpan={COLS}>
        <div className="lib-fact-form" onKeyDown={onKeyDown} role="group" aria-label={isNew ? 'New fact' : `Edit fact ${index + 1}`}>
          <div className="lib-field lib-span-2">
            <label className="field-label" htmlFor={`${base}-statement`}>
              Statement <span aria-hidden>*</span>
            </label>
            <textarea
              id={`${base}-statement`}
              rows={2}
              autoFocus
              value={f.statement}
              maxLength={LIMITS.factStatement}
              onChange={(e) => onPatch(f.uid, { statement: e.target.value })}
              placeholder="Minimum BTC withdrawal is 0.0002 BTC."
              aria-required="true"
            />
          </div>
          <div className="lib-field">
            <label className="field-label" htmlFor={`${base}-key`}>
              Key
            </label>
            <input
              id={`${base}-key`}
              className="mono"
              value={f.key}
              maxLength={LIMITS.factKey}
              onChange={(e) => onPatch(f.uid, { key: e.target.value })}
              placeholder="crypto.withdrawal.min_btc"
              spellCheck={false}
            />
          </div>
          <div className="lib-field">
            <label className="field-label" htmlFor={`${base}-value`}>
              Value
            </label>
            <input
              id={`${base}-value`}
              value={f.value}
              maxLength={LIMITS.factValue}
              onChange={(e) => onPatch(f.uid, { value: e.target.value })}
              placeholder="0.0002 BTC"
            />
          </div>
          <div className="lib-field lib-span-2">
            <label className="field-label" htmlFor={`${base}-url`}>
              Source URL
            </label>
            <input
              id={`${base}-url`}
              type="url"
              value={f.sourceUrl}
              maxLength={LIMITS.factUrl}
              onChange={(e) => onPatch(f.uid, { sourceUrl: e.target.value })}
              placeholder="https://help.stake.com/en/articles/…"
              aria-invalid={urlInvalid || undefined}
              spellCheck={false}
            />
          </div>
          <div className="lib-field lib-span-2">
            <label className="field-label" htmlFor={`${base}-quote`}>
              Evidence quote
            </label>
            <textarea
              id={`${base}-quote`}
              rows={2}
              value={f.evidenceQuote}
              maxLength={LIMITS.factQuote}
              onChange={(e) => onPatch(f.uid, { evidenceQuote: e.target.value })}
              placeholder="The exact sentence from the source that proves the statement."
            />
          </div>
          <div className="lib-field">
            <label className="field-label" htmlFor={`${base}-status`}>
              Status
            </label>
            <select id={`${base}-status`} value={f.status} onChange={(e) => onPatch(f.uid, { status: e.target.value as FactStatus })}>
              {FACT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {FACT_STATUS_META[s].label}
                </option>
              ))}
            </select>
            {f.statusAuto ? <span className="field-hint">Reset to Unchecked because the fact changed.</span> : null}
          </div>
          <div className="lib-fact-form-actions">
            {errors.length ? (
              <span className="lib-field-msg lib-field-error" role="alert">
                {errors[0]}
              </span>
            ) : null}
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel <Kbd combo="escape" />
            </Button>
            <Button size="sm" variant="primary" onClick={onDone} hotkey="mod+enter">
              Done
            </Button>
          </div>
        </div>
      </td>
    </tr>
  );
}
