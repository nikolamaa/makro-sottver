/**
 * Right column of the Library: macro editor (content + facts) and version history.
 * All state lives in useLibraryController; this component only renders it.
 */
import { useCallback, useEffect, useMemo, type KeyboardEvent } from 'react';
import type { Macro } from '../../../shared/types';
import { Badge, Button, EmptyState, Kbd, Spinner } from '../../ui';
import { BodyEditor } from './BodyEditor';
import { FactsEditor } from './FactsEditor';
import { CategoryPicker, FieldShell, IntentPicker, TagsField } from './fields';
import { StarIcon } from './Icons';
import {
  LIMITS,
  VERIFICATION_META,
  formatDateTime,
  formatDay,
  parseTriggers,
  relativeTime,
  type DraftField,
  type FactDraft,
  type MacroDraft,
} from './model';
import type { EditorTab, LibraryController } from './useLibraryController';
import { VersionsPanel } from './VersionsPanel';

export function MacroEditor({ ctl }: { ctl: LibraryController }) {
  if (ctl.selection.mode === 'none') {
    return <EditorPlaceholder hasMacros={ctl.allMacros.length > 0} onNew={ctl.requestNew} />;
  }
  if (ctl.selection.mode === 'loading' || !ctl.draft) {
    return (
      <section className="lib-editor panel" aria-busy="true" aria-label="Macro editor">
        <div className="lib-loading">
          <Spinner /> Loading macro…
        </div>
      </section>
    );
  }
  return <EditorBody ctl={ctl} draft={ctl.draft} />;
}

function EditorPlaceholder({ hasMacros, onNew }: { hasMacros: boolean; onNew: () => void }) {
  return (
    <section className="lib-editor panel lib-editor-placeholder" aria-label="Macro editor">
      <EmptyState title={hasMacros ? 'Select a macro to edit' : 'Your library is empty'}>
        <p className="lib-empty-text">
          {hasMacros ? 'Pick a macro from the list, or create a new one.' : 'Create your first macro or import the ones you use in Intercom.'}
        </p>
        <ul className="lib-keys" aria-label="Keyboard shortcuts">
          <li>
            <Kbd combo="/" /> search
          </li>
          <li>
            <Kbd combo="arrowup" /> <Kbd combo="arrowdown" /> move
          </li>
          <li>
            <Kbd combo="enter" /> open
          </li>
          <li>
            <Kbd combo="alt+n" /> new macro
          </li>
          <li>
            <Kbd combo="mod+s" /> save
          </li>
        </ul>
        <Button variant="primary" onClick={onNew} hotkey="alt+n">
          New macro
        </Button>
      </EmptyState>
    </section>
  );
}

const TABS: { id: EditorTab; label: string }[] = [
  { id: 'edit', label: 'Content' },
  { id: 'versions', label: 'Versions' },
];

function EditorBody({ ctl, draft }: { ctl: LibraryController; draft: MacroDraft }) {
  const { macro, readOnly, showErrors, issues, dirty, updateDraft } = ctl;
  const isNew = ctl.selection.mode === 'new';
  const tab: EditorTab = isNew ? 'edit' : ctl.tab;

  const err = (field: DraftField): string | null => (showErrors ? (issues.find((i) => i.field === field)?.message ?? null) : null);

  const set = useCallback(
    <K extends keyof MacroDraft>(key: K, value: MacroDraft[K]) => updateDraft((d) => ({ ...d, [key]: value })),
    [updateDraft],
  );
  const setFacts = useCallback(
    (updater: (facts: FactDraft[]) => FactDraft[]) => updateDraft((d) => ({ ...d, facts: updater(d.facts) })),
    [updateDraft],
  );
  const setBody = useCallback((body: string) => set('body', body), [set]);
  const setTags = useCallback((tagsText: string) => set('tagsText', tagsText), [set]);

  useEffect(() => {
    if (isNew) document.getElementById('lib-field-title')?.focus();
  }, [isNew]);

  const selfId = macro?.id ?? null;
  const shortcutDup = useMemo(() => {
    const s = draft.shortcut.trim().toLowerCase();
    return s ? ctl.allMacros.find((m) => m.id !== selfId && m.shortcut.trim().toLowerCase() === s) : undefined;
  }, [draft.shortcut, ctl.allMacros, selfId]);
  const titleDup = useMemo(() => {
    const t = draft.title.trim().toLowerCase().replace(/\s+/g, ' ');
    return t ? ctl.allMacros.find((m) => m.id !== selfId && m.title.trim().toLowerCase().replace(/\s+/g, ' ') === t) : undefined;
  }, [draft.title, ctl.allMacros, selfId]);
  const triggerCount = useMemo(() => parseTriggers(draft.triggersText).length, [draft.triggersText]);

  const displayTitle = draft.title.trim() || (isNew ? 'New macro' : 'Untitled macro');

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    if (isNew) return;
    e.preventDefault();
    const idx = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS[TABS.length - 1] : TABS[(idx + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
    if (!next) return;
    ctl.setTab(next.id);
    document.getElementById(`lib-tab-${next.id}`)?.focus();
  };

  const onChangeNoteKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void ctl.save();
    }
  };

  return (
    <section className="lib-editor panel" aria-label={`Macro editor: ${displayTitle}`}>
      <header className="lib-editor-head">
        <div className="lib-editor-heading">
          <h2 className="lib-editor-title" title={displayTitle}>
            {displayTitle}
          </h2>
          <div className="lib-editor-meta">
            {isNew ? <Badge tone="accent">New</Badge> : null}
            {macro ? <Badge>v{macro.version}</Badge> : null}
            {macro ? (
              <span title={VERIFICATION_META[macro.verification].description}>
                <Badge tone={VERIFICATION_META[macro.verification].tone}>{VERIFICATION_META[macro.verification].label}</Badge>
              </span>
            ) : null}
            {macro?.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
            {macro ? <MacroStats macro={macro} /> : null}
          </div>
        </div>
        <div className="lib-editor-actions">
          {macro && !readOnly ? (
            <button
              type="button"
              className={`btn btn-ghost btn-md lib-fav${macro.isFavorite ? ' is-on' : ''}`}
              aria-pressed={macro.isFavorite}
              aria-label="Favorite"
              title={macro.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              disabled={ctl.busy === 'favorite'}
              onClick={() => void ctl.toggleFavorite()}
            >
              <StarIcon filled={macro.isFavorite} />
            </button>
          ) : null}
          {macro && !readOnly ? (
            <Button onClick={ctl.sendToAssist} title="Open the Assist page with this macro">
              Use in Assist
            </Button>
          ) : null}
          {macro && !readOnly ? (
            <Button variant="ghost" onClick={ctl.archive} disabled={ctl.busy === 'archive'} title="Hide from recommendations; can be restored">
              {ctl.busy === 'archive' ? <Spinner label="Archiving" /> : null}
              Archive
            </Button>
          ) : null}
          {macro && readOnly ? (
            <Button variant="primary" onClick={() => void ctl.restore()} disabled={ctl.busy === 'restore'}>
              {ctl.busy === 'restore' ? <Spinner label="Restoring" /> : null}
              Restore
            </Button>
          ) : null}
          {macro ? (
            <Button variant="danger" onClick={() => ctl.setDeleteOpen(true)} title="Delete permanently, including history">
              Delete…
            </Button>
          ) : null}
          {isNew ? (
            <Button variant="ghost" onClick={ctl.requestClose}>
              Discard
            </Button>
          ) : null}
        </div>
      </header>

      <div className="lib-tabs" role="tablist" aria-label="Macro sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`lib-tab-${t.id}`}
            className="lib-tab"
            aria-selected={tab === t.id}
            aria-controls={`lib-tabpanel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            disabled={t.id === 'versions' && !macro}
            onClick={() => ctl.setTab(t.id)}
            onKeyDown={onTabKeyDown}
          >
            {t.label}
            {t.id === 'versions' && macro ? <span className="lib-tab-count">{macro.version}</span> : null}
            {t.id === 'edit' && draft.facts.length ? <span className="lib-tab-count">{draft.facts.length} facts</span> : null}
          </button>
        ))}
      </div>

      {tab === 'versions' && macro ? (
        <div className="lib-editor-scroll" role="tabpanel" id="lib-tabpanel-versions" aria-labelledby="lib-tab-versions">
          {dirty ? (
            <div className="lib-banner lib-banner-info" role="status">
              The comparison uses the saved version. Your unsaved edits are kept in the Content tab.
            </div>
          ) : null}
          <VersionsPanel
            macro={macro}
            categories={ctl.categories}
            readOnly={readOnly}
            reverting={ctl.busy === 'revert'}
            onRevert={ctl.revert}
          />
        </div>
      ) : (
        <div className="lib-editor-scroll" role="tabpanel" id="lib-tabpanel-edit" aria-labelledby="lib-tab-edit">
          {macro?.archivedAt ? (
            <div className="lib-banner lib-banner-warning" role="status">
              <span>
                Archived on {formatDay(macro.archivedAt)}. It is hidden from recommendations and read-only. Restore it to edit or use it.
              </span>
              <Button size="sm" variant="primary" onClick={() => void ctl.restore()} disabled={ctl.busy === 'restore'}>
                Restore
              </Button>
            </div>
          ) : null}
          {ctl.stale && macro ? (
            <div className="lib-banner lib-banner-info" role="status">
              <span>
                This macro changed while you were editing (now v{macro.version}). Saving keeps your text and creates a new version.
              </span>
              <Button size="sm" onClick={ctl.reloadStale}>
                Load latest
              </Button>
            </div>
          ) : null}

          <div className="lib-form">
            <div className="lib-grid">
              <FieldShell
                id="lib-field-title"
                label="Title"
                className="lib-col-wide"
                error={err('title')}
                warning={titleDup ? `Another macro has the same title.` : null}
                aside={
                  <span className={`small ${draft.title.length > LIMITS.title ? 'error' : 'muted'}`}>
                    {draft.title.length}/{LIMITS.title}
                  </span>
                }
              >
                <input
                  id="lib-field-title"
                  value={draft.title}
                  onChange={(e) => set('title', e.target.value)}
                  placeholder="e.g. Crypto withdrawal pending – normal processing time"
                  readOnly={readOnly}
                  autoComplete="off"
                  aria-required="true"
                  aria-invalid={err('title') ? true : undefined}
                  aria-describedby={err('title') || titleDup ? 'lib-field-title-msg' : undefined}
                />
              </FieldShell>
              <FieldShell
                id="lib-field-shortcut"
                label="Shortcut"
                error={err('shortcut')}
                warning={shortcutDup ? `Also used by “${shortcutDup.title}”.` : null}
                hint="Find it fast in quick search"
              >
                <input
                  id="lib-field-shortcut"
                  className="mono"
                  value={draft.shortcut}
                  onChange={(e) => set('shortcut', e.target.value)}
                  placeholder="wd-pending"
                  readOnly={readOnly}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="lib-field-shortcut-msg"
                />
              </FieldShell>
              <CategoryPicker value={draft.categoryId} categories={ctl.categories} onChange={(id) => set('categoryId', id)} disabled={readOnly} />
              <div className="lib-col-wide">
                <TagsField value={draft.tagsText} onChange={setTags} disabled={readOnly} error={err('tags')} />
              </div>
            </div>

            <IntentPicker value={draft.intents} onChange={(intents) => set('intents', intents)} disabled={readOnly} error={err('intents')} />

            <BodyEditor value={draft.body} onChange={setBody} disabled={readOnly} error={err('body')} />

            <div className="lib-grid-2">
              <FieldShell
                id="lib-field-triggers"
                label="Example customer messages"
                hint="One per line. Real phrasings help MacroPilot recognise when this macro fits."
                error={err('triggers')}
                aside={
                  <span className="muted small">
                    {triggerCount}/{LIMITS.triggers}
                  </span>
                }
              >
                <textarea
                  id="lib-field-triggers"
                  rows={5}
                  value={draft.triggersText}
                  onChange={(e) => set('triggersText', e.target.value)}
                  readOnly={readOnly}
                  placeholder={'where is my withdrawal??\nmy btc withdrawal is still pending\nwithdrew 2 hours ago and nothing arrived'}
                />
              </FieldShell>
              <FieldShell id="lib-field-notes" label="Internal notes" hint="Only for you. Never inserted into replies." error={err('notes')}>
                <textarea
                  id="lib-field-notes"
                  rows={5}
                  value={draft.notes}
                  onChange={(e) => set('notes', e.target.value)}
                  readOnly={readOnly}
                  placeholder="When to use it, what to check first, escalation rules…"
                />
              </FieldShell>
            </div>

            <FactsEditor facts={draft.facts} onChange={setFacts} readOnly={readOnly} showErrors={showErrors} />
          </div>
        </div>
      )}

      <footer className="lib-editor-foot">
        <div className="lib-foot-status" aria-live="polite">
          {ctl.saving ? (
            <span className="muted">Saving…</span>
          ) : dirty ? (
            <span className="lib-dirty">Unsaved changes</span>
          ) : isNew ? (
            <span className="muted">Not saved yet</span>
          ) : readOnly ? (
            <span className="muted">Read-only</span>
          ) : (
            <span className="muted">All changes saved</span>
          )}
          {showErrors && issues.length ? (
            <span className="lib-field-error">
              {issues.length} problem{issues.length === 1 ? '' : 's'} to fix
            </span>
          ) : null}
        </div>
        <input
          id="lib-field-changeNote"
          className="lib-changenote"
          value={ctl.changeNote}
          onChange={(e) => ctl.setChangeNote(e.target.value)}
          onKeyDown={onChangeNoteKeyDown}
          placeholder="Change note (optional), e.g. Updated BTC minimum"
          aria-label="Change note (optional)"
          maxLength={LIMITS.changeNote}
          readOnly={readOnly}
          autoComplete="off"
        />
        <Button
          variant="primary"
          hotkey="mod+s"
          onClick={() => void ctl.save()}
          disabled={ctl.saving || readOnly || (!isNew && !dirty)}
        >
          {ctl.saving ? <Spinner label="Saving" /> : null}
          {isNew ? 'Create macro' : 'Save'}
        </Button>
      </footer>
    </section>
  );
}

function MacroStats({ macro }: { macro: Macro }) {
  return (
    <span className="lib-stats small muted">
      <span title={macro.lastUsedAt ? `Last used ${formatDateTime(macro.lastUsedAt)}` : 'Never used'}>
        Used {macro.useCount}×{macro.lastUsedAt ? `, ${relativeTime(macro.lastUsedAt)}` : ''}
      </span>
      <span aria-hidden>·</span>
      <span title={`Updated ${formatDateTime(macro.updatedAt)} · created ${formatDateTime(macro.createdAt)}`}>
        updated {relativeTime(macro.updatedAt)}
      </span>
    </span>
  );
}
