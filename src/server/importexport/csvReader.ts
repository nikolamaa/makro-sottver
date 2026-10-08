/**
 * CSV import reader (RFC 4180 with a header row). Header names are matched with the shared synonyms;
 * unknown columns are ignored. The delimiter (",", ";" or tab) is detected from the header line, so
 * Excel's semicolon CSV and tab-separated copies from Google Sheets work too.
 * Rows are numbered like a spreadsheet: the header is row 1, the first data row is row 2.
 */
import { parse } from 'csv-parse/sync';
import { normalizeKey, resolveFields } from './fields.js';
import type { ImportField } from './fields.js';
import type { RawMacro } from './normalize.js';
import type { ProblemLog } from './problems.js';

const DELIMITERS = [',', ';', '\t'] as const;
/** Required columns with the header names users can pick from. */
const REQUIRED_COLUMNS = [
  ['title', 'a title column (title, name, macro or macro name)'],
  ['body', 'a body column (body, text, content, message, reply or template)'],
] as const satisfies readonly (readonly [ImportField, string])[];

/** Read macros from CSV text; structural problems are reported to `log`. */
export function readCsv(text: string, log: ProblemLog): RawMacro[] {
  let rows: string[][];
  try {
    rows = parse(text, {
      bom: true,
      delimiter: detectDelimiter(text),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    log.add(`The CSV could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const [header, ...records] = rows;
  if (!header) return [];

  const columns = resolveFields(headerIndex(header));
  const missing = REQUIRED_COLUMNS.filter(([field]) => !columns.has(field)).map(([, hint]) => hint);
  if (missing.length) {
    log.add(`The CSV header row needs ${missing.join(' and ')}.`);
    return [];
  }

  const raws: RawMacro[] = [];
  records.forEach((record, i) => {
    if (record.every((cell) => cell.trim() === '')) return;
    const values: Partial<Record<ImportField, unknown>> = {};
    for (const [field, index] of columns) values[field] = record[index] ?? '';
    raws.push({ label: `Row ${i + 2}`, values });
  });
  return raws;
}

/** Normalized header name -> column index (first occurrence wins). */
function headerIndex(header: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    const key = normalizeKey(name);
    if (key && !index.has(key)) index.set(key, i);
  });
  return index;
}

/** The candidate delimiter that occurs most often in the header line (comma on ties). */
function detectDelimiter(text: string): string {
  const newline = text.indexOf('\n');
  const headerLine = newline === -1 ? text : text.slice(0, newline);
  let best: string = DELIMITERS[0];
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = headerLine.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}
