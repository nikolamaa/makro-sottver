/**
 * Small text helpers shared by the personalization modules. Pure functions, no I/O.
 */

/** Escape a literal string for use inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/**
 * Regex source matching `value` literally, with word boundaries on the sides that start/end with a word
 * character (so "Ann" does not match inside "Announcement", but "john@x.com" still matches before a comma).
 * Unicode-aware: use with the 'u' flag.
 */
export function boundedPattern(value: string): string {
  const head = WORD_CHAR_RE.test(value.charAt(0)) ? '(?<![\\p{L}\\p{N}_])' : '';
  const tail = WORD_CHAR_RE.test(value.charAt(value.length - 1)) ? '(?![\\p{L}\\p{N}_])' : '';
  return `${head}${escapeRegExp(value)}${tail}`;
}

/** 32-bit FNV-1a hash; stable across runs, used for deterministic phrase selection. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** First lowercase letter of a word that has no capitals later on ("iOS", "eSports" are left alone). */
const FIRST_LETTER_RE = /^([\s"'“‘(*_]*)(\p{Ll})(?![\p{L}\p{N}]*\p{Lu})/u;

/** Upper-case the first letter (skipping leading quotes/brackets/whitespace), unless the word is camel-cased. */
export function capitalizeFirst(text: string): string {
  return text.replace(FIRST_LETTER_RE, (_m, lead: string, letter: string) => lead + letter.toUpperCase());
}

/** Normalize line endings to "\n". */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Collapse runs of 3+ newlines to a single blank line and trim the ends. */
export function tidyParagraphs(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Case-insensitive lookup of a non-empty (trimmed) value in a variables map. */
export function variableValue(vars: Record<string, string | undefined>, name: string): string | undefined {
  for (const [key, value] of Object.entries(vars)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}
