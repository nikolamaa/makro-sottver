/**
 * State + actions of the Library page: which macro is open, the editable draft, unsaved-changes guard,
 * save/archive/restore/delete/favorite/revert, archived list, focus requests from other pages.
 *
 * Unsaved changes are protected three ways:
 *  - switching macros / creating a new one / Use in Assist asks first (confirm modal),
 *  - top navigation (clicks and Alt+Shift+N hotkeys) asks first, the browser asks on reload/close (beforeunload),
 *  - anything else that unmounts the page (quick search, back button) keeps the draft in memory and restores it
 *    the next time the Library opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Id, Macro } from '../../../shared/types';
import { api } from '../../api';
import { matchCombo } from '../../hotkeys';
import { actions, getState, setState, useStore, type Page } from '../../store';
import { toast } from '../../ui';
import {
  draftFromMacro,
  draftSignature,
  draftToInput,
  emptyDraft,
  errorMessage,
  isBlankFact,
  parseSeed,
  takeSessionJson,
  validateDraft,
  type DraftField,
  type DraftIssue,
  type DraftSeed,
  type MacroDraft,
} from './model';

export const NEW_MACRO_DRAFT_KEY = 'macropilot.newMacroDraft';

export type EditorTab = 'edit' | 'versions';
export type Selection = { mode: 'none' } | { mode: 'new' } | { mode: 'edit'; id: Id } | { mode: 'loading'; id: Id };
export type BusyAction = 'favorite' | 'archive' | 'restore' | 'delete' | 'revert';

interface EditorState {
  selection: Selection;
  draft: MacroDraft | null;
  /** draftSignature() of the saved state the draft is compared with. */
  baseSig: string;
  changeNote: string;
  /** Macro snapshot the draft was loaded from. */
  loadedFrom: Macro | null;
  /** The macro changed elsewhere while the draft had unsaved changes. */
  stale: boolean;
  showErrors: boolean;
  tab: EditorTab;
}

const INITIAL: EditorState = {
  selection: { mode: 'none' },
  draft: null,
  baseSig: '',
  changeNote: '',
  loadedFrom: null,
  stale: false,
  showErrors: false,
  tab: 'edit',
};

/** Unsaved editor state kept in memory when the page unmounts while dirty. */
let stash: EditorState | null = null;

/** Mirrors the top navigation hotkeys in App.tsx. */
const NAV_HOTKEYS: { combo: string; page: Page }[] = [
  { combo: 'alt+shift+1', page: 'assist' },
  { combo: 'alt+shift+2', page: 'library' },
  { combo: 'alt+shift+3', page: 'import' },
  { combo: 'alt+shift+4', page: 'settings' },
];

function factsSig(m: Macro): string {
  return JSON.stringify(m.facts.map((f) => [f.id, f.key, f.statement, f.value, f.sourceUrl, f.evidenceQuote, f.status]));
}

/** Prefer whichever copy of the same macro is newer (guards against out-of-order store updates). */
function freshest(stored: Macro | undefined, loaded: Macro | null): Macro | null {
  if (!stored) return loaded;
  if (!loaded || loaded.id !== stored.id) return stored;
  if (loaded.version > stored.version) return loaded;
  if (loaded.version === stored.version && Date.parse(loaded.updatedAt) > Date.parse(stored.updatedAt)) return loaded;
  return stored;
}

export function focusField(field: DraftField, factUid?: string): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(field === 'facts' && factUid ? `lib-fact-edit-${factUid}` : `lib-field-${field}`);
    const target = el?.matches('input, textarea, select, button') ? el : el?.querySelector<HTMLElement>('button, input, textarea, select');
    target?.focus();
  });
}

export function useLibraryController() {
  const storeMacros = useStore((s) => s.macros);
  const categories = useStore((s) => s.categories);
  const focusRequest = useStore((s) => s.libraryFocusId);

  const [ed, setEd] = useState<EditorState>(INITIAL);
  const [archived, setArchived] = useState<Macro[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [pending, setPending] = useState<{ run: () => void } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const selection = ed.selection;
  const selectedId = selection.mode === 'edit' || selection.mode === 'loading' ? selection.id : null;

  const macro = useMemo(() => {
    if (selection.mode !== 'edit') return null;
    const stored = storeMacros.find((m) => m.id === selection.id) ?? archived.find((m) => m.id === selection.id);
    return freshest(stored, ed.loadedFrom?.id === selection.id ? ed.loadedFrom : null);
  }, [selection, storeMacros, archived, ed.loadedFrom]);

  const listMacros = useMemo(() => {
    if (!showArchived) return storeMacros;
    const activeIds = new Set(storeMacros.map((m) => m.id));
    return [...storeMacros, ...archived.filter((m) => m.archivedAt && !activeIds.has(m.id))];
  }, [showArchived, storeMacros, archived]);

  const draftSig = useMemo(() => (ed.draft ? draftSignature(ed.draft) : ''), [ed.draft]);
  const dirty = !!ed.draft && draftSig !== ed.baseSig;
  const readOnly = !!macro?.archivedAt;
  const issues = useMemo<DraftIssue[]>(() => (ed.draft ? validateDraft(ed.draft, ed.changeNote) : []), [ed.draft, ed.changeNote]);

  // Latest values for event handlers and async callbacks.
  const edRef = useRef(ed);
  edRef.current = ed;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const macroRef = useRef(macro);
  macroRef.current = macro;
  const archivedRef = useRef(archived);
  archivedRef.current = archived;
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const savingRef = useRef(false);
  const bypassNav = useRef(false);
  const initialized = useRef(false);

  // ---------------------------------------------------------------------------
  // Opening macros
  // ---------------------------------------------------------------------------

  const loadMacro = useCallback((m: Macro, tab?: EditorTab) => {
    const draft = draftFromMacro(m);
    const baseSig = draftSignature(draft);
    setEd((prev) => ({
      selection: { mode: 'edit', id: m.id },
      draft,
      baseSig,
      changeNote: '',
      loadedFrom: m,
      stale: false,
      showErrors: false,
      tab: tab ?? (prev.selection.mode === 'edit' && prev.selection.id === m.id ? prev.tab : 'edit'),
    }));
  }, []);

  const openNew = useCallback((seed?: DraftSeed | null) => {
    setEd({ ...INITIAL, selection: { mode: 'new' }, draft: emptyDraft(seed ?? undefined), baseSig: draftSignature(emptyDraft()) });
    focusField('title');
  }, []);

  const openMacro = useCallback(
    (id: Id) => {
      const found = getState().macros.find((m) => m.id === id) ?? archivedRef.current.find((m) => m.id === id);
      if (found) {
        loadMacro(found);
        return;
      }
      setEd({ ...INITIAL, selection: { mode: 'loading', id } });
      api('GET /api/macros/:id', { params: { id } })
        .then((m) => {
          const s = edRef.current.selection;
          if (s.mode !== 'loading' || s.id !== id) return;
          if (m.archivedAt) {
            setArchived((list) => [...list.filter((x) => x.id !== m.id), m]);
            setShowArchived(true);
          }
          loadMacro(m);
        })
        .catch((err: unknown) => {
          toast(errorMessage(err), 'danger');
          setEd((p) => (p.selection.mode === 'loading' && p.selection.id === id ? INITIAL : p));
        });
    },
    [loadMacro],
  );

  // ---------------------------------------------------------------------------
  // Unsaved-changes guard
  // ---------------------------------------------------------------------------

  /** Run `action` now, or after the agent confirms what to do with unsaved changes. */
  const guard = useCallback((action: () => void) => {
    if (!dirtyRef.current) action();
    else setPending({ run: action });
  }, []);

  const requestOpen = useCallback(
    (id: Id) => {
      const s = edRef.current.selection;
      if ((s.mode === 'edit' || s.mode === 'loading') && s.id === id) return;
      guard(() => openMacro(id));
    },
    [guard, openMacro],
  );

  const requestNew = useCallback(() => {
    if (edRef.current.selection.mode === 'new' && !dirtyRef.current) {
      focusField('title');
      return;
    }
    guard(() => openNew());
  }, [guard, openNew]);

  const requestClose = useCallback(() => guard(() => setEd(INITIAL)), [guard]);

  // ---------------------------------------------------------------------------
  // Draft editing
  // ---------------------------------------------------------------------------

  const updateDraft = useCallback((updater: (d: MacroDraft) => MacroDraft) => {
    setEd((p) => (p.draft ? { ...p, draft: updater(p.draft) } : p));
  }, []);

  const setChangeNote = useCallback((changeNote: string) => setEd((p) => ({ ...p, changeNote })), []);
  const setTab = useCallback((tab: EditorTab) => setEd((p) => ({ ...p, tab })), []);

  const reloadStale = useCallback(() => {
    const m = macroRef.current;
    if (m) loadMacro(m);
  }, [loadMacro]);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  const save = useCallback(async (): Promise<boolean> => {
    const e = edRef.current;
    const sel = e.selection;
    if (!e.draft || savingRef.current || (sel.mode !== 'new' && sel.mode !== 'edit')) return false;
    const current = sel.mode === 'edit' ? macroRef.current : null;
    if (current?.archivedAt) {
      toast('Restore this macro before editing it.', 'warning');
      return false;
    }
    const problems = validateDraft(e.draft, e.changeNote);
    const first = problems[0];
    if (first) {
      setEd((p) => ({ ...p, showErrors: true, tab: 'edit' }));
      toast(problems.length > 1 ? `${first.message} (+${problems.length - 1} more)` : first.message, 'danger');
      focusField(first.field, first.factUid);
      return false;
    }
    if (sel.mode === 'edit' && !dirtyRef.current) {
      toast('No changes to save', 'info');
      return true;
    }

    const savedDraft = e.draft;
    savingRef.current = true;
    setSaving(true);
    try {
      const input = draftToInput(savedDraft, e.changeNote);
      const result =
        sel.mode === 'new'
          ? await api('POST /api/macros', { body: input })
          : await api('PUT /api/macros/:id', { params: { id: sel.id }, body: input });

      const now = edRef.current;
      const sameTarget =
        now.selection.mode === sel.mode && (sel.mode === 'new' || (now.selection.mode === 'edit' && now.selection.id === sel.id));
      if (sameTarget && now.draft === savedDraft) {
        loadMacro(result);
      } else if (sameTarget && now.draft) {
        // The agent kept typing while saving: keep the newer text, adopt server ids for the saved facts.
        const savedFacts = savedDraft.facts.filter((f) => !isBlankFact(f));
        const byUid = new Map(savedFacts.map((f, i) => [f.uid, result.facts[i]]));
        const draft: MacroDraft = {
          ...now.draft,
          facts: now.draft.facts.map((f) => {
            const sf = byUid.get(f.uid);
            return sf ? { ...f, id: sf.id, original: sf } : f;
          }),
        };
        setEd((p) => ({
          ...p,
          selection: { mode: 'edit', id: result.id },
          draft,
          baseSig: draftSignature(draftFromMacro(result)),
          changeNote: '',
          loadedFrom: result,
          stale: false,
          showErrors: false,
        }));
      }
      actions.upsertMacro(result);
      if (sel.mode === 'new') toast('Macro created', 'success');
      else toast(current && result.version !== current.version ? `Saved as version ${result.version}` : 'Saved', 'success');
      return true;
    } catch (err) {
      toast(errorMessage(err), 'danger');
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [loadMacro]);

  // ---------------------------------------------------------------------------
  // Pending (unsaved changes) modal
  // ---------------------------------------------------------------------------

  const keepEditing = useCallback(() => setPending(null), []);

  const discardAndContinue = useCallback(() => {
    const p = pendingRef.current;
    setPending(null);
    dirtyRef.current = false;
    const e = edRef.current;
    if (e.selection.mode === 'edit' && macroRef.current) loadMacro(macroRef.current);
    else setEd(INITIAL);
    p?.run();
  }, [loadMacro]);

  const saveAndContinue = useCallback(async () => {
    const p = pendingRef.current;
    const ok = await save();
    setPending(null);
    if (!ok) return;
    dirtyRef.current = false;
    p?.run();
  }, [save]);

  // ---------------------------------------------------------------------------
  // Macro actions
  // ---------------------------------------------------------------------------

  const toggleFavorite = useCallback(async () => {
    const m = macroRef.current;
    if (!m || m.archivedAt) return;
    setBusy('favorite');
    try {
      const r = await api('POST /api/macros/:id/favorite', { params: { id: m.id }, body: { favorite: !m.isFavorite } });
      actions.upsertMacro(r);
      toast(r.isFavorite ? 'Added to favorites' : 'Removed from favorites', 'success');
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      setBusy(null);
    }
  }, []);

  const archive = useCallback(() => {
    const m = macroRef.current;
    if (!m || m.archivedAt) return;
    guard(() => {
      void (async () => {
        setBusy('archive');
        try {
          await api('DELETE /api/macros/:id', { params: { id: m.id } });
          const archivedMacro: Macro = { ...m, archivedAt: new Date().toISOString() };
          setArchived((list) => [...list.filter((x) => x.id !== m.id), archivedMacro]);
          actions.removeMacro(m.id);
          if (showArchivedRef.current) loadMacro(archivedMacro);
          else setEd(INITIAL);
          toast(showArchivedRef.current ? 'Macro archived' : 'Macro archived. Tick “Archived” in the list to see or restore it.', 'success');
        } catch (err) {
          toast(errorMessage(err), 'danger');
        } finally {
          setBusy(null);
        }
      })();
    });
  }, [guard, loadMacro]);

  const restore = useCallback(async () => {
    const m = macroRef.current;
    if (!m || !m.archivedAt) return;
    setBusy('restore');
    try {
      const r = await api('POST /api/macros/:id/restore', { params: { id: m.id } });
      setArchived((list) => list.filter((x) => x.id !== r.id));
      loadMacro(r);
      actions.upsertMacro(r);
      toast('Macro restored', 'success');
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      setBusy(null);
    }
  }, [loadMacro]);

  const hardDelete = useCallback(async () => {
    const m = macroRef.current;
    if (!m) return;
    setBusy('delete');
    try {
      await api('DELETE /api/macros/:id', { params: { id: m.id }, query: { hard: 1 } });
      setArchived((list) => list.filter((x) => x.id !== m.id));
      actions.removeMacro(m.id);
      dirtyRef.current = false;
      setEd(INITIAL);
      setDeleteOpen(false);
      toast(`“${m.title}” deleted permanently`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      setBusy(null);
    }
  }, []);

  const revert = useCallback(
    (version: number) => {
      const m = macroRef.current;
      if (!m || m.archivedAt) return;
      guard(() => {
        void (async () => {
          setBusy('revert');
          try {
            const r = await api('POST /api/macros/:id/revert', { params: { id: m.id }, body: { version } });
            loadMacro(r, 'versions');
            actions.upsertMacro(r);
            toast(
              r.version === m.version ? `v${version} has the same content as the current version` : `Reverted to v${version} (saved as v${r.version})`,
              'success',
            );
          } catch (err) {
            toast(errorMessage(err), 'danger');
          } finally {
            setBusy(null);
          }
        })();
      });
    },
    [guard, loadMacro],
  );

  const sendToAssist = useCallback(() => {
    const m = macroRef.current;
    if (!m || m.archivedAt) return;
    guard(() => actions.useInAssist(m.id));
  }, [guard]);

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Mount: restore a stashed draft, open a prefilled new macro (from Assist) or a focus request.
  useEffect(() => {
    if (initialized.current) {
      // StrictMode re-mount: our state survived, drop the stash written by the simulated unmount.
      stash = null;
    } else {
      initialized.current = true;
      const restored = stash;
      stash = null;
      const seed = parseSeed(takeSessionJson(NEW_MACRO_DRAFT_KEY));
      const focusId = getState().libraryFocusId;
      if (focusId) setState({ libraryFocusId: null });
      const restoredId = restored && restored.selection.mode === 'edit' ? restored.selection.id : null;
      const next = seed ? () => openNew(seed) : focusId && focusId !== restoredId ? () => openMacro(focusId) : null;
      if (restored) {
        setEd(restored);
        dirtyRef.current = true;
        if (next) setPending({ run: next });
        else toast('Restored your unsaved changes', 'info');
      } else {
        next?.();
      }
    }
    return () => {
      const e = edRef.current;
      stash = dirtyRef.current && e.draft ? e : null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus requests while the page is open (quick search, Assist "edit").
  useEffect(() => {
    const id = getState().libraryFocusId;
    if (!id || !initialized.current) return;
    setState({ libraryFocusId: null });
    requestOpen(id);
  }, [focusRequest, requestOpen]);

  // Keep the draft in sync with changes made elsewhere (favorite, accuracy checks, use counts, other tabs).
  useEffect(() => {
    const m = macro;
    const e = edRef.current;
    if (!m || e.selection.mode !== 'edit' || e.selection.id !== m.id) return;
    const prev = e.loadedFrom;
    if (prev === m) return;
    if (!prev || prev.id !== m.id) {
      loadMacro(m);
      return;
    }
    const contentChanged = prev.version !== m.version || factsSig(prev) !== factsSig(m);
    if (!contentChanged) setEd((p) => (p.loadedFrom === prev ? { ...p, loadedFrom: m } : p));
    else if (!dirtyRef.current) loadMacro(m);
    else setEd((p) => (p.stale ? p : { ...p, stale: true }));
  }, [macro, loadMacro]);

  // Archived macros are fetched on demand.
  useEffect(() => {
    if (!showArchived) return;
    const ctrl = new AbortController();
    setArchivedLoading(true);
    api('GET /api/macros', { query: { archived: 1 }, signal: ctrl.signal })
      .then((all) => setArchived(all.filter((m) => m.archivedAt)))
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) toast(errorMessage(err), 'danger');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setArchivedLoading(false);
      });
    return () => {
      ctrl.abort();
      setArchivedLoading(false);
    };
  }, [showArchived]);

  // Browser reload / close.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Leaving the page through the top navigation (clicks + Alt+Shift+N hotkeys).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (bypassNav.current || !dirtyRef.current || e.button !== 0) return;
      const item = e.target instanceof Element ? e.target.closest<HTMLElement>('.topbar .nav-item') : null;
      if (!item || item.classList.contains('active')) return;
      e.preventDefault();
      e.stopPropagation();
      guard(() => {
        bypassNav.current = true;
        try {
          item.click();
        } finally {
          bypassNav.current = false;
        }
      });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!dirtyRef.current) return;
      const hit = NAV_HOTKEYS.find((n) => matchCombo(n.combo, e));
      if (!hit || hit.page === 'library') return;
      e.preventDefault();
      e.stopPropagation();
      guard(() => actions.navigate(hit.page));
    };
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [guard]);

  return {
    // data
    categories,
    listMacros,
    allMacros: storeMacros,
    selection,
    selectedId,
    macro,
    draft: ed.draft,
    changeNote: ed.changeNote,
    tab: ed.tab,
    stale: ed.stale,
    showErrors: ed.showErrors,
    issues,
    dirty,
    readOnly,
    saving,
    busy,
    showArchived,
    archivedLoading,
    pending: pending !== null,
    deleteOpen,
    // actions
    setShowArchived,
    requestOpen,
    requestNew,
    requestClose,
    updateDraft,
    setChangeNote,
    setTab,
    reloadStale,
    save,
    keepEditing,
    discardAndContinue,
    saveAndContinue,
    toggleFavorite,
    archive,
    restore,
    hardDelete,
    revert,
    sendToAssist,
    setDeleteOpen,
  };
}

export type LibraryController = ReturnType<typeof useLibraryController>;
