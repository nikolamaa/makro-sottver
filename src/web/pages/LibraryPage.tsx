/**
 * Library: list + editor for macros, their facts and versions.
 * Keyboard: "/" search · ↑/↓ + Enter in the list · Alt+N new macro · Ctrl/⌘+S save · Alt+I insert variable.
 */
import { useHotkeys } from '../hotkeys';
import { MacroEditor } from '../components/library/MacroEditor';
import { MacroSidebar } from '../components/library/MacroSidebar';
import { DeleteMacroModal, UnsavedChangesModal } from '../components/library/Modals';
import { useLibraryController } from '../components/library/useLibraryController';
import './library.css';

export function LibraryPage() {
  const ctl = useLibraryController();
  const modalOpen = ctl.pending || ctl.deleteOpen;

  useHotkeys(
    {
      'alt+n': () => {
        if (!modalOpen) ctl.requestNew();
      },
      'mod+s': () => {
        if (!modalOpen && ctl.draft) void ctl.save();
      },
    },
    [],
  );

  return (
    <div className="page lib-page">
      <MacroSidebar
        macros={ctl.listMacros}
        categories={ctl.categories}
        activeId={ctl.selectedId}
        onOpen={ctl.requestOpen}
        onNew={ctl.requestNew}
        showArchived={ctl.showArchived}
        onShowArchivedChange={ctl.setShowArchived}
        archivedLoading={ctl.archivedLoading}
      />
      <MacroEditor ctl={ctl} />

      <UnsavedChangesModal
        open={ctl.pending}
        title={ctl.draft?.title.trim() ?? ''}
        saving={ctl.saving}
        canSave={!ctl.readOnly}
        onKeep={ctl.keepEditing}
        onDiscard={ctl.discardAndContinue}
        onSave={() => void ctl.saveAndContinue()}
      />
      <DeleteMacroModal
        open={ctl.deleteOpen && !!ctl.macro}
        title={ctl.macro?.title ?? ''}
        busy={ctl.busy === 'delete'}
        onCancel={() => ctl.setDeleteOpen(false)}
        onConfirm={() => void ctl.hardDelete()}
      />
    </div>
  );
}
