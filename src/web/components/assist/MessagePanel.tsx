import { memo, type ClipboardEvent, type RefObject } from 'react';
import { isMac } from '../../hotkeys';
import { Button } from '../../ui';
import type { AssistActions } from './useAssist';
import { MAX_VARIABLE_CHARS } from './variables';

interface MessagePanelProps {
  message: string;
  customerName: string;
  /** Detected name or the configured fallback, shown as the name input's placeholder. */
  namePlaceholder: string;
  messageRef: RefObject<HTMLTextAreaElement | null>;
  actions: AssistActions;
}

const MESSAGE_PLACEHOLDER = `Paste the customer's message - ${isMac ? '⌘V' : 'Ctrl+V'} anywhere`;

/**
 * Pasting into an empty box (or over the whole text) starts a new conversation, which also resets the
 * customer name and variables; pasting into the middle of the text is a normal edit.
 */
function onMessagePaste(e: ClipboardEvent<HTMLTextAreaElement>, actions: AssistActions): void {
  const el = e.currentTarget;
  if (el.selectionStart !== 0 || el.selectionEnd !== el.value.length) return;
  const text = e.clipboardData.getData('text/plain');
  if (!text.trim()) return;
  e.preventDefault();
  actions.loadMessage(text);
}

/** Customer message box plus the customer-name override. */
export const MessagePanel = memo(function MessagePanel({ message, customerName, namePlaceholder, messageRef, actions }: MessagePanelProps) {
  return (
    <section className="panel assist-message" aria-label="Customer message">
      <div className="assist-section-head">
        <label htmlFor="assist-message" className="assist-title">
          Customer message
        </label>
        <div className="row">
          <Button size="sm" variant="ghost" hotkey="mod+shift+v" onClick={() => void actions.readClipboard()}>
            Read clipboard
          </Button>
          <Button size="sm" variant="ghost" hotkey="escape" onClick={actions.clear} disabled={!message}>
            Clear
          </Button>
        </div>
      </div>
      <textarea
        id="assist-message"
        ref={messageRef}
        className="assist-message-input"
        autoFocus
        rows={7}
        value={message}
        placeholder={MESSAGE_PLACEHOLDER}
        onChange={(e) => actions.setMessage(e.target.value)}
        onPaste={(e) => onMessagePaste(e, actions)}
      />
      <div className="assist-name">
        <label htmlFor="assist-name" className="field-label">
          Customer name
        </label>
        <input
          id="assist-name"
          value={customerName}
          placeholder={namePlaceholder}
          maxLength={MAX_VARIABLE_CHARS}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => actions.setCustomerName(e.target.value)}
        />
      </div>
    </section>
  );
});
