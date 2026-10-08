/**
 * Library editor model: the editable draft of a macro (+ its facts), conversions to/from the API types,
 * validation and change detection. Pure functions only (no React).
 */
import {
  INTENTS,
  isIntent,
  type ChangeSource,
  type Fact,
  type FactInput,
  type FactStatus,
  type Id,
  type Intent,
  type Macro,
  type MacroContent,
  type MacroInput,
  type VerificationStatus,
} from '../../../shared/types';
import type { BadgeTone } from '../../ui';

// ---------------------------------------------------------------------------
// Limits (mirror the server's request validation so errors show before saving)
// ---------------------------------------------------------------------------

export const LIMITS = {
  title: 200,
  body: 20000,
  tags: 40,
  tag: 60,
  intents: 10,
  triggers: 60,
  trigger: 500,
  notes: 5000,
  shortcut: 60,
  facts: 100,
  factKey: 200,
  factStatement: 2000,
  factValue: 2000,
  factUrl: 2000,
  factQuote: 4000,
  changeNote: 500,
} as const;

// ---------------------------------------------------------------------------
// Draft types
// ---------------------------------------------------------------------------

export interface FactDraft {
  /** Stable React key (facts may not have a server id yet). */
  uid: string;
  id?: Id;
  key: string;
  statement: string;
  value: string;
  sourceUrl: string;
  evidenceQuote: string;
  status: FactStatus;
  /** True when the status was reset to 'unchecked' automatically because the fact's content changed. */
  statusAuto: boolean;
  /** The saved fact this draft started from (null for new facts). */
  original: Fact | null;
}

export interface MacroDraft {
  title: string;
  body: string;
  categoryId: Id | null;
  /** Comma separated, rendered as chips. */
  tagsText: string;
  intents: Intent[];
  shortcut: string;
  /** One example customer message per line. */
  triggersText: string;
  notes: string;
  facts: FactDraft[];
}

/** Prefill for a new macro (e.g. sessionStorage 'macropilot.newMacroDraft' written by the Assist page). */
export interface DraftSeed {
  title?: string;
  body?: string;
  intents?: Intent[];
}

let uidSeq = 0;
export function newUid(): string {
  uidSeq += 1;
  return `fd${uidSeq}`;
}

export function factDraftFrom(f: Fact): FactDraft {
  return {
    uid: newUid(),
    id: f.id,
    key: f.key,
    statement: f.statement,
    value: f.value,
    sourceUrl: f.sourceUrl ?? '',
    evidenceQuote: f.evidenceQuote ?? '',
    status: f.status,
    statusAuto: false,
    original: f,
  };
}

export function blankFact(): FactDraft {
  return {
    uid: newUid(),
    key: '',
    statement: '',
    value: '',
    sourceUrl: '',
    evidenceQuote: '',
    status: 'unchecked',
    statusAuto: false,
    original: null,
  };
}

export function draftFromMacro(m: Macro): MacroDraft {
  return {
    title: m.title,
    body: m.body,
    categoryId: m.categoryId,
    tagsText: m.tags.join(', '),
    intents: [...m.intents],
    shortcut: m.shortcut,
    triggersText: m.triggers.join('\n'),
    notes: m.notes,
    facts: m.facts.map(factDraftFrom),
  };
}

export function emptyDraft(seed?: DraftSeed): MacroDraft {
  return {
    title: seed?.title ?? '',
    body: seed?.body ?? '',
    categoryId: null,
    tagsText: '',
    intents: (seed?.intents ?? []).filter(isIntent),
    shortcut: '',
    triggersText: '',
    notes: '',
    facts: [],
  };
}

/** Parse an unknown JSON value into a DraftSeed (returns null when it carries nothing usable). */
export function parseSeed(raw: unknown): DraftSeed | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const seed: DraftSeed = {};
  if (typeof r.title === 'string') seed.title = r.title.slice(0, LIMITS.title);
  if (typeof r.body === 'string') seed.body = r.body.slice(0, LIMITS.body);
  if (Array.isArray(r.intents)) seed.intents = [...new Set(r.intents.filter(isIntent))].slice(0, LIMITS.intents);
  return seed.title || seed.body || seed.intents?.length ? seed : null;
}

// ---------------------------------------------------------------------------
// Lists (tags / triggers)
// ---------------------------------------------------------------------------

/** Split, trim, drop empties and dedupe case-insensitively (first spelling wins) - same rule as the server. */
export function parseList(text: string, separator: RegExp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(separator)) {
    const v = part.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export const parseTags = (text: string): string[] => parseList(text, /,/);
export const parseTriggers = (text: string): string[] => parseList(text, /\r?\n/);

// ---------------------------------------------------------------------------
// Conversion to the API
// ---------------------------------------------------------------------------

const FACT_CONTENT_KEYS = ['key', 'statement', 'value', 'sourceUrl', 'evidenceQuote'] as const;

function isBlankFact(f: FactDraft): boolean {
  return FACT_CONTENT_KEYS.every((k) => !f[k].trim());
}

function factContentChanged(f: FactDraft, original: Fact): boolean {
  return (
    f.key.trim() !== original.key.trim() ||
    f.statement.trim() !== original.statement.trim() ||
    f.value.trim() !== original.value.trim() ||
    f.sourceUrl.trim() !== (original.sourceUrl ?? '').trim() ||
    f.evidenceQuote.trim() !== (original.evidenceQuote ?? '').trim()
  );
}

/**
 * Apply an edit to a fact. When the content of a checked fact changes, its status is reset to 'unchecked'
 * (the old verification no longer applies); when the content goes back to the saved value, the status does too.
 */
export function patchFact(f: FactDraft, patch: Partial<Pick<FactDraft, (typeof FACT_CONTENT_KEYS)[number] | 'status'>>): FactDraft {
  const next: FactDraft = { ...f, ...patch };
  if (patch.status !== undefined) {
    next.statusAuto = false;
    return next;
  }
  const original = f.original;
  if (!original) return next;
  const changed = factContentChanged(next, original);
  if (changed && original.status !== 'unchecked' && (next.status === original.status || next.statusAuto)) {
    next.status = 'unchecked';
    next.statusAuto = true;
  } else if (!changed && next.statusAuto) {
    next.status = original.status;
    next.statusAuto = false;
  }
  return next;
}

export function draftContent(d: MacroDraft): MacroContent {
  return {
    title: d.title.trim(),
    body: d.body.trim(),
    categoryId: d.categoryId || null,
    tags: parseTags(d.tagsText),
    intents: [...new Set(d.intents)].filter(isIntent),
    triggers: parseTriggers(d.triggersText),
    notes: d.notes.trim(),
    shortcut: d.shortcut.trim(),
  };
}

function factToInput(f: FactDraft): FactInput {
  const out: FactInput = {
    key: f.key.trim(),
    statement: f.statement.trim(),
    value: f.value.trim(),
    sourceUrl: f.sourceUrl.trim() || null,
    evidenceQuote: f.evidenceQuote.trim() || null,
  };
  if (f.id) out.id = f.id;
  // Existing facts keep their server-side status unless the agent changed it (or it was reset by an edit).
  if (!f.original || f.status !== f.original.status) out.status = f.status;
  return out;
}

export function draftToInput(d: MacroDraft, changeNote: string): MacroInput {
  const input: MacroInput = {
    ...draftContent(d),
    facts: d.facts.filter((f) => !isBlankFact(f)).map(factToInput),
  };
  const note = changeNote.trim();
  if (note) input.changeNote = note;
  return input;
}

/** Stable string used to detect unsaved changes (ignores uids and whitespace-only differences). */
export function draftSignature(d: MacroDraft): string {
  return JSON.stringify([
    draftContent(d),
    d.facts
      .filter((f) => !isBlankFact(f))
      .map((f) => [f.id ?? null, ...FACT_CONTENT_KEYS.map((k) => f[k].trim()), f.status]),
  ]);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type DraftField = 'title' | 'body' | 'tags' | 'intents' | 'triggers' | 'notes' | 'shortcut' | 'facts' | 'changeNote';

export interface DraftIssue {
  field: DraftField;
  message: string;
  factUid?: string;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function validateFact(f: FactDraft, index: number): string[] {
  const n = `Fact ${index + 1}`;
  const errors: string[] = [];
  if (isBlankFact(f)) return errors;
  if (!f.statement.trim()) errors.push(`${n}: the statement is required.`);
  if (f.statement.length > LIMITS.factStatement) errors.push(`${n}: the statement is too long (max ${LIMITS.factStatement}).`);
  if (f.key.length > LIMITS.factKey) errors.push(`${n}: the key is too long (max ${LIMITS.factKey}).`);
  if (f.value.length > LIMITS.factValue) errors.push(`${n}: the value is too long (max ${LIMITS.factValue}).`);
  const url = f.sourceUrl.trim();
  if (url && !isHttpUrl(url)) errors.push(`${n}: the source URL must start with https:// or http://.`);
  if (url.length > LIMITS.factUrl) errors.push(`${n}: the source URL is too long.`);
  if (f.evidenceQuote.length > LIMITS.factQuote) errors.push(`${n}: the evidence quote is too long (max ${LIMITS.factQuote}).`);
  return errors;
}

export function validateDraft(d: MacroDraft, changeNote: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const c = draftContent(d);
  if (!c.title) issues.push({ field: 'title', message: 'Title is required.' });
  else if (c.title.length > LIMITS.title) issues.push({ field: 'title', message: `Title must be at most ${LIMITS.title} characters.` });
  if (!c.body) issues.push({ field: 'body', message: 'Reply text is required.' });
  else if (c.body.length > LIMITS.body) issues.push({ field: 'body', message: `Reply text must be at most ${LIMITS.body} characters.` });
  if (c.tags.length > LIMITS.tags) issues.push({ field: 'tags', message: `At most ${LIMITS.tags} tags.` });
  const longTag = c.tags.find((t) => t.length > LIMITS.tag);
  if (longTag) issues.push({ field: 'tags', message: `Tag "${longTag.slice(0, 20)}…" is longer than ${LIMITS.tag} characters.` });
  if (c.intents.length > LIMITS.intents) issues.push({ field: 'intents', message: `Pick at most ${LIMITS.intents} intents.` });
  if (c.triggers.length > LIMITS.triggers) issues.push({ field: 'triggers', message: `At most ${LIMITS.triggers} example messages.` });
  if (c.triggers.some((t) => t.length > LIMITS.trigger))
    issues.push({ field: 'triggers', message: `Each example message must be at most ${LIMITS.trigger} characters.` });
  if (c.notes.length > LIMITS.notes) issues.push({ field: 'notes', message: `Notes must be at most ${LIMITS.notes} characters.` });
  if (c.shortcut.length > LIMITS.shortcut) issues.push({ field: 'shortcut', message: `Shortcut must be at most ${LIMITS.shortcut} characters.` });
  const facts = d.facts.filter((f) => !isBlankFact(f));
  if (facts.length > LIMITS.facts) issues.push({ field: 'facts', message: `At most ${LIMITS.facts} facts per macro.` });
  d.facts.forEach((f, i) => {
    for (const message of validateFact(f, i)) issues.push({ field: 'facts', message, factUid: f.uid });
  });
  if (changeNote.trim().length > LIMITS.changeNote)
    issues.push({ field: 'changeNote', message: `Change note must be at most ${LIMITS.changeNote} characters.` });
  return issues;
}

// ---------------------------------------------------------------------------
// Labels, tones, sample data, formatting
// ---------------------------------------------------------------------------

export const FACT_STATUSES: FactStatus[] = ['unchecked', 'verified', 'outdated', 'contradicted', 'unverifiable'];

export const FACT_STATUS_META: Record<FactStatus, { label: string; tone: BadgeTone }> = {
  unchecked: { label: 'Unchecked', tone: 'neutral' },
  verified: { label: 'Verified', tone: 'success' },
  outdated: { label: 'Outdated', tone: 'warning' },
  contradicted: { label: 'Contradicted', tone: 'danger' },
  unverifiable: { label: 'Unverifiable', tone: 'neutral' },
};

export const VERIFICATION_META: Record<VerificationStatus, { label: string; tone: BadgeTone; description: string }> = {
  verified: { label: 'Verified', tone: 'success', description: 'All facts were verified against their sources.' },
  unverified: { label: 'Unverified', tone: 'neutral', description: 'No facts, or some facts have not been verified yet.' },
  outdated: { label: 'Outdated', tone: 'warning', description: 'At least one fact is outdated.' },
  conflict: { label: 'Conflict', tone: 'danger', description: 'At least one fact contradicts its source.' },
};

export const CHANGE_SOURCE_META: Record<ChangeSource, { label: string; tone: BadgeTone }> = {
  create: { label: 'Created', tone: 'accent' },
  manual: { label: 'Edited', tone: 'neutral' },
  import: { label: 'Import', tone: 'info' },
  revert: { label: 'Revert', tone: 'warning' },
  seed: { label: 'Seed', tone: 'neutral' },
  accuracy_check: { label: 'Accuracy check', tone: 'success' },
  learning: { label: 'Learning', tone: 'info' },
};

export const ALL_INTENTS: readonly Intent[] = INTENTS;

/** Example values used by the live preview. */
export const SAMPLE_VALUES: Record<string, string> = {
  user: 'Alex',
  username: 'alex_spins',
  email: 'alex@example.com',
  amount: '250',
  currency: 'USDT',
  crypto: 'BTC',
  network: 'TRC20',
  tx_hash: '0x8f3c2a91d4e7b6a05c1f9e2d3b4a5c6d7e8f9a0b',
  bet_id: '123456789',
  bonus_name: 'Weekly Boost',
  bonus_amount: '$50',
  vip_rank: 'Platinum I',
  eta_time: '24 hours',
  product: 'Casino',
  game: 'Gates of Olympus',
  provider: 'Pragmatic Play',
  date: '8 October 2026',
  document_type: 'proof of address',
  link: 'https://help.stake.com/en/',
};

const dateFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dayFmt.format(d);
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read a JSON value from sessionStorage and remove the key. Never throws. */
export function takeSessionJson(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    sessionStorage.removeItem(key);
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: ignore */
  }
}
