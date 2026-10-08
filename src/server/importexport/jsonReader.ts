/**
 * JSON import reader. Accepted shapes:
 *  - MacroPilot export: {format: 'macropilot-macros', version: 1, categories: [{id, name, color}], macros: [...]}
 *  - {macros: [...]} (optionally with the same categories list)
 *  - a bare array of macro objects
 *  - a single macro object
 * Macro keys use the shared synonyms (title|name, body|text|content, ...). The category is the macro's
 * `category` name when present, otherwise its `categoryId` resolved through the categories list; its color comes
 * from that list too. The export's `archived` and `isFavorite` flags are kept for MacroPilot's own format only.
 */
import { EXPORT_FORMAT, EXPORT_VERSION } from './exportFormat.js';
import { normalizeKey, resolveFields } from './fields.js';
import type { ImportField } from './fields.js';
import { isRecord } from './normalize.js';
import type { RawMacro, SourceRead } from './normalize.js';
import type { ProblemLog } from './problems.js';

const empty = (): SourceRead => ({ raws: [], native: false });

/** Category colors as the app writes them (#rgb, #rgba, #rrggbb, #rrggbbaa); anything else is ignored. */
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const WHITESPACE_RUN_RE = /\s+/g;

interface CategoryList {
  /** id -> name */
  names: Map<string, string>;
  /** normalized name -> color */
  colors: Map<string, string>;
}

const nameKey = (name: string): string => name.trim().toLowerCase().replace(WHITESPACE_RUN_RE, ' ');

/** Read macros from JSON text; structural problems are reported to `log`. */
export function readJson(text: string, log: ProblemLog): SourceRead {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    log.add(`The JSON could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return empty();
  }
  if (Array.isArray(data)) return { raws: toRawMacros(data, readCategories(undefined), false, log), native: false };
  if (!isRecord(data)) {
    log.add('The JSON must be a list of macros or an object with a "macros" list.');
    return empty();
  }

  const native = data.format === EXPORT_FORMAT;
  // A hand-edited "version": "1" is the same version; anything else gets a message that shows the value as written.
  if (native && data.version !== undefined && String(data.version) !== String(EXPORT_VERSION)) {
    log.add(`Unsupported export version ${JSON.stringify(data.version)}; this app reads version ${EXPORT_VERSION}.`);
    return empty();
  }
  if (!('macros' in data)) {
    if (!native) return { raws: toRawMacros([data], readCategories(undefined), false, log), native: false };
    log.add('The export file has no "macros" list.');
    return empty();
  }
  if (!Array.isArray(data.macros)) {
    log.add('"macros" must be a list.');
    return empty();
  }
  return { raws: toRawMacros(data.macros, readCategories(data.categories), native, log), native };
}

/** id -> name and name -> color for a `categories: [{id, name, color}]` list; anything malformed is ignored. */
function readCategories(categories: unknown): CategoryList {
  const list: CategoryList = { names: new Map(), colors: new Map() };
  if (!Array.isArray(categories)) return list;
  for (const category of categories) {
    if (!isRecord(category) || typeof category.name !== 'string') continue;
    if (typeof category.id === 'string') list.names.set(category.id, category.name);
    const color = typeof category.color === 'string' ? category.color.trim() : '';
    const key = nameKey(category.name);
    if (key && HEX_COLOR_RE.test(color) && !list.colors.has(key)) list.colors.set(key, color);
  }
  return list;
}

function toRawMacros(entries: readonly unknown[], categories: CategoryList, native: boolean, log: ProblemLog): RawMacro[] {
  const raws: RawMacro[] = [];
  entries.forEach((entry, i) => {
    const label = `Item ${i + 1}`;
    if (!isRecord(entry)) {
      log.add(`${label}: expected an object with a title and body`);
      return;
    }
    const values = pickFields(entry);
    if (!hasText(values.category) && typeof entry.categoryId === 'string') {
      values.category = categories.names.get(entry.categoryId) ?? null;
    }
    const extras: NonNullable<RawMacro['extras']> = {};
    const color = typeof values.category === 'string' ? categories.colors.get(nameKey(values.category)) : undefined;
    if (color) extras.categoryColor = color;
    if (native && entry.archived === true) extras.archived = true;
    if (native && entry.isFavorite === true) extras.isFavorite = true;
    raws.push(Object.keys(extras).length ? { label, values, extras } : { label, values });
  });
  return raws;
}

function pickFields(entry: Record<string, unknown>): Partial<Record<ImportField, unknown>> {
  const keys = new Map<string, string>();
  for (const key of Object.keys(entry)) {
    const normalized = normalizeKey(key);
    if (!keys.has(normalized)) keys.set(normalized, key);
  }
  const values: Partial<Record<ImportField, unknown>> = {};
  for (const [field, key] of resolveFields(keys)) values[field] = entry[key];
  return values;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
