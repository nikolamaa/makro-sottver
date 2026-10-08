/**
 * Multi-question support: split a message into the distinct questions/requests it contains.
 *
 * 1. Sentences: split on . ? ! and newlines (decimals, URLs and emails are not split - the punctuation must be
 *    followed by whitespace).
 * 2. Clauses: a sentence is also split where a connector introduces a new question
 *    ("... pending for 2 days and also when do i get my weekly bonus?").
 * 3. Grouping: greetings/sign-offs are dropped; a clause without its own topic ("Can you check?") joins the
 *    previous topic, consecutive clauses about the same intent are merged, "also/btw" always starts a new one.
 * 4. A group is kept when it is a question/request (ends with '?', starts with a wh-word/auxiliary, or contains a
 *    request phrase) or a clear issue statement ("my withdrawal is pending for 2 days").
 */
import type { Intent, IntentScore, QuestionSpan } from '../../shared/types.js';
import { prepare } from './concepts.js';
import { scoreIntentsPrepared } from './intents.js';
import { collapseWhitespace, STOPWORDS } from './text.js';

const MAX_QUESTIONS = 6;
/** Bounds the work on pathological input (thousands of one-word lines); real messages have far fewer clauses. */
const MAX_CLAUSES = 120;
/** Minimum score for a segment's own intent to define a topic. */
const TOPIC_SCORE = 0.3;
/** Minimum score for a non-question statement to count as an issue the customer wants solved. */
const ISSUE_SCORE = 0.45;
/** Statements about these intents are problems by nature ("my account got hacked"). */
const PROBLEM_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  'deposit_missing',
  'withdrawal_pending',
  'account_access',
  'account_security',
  'account_closure',
  'responsible_gambling',
  'technical_issue',
  'betting_limits',
]);
const PROBLEM_CUE_RE =
  /\b(?:but (?:they|i|we|it|he|she|the team) (?:won|lost|did)|should (?:have|be)|incorrect(?:ly)?|mistake|not|no|never|didn't|did not|don't|doesn't|can't|cannot|couldn't|won't|wasn't|isn't|haven't|hasn't|unable|missing|pending|stuck|still|wrong|error|problem|issue|failed|fail(?:s|ing)?|declined|rejected|locked|blocked|hacked|frozen|froze|lost|waiting|delayed|disappeared)\b/;

/** Sentence punctuation followed by whitespace, newlines, or the space before an inline "2) " list item. */
const SENTENCE_BOUNDARY_RE = /[.?!…]+(?=\s|$)|\n+|\s+(?=\d{1,2}\)\s)/g;
const PUNCTUATION_START_RE = /^[.?!…]/;
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'approx']);
const LAST_WORD_RE = /([a-z.]+)$/i;
const LEADING_SPACE_OR_MARKER_RE = /^\s*(?:(?:[-*•–]+|\d{1,2}[.)])\s+)?/;
const HAS_LETTER_RE = /\p{L}/u;

const QUESTION_LEAD_SRC = String.raw`(?:when|what|whats|what's|why|how|where|which|who|can|could|would|will|is|are|do|does|did|should|i want|i need|i would like|i'd like|please)\b`;
const CONNECTOR_SRC = String.raw`and also|and|also|but|plus|btw|by the way|oh and|additionally`;
const CLAUSE_SPLIT_RE = new RegExp(
  String.raw`(?:\s*[,;]\s*(?:(${CONNECTOR_SRC})\s*,?\s+)?|\s+(${CONNECTOR_SRC})\s*,?\s+)(?=${QUESTION_LEAD_SRC})`,
  'gi',
);
const NEW_TOPIC_CONNECTORS = new Set(['and also', 'also', 'plus', 'btw', 'by the way', 'oh and', 'additionally']);
const NEW_TOPIC_START_RE = /^(?:also|and also|btw|by the way|plus|additionally|another (?:question|thing)|one more (?:thing|question)|p\.?s\.?)\b/i;

const LEADING_FILLER_SRC = String.raw`(?:(?:so|and|but|also|ok|okay|hi|hello|hey|btw|then|plus|well|guys|sorry|hmm|um)[\s,]+)*`;
const QUESTION_START_RE = new RegExp(
  `^${LEADING_FILLER_SRC}(?:` +
    String.raw`(?:what|when|where|why|how|who|whose)(?:'s|'re|s\b|\s+(?:is|are|was|were|do|does|did|can|could|will|would|should|shall|has|have|had|am|long|much|many|often|soon|come|to|about|exactly|else|happened|happens|kind|type|time|day|coins?|currenc\w*|bonus\w*|games?|methods?|level|rank|documents?)\b)` +
    String.raw`|(?:which|who)\s+\S` +
    String.raw`|(?:is|are|was|were|do|does|did|can|could|will|would|should|shall|has|have|had|am|may|might|isn't|aren't|doesn't|don't|didn't|can't|won't|wouldn't|couldn't|shouldn't|hasn't|haven't|wasn't|weren't)\s+(?:i|you|u|it|my|there|this|that|we|they|he|she|the|your|someone|anyone|stake|a|an|any|these|those|its)\b` +
    ')',
);
const REQUEST_RE =
  /\b(?:please|pls|plz|kindly|help me|need help|i want to|i wanna|i need to|i need you to|i would like|i'd like|can you|could you|would you|can u|could u|let me know|tell me|i want my|i need my|give me|send me|check (?:my|this|it|why|on)|look into)\b/;
const ENDS_WITH_QUESTION_RE = /\?[\s\p{Extended_Pictographic}\u{FE0F}]*$/u;

const CHATTER_RE =
  /\b(?:hi+|hello+|hey+|yo|dear|good (?:morning|afternoon|evening|day|night)|greetings|thank you|thank u|thanks?|thx|tysm|ty|cheers|regards|best regards|kind regards|warm regards|best|sincerely|ok(?:ay)?|alright|sure|cool|great|perfect|noted|please|pls|plz|team|support|stake|guys|there|all|everyone|so much|very much|a lot|again|in advance|sir|madam|mate|bro|buddy|anyone|anybody|are you there|is anyone there|you there|waiting|for (?:your|the) help|appreciated?|much appreciated|have a (?:good|great|nice) (?:day|one))\b/giu;
const NON_WORD_G_RE = /[^\p{L}\p{N}]+/gu;
const CAPITALIZED_RE = /^\p{Lu}/u;

/** A piece of the original message (offsets into it). */
interface Span {
  start: number;
  end: number;
}

/** A trimmed span; `listItem` when it started with a list marker ("- ", "2) ", "3. "). */
interface ItemSpan extends Span {
  listItem: boolean;
}

interface Segment extends Span {
  /** Top intent of the segment as scoreIntents reports it (may be the 'general' fallback). */
  top: IntentScore | undefined;
  /** Intent with real evidence (never the 'general' fallback), or null. */
  topic: Intent | null;
  topicScore: number;
  question: boolean;
  /** Mentions a problem ("not", "still", "wrong", "rejected"...). */
  problem: boolean;
  newTopic: boolean;
  /**
   * Can only be read together with a neighbour: it refers back ("what does that mean?") or has no content of its
   * own ("Can you check?", "any update?").
   */
  followUp: boolean;
}

interface Group extends Span {
  /** Top intent when the group is a single segment (re-scored otherwise). */
  top: IntentScore | undefined;
  topic: Intent | null;
  topicScore: number;
  question: boolean;
  problem: boolean;
}

/** Trimmed span of text[start, end), without a leading list marker; null when it has no letters. */
function trimmedSpan(text: string, start: number, end: number): ItemSpan | null {
  const raw = text.slice(start, end);
  const lead = raw.match(LEADING_SPACE_OR_MARKER_RE)?.[0] ?? '';
  const body = raw.slice(lead.length).trimEnd();
  if (!HAS_LETTER_RE.test(body)) return null;
  return { start: start + lead.length, end: start + lead.length + body.length, listItem: lead.trim() !== '' };
}

/** Sentence spans: split on . ? ! … followed by whitespace (not inside decimals/URLs), and on newlines. */
function sentenceSpans(text: string): ItemSpan[] {
  const out: ItemSpan[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTENCE_BOUNDARY_RE)) {
    const at = m.index ?? 0;
    if (m[0] === '.' && ABBREVIATIONS.has((text.slice(Math.max(0, at - 8), at).match(LAST_WORD_RE)?.[1] ?? '').toLowerCase())) continue;
    const span = trimmedSpan(text, last, PUNCTUATION_START_RE.test(m[0]) ? at + m[0].length : at);
    if (span) out.push(span);
    last = at + m[0].length;
  }
  const tail = trimmedSpan(text, last, text.length);
  if (tail) out.push(tail);
  return out;
}

/** Split a sentence where a connector introduces a new question. */
function clauseSpans(text: string, sentence: ItemSpan): (Span & { newTopic: boolean })[] {
  const s = text.slice(sentence.start, sentence.end);
  const parts: (Span & { newTopic: boolean })[] = [];
  let last = 0;
  let newTopic = sentence.listItem || NEW_TOPIC_START_RE.test(s);
  for (const m of s.matchAll(CLAUSE_SPLIT_RE)) {
    const at = m.index ?? 0;
    const span = trimmedSpan(text, sentence.start + last, sentence.start + at);
    if (span) parts.push({ start: span.start, end: span.end, newTopic });
    newTopic = NEW_TOPIC_CONNECTORS.has(collapseWhitespace((m[1] ?? m[2] ?? '').toLowerCase()));
    last = at + m[0].length;
  }
  const tail = trimmedSpan(text, sentence.start + last, sentence.end);
  if (tail) parts.push({ start: tail.start, end: tail.end, newTopic });
  return parts;
}

/** True for a question or a request ("can you check", "i want to withdraw"); `norm` is normalized text. */
function isQuestionOrRequest(norm: string): boolean {
  return ENDS_WITH_QUESTION_RE.test(norm) || QUESTION_START_RE.test(norm) || REQUEST_RE.test(norm);
}

/** Greetings, thanks and sign-offs ("Hi team", "Thanks in advance, John"). */
function isChatter(text: string): boolean {
  const words = text.replace(NON_WORD_G_RE, ' ').trim();
  const rest = text.replace(CHATTER_RE, ' ').replace(NON_WORD_G_RE, ' ').trim();
  if (!rest) return true;
  if (rest.length === words.length) return false;
  const restWords = rest.split(' ');
  const looksLikeName = restWords.length <= 3 && restWords.every((w) => CAPITALIZED_RE.test(w));
  return looksLikeName && prepare(rest).concepts.terms.length === 0;
}

function toSegment(text: string, span: Span, newTopic: boolean): Segment {
  const p = prepare(text);
  const top = scoreIntentsPrepared(p)[0];
  const hasTopic = top !== undefined && top.intent !== 'general' && top.score >= TOPIC_SCORE;
  return {
    ...span,
    top,
    topic: hasTopic ? top.intent : null,
    topicScore: hasTopic ? top.score : 0,
    question: isQuestionOrRequest(p.norm),
    problem: PROBLEM_CUE_RE.test(p.norm),
    newTopic,
    followUp: isFollowUp(p.norm),
  };
}

/** Words of a follow-up that carry no topic ("can you check asap", "any update on this?"). */
const FOLLOW_UP_WORDS: ReadonlySet<string> = new Set(
  `check checking help fix look respond reply answer update updates status asap urgent urgently possible soon quickly
  quick sort resolve solve explain news eta long take takes taking mean means happening happened going wrong anyone
  someone human agent question questions thing things few couple two three hurry done`.split(/\s+/),
);
const ANAPHORA_RE = /\b(?:it|this|that|these|those|they|them)\b/;
const FOLLOW_UP_TOKEN_RE = /[a-z0-9]+(?:'[a-z]+)?/g;

/** True when a clause refers back to something said before or has no topic words of its own. */
function isFollowUp(norm: string): boolean {
  if (ANAPHORA_RE.test(norm)) return true;
  for (const m of norm.matchAll(FOLLOW_UP_TOKEN_RE)) {
    if (!STOPWORDS.has(m[0]) && !FOLLOW_UP_WORDS.has(m[0])) return false;
  }
  return true;
}

/** A statement describing a problem with a clear topic ("my withdrawal is pending for 2 days"). */
function isIssueStatement(g: Group): boolean {
  if (g.topic === null || g.topic === 'complaint' || g.topicScore < ISSUE_SCORE) return false;
  return PROBLEM_INTENTS.has(g.topic) || g.problem;
}

function groupOf(seg: Segment): Group {
  const { start, end, top, topic, topicScore, question, problem } = seg;
  return { start, end, top, topic, topicScore, question, problem };
}

/** Grow a group with the next segment (its text is then re-scored as a whole). */
function extend(g: Group, seg: Segment): void {
  g.end = seg.end;
  g.top = undefined;
  g.question ||= seg.question;
  g.problem ||= seg.problem;
  g.topicScore = Math.max(g.topicScore, seg.topicScore);
}

/**
 * A segment that stands on its own: it has a topic, or it is a question with content of its own ("do you have a
 * mobile app?") rather than a follow-up ("can you check?").
 */
function standsAlone(seg: Segment): boolean {
  return seg.topic !== null || (seg.question && !seg.followUp);
}

/** Attach follow-ups and topic-less clauses to their neighbours and merge consecutive clauses about the same intent. */
function groupSegments(segments: Segment[]): Group[] {
  const groups: Group[] = [];
  /** Follow-up clauses before the first group; they become part of the next group. */
  let prefix: Group | undefined;
  for (const seg of segments) {
    const last = groups.at(-1);
    const alone = standsAlone(seg);
    if (last && !seg.newTopic && (!alone || (seg.topic !== null && seg.topic === last.topic))) {
      extend(last, seg);
    } else if (!alone && !seg.newTopic) {
      if (prefix) extend(prefix, seg);
      else prefix = groupOf(seg);
    } else if (prefix && !seg.newTopic) {
      extend(prefix, seg);
      prefix.topic = seg.topic;
      groups.push(prefix);
      prefix = undefined;
    } else {
      if (prefix) groups.push(prefix);
      prefix = undefined;
      groups.push(groupOf(seg));
    }
  }
  if (prefix) groups.push(prefix);
  return groups;
}

/**
 * Split into distinct questions/requests and classify each one (intent = top intent when its score >= 0.3,
 * else null). Non-question chatter is dropped; at most 6 are returned.
 */
export function splitQuestions(text: string): QuestionSpan[] {
  if (!text.trim()) return [];
  const segments: Segment[] = [];
  const clauses = sentenceSpans(text).flatMap((sentence) => clauseSpans(text, sentence));
  for (const clause of clauses.slice(0, MAX_CLAUSES)) {
    const clauseText = text.slice(clause.start, clause.end);
    if (!isChatter(clauseText)) segments.push(toSegment(clauseText, clause, clause.newTopic));
  }
  const out: QuestionSpan[] = [];
  for (const g of groupSegments(segments)) {
    const joined = collapseWhitespace(text.slice(g.start, g.end));
    if (!g.question && !isIssueStatement(g)) continue;
    const top = g.top ?? scoreIntentsPrepared(prepare(joined))[0];
    out.push({ text: joined, intent: top && top.score >= TOPIC_SCORE ? top.intent : null });
    if (out.length === MAX_QUESTIONS) break;
  }
  return out;
}
