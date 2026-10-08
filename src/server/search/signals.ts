/**
 * Message-level relevance signals applied on top of the hybrid score (see ranker.ts / scoring.ts):
 *
 *  - Question focus: the domain concepts (iGaming vocabulary) and terms of the whole message and of each question
 *    span. Explanations use it to tell which question of a multi-question message a macro answers, so matched terms
 *    come from that question only.
 *  - Products (sports / casino / poker) the customer mentions, to detect a mismatch with a macro that is specific
 *    to another product ("max bet on tennis" vs a casino betting-limits macro).
 *  - Money flows the customer says are already resolved ("thanks, deposit arrived!"): they must not boost macros
 *    about a missing deposit or a pending withdrawal.
 *
 * Pure and fast: one pass over the message text plus one concept scan per question span.
 */
import type { Analysis, Intent, Macro } from '../../shared/types.js';
import { conceptsOfTerm, normalizeForMatch, PRODUCT_TERMS, type Product } from '../domain/igaming.js';
import { correctTypo, matchConcepts } from './concepts.js';
import { isGenericWord, isNoiseToken, stem, tokenize } from './text.js';

/** Concepts present in nearly every conversation ("today", "account", "ridiculous"); they identify no macro. */
export const GENERIC_CONCEPTS: ReadonlySet<string> = new Set(['time', 'account', 'complaint']);

export type MoneyFlow = 'deposit' | 'withdrawal';

/** Intent that a resolved money flow contradicts ("my deposit arrived" is not a missing deposit). */
export const RESOLVED_FLOW_INTENT: Readonly<Record<MoneyFlow, Intent>> = {
  deposit: 'deposit_missing',
  withdrawal: 'withdrawal_pending',
};

export interface QuestionFocus {
  /** Intent of the question span (null for the whole message). */
  intent: Intent | null;
  /** Non-generic concept ids the question mentions (typo-corrected words included). */
  concepts: ReadonlySet<string>;
  /** Stems of the question's content words (noise tokens removed). */
  terms: ReadonlySet<string>;
}

export interface MessageSignals {
  /** The whole message (without resolved clauses) first, then each question span when there are >= 2 of them. */
  questions: QuestionFocus[];
  /** Products named in the message (outside resolved clauses). */
  products: ReadonlySet<Product>;
  /** Money flows the customer reports as arrived/received and does not also report as a problem. */
  resolved: ReadonlySet<MoneyFlow>;
  /** Stems that occur only in resolved clauses (context such as "deposit arrived", not the question). */
  resolvedTerms: ReadonlySet<string>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PRODUCT_RES: readonly (readonly [Product, RegExp])[] = (Object.keys(PRODUCT_TERMS) as Product[]).map(
  (p) => [p, new RegExp(`(?:^|[^a-z0-9])(?:${PRODUCT_TERMS[p].map(escapeRe).join('|')})(?=$|[^a-z0-9])`)] as const,
);

/** Products named in a text (word-boundary match on normalized text). */
export function productsOf(text: string): Set<Product> {
  const norm = normalizeForMatch(text);
  const out = new Set<Product>();
  for (const [product, re] of PRODUCT_RES) if (re.test(norm)) out.add(product);
  return out;
}

/**
 * Products a macro is specific to: named in its title or implied by its intents. Bodies are ignored because they
 * mention other products in passing ("sports bets count 3x"). Empty for product-agnostic macros.
 */
export function macroProducts(macro: Pick<Macro, 'title' | 'intents'>): Set<Product> {
  const out = productsOf(macro.title);
  if (macro.intents.includes('sports_betting')) out.add('sports');
  if (macro.intents.includes('casino_games')) out.add('casino');
  return out;
}

/** Non-generic concept ids of a text, including concepts of misspelled domain words ("withdrawl"). */
export function conceptIdsOf(text: string): Set<string> {
  const ids = new Set(matchConcepts(text).keys());
  for (const token of tokenize(text)) {
    const fixed = correctTypo(token);
    if (fixed) for (const id of conceptsOfTerm(fixed)) ids.add(id);
  }
  for (const id of GENERIC_CONCEPTS) ids.delete(id);
  return ids;
}

/** Stems of the content words of a text. */
export function contentTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(text)) if (!isNoiseToken(token) && !isGenericWord(token)) out.add(stem(token));
  return out;
}

// ---------------------------------------------------------------------------
// Resolved money flows
// ---------------------------------------------------------------------------

/** Clauses: text between sentence punctuation, commas, semicolons, newlines and "but". */
const CLAUSE_RE = /[^.!?;,\n]+[.!?;,\n]*/g;
const BUT_SPLIT_RE = /\s+(?:but|however|though)\s+/i;
const TRAILING_PUNCTUATION_RE = /[.!?;,\n]+$/;
/** The flow happened: "arrived", "came through", "got credited", "received it", "got my withdrawal". */
const RESOLVED_RE =
  /\b(?:arrived|came (?:through|in)|went through|(?:got|been|was|is|now|finally|already) credited|credited now|showed up|shows? up now|landed|cleared|(?:already |finally )?received (?:it|them|my|the)|(?:got|received) it|got (?:my|the) (?:deposit|withdrawal|money|funds|payout|cashout|coins?|crypto)|is (?:there|in my (?:balance|wallet|account)) now|all good now)\b/;
/**
 * Negation, a problem, doubt or a question word anywhere in the clause cancels the resolution ("hasn't arrived",
 * "got my withdrawal denied", "when ...").
 */
const UNRESOLVED_RE =
  /\b(?:not|no|never|nothing|nowhere|still|yet|cant|cannot|didnt|doesnt|hasnt|havent|isnt|wasnt|wont|where|when|why|how|if|whether|only|half|partially|part|less|short|wrong|missing|lost|pending|stuck|denied|rejected|declined|cancell?ed|reversed|returned)\b/;
const QUESTION_LEAD_RE = /^\s*(?:has|have|had|did|does|do|is|was|will|would|should|can|could)\b/;

interface Clause {
  /** Original text of the clause. */
  text: string;
  resolved: boolean;
}

/** True when a clause reports that money arrived, without negation, doubt or a question. */
function isResolvedClause(text: string, question: boolean): boolean {
  if (question) return false;
  const norm = text.toLowerCase().replace(/[’‘`]/g, "'").replace(/n't\b/g, 'nt');
  return RESOLVED_RE.test(norm) && !UNRESOLVED_RE.test(norm) && !QUESTION_LEAD_RE.test(norm);
}

function clausesOf(message: string): Clause[] {
  const out: Clause[] = [];
  for (const m of message.matchAll(CLAUSE_RE)) {
    const raw = m[0];
    const question = raw.includes('?');
    for (const part of raw.split(BUT_SPLIT_RE)) {
      const text = part.replace(TRAILING_PUNCTUATION_RE, '').trim();
      if (text) out.push({ text, resolved: isResolvedClause(text, question) });
    }
  }
  return out;
}

function flowsOf(concepts: ReadonlySet<string>): MoneyFlow[] {
  const flows: MoneyFlow[] = [];
  if (concepts.has('deposit')) flows.push('deposit');
  if (concepts.has('withdrawal')) flows.push('withdrawal');
  return flows;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Relevance signals of a customer message. `analysis.questions` provides the question spans. */
export function messageSignals(message: string, analysis: Pick<Analysis, 'questions'>): MessageSignals {
  const clauses = clausesOf(message);
  const resolvedFlows = new Set<MoneyFlow>();
  const openFlows = new Set<MoneyFlow>();
  const resolvedStems = new Set<string>();
  const openStems = new Set<string>();
  const open: string[] = [];
  for (const clause of clauses) {
    const flows = flowsOf(new Set(matchConcepts(clause.text).keys()));
    const stems = contentTerms(clause.text);
    if (clause.resolved && flows.length > 0) {
      for (const f of flows) resolvedFlows.add(f);
      for (const s of stems) resolvedStems.add(s);
    } else {
      for (const f of flows) openFlows.add(f);
      for (const s of stems) openStems.add(s);
      open.push(clause.text);
    }
  }
  const resolved = new Set([...resolvedFlows].filter((f) => !openFlows.has(f)));
  const resolvedTerms = new Set([...resolvedStems].filter((s) => !openStems.has(s)));
  const openText = resolved.size > 0 ? open.join('\n') : message;

  const questions: QuestionFocus[] = [{ intent: null, concepts: conceptIdsOf(openText), terms: contentTerms(openText) }];
  if (analysis.questions.length >= 2) {
    for (const q of analysis.questions) questions.push({ intent: q.intent, concepts: conceptIdsOf(q.text), terms: contentTerms(q.text) });
  }
  return { questions, products: productsOf(openText), resolved, resolvedTerms };
}

/** True when the message names products and the macro is specific to other products only. */
export function isProductMismatch(messageProducts: ReadonlySet<Product>, macroProductSet: ReadonlySet<Product>): boolean {
  if (messageProducts.size === 0 || macroProductSet.size === 0) return false;
  for (const p of messageProducts) if (macroProductSet.has(p)) return false;
  return true;
}
