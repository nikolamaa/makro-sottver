/**
 * Pure helpers for the Import / Export page (no React, no DOM), so they can be unit tested.
 */
import type { ImportCommitResult, ImportFormat } from '../../../shared/types';

/** File extension -> import tab. Returns null for unsupported files. */
export function formatFromFileName(name: string): ImportFormat | null {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'json') return 'json';
  if (ext === 'txt' || ext === 'md' || ext === 'markdown') return 'text';
  return null;
}

/**
 * JSON must start with an array of objects/strings or an object with a quoted key. A plain "[" or "{" is not
 * enough: Intercom macros often start with "[VIP] ..." or "{{first_name}}, ...".
 */
const JSON_START_RE = /^(?:\[\s*(?:[{["\]]|$)|\{\s*(?:["}]|$))/;
const LINE_SEPARATOR_RE = /^\s*-{3,}\s*$/m;
const CSV_DELIMITERS = [',', ';', '\t'] as const;
/** Same synonyms as the server's CSV reader (normalized: lowercase, no spaces/underscores/hyphens). */
const CSV_TITLE_KEYS = new Set(['title', 'name', 'macro', 'macroname']);
const CSV_BODY_KEYS = new Set(['body', 'text', 'content', 'message', 'reply', 'template']);

function looksLikeCsvHeader(line: string): boolean {
  let best: string | null = null;
  let bestCount = 0;
  for (const d of CSV_DELIMITERS) {
    const count = line.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  if (!best) return false;
  const cells = line.split(best).map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase().replace(/[\s_-]+/g, ''));
  return cells.some((c) => CSV_TITLE_KEYS.has(c)) && cells.some((c) => CSV_BODY_KEYS.has(c));
}

/** Cheap guess of the pasted format, used only to suggest switching tabs. */
export function guessFormat(content: string): ImportFormat | null {
  const t = content.trimStart();
  if (!t) return null;
  if (JSON_START_RE.test(t.slice(0, 200))) return 'json';
  const newline = t.indexOf('\n');
  const first = (newline >= 0 ? t.slice(0, newline) : t).replace(/\r$/, '');
  if (looksLikeCsvHeader(first)) return 'csv';
  if (t.startsWith('#') || LINE_SEPARATOR_RE.test(t)) return 'text';
  return null;
}

/** Windows-1252 code points for bytes 0x80-0x9F (undefined bytes keep their C1 value). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
const C1_RE = /[\u0080-\u009f]/g;

/**
 * Decode an uploaded file. Handles UTF-8 (with or without BOM), UTF-16 with BOM (Excel "Unicode text") and falls
 * back to Windows-1252 for legacy "CSV (Comma delimited)" files saved by Excel on Windows, so typographic quotes
 * like ’ are not turned into U+FFFD.
 */
export function decodeFileBytes(bytes: Uint8Array): string {
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(bytes);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(bytes);
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Some runtimes decode "windows-1252" as Latin-1; map the 0x80-0x9F range explicitly so both agree.
      text = new TextDecoder('windows-1252')
        .decode(bytes)
        .replace(C1_RE, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80] ?? c.charCodeAt(0)));
    }
  }
  return text.replace(/^﻿/, '');
}

/**
 * Split the items of one import into request-sized batches (the server limits the request body size).
 * Order is preserved; an item larger than `maxBytes` gets a batch of its own.
 */
export function chunkForCommit<T>(items: readonly T[], maxBytes: number, maxCount: number): T[][] {
  const encoder = new TextEncoder();
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length + 1;
    if (batch.length && (bytes + size > maxBytes || batch.length >= maxCount)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function addCommitResults(a: ImportCommitResult, b: ImportCommitResult): ImportCommitResult {
  return { created: a.created + b.created, updated: a.updated + b.updated, skipped: a.skipped + b.skipped };
}
