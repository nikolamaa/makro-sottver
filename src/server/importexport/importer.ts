/**
 * Import parsers for macros the agent copies out of Intercom by hand (no export permission), plus JSON export.
 * Pure functions, no I/O.
 */
import type { Category, ImportFormat, ImportPreview, Macro } from '../../shared/types.js';
import { readCsv } from './csvReader.js';
import { EXPORT_FORMAT, EXPORT_VERSION } from './exportFormat.js';
import type { ExportedMacro, ExportFile } from './exportFormat.js';
import { readJson } from './jsonReader.js';
import { buildItems, IMPORT_LIMITS } from './normalize.js';
import type { SourceRead } from './normalize.js';
import { ProblemLog } from './problems.js';
import { readText } from './textReader.js';

const BOM = '\uFEFF';
const NEWLINE_RE = /\r\n?/g;
const BYTES_PER_MB = 1024 * 1024;

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
 *
 * Content above 2 MB or with more than 5000 macros is rejected as a whole (no items, one error).
 * Bodies from MacroPilot's own export format are taken verbatim (no Intercom conversion).
 */
export function parseImport(format: ImportFormat, content: string, existing: Pick<Macro, 'id' | 'title'>[]): ImportPreview {
  const sizeError = contentSizeError(content);
  if (sizeError) return { items: [], errors: [sizeError] };
  const text = normalizeText(content);
  if (!text.trim()) return { items: [], errors: ['Nothing to import: the content is empty.'] };

  const log = new ProblemLog();
  const source = readSource(format, text, log);
  if (source.raws.length > IMPORT_LIMITS.maxItems) {
    return {
      items: [],
      errors: [`Too many macros (${source.raws.length}); import at most ${IMPORT_LIMITS.maxItems} at a time by splitting the file.`],
    };
  }
  const items = buildItems(source.raws, existing, log, { convertIntercom: !source.native });
  if (!items.length && !log.count) log.add('No macros found in the content.');
  return { items, errors: log.toArray() };
}

/** Plaintext export (UI warns the user). Accepted back by parseImport('json'). */
export function toExportJson(macros: Macro[], categories: Category[], exportedAt?: Date): string {
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: (exportedAt ?? new Date()).toISOString(),
    categories: categories.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    macros: macros.map((m) => toExportedMacro(m, categoryNames)),
  };
  return JSON.stringify(file, null, 2);
}

function toExportedMacro(m: Macro, categoryNames: ReadonlyMap<string, string>): ExportedMacro {
  return {
    id: m.id,
    title: m.title,
    body: m.body,
    categoryId: m.categoryId,
    category: m.categoryId === null ? null : (categoryNames.get(m.categoryId) ?? null),
    tags: m.tags,
    intents: m.intents,
    triggers: m.triggers,
    notes: m.notes,
    shortcut: m.shortcut,
    isFavorite: m.isFavorite,
    archived: m.archivedAt !== null,
    facts: m.facts.map((f) => ({
      key: f.key,
      statement: f.statement,
      value: f.value,
      sourceUrl: f.sourceUrl,
      evidenceQuote: f.evidenceQuote,
      status: f.status,
    })),
  };
}

function readSource(format: ImportFormat, text: string, log: ProblemLog): SourceRead {
  switch (format) {
    case 'json':
      return readJson(text, log);
    case 'csv':
      return { raws: readCsv(text, log), native: false };
    case 'text':
      return { raws: readText(text), native: false };
    default:
      log.add(`Unknown import format "${String(format satisfies never)}".`);
      return { raws: [], native: false };
  }
}

function contentSizeError(content: string): string | null {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= IMPORT_LIMITS.maxContentBytes) return null;
  // Round up so content just over the limit never reads as "2.0 MB; the maximum is 2 MB".
  const mb = (Math.ceil((bytes / BYTES_PER_MB) * 10) / 10).toFixed(1);
  return `The content is too large (${mb} MB); the maximum is ${IMPORT_LIMITS.maxContentBytes / BYTES_PER_MB} MB. Split it into smaller files.`;
}

/** Strip a byte-order mark and unify Windows/old-Mac line endings. */
function normalizeText(content: string): string {
  const withoutBom = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  return withoutBom.replace(NEWLINE_RE, '\n');
}
