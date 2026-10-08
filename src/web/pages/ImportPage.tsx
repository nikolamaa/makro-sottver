/**
 * Import / Export page.
 *
 * Import: Intercom macros can't be exported (no permission), so the agent pastes them as text (or loads a CSV/JSON
 * file), previews what will be created, unticks what they don't want and imports. Export: encrypted backup
 * (.mpbackup) or a plain JSON file (after an explicit warning).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';
import { INTENTS, INTENT_LABELS, type ImportCommitRequest, type ImportCommitResult, type ImportFormat, type ImportItem } from '../../shared/types';
import { api, downloadFile } from '../api';
import { useHotkeys } from '../hotkeys';
import { actions } from '../store';
import { Badge, Button, EmptyState, Kbd, Modal, Spinner, toast } from '../ui';
import { errorMessage } from '../components/settings/settingsUtils';
import { addCommitResults, chunkForCommit, decodeFileBytes, formatFromFileName, guessFormat } from '../components/settings/importUtils';
import './import.css';

/** Server limit for one import request. */
const MAX_CONTENT_CHARS = 2_000_000;
const MAX_ERRORS_SHOWN = 50;
/** The server caps request bodies at 3 MB; large imports are committed in batches well below that. */
const COMMIT_BATCH_BYTES = 1_000_000;
const COMMIT_BATCH_ITEMS = 500;

type OnDuplicate = ImportCommitRequest['onDuplicate'];

const TABS: { format: ImportFormat; label: string }[] = [
  { format: 'text', label: 'Paste text' },
  { format: 'csv', label: 'CSV' },
  { format: 'json', label: 'JSON' },
];

const FORMAT_LABEL: Record<ImportFormat, string> = { text: 'text', csv: 'CSV', json: 'JSON' };

const EXAMPLES: Record<ImportFormat, string> = {
  text: `### Pending crypto withdrawal
Category: Withdrawals
Tags: crypto, pending
Intents: withdrawal_pending
Hi {{first_name | fallback: "there"}},

Thank you for your patience! Your {{crypto}} withdrawal is still pending. I'll keep an eye on it and update you as soon as it has been processed.
---
### Verification documents
Category: Verification
Tags: kyc, documents
Intents: kyc_verification
Hi {{first_name | fallback: "there"}},

To complete your verification, please upload a clear photo of your {{document_type}}.`,
  csv: `title,body,category,tags,intents,triggers,shortcut
"Pending crypto withdrawal","Hi {{user}},

Your withdrawal is still pending. I'll update you as soon as it has been processed.","Withdrawals","crypto;pending","withdrawal_pending","where is my withdrawal|withdrawal still pending","wd-pending"`,
  json: `[
  {
    "title": "Pending crypto withdrawal",
    "body": "Hi {{user}},\\n\\nYour withdrawal is still pending. I'll update you as soon as it has been processed.",
    "category": "Withdrawals",
    "tags": ["crypto", "pending"],
    "intents": ["withdrawal_pending"],
    "triggers": ["where is my withdrawal"],
    "shortcut": "wd-pending"
  }
]`,
};

const PLACEHOLDERS: Record<ImportFormat, string> = {
  text: 'Paste macros copied from Intercom here.\n\n### Macro title\nCategory: Withdrawals\nTags: crypto, pending\nHi {{first_name | fallback: "there"}}, ...\n---\n### Next macro ...',
  csv: 'Paste CSV with a header row (title, body, category, tags, intents, ...) or load a .csv file.',
  json: 'Paste a JSON array of macros or a MacroPilot JSON export, or load a .json file.',
};

const ON_DUPLICATE: { value: OnDuplicate; label: string; hint: string }[] = [
  { value: 'skip', label: 'Skip', hint: 'Keep the existing macro unchanged.' },
  { value: 'new_version', label: 'Save as new version', hint: 'Replace the content; the old text stays in version history.' },
  { value: 'create_copy', label: 'Create a copy', hint: 'Import as a separate macro with the same title.' },
];

/** Page hotkeys must not fire underneath a dialog (e.g. the recovery key prompt). */
function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"]') !== null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

interface PreviewState {
  format: ImportFormat;
  content: string;
  items: ImportItem[];
  errors: string[];
  included: boolean[];
}

export function ImportPage() {
  const [format, setFormat] = useState<ImportFormat>('text');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [onDuplicate, setOnDuplicate] = useState<OnDuplicate>('skip');
  const [result, setResult] = useState<{ counts: ImportCommitResult; partial: boolean } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  /** Synchronous guard: blocks a second commit (double click / key repeat) and previews while importing. */
  const importingRef = useRef(false);

  useEffect(() => () => previewAbort.current?.abort(), []);

  const stale = preview !== null && (preview.content !== content || preview.format !== format);
  const suggested = useMemo(() => {
    const g = guessFormat(content);
    return g && g !== format ? g : null;
  }, [content, format]);

  const runPreview = useCallback(async (fmt: ImportFormat, text: string) => {
    if (importingRef.current) return;
    if (!text.trim()) {
      toast('Paste or load some macros first', 'warning');
      textareaRef.current?.focus();
      return;
    }
    if (text.length > MAX_CONTENT_CHARS) {
      toast(`Too much text at once (max ${(MAX_CONTENT_CHARS / 1_000_000).toFixed(0)} million characters). Split it into smaller parts.`, 'danger', 5000);
      return;
    }
    previewAbort.current?.abort();
    const ctrl = new AbortController();
    previewAbort.current = ctrl;
    setPreviewing(true);
    try {
      const res = await api('POST /api/import/preview', { body: { format: fmt, content: text }, signal: ctrl.signal });
      setPreview({ format: fmt, content: text, items: res.items, errors: res.errors, included: res.items.map(() => true) });
      setResult(null);
      if (res.items.length === 0) {
        toast(res.errors.length ? 'No macros could be read - see the problems listed below' : `No macros found in this ${FORMAT_LABEL[fmt]}`, 'warning', 4000);
      }
      requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    } catch (err) {
      if (ctrl.signal.aborted) return;
      toast(errorMessage(err), 'danger');
    } finally {
      if (previewAbort.current === ctrl) {
        previewAbort.current = null;
        setPreviewing(false);
      }
    }
  }, []);

  const loadFile = useCallback(
    async (file: File) => {
      if (importingRef.current) {
        toast('Wait for the current import to finish', 'warning');
        return;
      }
      const fmt = formatFromFileName(file.name);
      if (!fmt) {
        toast('Unsupported file type. Use .csv, .tsv, .json, .txt or .md', 'danger');
        return;
      }
      if (file.size > MAX_CONTENT_CHARS * 4) {
        toast('This file is too large to import at once. Split it into smaller files.', 'danger');
        return;
      }
      try {
        const text = decodeFileBytes(new Uint8Array(await file.arrayBuffer()));
        setFormat(fmt);
        setContent(text);
        setFileName(file.name);
        setResult(null);
        await runPreview(fmt, text);
      } catch (err) {
        toast(`Could not read ${file.name}: ${errorMessage(err)}`, 'danger');
      }
    },
    [runPreview],
  );

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow loading the same file again
    if (file) void loadFile(file);
  };

  const isFileDrag = (e: DragEvent<HTMLDivElement>) => Array.from(e.dataTransfer.types).includes('Files');

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    // Only take over file drags; dragging selected text into the textarea keeps the browser default.
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // dragleave also fires when moving onto a child element; only reset when the pointer left the drop zone.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragging(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return; // plain text drop: let the textarea insert it
    e.preventDefault();
    void loadFile(file);
  };

  const selectedCount = useMemo(() => (preview ? preview.included.filter(Boolean).length : 0), [preview]);
  const duplicateCount = useMemo(() => (preview ? preview.items.filter((it) => it.duplicateOf).length : 0), [preview]);
  const selectedDuplicates = useMemo(
    () => (preview ? preview.items.filter((it, i) => it.duplicateOf && preview.included[i]).length : 0),
    [preview],
  );

  const commit = useCallback(async () => {
    if (!preview || importingRef.current) return;
    const items = preview.items.filter((_, i) => preview.included[i]);
    if (!items.length) {
      toast('Select at least one macro to import', 'warning');
      return;
    }
    // A preview still running for the same text would otherwise come back after the import and re-show it.
    previewAbort.current?.abort();
    importingRef.current = true;
    setImporting(true);
    const batches = chunkForCommit(items, COMMIT_BATCH_BYTES, COMMIT_BATCH_ITEMS);
    let total: ImportCommitResult = { created: 0, updated: 0, skipped: 0 };
    let done = 0;
    try {
      for (const batch of batches) {
        if (batches.length > 1) setProgress({ done, total: items.length });
        const res = await api('POST /api/import/commit', { body: { items: batch, onDuplicate } });
        total = addCommitResults(total, res);
        done += batch.length;
      }
      toast(`Imported: ${total.created} created, ${total.updated} updated, ${total.skipped} skipped`, 'success', 4500);
      setResult({ counts: total, partial: false });
      setPreview(null);
      setContent('');
      setFileName(null);
    } catch (err) {
      if (done === 0) {
        toast(errorMessage(err), 'danger');
      } else {
        // Earlier batches are saved: drop them from the preview so importing again continues where it stopped.
        const committed = new Set(items.slice(0, done));
        setPreview((p) => {
          if (!p) return p;
          const keep = p.items.map((it) => !committed.has(it));
          return { ...p, items: p.items.filter((_, i) => keep[i]), included: p.included.filter((_, i) => keep[i]) };
        });
        setResult({ counts: total, partial: true });
        toast(
          `Import stopped after ${done} of ${items.length} macros: ${errorMessage(err)}. The rest are still listed - import again to continue.`,
          'danger',
          8000,
        );
      }
    } finally {
      importingRef.current = false;
      setImporting(false);
      setProgress(null);
    }
    if (done > 0) {
      await Promise.all([actions.refreshMacros(), actions.refreshCategories()]).catch((err: unknown) =>
        toast(`Imported, but the library could not be refreshed: ${errorMessage(err)}`, 'danger'),
      );
    }
  }, [preview, onDuplicate]);

  const toggleItem = useCallback((index: number) => {
    setPreview((p) => (p ? { ...p, included: p.included.map((v, i) => (i === index ? !v : v)) } : p));
  }, []);

  const setAll = useCallback((pick: (item: ImportItem) => boolean) => {
    setPreview((p) => (p ? { ...p, included: p.items.map(pick) } : p));
  }, []);

  useHotkeys(
    {
      'mod+enter': () => {
        if (!previewing && !dialogOpen()) void runPreview(format, content);
      },
      'mod+shift+enter': () => {
        if (preview && !stale && !dialogOpen()) void commit();
      },
      'mod+o': () => {
        if (!dialogOpen()) fileInput.current?.click();
      },
    },
    [format, content, previewing, preview, stale, commit, runPreview],
  );

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const idx = TABS.findIndex((t) => t.format === format);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (idx + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const tab = TABS[next]!;
    setFormat(tab.format);
    document.getElementById(`imp-tab-${tab.format}`)?.focus();
  };

  return (
    <div className="page imp-page">
      <header className="imp-header">
        <h1>Import / Export</h1>
        <p className="muted">
          Intercom doesn&apos;t allow exporting macros with your permissions, so copy them over by hand: open a macro in
          Intercom, copy its title and text, and paste it below. Paste as many as you like at once.
        </p>
      </header>

      {result ? <ImportResult result={result.counts} partial={result.partial} onDismiss={() => setResult(null)} /> : null}

      <div className="imp-grid">
        <section className="panel imp-input" aria-labelledby="imp-input-title">
          <h2 id="imp-input-title" className="imp-section-title">
            1. Add macros
          </h2>
          <div className="imp-tabs" role="tablist" aria-label="Import format" onKeyDown={onTabKey}>
            {TABS.map((t) => {
              const selected = t.format === format;
              return (
                <button
                  key={t.format}
                  id={`imp-tab-${t.format}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="imp-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  className={`imp-tab ${selected ? 'active' : ''}`}
                  onClick={() => setFormat(t.format)}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <div id="imp-tabpanel" role="tabpanel" aria-labelledby={`imp-tab-${format}`} className="imp-tabpanel">
            <div
              className={`imp-drop ${dragging ? 'is-dragging' : ''}`}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              <textarea
                ref={textareaRef}
                className="imp-textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={PLACEHOLDERS[format]}
                aria-label={`Macros to import (${FORMAT_LABEL[format]})`}
                spellCheck={false}
                rows={14}
              />
              {dragging ? <div className="imp-drop-hint">Drop a .csv, .json, .txt or .md file</div> : null}
            </div>

            <div className="imp-hint-row" aria-live="polite">
              {suggested ? (
                <span className="imp-suggest">
                  This looks like {FORMAT_LABEL[suggested]}.{' '}
                  <button type="button" className="imp-link" onClick={() => setFormat(suggested)}>
                    Switch to {TABS.find((t) => t.format === suggested)?.label}
                  </button>
                </span>
              ) : fileName ? (
                <span className="muted small">
                  Loaded <strong>{fileName}</strong>
                </span>
              ) : (
                // aria-hidden: the counter changes on every keystroke and must not be announced by the live region.
                <span className="muted small" aria-hidden={content ? true : undefined}>
                  {content ? `${content.length.toLocaleString('en-US')} characters` : 'You can also drop a file here.'}
                </span>
              )}
            </div>

            <div className="imp-toolbar">
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.tsv,.json,.txt,.md,text/csv,text/tab-separated-values,application/json,text/plain,text/markdown"
                onChange={onFileChange}
                hidden
              />
              <Button onClick={() => fileInput.current?.click()} hotkey="mod+o">
                Load file
              </Button>
              {content ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setContent('');
                    setFileName(null);
                    setPreview(null);
                    textareaRef.current?.focus();
                  }}
                >
                  Clear
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setContent(EXAMPLES[format])}>
                  Insert example
                </Button>
              )}
              <span className="spacer" />
              <Button variant="primary" onClick={() => void runPreview(format, content)} disabled={previewing || importing || !content.trim()} hotkey="mod+enter">
                {previewing ? <Spinner label="Reading macros" /> : null}
                Preview
              </Button>
            </div>
          </div>
        </section>

        <FormatHelp format={format} />
      </div>

      <section ref={previewRef} className="panel imp-preview" aria-labelledby="imp-preview-title">
        <h2 id="imp-preview-title" className="imp-section-title">
          2. Review &amp; import
        </h2>
        {!preview ? (
          <EmptyState title={previewing ? 'Reading your macros...' : 'Nothing to review yet'}>
            {previewing ? (
              <Spinner label="Reading macros" />
            ) : (
              <>
                Paste macros above and press <Kbd combo="mod+enter" /> to see what will be imported. Nothing is saved until
                you confirm.
              </>
            )}
          </EmptyState>
        ) : (
          <>
            {stale ? (
              <div className="imp-stale" role="status">
                <span>The text changed since this preview.</span>
                <Button size="sm" onClick={() => void runPreview(format, content)} disabled={previewing || importing}>
                  Refresh preview
                </Button>
              </div>
            ) : null}

            <div className="imp-summary">
              <Badge tone="info">{plural(preview.items.length, 'macro')} found</Badge>
              {duplicateCount ? <Badge tone="warning">{plural(duplicateCount, 'duplicate')}</Badge> : null}
              {preview.errors.length ? <Badge tone="danger">{plural(preview.errors.length, 'problem')}</Badge> : null}
              <span className="spacer" />
              {preview.items.length ? (
                <div className="imp-select-btns" role="group" aria-label="Select macros">
                  <Button size="sm" variant="ghost" onClick={() => setAll(() => true)}>
                    All
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAll(() => false)}>
                    None
                  </Button>
                  {duplicateCount ? (
                    <Button size="sm" variant="ghost" onClick={() => setAll((it) => !it.duplicateOf)}>
                      New only
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {preview.errors.length ? <ErrorList errors={preview.errors} /> : null}

            {preview.items.length ? (
              <PreviewTable preview={preview} onToggle={toggleItem} onSetAll={setAll} selectedCount={selectedCount} />
            ) : null}

            {preview.items.length ? (
              <div className="imp-commit">
                <label className="imp-dup">
                  <span className="field-label">When a macro with the same title exists</span>
                  <select value={onDuplicate} onChange={(e) => setOnDuplicate(e.target.value as OnDuplicate)}>
                    {ON_DUPLICATE.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">{ON_DUPLICATE.find((o) => o.value === onDuplicate)?.hint}</span>
                </label>
                <div className="imp-commit-action">
                  {selectedDuplicates && onDuplicate === 'skip' ? (
                    <span className="small muted">{plural(selectedDuplicates, 'duplicate')} will be skipped.</span>
                  ) : null}
                  <Button
                    variant="primary"
                    onClick={() => void commit()}
                    disabled={importing || selectedCount === 0 || stale}
                    title={stale ? 'Refresh the preview first' : undefined}
                    hotkey="mod+shift+enter"
                  >
                    {importing ? <Spinner label="Importing" /> : null}
                    {importing && progress
                      ? `Importing ${progress.done.toLocaleString('en-US')} / ${progress.total.toLocaleString('en-US')}...`
                      : `Import ${plural(selectedCount, 'macro')}`}
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      <ExportSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Format help
// ---------------------------------------------------------------------------

const FormatHelp = memo(function FormatHelp({ format }: { format: ImportFormat }) {
  return (
    <aside className="panel imp-help" aria-labelledby="imp-help-title">
      <h2 id="imp-help-title" className="imp-section-title">
        {format === 'text' ? 'Text format' : format === 'csv' ? 'CSV format' : 'JSON format'}
      </h2>
      {format === 'text' ? (
        <>
          <ul className="imp-help-list">
            <li>
              Start each macro with <code>### Title</code>, or separate macros with a line containing only <code>---</code>.
            </li>
            <li>
              Optional lines right below the title: <code>Category:</code>, <code>Tags:</code>, <code>Intents:</code>,{' '}
              <code>Shortcut:</code>. Everything after them is the reply text.
            </li>
          </ul>
        </>
      ) : format === 'csv' ? (
        <ul className="imp-help-list">
          <li>
            First row is the header: <code>title</code>, <code>body</code> and optionally <code>category</code>,{' '}
            <code>tags</code>, <code>intents</code>, <code>triggers</code>, <code>notes</code>, <code>shortcut</code>.
          </li>
          <li>
            Separate tags and intents with <code>;</code> or <code>,</code>; triggers with <code>|</code>. Wrap text with
            line breaks in double quotes.
          </li>
          <li>Exports from Google Sheets or Excel (File → Download → CSV) work as-is.</li>
        </ul>
      ) : (
        <ul className="imp-help-list">
          <li>
            An array of objects with <code>title</code> and <code>body</code>, plus optional <code>category</code>,{' '}
            <code>tags</code>, <code>intents</code>, <code>triggers</code>, <code>notes</code>, <code>shortcut</code>,{' '}
            <code>facts</code>.
          </li>
          <li>A plain JSON export from MacroPilot can be imported again as-is.</li>
        </ul>
      )}
      <pre className="imp-example" tabIndex={0} aria-label="Example">
        {EXAMPLES[format]}
      </pre>
      <p className="imp-help-note small">
        Intercom variables like <code>{'{{first_name | fallback: "there"}}'}</code> are converted automatically (to{' '}
        <code>{'{{user|there}}'}</code>). Missing values become <code>[ENTER ...]</code> placeholders you fill in before
        sending.
      </p>
      <details className="imp-intents">
        <summary>Valid intents ({INTENTS.length})</summary>
        <ul>
          {INTENTS.map((i) => (
            <li key={i}>
              <code>{i}</code> <span className="muted">{INTENT_LABELS[i]}</span>
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
});

// ---------------------------------------------------------------------------
// Preview table
// ---------------------------------------------------------------------------

function PreviewTable({
  preview,
  onToggle,
  onSetAll,
  selectedCount,
}: {
  preview: PreviewState;
  onToggle: (index: number) => void;
  onSetAll: (pick: (item: ImportItem) => boolean) => void;
  selectedCount: number;
}) {
  const headerRef = useRef<HTMLInputElement>(null);
  const total = preview.items.length;
  const allChecked = selectedCount === total;
  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = selectedCount > 0 && selectedCount < total;
  }, [selectedCount, total]);

  return (
    <div className="imp-table-wrap">
      <table className="imp-table">
        <thead>
          <tr>
            <th scope="col" className="imp-col-check">
              <input
                ref={headerRef}
                type="checkbox"
                checked={allChecked}
                onChange={() => onSetAll(() => !allChecked)}
                aria-label={allChecked ? 'Deselect all macros' : 'Select all macros'}
              />
            </th>
            <th scope="col">Title</th>
            <th scope="col">Category</th>
            <th scope="col">Tags</th>
            <th scope="col">Intents</th>
            <th scope="col" className="imp-col-num">
              Facts
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {preview.items.map((item, i) => (
            <PreviewRow key={i} index={i} item={item} checked={preview.included[i] ?? false} onToggle={onToggle} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MAX_CHIPS = 3;

const PreviewRow = memo(function PreviewRow({
  index,
  item,
  checked,
  onToggle,
}: {
  index: number;
  item: ImportItem;
  checked: boolean;
  onToggle: (index: number) => void;
}) {
  const extraTags = item.tags.length - MAX_CHIPS;
  const extraIntents = item.intents.length - MAX_CHIPS;
  // Bodies are rendered only when expanded: a big import can list thousands of rows.
  const [open, setOpen] = useState(false);
  return (
    <tr className={checked ? '' : 'is-excluded'}>
      <td className="imp-col-check">
        <input type="checkbox" checked={checked} onChange={() => onToggle(index)} aria-label={`Include "${item.title}"`} />
      </td>
      <td className="imp-col-title">
        <details onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>
            <span className="imp-title">{item.title}</span>
            {item.shortcut ? <span className="imp-shortcut mono">/{item.shortcut}</span> : null}
          </summary>
          {open ? (
            <>
              <pre className="imp-body">{item.body}</pre>
              {item.triggers.length ? (
                <p className="small muted">
                  Triggers: {item.triggers.slice(0, 5).join(' · ')}
                  {item.triggers.length > 5 ? ` +${item.triggers.length - 5}` : ''}
                </p>
              ) : null}
              {item.notes ? <p className="small muted">Notes: {item.notes}</p> : null}
            </>
          ) : null}
        </details>
      </td>
      <td>{item.category ? item.category : <span className="muted">-</span>}</td>
      <td>
        <span className="row-wrap">
          {item.tags.slice(0, MAX_CHIPS).map((t, i) => (
            <Badge key={`${i}-${t}`}>{t}</Badge>
          ))}
          {extraTags > 0 ? <Badge title={item.tags.slice(MAX_CHIPS).join(', ')}>+{extraTags}</Badge> : null}
          {!item.tags.length ? <span className="muted">-</span> : null}
        </span>
      </td>
      <td>
        <span className="row-wrap">
          {item.intents.slice(0, MAX_CHIPS).map((it, i) => (
            <Badge key={`${i}-${it}`} tone="accent" title={it}>
              {INTENT_LABELS[it] ?? it}
            </Badge>
          ))}
          {extraIntents > 0 ? <Badge tone="accent">+{extraIntents}</Badge> : null}
          {!item.intents.length ? <span className="muted small">auto</span> : null}
        </span>
      </td>
      <td className="imp-col-num">{item.facts.length || <span className="muted">0</span>}</td>
      <td>
        {item.duplicateOf ? (
          <Badge tone="warning" title="A macro with the same title already exists">
            Duplicate
          </Badge>
        ) : (
          <Badge tone="success">New</Badge>
        )}
      </td>
    </tr>
  );
});

function ErrorList({ errors }: { errors: string[] }) {
  const shown = errors.slice(0, MAX_ERRORS_SHOWN);
  return (
    <div className="imp-errors" role="alert">
      <strong>
        {plural(errors.length, 'problem')} - {errors.length === 1 ? 'this part was' : 'these parts were'} not imported:
      </strong>
      <ul>
        {shown.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
      {errors.length > shown.length ? <p className="small">...and {errors.length - shown.length} more.</p> : null}
    </div>
  );
}

function ImportResult({ result, partial, onDismiss }: { result: ImportCommitResult; partial: boolean; onDismiss: () => void }) {
  return (
    <div className="panel imp-result" role="status">
      <div>
        <strong>{partial ? 'Import stopped part-way.' : 'Import complete.'}</strong>{' '}
        <span>
          {plural(result.created, 'macro')} created, {result.updated} updated, {result.skipped} skipped.
        </span>
      </div>
      <div className="row">
        <Button variant="primary" size="sm" onClick={() => actions.navigate('library')}>
          Open Library
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss import result">
          Dismiss
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function ExportSection() {
  const [busy, setBusy] = useState<'backup' | 'json' | null>(null);
  const [confirmJson, setConfirmJson] = useState(false);

  const download = async (kind: 'backup' | 'json') => {
    setBusy(kind);
    try {
      if (kind === 'backup') {
        await downloadFile('/api/export?format=backup', 'macropilot-backup.mpbackup');
        toast('Encrypted backup downloaded', 'success');
      } else {
        await downloadFile('/api/export?format=json', 'macropilot-macros.json');
        toast('Plain JSON downloaded - delete it when you are done', 'warning', 4000);
      }
    } catch (err) {
      toast(`Export failed: ${errorMessage(err)}`, 'danger');
    } finally {
      setBusy(null);
    }
  };

  const closeConfirm = useCallback(() => setConfirmJson(false), []);

  return (
    <section className="panel imp-export" aria-labelledby="imp-export-title">
      <h2 id="imp-export-title" className="imp-section-title">
        Export &amp; backup
      </h2>
      <div className="imp-export-grid">
        <div className="imp-export-item">
          <h3>
            Encrypted backup <Badge tone="success">🔒 recommended</Badge>
          </h3>
          <p className="muted small">
            All macros (including archived), their facts and categories in one encrypted <code>.mpbackup</code> file. Safe to
            keep in cloud storage. <strong>Restoring it requires your recovery key.</strong>
          </p>
          <Button variant="primary" onClick={() => void download('backup')} disabled={busy !== null}>
            {busy === 'backup' ? <Spinner label="Preparing backup" /> : null}
            Download encrypted backup (.mpbackup)
          </Button>
        </div>
        <div className="imp-export-item">
          <h3>Plain JSON</h3>
          <p className="muted small">
            Readable by anyone. Useful for bulk edits or moving macros to another tool; it can be imported here again.
          </p>
          <Button onClick={() => setConfirmJson(true)} disabled={busy !== null}>
            {busy === 'json' ? <Spinner label="Preparing export" /> : null}
            Export plain JSON
          </Button>
        </div>
      </div>

      <Modal
        open={confirmJson}
        title="Export an unencrypted file?"
        onClose={closeConfirm}
        footer={
          <>
            <Button variant="ghost" onClick={closeConfirm} autoFocus>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmJson(false);
                void download('json');
              }}
            >
              Export anyway
            </Button>
          </>
        }
      >
        <div className="imp-warning">
          <p>
            <strong>This file is NOT encrypted.</strong> Anyone who gets it can read all your macros and internal notes.
          </p>
          <ul>
            <li>Don&apos;t upload it, email it or leave it in your Downloads folder.</li>
            <li>Delete it as soon as you no longer need it.</li>
            <li>For safekeeping, use the encrypted backup instead.</li>
          </ul>
        </div>
      </Modal>
    </section>
  );
}
