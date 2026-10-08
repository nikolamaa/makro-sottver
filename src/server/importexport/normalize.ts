/**
 * Turns loosely typed records from any import source (CSV row, JSON object, text block) into validated
 * ImportItems. Every limit mirrors the /api/import/commit schema so a previewed item can always be committed.
 */
import { INTENT_LABELS, INTENTS } from '../../shared/types.js';
import type { FactInput, FactStatus, Id, ImportItem, Intent, Macro } from '../../shared/types.js';
import type { ImportField } from './fields.js';
import { normalizeKey } from './fields.js';
import { convertIntercomVariables } from './intercom.js';
import type { ProblemLog } from './problems.js';

/** Import limits (items, content size, and per-field limits accepted by the commit endpoint). */
export const IMPORT_LIMITS = {
  maxItems: 5000,
  maxContentBytes: 2 * 1024 * 1024,
  title: 200,
  body: 20_000,
  category: 80,
  notes: 5000,
  shortcut: 60,
  tag: 60,
  maxTags: 40,
  maxIntents: 10,
  trigger: 500,
  maxTriggers: 60,
  maxFacts: 100,
  factKey: 200,
  factStatement: 2000,
  factValue: 2000,
  factSourceUrl: 2000,
  factEvidence: 4000,
} as const;

/** One macro as read from a source, before validation. */
export interface RawMacro {
  /** Location used in messages, e.g. "Row 4", "Item 2" or "Block 3". */
  label: string;
  values: Partial<Record<ImportField, unknown>>;
}

/** Records read from one import source. */
export interface SourceRead {
  raws: RawMacro[];
  /** True for MacroPilot's own export format: bodies already use native syntax, so no Intercom conversion. */
  native: boolean;
}

export interface NormalizeOptions {
  /** Rewrite Intercom attribute syntax in bodies (off for MacroPilot's own export format). */
  convertIntercom: boolean;
}

interface ListRule {
  noun: string;
  maxItems: number;
  maxLength: number;
}

const TAG_RULE: ListRule = { noun: 'tags', maxItems: IMPORT_LIMITS.maxTags, maxLength: IMPORT_LIMITS.tag };
const TRIGGER_RULE: ListRule = { noun: 'triggers', maxItems: IMPORT_LIMITS.maxTriggers, maxLength: IMPORT_LIMITS.trigger };

/** Tags/intents in a single string: "a, b; c" or one per line. */
const LIST_SPLIT_RE = /[;,\n]/;
/** Triggers in a single string: "how long | where is my money" or one per line. */
const TRIGGER_SPLIT_RE = /[|\n]/;
const WHITESPACE_RUN_RE = /\s+/g;
const NEWLINE_RE = /\r\n?/g;
const SLUG_INVALID_RE = /[^a-z0-9]+/g;
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;
const EDGE_UNDERSCORES_RE = /^_+|_+$/g;
const SLUG_MAX_LENGTH = 60;
const MAX_UNKNOWN_SHOWN = 5;
const HTTP_PREFIX_RE = /^https?:/i;

const FACT_STATUSES: ReadonlySet<string> = new Set<FactStatus>(['unchecked', 'verified', 'outdated', 'contradicted', 'unverifiable']);

/** Intent ids and display labels in slug form -> intent ("Missing deposit" and "deposit-missing" both work). */
const INTENT_LOOKUP: ReadonlyMap<string, Intent> = new Map(
  INTENTS.flatMap((intent): [string, Intent][] => [
    [slugify(intent), intent],
    [slugify(INTENT_LABELS[intent]), intent],
  ]),
);

/**
 * Validate raw records into import items. Records with a missing title/body or an over-long field are
 * reported and skipped; list overflows and unknown intents are reported and trimmed. `duplicateOf` is set
 * from `existing` by normalized title, and repeated titles inside the same import are reported.
 */
export function buildItems(
  raws: readonly RawMacro[],
  existing: readonly Pick<Macro, 'id' | 'title'>[],
  log: ProblemLog,
  options: NormalizeOptions,
): ImportItem[] {
  const existingByTitle = new Map<string, Id>();
  for (const macro of existing) {
    const key = titleKey(macro.title);
    if (!existingByTitle.has(key)) existingByTitle.set(key, macro.id);
  }
  const firstLabelByTitle = new Map<string, string>();
  const items: ImportItem[] = [];
  for (const raw of raws) {
    const item = normalizeItem(raw, log, options);
    if (!item) continue;
    const key = titleKey(item.title);
    item.duplicateOf = existingByTitle.get(key) ?? null;
    const firstLabel = firstLabelByTitle.get(key);
    if (firstLabel === undefined) firstLabelByTitle.set(key, raw.label);
    else log.add(`${raw.label}: same title as ${firstLabel}`);
    items.push(item);
  }
  return items;
}

/** Case- and whitespace-insensitive title key (same rule as LibraryService). */
export function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(WHITESPACE_RUN_RE, ' ');
}

function normalizeItem({ label, values }: RawMacro, log: ProblemLog, options: NormalizeOptions): ImportItem | null {
  const title = cleanLine(values.title);
  const multiline = cleanMultiline(values.body);
  const body = options.convertIntercom ? convertIntercomVariables(multiline) : multiline;
  const missing = [title ? null : 'title', body ? null : 'body'].filter((f) => f !== null);
  if (missing.length) {
    log.add(`${label}: missing ${missing.join(' and ')}`);
    return null;
  }
  const category = cleanLine(values.category);
  const notes = cleanMultiline(values.notes);
  const shortcut = cleanLine(values.shortcut);
  const overflow = findOverflow([
    ['title', title, IMPORT_LIMITS.title],
    ['body', body, IMPORT_LIMITS.body],
    ['category', category, IMPORT_LIMITS.category],
    ['notes', notes, IMPORT_LIMITS.notes],
    ['shortcut', shortcut, IMPORT_LIMITS.shortcut],
  ]);
  if (overflow) {
    log.add(`${label}: ${overflow}, skipped`);
    return null;
  }
  return {
    title,
    body,
    category: category || null,
    tags: cleanList(asList(values.tags, LIST_SPLIT_RE), TAG_RULE, label, log),
    intents: readIntents(values.intents, label, log),
    triggers: cleanList(asList(values.triggers, TRIGGER_SPLIT_RE), TRIGGER_RULE, label, log),
    notes,
    shortcut,
    facts: readFacts(values.facts, label, log),
    duplicateOf: null,
  };
}

function findOverflow(fields: readonly (readonly [string, string, number])[]): string | null {
  for (const [name, value, max] of fields) {
    if (value.length > max) return `${name} is longer than ${max} characters`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scalars and lists
// ---------------------------------------------------------------------------

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Single-line value: whitespace (including newlines) collapsed, trimmed. */
function cleanLine(value: unknown): string {
  return asText(value).replace(WHITESPACE_RUN_RE, ' ').trim();
}

/** Multi-line value: Windows/Mac newlines unified, outer whitespace trimmed, inner blank lines kept. */
function cleanMultiline(value: unknown): string {
  return asText(value).replace(NEWLINE_RE, '\n').trim();
}

/** Arrays are taken element by element; strings are split with `separator`. */
function asList(value: unknown, separator: RegExp): string[] {
  if (Array.isArray(value)) return value.map(asText);
  const text = asText(value).replace(NEWLINE_RE, '\n');
  return text ? text.split(separator) : [];
}

/** Trim, drop empties and case-insensitive duplicates, then enforce the rule's length and count limits. */
function cleanList(values: readonly string[], rule: ListRule, label: string, log: ProblemLog): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let tooLong = 0;
  for (const value of values) {
    const text = cleanLine(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    if (text.length > rule.maxLength) tooLong++;
    else out.push(text);
  }
  if (tooLong) log.add(`${label}: ${tooLong} ${rule.noun} longer than ${rule.maxLength} characters skipped`);
  return keepFirst(out, rule.maxItems, rule.noun, label, log);
}

function keepFirst<T>(values: T[], max: number, noun: string, label: string, log: ProblemLog): T[] {
  if (values.length <= max) return values;
  log.add(`${label}: only the first ${max} ${noun} were kept`);
  return values.slice(0, max);
}

function readIntents(value: unknown, label: string, log: ProblemLog): Intent[] {
  const intents: Intent[] = [];
  /** Lowercased name -> name as first written, so "Foo" and "foo" are reported once. */
  const unknown = new Map<string, string>();
  for (const raw of asList(value, LIST_SPLIT_RE)) {
    const text = cleanLine(raw);
    if (!text) continue;
    const intent = INTENT_LOOKUP.get(slugify(text));
    if (intent) {
      if (!intents.includes(intent)) intents.push(intent);
    } else if (!unknown.has(text.toLowerCase())) {
      unknown.set(text.toLowerCase(), text);
    }
  }
  if (unknown.size) log.add(`${label}: unknown intent(s) dropped: ${describeUnknown([...unknown.values()])}`);
  return keepFirst(intents, IMPORT_LIMITS.maxIntents, 'intents', label, log);
}

/** '"a", "b", "c"' - at most MAX_UNKNOWN_SHOWN names, then "and N more", so one bad cell cannot flood the preview. */
function describeUnknown(names: readonly string[]): string {
  const shown = names.slice(0, MAX_UNKNOWN_SHOWN).map(quoteShort).join(', ');
  const hidden = names.length - MAX_UNKNOWN_SHOWN;
  return hidden > 0 ? `${shown} and ${hidden} more` : shown;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * Facts come as an array (JSON) or a JSON array string (CSV cell); a single fact object is accepted too.
 * Bad facts are reported and skipped; keys are made unique within the macro. Reading stops once
 * IMPORT_LIMITS.maxFacts facts were accepted, so a huge list costs nothing beyond JSON parsing.
 */
function readFacts(value: unknown, label: string, log: ProblemLog): FactInput[] {
  const list = parseFactList(value, label, log);
  const facts: FactInput[] = [];
  const usedKeys = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    if (facts.length === IMPORT_LIMITS.maxFacts) {
      log.add(`${label}: only the first ${IMPORT_LIMITS.maxFacts} facts were kept`);
      break;
    }
    const where = `${label}, fact ${i + 1}`;
    const result = toFact(list[i], (note) => log.add(`${where}: ${note}`));
    if (typeof result === 'string') {
      log.add(`${where}: ${result}`);
      continue;
    }
    result.key = uniqueKey(result.key, usedKeys);
    facts.push(result);
  }
  return facts;
}

function parseFactList(value: unknown, label: string, log: ProblemLog): unknown[] {
  if (value === undefined || value === null) return [];
  let list = value;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      list = JSON.parse(value);
    } catch {
      log.add(`${label}: facts are not valid JSON and were skipped`);
      return [];
    }
  }
  if (Array.isArray(list)) return list;
  if (isRecord(list)) return [list];
  log.add(`${label}: facts must be a list and were skipped`);
  return [];
}

/**
 * A fact object (or a plain statement string) -> FactInput, or a problem description when the fact is skipped.
 * A source that is not an http(s) link (e.g. "Confluence") is dropped and reported through `note`, because the
 * library editor refuses to save such a fact.
 */
function toFact(rawFact: unknown, note: (problem: string) => void): FactInput | string {
  if (typeof rawFact === 'string') return toFact({ statement: rawFact }, note);
  if (!isRecord(rawFact)) return 'expected an object with a statement';
  const get = keyedGetter(rawFact);
  const statement = cleanMultiline(get('statement'));
  if (!statement) return 'missing statement';
  const source = cleanLine(get('sourceurl')) || cleanLine(get('source'));
  const sourceIsLink = isHttpUrl(source);
  if (source && !sourceIsLink) note(`source ${quoteShort(source)} is not an http(s) link and was dropped`);
  const fact: FactInput = {
    key: cleanLine(get('key')) || defaultFactKey(statement),
    statement,
    value: cleanMultiline(get('value')),
    sourceUrl: sourceIsLink ? source : null,
    evidenceQuote: cleanMultiline(get('evidencequote')) || null,
  };
  const status = get('status');
  if (isFactStatus(status)) fact.status = status;
  return factOverflow(fact) ?? fact;
}

/** Slug of the statement, e.g. "Minimum deposit is 10 USD" -> "minimum_deposit_is_10_usd". */
function defaultFactKey(statement: string): string {
  return slugify(statement).slice(0, SLUG_MAX_LENGTH).replace(EDGE_UNDERSCORES_RE, '') || 'fact';
}

/** Same rule as the library editor: an absolute http: or https: URL. */
function isHttpUrl(text: string): boolean {
  if (!HTTP_PREFIX_RE.test(text)) return false;
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isFactStatus(value: unknown): value is FactStatus {
  return typeof value === 'string' && FACT_STATUSES.has(value);
}

function factOverflow(fact: FactInput): string | null {
  const overflow = findOverflow([
    ['key', fact.key, IMPORT_LIMITS.factKey],
    ['statement', fact.statement, IMPORT_LIMITS.factStatement],
    ['value', fact.value, IMPORT_LIMITS.factValue],
    ['source URL', fact.sourceUrl ?? '', IMPORT_LIMITS.factSourceUrl],
    ['evidence quote', fact.evidenceQuote ?? '', IMPORT_LIMITS.factEvidence],
  ]);
  return overflow && `${overflow}, skipped`;
}

/** Look up object properties by normalized key ("source_url", "sourceUrl" and "Source URL" are equal). */
function keyedGetter(record: Record<string, unknown>): (normalized: string) => unknown {
  const byKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeKey(key);
    if (!byKey.has(normalized)) byKey.set(normalized, value);
  }
  return (normalized) => byKey.get(normalized);
}

/** `key`, or `key_2`, `key_3`, ... when taken; the base is shortened so the result stays within the key limit. */
function uniqueKey(key: string, used: Set<string>): string {
  let candidate = key;
  for (let n = 2; used.has(candidate); n++) {
    const suffix = `_${n}`;
    candidate = key.slice(0, IMPORT_LIMITS.factKey - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True for plain JSON objects (not arrays or null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** "Missing deposit (BTC)" -> "missing_deposit_btc" */
function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RE, '')
    .toLowerCase()
    .replace(SLUG_INVALID_RE, '_')
    .replace(EDGE_UNDERSCORES_RE, '');
}

function quoteShort(text: string): string {
  return text.length > 40 ? `"${text.slice(0, 40)}..."` : `"${text}"`;
}
