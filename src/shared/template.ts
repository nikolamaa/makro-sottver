/**
 * Macro template engine (shared by server and UI).
 *
 * Syntax:  {{variable}}  or  {{variable|fallback text}}
 * - Variable names are case-insensitive, letters/digits/underscore, starting with a letter or underscore.
 * - When a value is missing and there is no fallback, a clearly marked placeholder is inserted,
 *   e.g. {{eta_time}} -> "[ENTER ETA TIME]". Placeholders must be filled by the agent before sending.
 */
import type { Placeholder } from './types.js';

export type TemplateToken =
  | { kind: 'text'; text: string; start: number; end: number }
  | { kind: 'var'; name: string; fallback: string | null; raw: string; start: number; end: number };

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|([^}]*))?\}\}/g;

/** Matches placeholders inserted for missing values, e.g. "[ENTER ETA TIME]". */
export const PLACEHOLDER_RE = /\[ENTER [A-Z0-9][A-Z0-9 _\-/]*\]/g;

export function parseTemplate(body: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let last = 0;
  for (const m of body.matchAll(VAR_RE)) {
    const start = m.index ?? 0;
    if (start > last) tokens.push({ kind: 'text', text: body.slice(last, start), start: last, end: start });
    const fallbackRaw = m[2];
    tokens.push({
      kind: 'var',
      name: (m[1] ?? '').toLowerCase(),
      fallback: fallbackRaw === undefined ? null : fallbackRaw.trim(),
      raw: m[0],
      start,
      end: start + m[0].length,
    });
    last = start + m[0].length;
  }
  if (last < body.length) tokens.push({ kind: 'text', text: body.slice(last), start: last, end: body.length });
  return tokens;
}

/** Unique variable names in order of first appearance. */
export function listVariables(body: string): string[] {
  const seen = new Set<string>();
  for (const t of parseTemplate(body)) if (t.kind === 'var') seen.add(t.name);
  return [...seen];
}

export function placeholderLabel(variable: string): string {
  return `[ENTER ${variable.replace(/[_\s]+/g, ' ').trim().toUpperCase()}]`;
}

export interface RenderResult {
  text: string;
  /** Variables that received a real value (not fallback, not placeholder). */
  filled: Record<string, string>;
  /** Variables replaced by their inline fallback text. */
  usedFallback: string[];
  placeholders: Placeholder[];
}

/**
 * Render a template. `values` keys are matched case-insensitively.
 * Empty/whitespace-only values count as missing.
 */
export function renderTemplate(body: string, values: Record<string, string | undefined | null>): RenderResult {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && v.trim() !== '') normalized[k.toLowerCase()] = v.trim();
  }
  const filled: Record<string, string> = {};
  const usedFallback: string[] = [];
  const placeholders: Placeholder[] = [];
  const seenPlaceholder = new Set<string>();
  let text = '';
  for (const t of parseTemplate(body)) {
    if (t.kind === 'text') {
      text += t.text;
      continue;
    }
    const value = normalized[t.name];
    if (value !== undefined) {
      text += value;
      filled[t.name] = value;
    } else if (t.fallback !== null) {
      text += t.fallback;
      if (!usedFallback.includes(t.name)) usedFallback.push(t.name);
    } else {
      const label = placeholderLabel(t.name);
      text += label;
      if (!seenPlaceholder.has(label)) {
        seenPlaceholder.add(label);
        placeholders.push({ label, variable: t.name });
      }
    }
  }
  return { text, filled, usedFallback, placeholders };
}

/** All placeholder labels still present in a text (e.g. after the agent edited it). */
export function findPlaceholders(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER_RE) ?? [])];
}

/**
 * Normalized character edit distance in [0, 1] (0 = identical).
 * Uses a two-row Levenshtein; inputs are capped to keep it O(4000^2) worst case.
 */
export function editRatio(a: string, b: string): number {
  const x = a.slice(0, 4000);
  const y = b.slice(0, 4000);
  if (x === y) return 0;
  if (!x.length || !y.length) return 1;
  let prev = new Uint32Array(y.length + 1);
  let cur = new Uint32Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    const xc = x.charCodeAt(i - 1);
    for (let j = 1; j <= y.length; j++) {
      const cost = xc === y.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (cur[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      cur[j] = Math.min(del, ins, sub);
    }
    [prev, cur] = [cur, prev];
  }
  return Math.min(1, (prev[y.length] ?? 0) / Math.max(x.length, y.length));
}
