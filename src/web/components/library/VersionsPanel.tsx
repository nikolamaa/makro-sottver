/**
 * Version history of a macro: list (vN, date, change source, note) + word diff of the selected version
 * against the current content, and "Revert to vN" (creates a new version with the old content).
 */
import { memo, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { INTENT_LABELS, type Category, type Macro, type MacroContent, type MacroVersion } from '../../../shared/types';
import { api } from '../../api';
import { Badge, Button, EmptyState, Spinner, toast } from '../../ui';
import { visibleWhitespace, wordDiff } from './diffing';
import { CHANGE_SOURCE_META, errorMessage, formatDateTime, relativeTime } from './model';

export function VersionsPanel({
  macro,
  categories,
  readOnly,
  reverting,
  onRevert,
}: {
  macro: Macro;
  categories: Category[];
  readOnly: boolean;
  reverting: boolean;
  onRevert: (version: number) => void;
}) {
  const [versions, setVersions] = useState<MacroVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    api('GET /api/macros/:id/versions', { params: { id: macro.id }, signal: ctrl.signal })
      .then((list) => {
        const sorted = [...list].sort((a, b) => b.version - a.version);
        setVersions(sorted);
        setSelected((prev) =>
          prev !== null && sorted.some((v) => v.version === prev && v.version !== macro.version)
            ? prev
            : (sorted.find((v) => v.version !== macro.version)?.version ?? sorted[0]?.version ?? null),
        );
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const msg = errorMessage(err);
        setError(msg);
        toast(msg, 'danger');
      });
    return () => ctrl.abort();
  }, [macro.id, macro.version, reloadKey]);

  const current = useMemo<MacroContent>(
    () => ({
      title: macro.title,
      body: macro.body,
      categoryId: macro.categoryId,
      tags: macro.tags,
      intents: macro.intents,
      triggers: macro.triggers,
      notes: macro.notes,
      shortcut: macro.shortcut,
    }),
    [macro],
  );

  const selectedVersion = versions?.find((v) => v.version === selected) ?? null;
  const index = versions && selectedVersion ? versions.indexOf(selectedVersion) : -1;

  const onListKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (!versions?.length) return;
    let next = index;
    if (e.key === 'ArrowDown') next = Math.min(versions.length - 1, index + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = versions.length - 1;
    else return;
    e.preventDefault();
    const v = versions[next];
    if (v) {
      setSelected(v.version);
      document.getElementById(`lib-ver-${v.version}`)?.scrollIntoView({ block: 'nearest' });
    }
  };

  if (error && !versions) {
    return (
      <EmptyState title="Could not load versions">
        <p className="lib-empty-text">{error}</p>
        <Button size="sm" onClick={() => setReloadKey((k) => k + 1)}>
          Try again
        </Button>
      </EmptyState>
    );
  }
  if (!versions) {
    return (
      <div className="lib-loading">
        <Spinner /> Loading versions…
      </div>
    );
  }
  if (!versions.length) return <EmptyState title="No versions yet" />;

  const isCurrent = selectedVersion?.version === macro.version;

  return (
    <div className="lib-versions">
      <ol
        className="lib-version-list"
        role="listbox"
        aria-label="Versions"
        tabIndex={0}
        aria-activedescendant={selectedVersion ? `lib-ver-${selectedVersion.version}` : undefined}
        onKeyDown={onListKeyDown}
      >
        {versions.map((v) => {
          const meta = CHANGE_SOURCE_META[v.changeSource];
          return (
            <li
              key={v.version}
              id={`lib-ver-${v.version}`}
              role="option"
              aria-selected={v.version === selected}
              className={`lib-version${v.version === selected ? ' is-selected' : ''}`}
              onClick={() => setSelected(v.version)}
            >
              <div className="lib-version-top">
                <strong>v{v.version}</strong>
                <Badge tone={meta.tone}>{meta.label}</Badge>
                {v.version === macro.version ? <Badge tone="accent">Current</Badge> : null}
              </div>
              <div className="small muted" title={formatDateTime(v.createdAt)}>
                {formatDateTime(v.createdAt)} · {relativeTime(v.createdAt)}
              </div>
              {v.changeNote ? <div className="small lib-version-note">{v.changeNote}</div> : null}
            </li>
          );
        })}
      </ol>

      <div className="lib-version-detail" aria-live="polite">
        {selectedVersion ? (
          <>
            <div className="lib-version-detail-head">
              <div>
                <h3>
                  {isCurrent ? `v${selectedVersion.version} (current)` : `Changes from v${selectedVersion.version} to current (v${macro.version})`}
                </h3>
                {isCurrent ? null : (
                  <div className="lib-diff-legend small muted">
                    <del className="lib-diff-del">only in v{selectedVersion.version}</del>
                    <ins className="lib-diff-add">only in current</ins>
                  </div>
                )}
              </div>
              <span className="spacer" />
              {isCurrent ? null : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={readOnly || reverting}
                  onClick={() => onRevert(selectedVersion.version)}
                  title={readOnly ? 'Restore the macro to revert it' : 'Creates a new version with this content'}
                >
                  {reverting ? <Spinner label="Reverting" /> : null}
                  Revert to v{selectedVersion.version}
                </Button>
              )}
            </div>
            <VersionDiff from={selectedVersion.content} to={current} categories={categories} same={isCurrent} />
          </>
        ) : (
          <EmptyState title="Select a version" />
        )}
      </div>
    </div>
  );
}

const isBlank = (s: string) => !/\S/.test(s);

const DiffText = memo(function DiffText({ from, to, multiline }: { from: string; to: string; multiline?: boolean }) {
  const { parts, mode } = useMemo(() => wordDiff(from, to), [from, to]);
  return (
    <>
      <div className={`lib-diff${multiline ? ' is-multiline' : ''}`}>
        {parts.map((p, i) => {
          // Whitespace-only changes would be invisible: show them as ·, → and ↵.
          const ws = mode === 'whitespace' && (p.added || p.removed) && isBlank(p.value);
          return p.added ? (
            <ins key={i} className={`lib-diff-add${ws ? ' is-space' : ''}`} title={ws ? 'Added spacing / line break' : undefined}>
              {ws ? visibleWhitespace(p.value, true) : p.value}
            </ins>
          ) : p.removed ? (
            <del key={i} className={`lib-diff-del${ws ? ' is-space' : ''}`} title={ws ? 'Removed spacing / line break' : undefined}>
              {ws ? visibleWhitespace(p.value) : p.value}
            </del>
          ) : (
            <span key={i}>{p.value}</span>
          );
        })}
      </div>
      {mode === 'whitespace' ? <p className="small muted lib-diff-note">Only spacing or line breaks changed.</p> : null}
      {mode === 'whole' ? (
        <p className="small muted lib-diff-note">Too many changes to compare word by word: the old text is shown struck through, then the current text.</p>
      ) : null}
    </>
  );
});

function VersionDiff({ from, to, categories, same }: { from: MacroContent; to: MacroContent; categories: Category[]; same: boolean }) {
  const catName = (id: string | null) => (id ? (categories.find((c) => c.id === id)?.name ?? '(deleted category)') : 'No category');
  const others: { label: string; from: string; to: string; multiline?: boolean }[] = [
    { label: 'Category', from: catName(from.categoryId), to: catName(to.categoryId) },
    { label: 'Shortcut', from: from.shortcut, to: to.shortcut },
    { label: 'Tags', from: from.tags.join(', '), to: to.tags.join(', ') },
    { label: 'Intents', from: from.intents.map((i) => INTENT_LABELS[i] ?? i).join(', '), to: to.intents.map((i) => INTENT_LABELS[i] ?? i).join(', ') },
    { label: 'Example messages', from: from.triggers.join('\n'), to: to.triggers.join('\n'), multiline: true },
    { label: 'Internal notes', from: from.notes, to: to.notes, multiline: true },
  ];
  const changed = others.filter((o) => o.from !== o.to);

  if (same) {
    return (
      <div className="lib-version-content">
        <section>
          <h4 className="field-label">Title</h4>
          <div className="lib-diff">{from.title}</div>
        </section>
        <section>
          <h4 className="field-label">Reply text</h4>
          <div className="lib-diff is-multiline">{from.body}</div>
        </section>
      </div>
    );
  }

  return (
    <div className="lib-version-content">
      <section>
        <h4 className="field-label">Title{from.title === to.title ? <span className="muted"> · unchanged</span> : null}</h4>
        <DiffText from={from.title} to={to.title} />
      </section>
      <section>
        <h4 className="field-label">Reply text{from.body === to.body ? <span className="muted"> · unchanged</span> : null}</h4>
        <DiffText from={from.body} to={to.body} multiline />
      </section>
      {changed.length ? (
        changed.map((o) => (
          <section key={o.label}>
            <h4 className="field-label">{o.label}</h4>
            <DiffText from={o.from || '—'} to={o.to || '—'} multiline={o.multiline} />
          </section>
        ))
      ) : (
        <p className="muted small">No other fields changed.</p>
      )}
    </div>
  );
}
