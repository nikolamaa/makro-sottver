/** Confirmation dialogs used by the Library: unsaved-changes guard and permanent delete. */
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Kbd, Modal, Spinner } from '../../ui';

export function UnsavedChangesModal({
  open,
  title,
  saving,
  canSave,
  onKeep,
  onDiscard,
  onSave,
}: {
  open: boolean;
  title: string;
  saving: boolean;
  canSave: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  useEffect(() => {
    if (open) requestAnimationFrame(() => document.getElementById(canSave ? 'lib-unsaved-save' : 'lib-unsaved-keep')?.focus());
  }, [open, canSave]);
  return (
    <Modal
      open={open}
      title="Unsaved changes"
      onClose={onKeep}
      footer={
        <>
          <Button id="lib-unsaved-keep" variant="ghost" onClick={onKeep} disabled={saving}>
            Keep editing <Kbd combo="escape" />
          </Button>
          <Button variant="danger" onClick={onDiscard} disabled={saving}>
            Discard changes
          </Button>
          {canSave ? (
            <Button id="lib-unsaved-save" variant="primary" onClick={onSave} disabled={saving}>
              {saving ? <Spinner label="Saving" /> : null}
              Save and continue
            </Button>
          ) : null}
        </>
      }
    >
      <p className="lib-modal-text">
        You have unsaved changes in <strong>{title || 'this macro'}</strong>. Save them before continuing?
      </p>
    </Modal>
  );
}

export function DeleteMacroModal({
  open,
  title,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const expected = title.trim();
  const matches = typed.trim() === expected && expected !== '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (matches && !busy) onConfirm();
  };
  return (
    <Modal
      open={open}
      title="Delete macro permanently"
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <button type="submit" form="lib-delete-form" className="btn btn-md lib-btn-danger-solid" disabled={!matches || busy}>
            {busy ? <Spinner label="Deleting" /> : null}
            Delete permanently
          </button>
        </>
      }
    >
      <form id="lib-delete-form" className="stack" onSubmit={submit}>
        <p className="lib-modal-text">
          This deletes <strong>{expected}</strong>, all of its versions and facts. It cannot be undone. To keep the history, use{' '}
          <em>Archive</em> instead.
        </p>
        <label className="field">
          <span className="field-label">
            Type the title <span className="mono">{expected}</span> to confirm
          </span>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
        </label>
      </form>
    </Modal>
  );
}
