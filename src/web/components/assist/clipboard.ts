/**
 * Clipboard rules for the Assist page: the "placeholders left" copy guard, when an automatically read
 * clipboard should replace the message, and paste-target detection.
 */
import { findPlaceholders } from '../../../shared/template';

/** A second copy press within this window copies even when placeholders remain. */
export const COPY_CONFIRM_WINDOW_MS = 3000;
/** Mirrors the server's message size limit; longer clipboard contents are not auto-imported. */
export const MAX_MESSAGE_CHARS = 8000;

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

/**
 * Whether clipboard text read on window focus should become the new customer message: it must be non-empty,
 * within the size limit, and differ from both the current message and the reply the agent last copied.
 */
export function shouldAdoptClipboard(clip: string, currentMessage: string, lastCopiedReply: string): boolean {
  const text = clip.trim();
  return text !== '' && text.length <= MAX_MESSAGE_CHARS && text !== currentMessage.trim() && text !== lastCopiedReply.trim();
}

/** True for inputs, textareas, selects and contenteditable elements (where native paste must win). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Read text from the system clipboard; null when unavailable or permission is denied. */
export async function readClipboardText(): Promise<string | null> {
  try {
    return (await navigator.clipboard.readText()) ?? null;
  } catch {
    return null;
  }
}
