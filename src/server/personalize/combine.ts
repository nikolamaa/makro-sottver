/**
 * Combine 2-3 macro bodies into one natural reply. Pure functions, no I/O.
 */
import { splitGreeting } from './greeting.js';
import { capitalizeFirst, normalizeNewlines, tidyParagraphs } from './text.js';

/** End of a clause: punctuation or end of sentence. */
const CLAUSE_END = String.raw`\s*(?:[.!?,;:)]|$)`;

const NEED_WORDS = '(?:other|further|more|additional)';
const NEED_QUALIFIER = String.raw`${NEED_WORDS}\s+`;

/** A generic need ("anything else", "any other questions", "further help"), not a concrete one ("any documents"). */
const GENERIC_NEED =
  String.raw`(?:anything\s+else\b|anything(?:\s+(?:more|further))?(?:\s+(?:i|we)\s+can\b|${CLAUSE_END})` +
  String.raw`|(?:any\s+(?:${NEED_QUALIFIER})?|${NEED_QUALIFIER})questions?\b|questions?${CLAUSE_END}` +
  String.raw`|(?:any\s+)?(?:${NEED_QUALIFIER})?(?:help|assistance|info(?:rmation)?|support)` +
  String.raw`(?:\s+(?:with|regarding)\s+(?:anything(?:\s+else)?|this|that))?(?:\s+(?:at\s+all|in\s+the\s+future|later))?${CLAUSE_END}` +
  String.raw`|any(?:\s+${NEED_WORDS})?${CLAUSE_END})`;

/** "... if you have any other questions", "... should you need anything else", "... if we can help further". */
const GENERIC_CONDITION =
  String.raw`(?:you\s+(?:have|need|require|want)\s+${GENERIC_NEED}` +
  String.raw`|you(?:\s+would|['’]d)\s+like\s+${GENERIC_NEED}` +
  String.raw`|there(?:['’]s|\s+is|\s+are)\s+${GENERIC_NEED}` +
  String.raw`|(?:i|we)\s+can\s+(?:help|assist|be\s+of\s+(?:any\s+)?(?:further\s+)?(?:help|assistance))(?:\s+(?:you\s+)?(?:with\s+)?(?:anything|any\s+other|any\s+further|further|more)\b|${CLAUSE_END}))`;

/** "reach out", "contact us", "get in touch" ... - inviting a new message, not asking for something specific. */
const CONTACT_US = String.raw`(?:reach\s+out|contact|ask|write|message|chat|drop|get\s+(?:back\s+)?in\s+touch|get\s+back|come\s+back|send\s+us\s+a\s+message|open\s+a\s+(?:new\s+)?chat|let\s+(?:me|us)\s+know)\b`;

/**
 * A sentence that is a closing / sign-off when it appears at the end of a part. Anchored at sentence start so
 * "If you feel you'd like a break, just let me know ..." is NOT a closing, and "let us know" / "feel free" /
 * "should you" / "if you need" only count when generic: "Please let us know your TXID.", "Let us know if the
 * deposit is still missing after 1 hour." and "If you need any documents, ..." carry content and are kept.
 */
const CLOSING_SENTENCE_RE = new RegExp(
  String.raw`^(?:and\s+)?(?:just\s+)?(?:please\s+)?(?:just\s+)?(?:do\s+)?(?:` +
    [
      String.raw`(?:don['’]?t|do\s+not)\s+hesitate\s+to\s+${CONTACT_US}`,
      String.raw`let\s+(?:me|us)\s+know(?:${CLAUSE_END}|\s+(?:anytime|any\s+time)\b|\s+how\s+(?:it\s+goes|(?:i|we)\s+can\s+help)\b|\s+(?:if|whenever|in\s+case)\s+${GENERIC_CONDITION})`,
      String.raw`feel\s+free\s+to\s+${CONTACT_US}`,
      String.raw`(?:if|should|whenever|in\s+case)\s+${GENERIC_CONDITION}`,
      String.raw`is\s+there\s+anything\s+else\b`,
      String.raw`(?:i\s+|we\s+)?hope\s+(?:this|that)\s+(?:helps|clarifies|clears)\b`,
      String.raw`have\s+a\s+(?:great|nice|lovely|good|wonderful|fantastic|pleasant)\s+(?:day|evening|weekend|night|afternoon|morning|week|one)\b`,
      String.raw`enjoy\s+(?:the\s+rest\s+of\s+)?(?:your|the)\s+(?:day|evening|weekend|games?)\b`,
      String.raw`(?:good|best\s+of)\s+luck\b`,
      String.raw`(?:kind|best|warm|warmest)\s+regards\b`,
      String.raw`regards\b`,
      String.raw`cheers\b`,
      String.raw`best\s+wishes\b`,
      String.raw`all\s+the\s+best\b`,
      String.raw`take\s+care\b`,
      String.raw`(?:many\s+)?thanks(?:\s+again)?\s*[.!,]*$`,
    ].join('|') +
    ')',
  'i',
);

/** "Thank you for your patience." is a closing only when it is the whole final line of a part. */
const PATIENCE_LINE_RE =
  /^thank(?:s|\s+you)(?:\s+(?:so|very)\s+much)?\s+for\s+your\s+(?:patience|understanding)(?:\s+and\s+(?:patience|understanding|cooperation))?\s*[.!]*$/i;

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

/** Links, emails, placeholders and variables other than {{user}} carry content: such a sentence is never a closing. */
const CONTENT_MARKER_RE = /https?:\/\/|\bwww\.|\S@\S|\[ENTER |\{\{\s*(?!user\s*[|}])/i;

function isClosingSentence(sentence: string): boolean {
  if (CONTENT_MARKER_RE.test(sentence)) return false;
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

/** Name/team lines that may follow a sign-off ("Kind regards,\nAna\nStake Support"). */
const MAX_NAME_LINES = 2;

/** Index of a sign-off line followed by 1-2 short name lines that end the body, or -1. */
function signoffStart(lines: string[], last: number): number {
  let i = last;
  for (let names = 0; names < MAX_NAME_LINES && i >= 0; names++) {
    if (!isShortNameLine(lines[i] ?? '')) return -1;
    i = lastContentIndex(lines, i);
    if (i >= 0 && SIGNOFF_LINE_RE.test(lines[i]?.trim() ?? '')) return i;
  }
  return -1;
}

/** Split a body into its content and its trailing closing block (sign-offs, "Let me know ...", "Have a great day"). */
export function splitClosing(body: string): { body: string; closing: string } {
  const lines = body.split('\n');
  const closing: string[] = [];
  let last = lastContentIndex(lines, lines.length);

  const signoff = signoffStart(lines, last);
  if (signoff !== -1) {
    closing.unshift(lines.slice(signoff, last + 1).map((l) => l.trim()).filter(Boolean).join('\n'));
    last = lastContentIndex(lines, signoff);
  } else if (PATIENCE_LINE_RE.test(lines[last]?.trim() ?? '')) {
    closing.unshift(lines[last]?.trim() ?? '');
    last = lastContentIndex(lines, last);
  }

  while (last >= 0) {
    const line = lines[last] ?? '';
    if (LIST_LINE_RE.test(line)) break; // a list step is content, even "3. Feel free to contact us."
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
