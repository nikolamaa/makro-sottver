/**
 * Clipboard rules for the Assist page: the "placeholders left" copy guard, when an automatically read
 * clipboard should replace the message, which copies came from the app itself, and paste-target detection.
 */
import { findPlaceholders } from '../../../shared/template';
import { copyToClipboard } from '../../ui';

/** A second copy press within this window copies even when placeholders remain. */
export const COPY_CONFIRM_WINDOW_MS = 3000;
/** Mirrors the server's message size limit; longer clipboard contents are not auto-imported. */
export const MAX_MESSAGE_CHARS = 8000;
/** How many of the app's own recent copies auto-read remembers (in memory only, never persisted). */
const REMEMBERED_COPIES = 8;

export type CopyDecision =
  | { action: 'empty' }
  | { action: 'copy' }
  | { action: 'confirm'; placeholders: number; armedUntil: number };

/**
 * Decide what a copy press does. `armedUntil` is the timestamp returned by the previous 'confirm' decision
 * (0 when none): within that window the reply is copied even with placeholders left.
 */
export function decideCopy(text: string, armedUntil: number, now: number): CopyDecision {
  if (!text.trim()) return { action: 'empty' };
  const placeholders = findPlaceholders(text).length;
  if (placeholders === 0 || now <= armedUntil) return { action: 'copy' };
  return { action: 'confirm', placeholders, armedUntil: now + COPY_CONFIRM_WINDOW_MS };
}

const appCopies: string[] = [];

/** Remember a text this app put on the clipboard (reply, macro body, detected value). */
export function rememberAppCopy(text: string): void {
  const t = text.trim();
  const at = appCopies.indexOf(t);
  if (at >= 0) appCopies.splice(at, 1);
  appCopies.push(t);
  if (appCopies.length > REMEMBERED_COPIES) appCopies.shift();
}

/** Copy text to the clipboard and remember it, so clipboard auto-read never mistakes it for a customer message. */
export async function copyText(text: string): Promise<boolean> {
  if (!(await copyToClipboard(text))) return false;
  rememberAppCopy(text);
  return true;
}

/** What the Assist page currently shows. */
export interface ClipboardContext {
  message: string;
  reply: string;
}

/**
 * Whether clipboard text read on window focus should become the new customer message. It must be non-empty and
 * within the size limit, must not be something the app copied itself (a reply, a macro, a detected value), and
 * must not be part of the current message or reply - an agent who copied a tx hash or email from them to look
 * it up elsewhere must not lose the conversation on returning.
 */
export function shouldAdoptClipboard(clip: string, current: ClipboardContext): boolean {
  const text = clip.trim();
  if (!text || text.length > MAX_MESSAGE_CHARS || appCopies.includes(text)) return false;
  return !current.message.includes(text) && !current.reply.includes(text);
}

/** True for inputs, textareas, selects and contenteditable elements (where native paste must win). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Whether Mod+Shift+V ("read clipboard") should load the clipboard as the customer message. In any other text
 * field (reply editor, variables) the browser's own "paste as plain text" wins, so the shortcut never wipes
 * a reply the agent is editing.
 */
export function shortcutReadsClipboard(target: EventTarget | null, messageBox: Element | null): boolean {
  return target === messageBox || !isEditableTarget(target);
}

/** Read text from the system clipboard; null when unavailable or permission is denied. */
export async function readClipboardText(): Promise<string | null> {
  try {
    return (await navigator.clipboard.readText()) ?? null;
  } catch {
    return null;
  }
}
