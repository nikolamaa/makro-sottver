/**
 * Anti-hallucination guardrail for AI-written replies: every number, amount, duration, date, link, email address
 * and promise in the reply must be traceable to the macro bodies, the facts, the customer message or the
 * agent-confirmed variables. Pure functions, no I/O.
 */
import { PLACEHOLDER_RE, findPlaceholders, renderTemplate } from '../../shared/template.js';
import type { Fact, GuardrailIssue, GuardrailKind } from '../../shared/types.js';
import { CRYPTO_ALIASES, FIAT_ALIASES } from '../domain/igaming.js';
import { escapeRegExp } from './text.js';

export interface GroundingSources {
  macroBodies: string[];
  facts: Pick<Fact, 'statement' | 'value' | 'sourceUrl'>[];
  message: string;
  variables: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  'twenty-four': 24,
  'forty-eight': 48,
  'seventy-two': 72,
};

/** Non-currency units -> canonical unit. */
const MEASURE_UNITS: Record<string, string> = {
  '%': '%',
  percent: '%',
  'per cent': '%',
  pct: '%',
  x: 'x',
  times: 'x',
  sec: 'second',
  secs: 'second',
  second: 'second',
  seconds: 'second',
  min: 'minute',
  mins: 'minute',
  minute: 'minute',
  minutes: 'minute',
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  day: 'day',
  days: 'day',
  wk: 'week',
  wks: 'week',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  yr: 'year',
  yrs: 'year',
  year: 'year',
  years: 'year',
  confirmation: 'confirmation',
  confirmations: 'confirmation',
  block: 'block',
  blocks: 'block',
  spin: 'spin',
  spins: 'spin',
  'free spin': 'spin',
  'free spins': 'spin',
};

/** Currency words/codes/symbols (fiat + crypto) -> canonical code ("dollars" -> USD, "tether" -> USDT). */
const CURRENCY_WORDS: Record<string, string> = Object.fromEntries(
  Object.entries({ ...FIAT_ALIASES, ...CRYPTO_ALIASES }).map(([alias, code]) => [alias.toLowerCase(), code]),
);

/** Currency symbols written before the amount ("$100", "US$ 5", "R$ 50"). */
const PREFIX_CURRENCIES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(FIAT_ALIASES).filter(([alias]) => /[^a-z]/.test(alias))),
  'us$': 'USD',
  'a$': 'AUD',
};

/** Currency aliases that are also English words; they count as a currency only when written in capitals. */
const AMBIGUOUS_CURRENCY_WORDS = new Set(['try', 'link', 'pen', 'sand', 'uni', 'ape', 'cop', 'sol', 'pol', 'eos', 'ada', 'cro', 'dai', 'ars']);

const UNIT_CANON: Record<string, string> = { ...MEASURE_UNITS, ...CURRENCY_WORDS };
const CURRENCY_CODES = new Set([...Object.values(CURRENCY_WORDS), ...Object.values(PREFIX_CURRENCIES)]);

/** Regex alternation of literal phrases, longest first, spaces matching any whitespace. */
function alternation(phrases: string[]): string {
  return [...phrases]
    .sort((a, b) => b.length - a.length)
    .map((p) => escapeRegExp(p).replace(/ /g, '\\s+'))
    .join('|');
}

// ---------------------------------------------------------------------------
// Regexes (compiled once)
// ---------------------------------------------------------------------------

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const QUANTITY = `(?:${NUMBER}|${alternation(Object.keys(WORD_NUMBERS))})`;
const PREFIX = alternation(Object.keys(PREFIX_CURRENCIES));
const QUALIFIER = String.raw`(?:(?:business|working|calendar|banking)\s+)`;
const QUALIFIER_RE = new RegExp(`^${QUALIFIER}`, 'i');

/**
 * A quantity with optional currency prefix, range ("3-5", "10 to 20") and unit ("24h", "5 %", "100 USDT",
 * "3 business days"). Not preceded by a word character / number punctuation, so ids, hashes and versions
 * ("v1.5", "0x3fa9", "2FA") are not claims.
 */
const CLAIM_RE = new RegExp(
  String.raw`(?<![\w.,/:#@$€£₹¥₺₦₩-])` +
    String.raw`(?:(?<pre>${PREFIX})\s?)?` +
    String.raw`(?<n1>${QUANTITY})(?:st|nd|rd|th)?(?<k1>k)?` +
    String.raw`(?:\s*(?:-|–|—|to)\s*(?:${PREFIX})?\s?(?<n2>${QUANTITY})(?<k2>k)?)?` +
    String.raw`(?:[\s-]*(?<unit>${QUALIFIER}?(?:${alternation(Object.keys(UNIT_CANON))})))?` +
    String.raw`(?![\w%])`,
  'gi',
);

const CURRENCY_MENTION_RE = new RegExp(`(?<![\\w])(?:${alternation(Object.keys(CURRENCY_WORDS))})(?![\\w])`, 'gi');
const DATE_RE = /(?<![\w/.-])(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})(?![\w/-])(?!\.\d)/g;
const TIME_RE = /(?<![\w:.])(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?m\.?)?(?![\w:])/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const TLDS = 'com|net|org|io|gg|bet|casino|games|co|us|uk|ca|info|help|app|tv|ac|ly|ai|dev|eu|de|jp|br|au|nz|bz|cc|xyz|online|site|support';
const URL_RE = new RegExp(
  String.raw`\bhttps?://[^\s<>"'\x60)\]]+|(?<![\w@.-])(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS})\b(?:/[^\s<>"'\x60)\]]*)?`,
  'gi',
);
const URL_TRAILING_PUNCT_RE = /[.,;:!?'"’”]+$/;
const DIGITS_RE = /\d+/g;
/** Pseudonymization tokens (⟦NAME_1⟧, [[NAME_1]]) - never claims, and flagged when left in a reply. */
const PSEUDONYM_TOKEN_RE = /⟦[^⟧\n]*⟧|\[\[[^\]\n]*\]\]/g;
/** "1." / "2)" list markers at line start. */
const LIST_MARKER_RE = /^[ \t]*\d{1,2}[.)](?=\s)/gm;

const PROMISE_PATTERNS = [
  String.raw`\bguarantee(?:s|d|ing)?\b`,
  String.raw`\bwill\s+definitely\b|\bdefinitely\s+will\b`,
  String.raw`\bwill\s+certainly\b|\bcertainly\s+will\b`,
  String.raw`\b(?:i|we)\s+promise\b|\bpromise\s+(?:you|that)\b`,
  String.raw`(?<![\d.,])100\s?%|\b100\s+percent\b`,
  String.raw`\brest\s+assured\b`,
  String.raw`\bwill\s+be\s+(?:credited|processed|approved|released|paid|sent|unlocked|reactivated)\s+(?:today|tonight|immediately|instantly|right\s+away|now)\b`,
  String.raw`\b(?:will\s+)?refund\s+you\b|\bwill\s+(?:be\s+)?refund(?:ed)?\b|\bissue\s+(?:you\s+)?a\s+refund\b`,
  String.raw`\b(?:reimburse|compensate)\s+you\b`,
].map((source) => new RegExp(source, 'gi'));

/** A negation shortly before a promise phrase ("we cannot guarantee", "not 100% sure", "unable to refund you"). */
const NEGATION_BEFORE_RE = /(?:\bnot|n['’]t|\bnever|\bno|\bcannot|\bunable\s+to)\s+(?:[\w'’]+\s+){0,3}$/i;
/** How far back (in characters) a negation may precede the promise phrase. */
const NEGATION_WINDOW = 40;
const NON_SPACE_RE = /\S/;
const LEADING_WORD_RE = /^\S*/;

const DETAILS: Record<GuardrailKind, string> = {
  unsupported_number: 'Not found in the macro, facts or customer message - check this number before sending.',
  unsupported_url: 'Link or address not found in the macro, facts or customer message.',
  unsupported_claim: 'Claim not found in the macro, facts or customer message.',
  promise: 'Promise or guarantee the macro does not make - avoid promising outcomes.',
  placeholder_left: 'Fill in this placeholder before sending.',
};
const TOKEN_DETAIL = 'Unresolved privacy token - replace it with the real value.';

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

interface NumericClaim extends Span {
  text: string;
  /** Canonical quantities: one value, or two for a range. */
  values: string[];
  unit: string | null;
  /** Worth checking on its own: has a unit, or is a number with >= 2 digits. */
  significant: boolean;
}

/** A date or time of day, e.g. key "date:2026-10-08" / "time:14:30". */
interface Stamp {
  text: string;
  key: string;
}

interface Scan {
  urls: { text: string; normalized: string }[];
  emails: string[];
  stamps: Stamp[];
  claims: NumericClaim[];
}

const blank = (match: string): string => ' '.repeat(match.length);

function canonicalQuantity(raw: string, thousands: boolean): string {
  const word = WORD_NUMBERS[raw.toLowerCase()];
  if (word !== undefined) return String(word);
  const digits = raw.replace(/,/g, '');
  if (!thousands && /^\d+$/.test(digits)) return digits.replace(/^0+(?=\d)/, '');
  const n = Number(digits) * (thousands ? 1000 : 1);
  return String(Number(n.toPrecision(12)));
}

/** Canonical unit of a matched unit string, or null for an ambiguous lowercase currency word ("try", "link"). */
function canonicalUnit(raw: string): string | null {
  const bare = raw.replace(QUALIFIER_RE, '');
  const key = bare.toLowerCase().replace(/\s+/g, ' ');
  if (AMBIGUOUS_CURRENCY_WORDS.has(key) && bare !== bare.toUpperCase()) return null;
  return UNIT_CANON[key] ?? null;
}

function isNumeric(raw: string): boolean {
  return /\d/.test(raw);
}

function toClaim(m: RegExpMatchArray): NumericClaim | null {
  const g = m.groups ?? {};
  const n1 = g['n1'];
  if (!n1) return null;
  const start = m.index ?? 0;
  let text = m[0];
  let unit = g['unit'] ? canonicalUnit(g['unit']) : null;
  if (g['unit'] && unit === null) text = text.slice(0, text.length - g['unit'].length).replace(/[\s-]+$/, '');
  if (!unit && g['pre']) unit = PREFIX_CURRENCIES[g['pre'].toLowerCase()] ?? null;

  const raws = g['n2'] ? [n1, g['n2']] : [n1];
  const values = [canonicalQuantity(n1, Boolean(g['k1']))];
  if (g['n2']) values.push(canonicalQuantity(g['n2'], Boolean(g['k2'])));
  const significant = unit !== null || raws.some((raw, i) => isNumeric(raw) && (values[i] ?? '').replace(/\D/g, '').length >= 2);
  return { text: text.trim(), start, end: start + text.length, values, unit, significant };
}

function stampsIn(text: string): Stamp[] {
  const stamps: Stamp[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    stamps.push({ text: m[0], key: `date:${m[0].replace(/[/.]/g, '-')}` });
  }
  for (const m of text.matchAll(TIME_RE)) {
    const key = `time:${Number(m[1])}:${m[2]}${(m[3] ?? '').toLowerCase()}`;
    stamps.push({ text: m[0].trim(), key });
  }
  return stamps;
}

/** Normalize a URL for comparison: no scheme, no "www.", no query/fragment, no trailing slash, lowercase. */
export function normalizeUrl(raw: string): string {
  return raw
    .replace(URL_TRAILING_PUNCT_RE, '')
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/** Find emails, URLs, dates/times and numeric claims; each layer is masked before the next one is scanned. */
function scan(text: string): Scan {
  let masked = text.replace(PLACEHOLDER_RE, blank).replace(PSEUDONYM_TOKEN_RE, blank);

  const emails = (masked.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase());
  masked = masked.replace(EMAIL_RE, blank);

  const urls = (masked.match(URL_RE) ?? []).map((u) => {
    const clean = u.replace(URL_TRAILING_PUNCT_RE, '');
    return { text: clean, normalized: normalizeUrl(clean) };
  });
  masked = masked.replace(URL_RE, blank);

  const stamps = stampsIn(masked);
  masked = masked.replace(DATE_RE, blank).replace(TIME_RE, blank).replace(LIST_MARKER_RE, blank);

  const claims: NumericClaim[] = [];
  for (const m of masked.matchAll(CLAIM_RE)) {
    const claim = toClaim(m);
    if (claim) claims.push(claim);
  }
  return { urls, emails, stamps, claims };
}

// ---------------------------------------------------------------------------
// Source index
// ---------------------------------------------------------------------------

interface SourceIndex {
  /** Every canonical number mentioned anywhere (with or without unit, including date/time parts). */
  numbers: Set<string>;
  /** "24|hour", "100|USD", "3-5|day" ... */
  quantities: Set<string>;
  /** Numbers and currencies the customer or the agent supplied (message + variable values). */
  customerNumbers: Set<string>;
  customerCurrencies: Set<string>;
  stamps: Set<string>;
  urls: string[];
  emails: Set<string>;
  /** Company-authored texts (macro bodies + facts): the only sources that may license promise wording. */
  policyTexts: string[];
}

function quantityKey(value: string, unit: string | null): string {
  return `${value}|${unit ?? ''}`;
}

function nonEmpty(texts: string[]): string[] {
  return texts.filter((t) => typeof t === 'string' && t.trim() !== '');
}

/** Macro bodies (raw and rendered with the variables) and fact statements/values/source URLs. */
function policyTexts(sources: GroundingSources): string[] {
  return nonEmpty([
    ...sources.macroBodies,
    ...sources.macroBodies.map((body) => renderTemplate(body, sources.variables).text),
    ...sources.facts.flatMap((f) => [f.statement, f.value, f.sourceUrl ?? '']),
  ]);
}

/** What the customer wrote and what the agent confirmed (variable values). */
function customerTexts(sources: GroundingSources): string[] {
  return nonEmpty([sources.message, ...Object.values(sources.variables).filter((v): v is string => typeof v === 'string')]);
}

function addScan(index: SourceIndex, text: string, fromCustomer: boolean): void {
  const s = scan(text);
  for (const url of s.urls) index.urls.push(url.normalized);
  for (const email of s.emails) index.emails.add(email);
  for (const stamp of s.stamps) {
    index.stamps.add(stamp.key);
    for (const part of stamp.text.match(DIGITS_RE) ?? []) index.numbers.add(canonicalQuantity(part, false));
  }
  for (const claim of s.claims) {
    for (const value of claim.values) {
      index.numbers.add(value);
      if (fromCustomer) index.customerNumbers.add(value);
      if (claim.unit) index.quantities.add(quantityKey(value, claim.unit));
    }
    if (claim.values.length > 1) index.quantities.add(quantityKey(claim.values.join('-'), claim.unit));
    if (fromCustomer && claim.unit && CURRENCY_CODES.has(claim.unit)) index.customerCurrencies.add(claim.unit);
  }
  if (!fromCustomer) return;
  for (const m of text.matchAll(CURRENCY_MENTION_RE)) {
    const code = canonicalUnit(m[0]);
    if (code) index.customerCurrencies.add(code);
  }
}

function buildSourceIndex(sources: GroundingSources): SourceIndex {
  const index: SourceIndex = {
    numbers: new Set(),
    quantities: new Set(),
    customerNumbers: new Set(),
    customerCurrencies: new Set(),
    stamps: new Set(),
    urls: [],
    emails: new Set(),
    policyTexts: policyTexts(sources),
  };
  for (const text of index.policyTexts) addScan(index, text, false);
  for (const text of customerTexts(sources)) addScan(index, text, true);
  return index;
}

function valueSupported(value: string, unit: string | null, index: SourceIndex): boolean {
  if (!unit) return index.numbers.has(value);
  if (index.quantities.has(quantityKey(value, unit))) return true;
  // "250" and "USDT" both come from the customer/agent (message or variables): "250 USDT" is supported. A number
  // and a currency that merely appear somewhere in the macro ("$10 minimum", "100 free spins") do not make "$100".
  return CURRENCY_CODES.has(unit) && index.customerNumbers.has(value) && index.customerCurrencies.has(unit);
}

/**
 * Number+unit (or the bare number when there is no unit) must appear in a source. A range is supported as a
 * range, or when both ends are supported. Source ranges also support their end points ("within 24 hours" vs
 * "24-48 hours") to avoid flagging common rephrasings.
 */
function claimSupported(claim: NumericClaim, index: SourceIndex): boolean {
  if (claim.values.length > 1 && index.quantities.has(quantityKey(claim.values.join('-'), claim.unit))) return true;
  return claim.values.every((value) => valueSupported(value, claim.unit, index));
}

function urlSupported(url: string, index: SourceIndex): boolean {
  return index.urls.some((source) => source === url || source.startsWith(`${url}/`));
}

/** Non-negated matches of a promise pattern: "we guarantee" counts, "we cannot guarantee" does not. */
function affirmedPromises(text: string, pattern: RegExp): RegExpMatchArray[] {
  return [...text.matchAll(pattern)].filter((m) => {
    const start = m.index ?? 0;
    const from = Math.max(0, start - NEGATION_WINDOW);
    let before = text.slice(from, start);
    // Drop a word cut in half by the window ("casi|no guarantee" must not read as "no guarantee").
    if (from > 0 && NON_SPACE_RE.test(text.charAt(from - 1))) before = before.replace(LEADING_WORD_RE, '');
    return !NEGATION_BEFORE_RE.test(before);
  });
}

function overlaps(span: Span, spans: Span[]): boolean {
  return spans.some((s) => span.start < s.end && s.start < span.end);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Anti-hallucination check for AI-written replies. Flags:
 *  - unsupported_number: numbers/amounts/percentages/durations/ranges/dates/times ("24 hours", "5%", "$100",
 *    "3-5 days") and bare numbers with >= 2 digits that do not appear in any source (macro bodies - raw and
 *    rendered with the variables -, fact statements/values, the customer message, variable values).
 *    Normalized before comparing: thousand separators, "24h" ~ "24 hrs" ~ "24 hours", "one".."twelve" -> digits,
 *    "$100" ~ "100 USD" ~ "100 dollars". Placeholders, ⟦TOKENS⟧, URLs, emails and "1." list markers are ignored.
 *  - unsupported_url: URLs/domains (and email addresses) not present in the sources. Query/fragment/trailing
 *    slash are ignored; a link to a parent path of a source URL on the same full hostname is accepted.
 *  - promise: guarantee language ("guarantee", "will definitely", "100%", "I promise", "will be credited today",
 *    "refund you" ...) that the macro bodies / facts do not use themselves. The customer's own words never license a
 *    promise ("Can you guarantee it?" -> "I guarantee it" is flagged), and negated phrases ("we cannot guarantee",
 *    "not 100% sure") are neither promises in the reply nor licenses in the sources.
 *  - placeholder_left: any [ENTER ...] placeholder (or unresolved ⟦TOKEN⟧) left in the text.
 * Issues are de-duplicated and carry the offending fragment plus a short detail.
 */
export function checkGrounding(reply: string, sources: GroundingSources): GuardrailIssue[] {
  const index = buildSourceIndex(sources);
  const issues: GuardrailIssue[] = [];
  const seen = new Set<string>();
  const add = (kind: GuardrailKind, text: string, detail = DETAILS[kind]): void => {
    const key = `${kind}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ kind, text, detail });
  };

  // Promise phrases ("100%" included) are judged as promises only, never also as numeric claims.
  const promiseSpans: Span[] = [];
  const promiseIssues: string[] = [];
  for (const pattern of PROMISE_PATTERNS) {
    for (const m of reply.matchAll(pattern)) promiseSpans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    if (index.policyTexts.some((t) => affirmedPromises(t, pattern).length > 0)) continue;
    for (const m of affirmedPromises(reply, pattern)) promiseIssues.push(m[0]);
  }

  const scanned = scan(reply);
  for (const stamp of scanned.stamps) if (!index.stamps.has(stamp.key)) add('unsupported_number', stamp.text);
  for (const claim of scanned.claims) {
    if (!claim.significant || overlaps(claim, promiseSpans)) continue;
    if (!claimSupported(claim, index)) add('unsupported_number', claim.text);
  }
  for (const url of scanned.urls) if (!urlSupported(url.normalized, index)) add('unsupported_url', url.text);
  for (const email of scanned.emails) if (!index.emails.has(email)) add('unsupported_url', email);
  for (const text of promiseIssues) add('promise', text);
  for (const label of findPlaceholders(reply)) add('placeholder_left', label);
  for (const token of reply.match(PSEUDONYM_TOKEN_RE) ?? []) add('placeholder_left', token, TOKEN_DETAIL);
  return issues;
}
