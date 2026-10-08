/**
 * Plain-text import reader for macros copied out of Intercom by hand.
 *
 * Blocks are separated by a line of 3+ dashes ("---") or start with a "### Title" heading.
 * In a block, the first non-empty line is the title (leading "#"s stripped). It may be followed by header
 * lines "Category: X", "Tags: a, b", "Intents: a, b", "Shortcut: x" (also "Folder:", "Labels:", "Intent:").
 * Everything after the first non-header line is the body; internal blank lines are kept.
 */
import { normalizeKey } from './fields.js';
import type { ImportField } from './fields.js';
import type { RawMacro } from './normalize.js';

const SEPARATOR_RE = /^\s*-{3,}\s*$/;
const HEADING_RE = /^\s*###\s+(\S.*)$/;
const LEADING_HASHES_RE = /^#+\s*/;

/**
 * Header keys accepted right after the title. Deliberately narrower than the CSV/JSON synonyms so a body
 * that starts with e.g. "Code: WELCOME" or "Note: ..." is not mistaken for a header.
 */
const TEXT_HEADERS: ReadonlyMap<string, ImportField> = new Map<string, ImportField>([
  ['category', 'category'],
  ['folder', 'category'],
  ['tags', 'tags'],
  ['labels', 'tags'],
  ['intents', 'intents'],
  ['intent', 'intents'],
  ['shortcut', 'shortcut'],
]);

/** Split newline-normalized text into macro blocks. Blank blocks are ignored. */
export function readText(text: string): RawMacro[] {
  return splitBlocks(text.split('\n')).map((lines, i) => blockToRaw(lines, `Block ${i + 1}`));
}

function splitBlocks(lines: readonly string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  let hasContent = false;
  const flush = (): void => {
    if (hasContent) blocks.push(current);
    current = [];
    hasContent = false;
  };
  for (const line of lines) {
    if (SEPARATOR_RE.test(line)) {
      flush();
      continue;
    }
    if (HEADING_RE.test(line)) flush();
    current.push(line);
    hasContent ||= line.trim() !== '';
  }
  flush();
  return blocks;
}

/** First non-empty line = title, then header lines, then the body. */
function blockToRaw(lines: readonly string[], label: string): RawMacro {
  let i = lines.findIndex((line) => line.trim() !== '');
  const first = lines[i] ?? '';
  const heading = HEADING_RE.exec(first);
  const values: Partial<Record<ImportField, unknown>> = {
    title: heading?.[1] ?? first.trim().replace(LEADING_HASHES_RE, ''),
  };
  for (i++; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const header = parseHeaderLine(line);
    if (!header) break;
    values[header.field] = header.value;
  }
  values.body = lines.slice(i).join('\n');
  return { label, values };
}

/** "Tags: a, b" -> {field: 'tags', value: 'a, b'}; null when the line is not a known header. */
function parseHeaderLine(line: string): { field: ImportField; value: string } | null {
  const colon = line.indexOf(':');
  const field = colon === -1 ? undefined : TEXT_HEADERS.get(normalizeKey(line.slice(0, colon)));
  return field ? { field, value: line.slice(colon + 1).trim() } : null;
}
