/**
 * First-run recovery key dialog (mounted globally by App).
 *
 * On start it asks the server whether the recovery key has been acknowledged. If not, the key (which the server
 * keeps only until acknowledgement) is shown once with Copy / Download actions. The agent must tick
 * "I have saved my recovery key" before Continue acknowledges it. "Remind me later" hides the dialog for this
 * browser session only. Settings > Security can reopen it via openRecoveryKeyDialog().
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useHotkeys } from '../hotkeys';
import { useStore } from '../store';
import { Button, Modal, Spinner, toast } from '../ui';
import { RecoveryKeyDisplay } from './settings/RecoveryKeyDisplay';
import { errorMessage, sessionFlag } from './settings/settingsUtils';
import './settings/recovery-key.css';

const REMIND_LATER_KEY = 'macropilot.recoveryKey.remindLater';
const OPEN_EVENT = 'macropilot:open-recovery-key';
/** Fired after the recovery key was acknowledged or rotated, so open views can refresh the security status. */
export const SECURITY_CHANGED_EVENT = 'macropilot:security-changed';

/** Reopen the recovery key dialog (ignores "Remind me later"). */
export function openRecoveryKeyDialog(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function notifySecurityChanged(): void {
  window.dispatchEvent(new Event(SECURITY_CHANGED_EVENT));
}

export function Onboarding() {
  const ready = useStore((s) => s.loaded && !s.loadError);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const check = useCallback(async (manual: boolean) => {
    if (!manual && sessionFlag.get(REMIND_LATER_KEY)) return;
    try {
      const status = await api('GET /api/security/status');
      if (status.recoveryKeyAcknowledged) {
        if (manual) toast('Your recovery key is already confirmed. Generate a new one in Settings if you lost it.', 'info', 4000);
        return;
      }
      const { recoveryKey: key } = await api('GET /api/security/recovery-key');
      if (!key) {
        if (manual) toast('No recovery key is waiting to be saved. Generate a new one in Settings > Security.', 'warning', 4000);
        return;
      }
      setSaved(false);
      setRecoveryKey(key);
    } catch (err) {
      toast(`Could not check the recovery key: ${errorMessage(err)}`, 'danger');
    }
  }, []);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    void check(false);
  }, [ready, check]);

  useEffect(() => {
    const onOpen = () => void check(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [check]);

  const remindLater = useCallback(() => {
    sessionFlag.set(REMIND_LATER_KEY, true);
    setRecoveryKey(null);
    toast('We will remind you the next time you open MacroPilot.', 'info');
  }, []);

  const acknowledge = useCallback(async () => {
    if (!saved || busy) return;
    setBusy(true);
    try {
      await api('POST /api/security/recovery-key/ack');
      sessionFlag.set(REMIND_LATER_KEY, false);
      setRecoveryKey(null);
      notifySecurityChanged();
      toast('Recovery key confirmed. Your library is protected.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      setBusy(false);
    }
  }, [saved, busy]);

  const open = recoveryKey !== null;
  useHotkeys(open ? { 'mod+enter': () => void acknowledge() } : {}, [open, acknowledge]);

  return (
    <Modal
      open={open}
      title="Save your recovery key"
      onClose={remindLater}
      footer={
        <>
          <Button variant="ghost" onClick={remindLater} disabled={busy}>
            Remind me later
          </Button>
          <Button
            variant="primary"
            onClick={() => void acknowledge()}
            disabled={!saved || busy}
            hotkey={saved ? 'mod+enter' : undefined}
          >
            {busy ? <Spinner label="Saving" /> : null}
            Continue
          </Button>
        </>
      }
    >
      {recoveryKey ? (
        <div className="ob">
          <p>
            Your macro library is <strong>encrypted on this computer</strong> (AES-256-GCM). The encryption key is kept
            on this computer (in the system keychain when available), so there is no password to type.
          </p>
          <div>
            <p>This recovery key is the only way to:</p>
            <ul className="ob-points">
              <li>restore an encrypted backup (.mpbackup) on another computer,</li>
              <li>recover your library if the system keychain is lost or reset.</li>
            </ul>
          </div>
          <RecoveryKeyDisplay recoveryKey={recoveryKey} autoFocus />
          <p className="ob-warning">
            Store it in a password manager (1Password, Bitwarden, KeePass...). It is shown only until you confirm, and
            nobody - not even MacroPilot - can recover it for you.
          </p>
          <label className="ob-confirm">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved my
            recovery key
          </label>
        </div>
      ) : null}
    </Modal>
  );
}
