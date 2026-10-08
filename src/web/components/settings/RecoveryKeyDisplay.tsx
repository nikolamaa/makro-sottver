/**
 * Shows a recovery key in large monospace with Copy and Download .txt actions.
 * Used by the first-run onboarding dialog and by Settings > Security after generating a new key.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { Button, copyToClipboard, toast } from '../../ui';
import { downloadText } from './settingsUtils';
import './recovery-key.css';

function keyFileText(recoveryKey: string): string {
  const created = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return [
    'MacroPilot recovery key',
    '=======================',
    '',
    recoveryKey,
    '',
    `Saved: ${created}`,
    '',
    'Keep this key in a password manager. It is the only way to:',
    '  - restore an encrypted backup (.mpbackup) on another computer,',
    '  - regain access to your library if the system keychain is lost (npm run recover).',
    '',
    'Do not share it. Anyone who has this key AND one of your backups can read your macros.',
    'Delete this file once the key is stored in your password manager.',
    '',
  ].join('\n');
}

export function RecoveryKeyDisplay({ recoveryKey, autoFocus }: { recoveryKey: string; autoFocus?: boolean }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const onCopy = async () => {
    const ok = await copyToClipboard(recoveryKey);
    if (!ok) {
      toast('Could not copy - select the key and copy it manually', 'danger');
      return;
    }
    setCopied(true);
    toast('Recovery key copied', 'success');
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const onDownload = () => {
    downloadText('macropilot-recovery-key.txt', keyFileText(recoveryKey));
  };

  // Allow line breaks after each dash so the key wraps cleanly on narrow screens; copying still yields the exact key.
  const parts = recoveryKey.split('-');

  return (
    <div className="rk">
      <code className="rk-key" aria-label="Recovery key" translate="no" spellCheck={false}>
        {parts.map((part, i) => (
          <Fragment key={i}>
            {part}
            {i < parts.length - 1 ? (
              <>
                -<wbr />
              </>
            ) : null}
          </Fragment>
        ))}
      </code>
      <div className="rk-actions">
        <Button variant="primary" autoFocus={autoFocus} onClick={() => void onCopy()}>
          {copied ? 'Copied ✓' : 'Copy'}
        </Button>
        <Button onClick={onDownload}>Download .txt</Button>
      </div>
    </div>
  );
}
