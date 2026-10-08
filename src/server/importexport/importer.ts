/**
 * Import parsers for macros the agent copies out of Intercom by hand (no export permission), plus JSON export.
 * Pure functions, no I/O.
 */
import type { Category, ImportFormat, ImportPreview, Macro } from '../../shared/types.js';

/**
 * Parse import content.
 *  - 'json': either the MacroPilot export format (see toExportJson) or an array of objects with flexible keys
 *            (title|name, body|text|content|message, category, tags (array or comma string), intents, triggers,
 *            notes, shortcut, facts[]).
 *  - 'csv':  RFC 4180 CSV with a header row; header names matched case-insensitively with the same synonyms;
 *            list cells split on ";" or "," for tags/intents and on "|" or newlines for triggers.
 *  - 'text': manual paste. Blocks separated by a line "---" (3+ dashes) or started by "### Title". Inside a
 *            block, the first non-empty line is the title (leading "#"s stripped) unless "### " was used; then
 *            optional header lines "Category: X", "Tags: a, b", "Intents: a, b", "Shortcut: x"; the rest is the body.
 * Intercom attribute syntax is converted: {{first_name}} / {{ first_name | fallback: "there" }} -> {{user|there}},
 * {{name}} -> {{user}}, {{email}} -> {{email}}, other {{ attr | fallback: "x" }} -> {{attr|x}}.
 * Invalid intents are dropped (reported in errors). Empty title or body -> error for that block, skipped.
 * duplicateOf is set when an existing macro has the same normalized title (case/whitespace-insensitive).
 */
export function parseImport(format: ImportFormat, content: string, existing: Pick<Macro, 'id' | 'title'>[]): ImportPreview {
  throw new Error('TODO');
}

/** Plaintext export (UI warns the user). Accepted back by parseImport('json'). */
export function toExportJson(macros: Macro[], categories: Category[], exportedAt?: Date): string {
  throw new Error('TODO');
}
