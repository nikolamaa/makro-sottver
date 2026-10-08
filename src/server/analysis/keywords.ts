/**
 * Salient keywords and a lightweight "is this English?" heuristic.
 */
import type { Entity, EntityType } from '../../shared/types.js';
import { CONCEPTS } from '../domain/igaming.js';
import { prepare, type Prepared } from './concepts.js';
import { extractEntities } from './entities.js';
import { STOPWORDS } from './text.js';

const MAX_KEYWORDS = 12;
const KEYWORD_TOKEN_RE = /[\p{L}\p{N}]+(?:'\p{L}+)?/gu;
const DIGITS_ONLY_RE = /^\d+$/;
const MAX_KEYWORD_LENGTH = 24;
/** Personal data and identifiers never become keywords. */
const PRIVATE_TYPES: ReadonlySet<EntityType> = new Set(['email', 'username', 'name', 'phone', 'url', 'crypto_address', 'tx_hash', 'bet_id']);

function privateTokens(entities: readonly Entity[]): Set<string> {
  const tokens = new Set<string>();
  for (const e of entities) {
    if (!PRIVATE_TYPES.has(e.type)) continue;
    for (const m of e.raw.toLowerCase().matchAll(KEYWORD_TOKEN_RE)) tokens.add(m[0]);
  }
  return tokens;
}

const TERM_SEPARATORS_RE = /[\s'/-]+/;
const CURLY_APOSTROPHE_G_RE = /’/g;

function isStopPhrase(term: string): boolean {
  return term.split(TERM_SEPARATORS_RE).every((t) => !t || STOPWORDS.has(t));
}

function keywordToken(token: string): boolean {
  return token.length >= 3 && token.length <= MAX_KEYWORD_LENGTH && !DIGITS_ONLY_RE.test(token) && !STOPWORDS.has(token);
}

/** Keywords of a prepared message (see extractKeywords); `entities` are the message's extracted entities. */
export function extractKeywordsPrepared(p: Prepared, entities: readonly Entity[]): string[] {
  const out: string[] = [];
  /** Tokens already covered by a domain term, plus tokens of personal data. */
  const seen = privateTokens(entities);
  for (const term of p.concepts.terms) {
    if (isStopPhrase(term)) continue;
    for (const part of term.split(' ')) seen.add(part);
    out.push(term);
    if (out.length === MAX_KEYWORDS) return out;
  }
  for (const m of p.norm.matchAll(KEYWORD_TOKEN_RE)) {
    const token = m[0];
    if (seen.has(token) || !keywordToken(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

/**
 * Salient lowercase keywords: iGaming domain terms first (in order of appearance, e.g. "weekly bonus", "tx hash"),
 * then other non-stopword tokens; unique, max 12. Numbers, hash-like tokens and personal data (names, emails,
 * usernames, phones, addresses, ids) are never keywords.
 */
export function extractKeywords(text: string): string[] {
  return extractKeywordsPrepared(prepare(text), extractEntities(text));
}

// ---------------------------------------------------------------------------
// Language heuristic
// ---------------------------------------------------------------------------

const ENGLISH_WORDS: ReadonlySet<string> = new Set([
  ...STOPWORDS,
  ...`money account why from at by as but or if so get got want need still there here they them our us any all again today
  yesterday days day hours hour time ok okay yes sorry support ago been since waiting wait received sent help please
  problem issue question balance bet bets won lost win play played site website number email name know tell said
  made make take took give gave check checked working work new old good bad long much many more less same other
  anything nothing everything something time week month year minutes`
    .split(/\s+/)
    .filter(Boolean),
  ...CONCEPTS.flatMap((c) => c.terms.flatMap((t) => t.split(/[^a-z0-9]+/))).filter((t) => t.length >= 3),
]);

/** Distinctive function/support words of languages our customers often write in (pt, es, tr, de, fr, it). */
const FOREIGN_WORDS: ReadonlySet<string> = new Set(
  `não nao que de da dos das meu minha está esta estou você voce obrigado obrigada saque depósito deposito porque por favor
  ainda conta dinheiro já há dias hoje ontem mas quando como olá ola bom boa isso esse essa foi fiz tem tenho pelo pela uma
  sacar retirada recebi podem verificar pendente
  el la los las es mi mis para con hola gracias retiro cuenta dinero todavía aún días hoy ayer pero cuándo cómo estoy tengo
  hice ayuda nada muy bien también puedo quiero necesito del uno
  ve bir bu için icin ne neden para hesabım hesabim hesap merhaba lütfen lutfen değil degil yok var sen çekim cekim yatırım
  yatirim hala hâlâ gün gündür bekliyorum yardım yardim teşekkürler tesekkurler nasıl nasil mı mi mu mü ama çok cok şu daha
  olarak oldu ile
  ich und nicht das ist mein meine auszahlung einzahlung bitte danke noch schon warum wann wie habe hallo kein keine geld
  konto aber oder mit auf für sie wir der den dem
  je le les est mes pas et retrait dépôt merci bonjour pourquoi quand comment toujours encore argent compte avec une des
  du sur mais oui très tres
  il lo gli sono prelievo grazie ciao perché perche ancora soldi mio mia che di`
    .split(/\s+/)
    .filter((w) => w && !ENGLISH_WORDS.has(w)),
);

const LETTER_G_RE = /\p{L}/gu;
const LATIN_LETTER_G_RE = /\p{Script=Latin}/gu;
const WORD_G_RE = /\p{L}+(?:['’]\p{L}+)*/gu;
const NON_ASCII_LETTER_RE = /[^\x00-\x7F]/;

/**
 * Heuristic: true when the text is probably not English - mostly non-Latin script (Cyrillic, Arabic, CJK...),
 * or Latin text dominated by common Portuguese/Spanish/Turkish/German/French/Italian words or accented words
 * with almost no English words. Emoji-only, numbers-only and very short ambiguous texts return false.
 */
export function isLikelyNonEnglish(text: string): boolean {
  const letters = text.match(LETTER_G_RE)?.length ?? 0;
  if (letters < 3) return false;
  const latin = text.match(LATIN_LETTER_G_RE)?.length ?? 0;
  if ((letters - latin) / letters > 0.4) return true;

  const words = (text.toLowerCase().match(WORD_G_RE) ?? []).map((w) => w.replace(CURLY_APOSTROPHE_G_RE, "'")).filter((w) => w.length >= 2);
  if (!words.length) return false;
  let english = 0;
  let foreign = 0;
  let accented = 0;
  for (const w of words) {
    if (ENGLISH_WORDS.has(w)) english++;
    else if (FOREIGN_WORDS.has(w)) foreign++;
    if (NON_ASCII_LETTER_RE.test(w)) accented++;
  }
  const n = words.length;
  if (n <= 2) return foreign > 0 && english === 0;
  if (english / n >= 0.35) return false;
  if (foreign >= 2 && foreign > english) return true;
  if (accented / n >= 0.25 && english / n < 0.2) return true;
  return n >= 4 && english / n < 0.1;
}
