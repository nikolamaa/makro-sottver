/**
 * Settings > Security: where the master key lives, data folder, recovery key status and rotation.
 * A new recovery key stays pending on the server (shown again by "Show recovery key" / the start-up dialog) until
 * the agent confirms it was saved, which calls POST /api/security/recovery-key/ack.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SecurityStatus } from '../../../shared/types';
import { api } from '../../api';
import { Badge, Button, Modal, Spinner, copyToClipboard, toast } from '../../ui';
import { SECURITY_CHANGED_EVENT, notifySecurityChanged, openRecoveryKeyDialog } from '../Onboarding';
import { RecoveryKeyDisplay } from './RecoveryKeyDisplay';
import { SectionCard, SettingRow } from './controls';
import { errorMessage } from './settingsUtils';
import './recovery-key.css';

const KEY_STORAGE: Record<SecurityStatus['keyStorage'], { label: string; tone: 'success' | 'warning' | 'info'; text: string }> = {
  keychain: {
    label: 'System keychain',
    tone: 'success',
    text: 'The master key is kept in your operating system keychain (Windows Credential Manager, macOS Keychain or Linux Secret Service). A copy of the data folder alone cannot be decrypted.',
  },
  file: {
    label: 'Protected key file',
    tone: 'warning',
    text: 'The system keychain was not available, so the master key is kept in a protected file (readable only by your user) in a different folder than the data. Do not copy that file together with the data folder.',
  },
  env: {
    label: 'Environment variable',
    tone: 'info',
    text: 'The master key is supplied through the MACROPILOT_MASTER_KEY environment variable and is never written to disk by MacroPilot.',
  },
};

export function SecuritySection() {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [newKeySaved, setNewKeySaved] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api('GET /api/security/status'));
      setError(null);
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      toast(`Could not load security status: ${msg}`, 'danger');
    }
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener(SECURITY_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SECURITY_CHANGED_EVENT, onChange);
  }, [load]);

  const closeConfirm = useCallback(() => {
    if (!rotating) setConfirmOpen(false);
  }, [rotating]);

  const rotate = async () => {
    setRotating(true);
    try {
      const { recoveryKey } = await api('POST /api/security/recovery-key/rotate');
      setConfirmOpen(false);
      setNewKeySaved(false);
      setNewKey(recoveryKey);
      notifySecurityChanged();
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      setRotating(false);
    }
  };

  /** Close without confirming: the key stays pending and can be shown again until it is confirmed. */
  const closeNewKey = useCallback(() => {
    if (confirming) return;
    setNewKey(null);
    toast('The new recovery key is not confirmed yet. "Show recovery key" shows it again until you confirm it.', 'warning', 6000);
  }, [confirming]);

  const confirmNewKey = async () => {
    if (!newKeySaved || confirming) return;
    setConfirming(true);
    try {
      await api('POST /api/security/recovery-key/ack');
      setNewKey(null);
      notifySecurityChanged();
      toast('New recovery key confirmed', 'success');
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      setConfirming(false);
    }
  };

  const copyDir = async () => {
    if (!status) return;
    const ok = await copyToClipboard(status.dataDir);
    toast(ok ? 'Folder path copied' : 'Could not copy', ok ? 'success' : 'danger');
  };

  const storage = status ? KEY_STORAGE[status.keyStorage] : null;

  return (
    <SectionCard id="st-security" title="Security" description="No login needed: the app only listens on this computer and everything you store is encrypted.">
      {!status ? (
        <div className="st-loading">
          {error ? (
            <>
              <span className="error small">{error}</span>
              <Button size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </>
          ) : (
            <>
              <Spinner label="Loading security status" /> <span className="muted small">Loading security status...</span>
            </>
          )}
        </div>
      ) : (
        <>
          <SettingRow label="Encryption" hint="Macros, facts, settings, API keys and search vectors are all encrypted.">
            <Badge tone="success">🔒 All data encrypted at rest (AES-256-GCM)</Badge>
          </SettingRow>
          <SettingRow label="Master key storage" hint={storage?.text}>
            <Badge tone={storage?.tone ?? 'neutral'}>{storage?.label ?? status.keyStorage}</Badge>
          </SettingRow>
          <SettingRow label="Data folder" wide hint="The encrypted database lives here. It cannot be read without the master key.">
            <div className="st-path">
              <code className="st-path-text" title={status.dataDir}>
                {status.dataDir}
              </code>
              <Button size="sm" onClick={() => void copyDir()}>
                Copy
              </Button>
            </div>
          </SettingRow>
          <SettingRow
            label="Recovery key"
            wide
            hint="Needed to restore a backup on another computer or to recover if the system keychain is lost."
          >
            <div className="st-actions">
              <Badge tone={status.recoveryKeyAcknowledged ? 'success' : 'warning'}>
                {status.recoveryKeyAcknowledged ? '✓ Saved by you' : 'Not saved yet'}
              </Badge>
              {!status.recoveryKeyAcknowledged ? (
                <Button size="sm" variant="primary" onClick={openRecoveryKeyDialog}>
                  Show recovery key
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setConfirmOpen(true)}>
                Generate new recovery key
              </Button>
            </div>
          </SettingRow>
        </>
      )}

      <Modal
        open={confirmOpen}
        title="Generate a new recovery key?"
        onClose={closeConfirm}
        footer={
          <>
            <Button variant="ghost" onClick={closeConfirm} disabled={rotating} autoFocus>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void rotate()} disabled={rotating}>
              {rotating ? <Spinner label="Generating" /> : null}
              Generate new key
            </Button>
          </>
        }
      >
        <div className="ob">
          <p>A new recovery key replaces the current one:</p>
          <ul className="ob-points">
            <li>
              From now on, <code>npm run recover</code> and new encrypted backups need the new key. The old key does not
              open them.
            </li>
            <li>
              The encryption key of your library stays the same, so backups made earlier (and old copies of the data
              folder) still open with the old key. Keep the old key until you have made a fresh backup.
            </li>
            <li>
              It does not shut out an old key that has already leaked: together with an older backup or an old copy of
              the data folder, the old key still reveals the library&apos;s encryption key, which also opens backups made
              later. If that happened, delete old backups and old copies of the data folder after making a new backup.
            </li>
            <li>Have your password manager ready. The new key is shown until you confirm that you saved it.</li>
          </ul>
        </div>
      </Modal>

      <Modal
        open={newKey !== null}
        title="Your new recovery key"
        onClose={closeNewKey}
        footer={
          <>
            <Button variant="ghost" onClick={closeNewKey} disabled={confirming}>
              Later
            </Button>
            <Button variant="primary" onClick={() => void confirmNewKey()} disabled={!newKeySaved || confirming}>
              {confirming ? <Spinner label="Saving" /> : null}
              Done
            </Button>
          </>
        }
      >
        {newKey ? (
          <div className="ob">
            <p>
              Store this key in your password manager now. Until you confirm below, &quot;Show recovery key&quot; in
              Settings &gt; Security shows it again; after that nobody, not even MacroPilot, can show it again.
            </p>
            <RecoveryKeyDisplay recoveryKey={newKey} autoFocus />
            <p className="ob-warning">Tip: make a new encrypted backup (Import / Export page) so your latest backup matches this key.</p>
            <label className="ob-confirm">
              <input type="checkbox" checked={newKeySaved} onChange={(e) => setNewKeySaved(e.target.checked)} />I have saved
              my new recovery key
            </label>
          </div>
        ) : null}
      </Modal>
    </SectionCard>
  );
}
