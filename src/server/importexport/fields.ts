/**
 * Field-name synonyms shared by the CSV reader (header row) and the JSON reader (object keys).
 * Matching ignores case, spaces, underscores and hyphens: "Macro Name", "macro_name" and "MacroName" are equal.
 */

/** Macro fields an import source can provide. */
export type ImportField = 'title' | 'body' | 'category' | 'tags' | 'intents' | 'triggers' | 'notes' | 'shortcut' | 'facts';

/** Accepted names per field, in priority order, already in normalized form (see normalizeKey). */
const FIELD_SYNONYMS: Readonly<Record<ImportField, readonly string[]>> = {
  title: ['title', 'name', 'macro', 'macroname'],
  body: ['body', 'text', 'content', 'message', 'reply', 'template'],
  category: ['category', 'folder', 'group'],
  tags: ['tags', 'labels'],
  intents: ['intents', 'intent'],
  triggers: ['triggers', 'examples', 'examplequestions'],
  notes: ['notes', 'note', 'internalnote'],
  shortcut: ['shortcut', 'code', 'key'],
  facts: ['facts'],
};

const IMPORT_FIELDS = Object.keys(FIELD_SYNONYMS) as ImportField[];
const KEY_NOISE_RE = /[\s_-]+/g;

/** Normalized form of a header or object key: lowercase without spaces, underscores and hyphens. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(KEY_NOISE_RE, '');
}

/**
 * For every field, pick the highest-priority synonym present in `available`
 * (normalized key -> column index or original object key). Fields without a match are absent.
 */
export function resolveFields<T>(available: ReadonlyMap<string, T>): Map<ImportField, T> {
  const resolved = new Map<ImportField, T>();
  for (const field of IMPORT_FIELDS) {
    const synonym = FIELD_SYNONYMS[field].find((s) => available.has(s));
    if (synonym !== undefined) resolved.set(field, available.get(synonym) as T);
  }
  return resolved;
}
