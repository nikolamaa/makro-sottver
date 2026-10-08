/**
 * Combine 2-3 macro bodies into one natural reply. Pure functions, no I/O.
 */
import { splitGreeting } from './greeting.js';
import { capitalizeFirst, normalizeNewlines, tidyParagraphs } from './text.js';

/**
 * A sentence that is a closing / sign-off when it appears at the end of a part. Anchored at sentence start so
 * "If you feel you'd like a break, just let me know ..." is NOT a closing.
 */
const CLOSING_SENTENCE_RE = new RegExp(
  '^(?:and\\s+)?(?:please\\s+)?(?:do\\s+)?(?:' +
    [
      "(?:don'?t|do\\s+not)\\s+hesitate\\b",
      'let\\s+(?:me|us)\\s+know\\b',
      'feel\\s+free\\b',
      'if\\s+(?:you\\s+have|there\\s+(?:are|is))\\s+any\\s+(?:(?:other|further|more|additional)\\s+)?questions?\\b',
      "if\\s+there(?:'s|\\s+is)\\s+anything\\s+else\\b",
      'should\\s+you\\s+(?:have|need)\\b',
      'is\\s+there\\s+anything\\s+else\\b',
      '(?:i\\s+|we\\s+)?hope\\s+(?:this|that)\\s+(?:helps|clarifies|clears)\\b',
      'have\\s+a\\s+(?:great|nice|lovely|good|wonderful|fantastic|pleasant)\\s+(?:day|evening|weekend|night|afternoon|morning|week|one)\\b',
      'enjoy\\s+(?:the\\s+rest\\s+of\\s+)?(?:your|the)\\s+(?:day|evening|weekend|games?)\\b',
      '(?:good|best\\s+of)\\s+luck\\b',
      '(?:kind|best|warm|warmest)\\s+regards\\b',
      'regards\\b',
      'cheers\\b',
      'best\\s+wishes\\b',
      'all\\s+the\\s+best\\b',
      'take\\s+care\\b',
      '(?:many\\s+)?thanks(?:\\s+again)?\\s*[.!,]*$',
    ].join('|') +
    ')',
  'i',
);

/** "Thank you for your patience." is a closing only when it is the whole final line of a part. */
const PATIENCE_LINE_RE = /^thank(?:s|\s+you)(?:\s+(?:so|very)\s+much)?\s+for\s+your\s+(?:patience|understanding)\s*[.!]*$/i;

/** Sign-off line that may be followed by a short name/team line ("Kind regards,\nStake Support"). */
const SIGNOFF_LINE_RE = /^(?:(?:kind|best|warm|warmest)\s+)?regards,?$|^(?:cheers|thanks|many thanks|best wishes|all the best|sincerely|take care),?$/i;

/** Short generic opener repeated by every macro ("Thank you for contacting us."); dropped from parts 2..n. */
const OPENER_RE = /^thank(?:s|\s+you)(?:\s+(?:so|very)\s+much)?\s+for\s+(?:contacting|reaching\s+out|getting\s+in\s+touch|writing|your\s+(?:message|question|inquiry|enquiry))\b[^.!?,\n]{0,40}[.!]+[ \t]*/i;

const SENTENCE_RE = /[^.!?]+(?:[.!?]+|$)/g;
const HAS_LETTER_RE = /\p{L}/u;
const SENTENCE_LEAD_RE = /^[\s"'“‘(*_-]+/;
const BRACKET_TAG_RE = /\[[^\]]*\]/g;
const TITLE_EDGE_RE = /^[\s\-–—:|.]+|[\s\-–—:|.!?]+$/g;
const ACRONYM_RE = /^(?=.*[A-Z])[A-Z0-9][A-Z0-9&/+-]+$/;
const WORD_EDGE_PUNCT_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const LIST_LINE_RE = /^\s*(?:[-*•]|\d{1,2}[.)])\s/;
/** Lines shorter than this (in words) are never deduplicated across parts ("Steps:", "Thanks!"). */
const MIN_DEDUPE_WORDS = 4;

function isClosingSentence(sentence: string): boolean {
  return CLOSING_SENTENCE_RE.test(sentence.replace(SENTENCE_LEAD_RE, '').trim());
}

/** Index where the trailing closing sentences of a line start, or -1 when the line does not end with one. */
function closingStart(line: string): number {
  const sentences = [...line.matchAll(SENTENCE_RE)];
  let cut = -1;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i];
    if (!sentence) break;
    if (!HAS_LETTER_RE.test(sentence[0])) continue; // emoji / punctuation tail belongs to the closing before it
    if (!isClosingSentence(sentence[0])) break;
    cut = sentence.index ?? 0;
  }
  return cut;
}

function lastContentIndex(lines: string[], end: number): number {
  let i = end - 1;
  while (i >= 0 && !lines[i]?.trim()) i--;
  return i;
}

function isShortNameLine(line: string): boolean {
  const words = line.trim().split(/\s+/);
  return words.length <= 4 && !/[.?!:]/.test(line);
}

/** Split a body into its content and its trailing closing block (sign-offs, "Let me know ...", "Have a great day"). */
export function splitClosing(body: string): { body: string; closing: string } {
  const lines = body.split('\n');
  const closing: string[] = [];
  let last = lastContentIndex(lines, lines.length);

  const prev = lastContentIndex(lines, last);
  const lastLine = lines[last]?.trim() ?? '';
  if (prev >= 0 && SIGNOFF_LINE_RE.test(lines[prev]?.trim() ?? '') && isShortNameLine(lastLine)) {
    closing.unshift(`${lines[prev]?.trim()}\n${lastLine}`);
    last = lastContentIndex(lines, prev);
  } else if (PATIENCE_LINE_RE.test(lastLine)) {
    closing.unshift(lastLine);
    last = lastContentIndex(lines, last);
  }

  while (last >= 0) {
    const line = lines[last] ?? '';
    const cut = closingStart(line);
    if (cut === -1) break;
    closing.unshift(line.slice(cut).trim());
    const kept = line.slice(0, cut).trimEnd();
    if (kept) {
      lines[last] = kept;
      break;
    }
    last = lastContentIndex(lines, last);
  }
  return { body: lines.slice(0, last + 1).join('\n').trimEnd(), closing: closing.join('\n') };
}

/** Remove the leading greeting of a part ("Hi {{user}}," line, or "Hi John," before inline content). */
function stripGreeting(body: string): string {
  const split = splitGreeting(body);
  if (!split) return body;
  return split.separator === ' ' ? capitalizeFirst(split.rest) : split.rest;
}

function stripOpener(body: string): string {
  return body.replace(OPENER_RE, '').replace(/^\s*\n/, '');
}

function dedupeKey(line: string): string | null {
  if (LIST_LINE_RE.test(line)) return null;
  const key = line.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?,;:]+$/, '').trim();
  return key.split(' ').length >= MIN_DEDUPE_WORDS ? key : null;
}

/** Drop non-list lines (>= 4 words) that already appeared in an earlier part, e.g. a shared disclaimer. */
function dropSeenLines(body: string, seen: Set<string>): string {
  return body
    .split('\n')
    .filter((line) => {
      const key = dedupeKey(line);
      return key === null || !seen.has(key);
    })
    .join('\n');
}

function rememberLines(body: string, seen: Set<string>): void {
  for (const line of body.split('\n')) {
    const key = dedupeKey(line);
    if (key !== null) seen.add(key);
  }
}

/** "Withdrawal Limits [WD] - BTC" -> "withdrawal limits - BTC" (acronyms such as KYC/VIP/BTC keep their case). */
export function titleTopic(title: string): string {
  return title
    .replace(BRACKET_TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(TITLE_EDGE_RE, '')
    .split(' ')
    .map((word) => (ACRONYM_RE.test(word.replace(WORD_EDGE_PUNCT_RE, '')) ? word : word.toLowerCase()))
    .join(' ');
}

function bridge(title: string): string {
  const topic = titleTopic(title);
  return topic ? `Regarding your question about ${topic}:` : 'Regarding your other question:';
}

/**
 * Combine several macro bodies into one reply: keep the first greeting only, drop generic openers
 * ("Thank you for contacting us.") and lines already used by an earlier part, drop sign-offs/closing lines
 * ("Let me know if...", "Have a great day") except the last (the last closing found is kept at the end),
 * separate parts with a blank line, and prefix parts 2..n with a short bridge
 * ("Regarding your question about <title lowercased>:") on its own line.
 * A single part is returned unchanged (trimmed, "\n" line endings).
 */
export function combineBodies(parts: { title: string; body: string }[]): string {
  const items = parts
    .map((p) => ({ title: p.title, body: normalizeNewlines(p.body).trim() }))
    .filter((p) => p.body !== '');
  if (items.length <= 1) return items[0]?.body ?? '';

  const seen = new Set<string>();
  const out: string[] = [];
  let carriedClosing = '';
  let lastHasClosing = false;

  items.forEach((item, i) => {
    const isFirst = i === 0;
    const isLast = i === items.length - 1;
    let body = isFirst ? item.body : dropSeenLines(stripOpener(stripGreeting(item.body)), seen);
    const split = splitClosing(body);
    if (isLast) {
      lastHasClosing = split.closing !== '';
    } else {
      body = split.body;
      if (split.closing) carriedClosing = split.closing;
    }
    rememberLines(body, seen);
    if (!body.trim()) return;
    out.push(isFirst ? body.trim() : `${bridge(item.title)}\n${body.trim()}`);
  });

  if (carriedClosing && !lastHasClosing) out.push(carriedClosing);
  return tidyParagraphs(out.join('\n\n'));
}
