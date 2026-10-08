/**
 * Entity extraction for customer messages (emails, amounts, crypto, tx hashes, addresses, bet ids, VIP ranks...).
 *
 * Every extractor proposes candidates with offsets into the ORIGINAL text; overlaps are then resolved so the
 * longer (and, on ties, more specific) candidate wins: a tx hash beats a phone number, an email beats the bare
 * domain inside it, a URL beats an email inside its query string.
 */
import type { Entity, EntityType } from '../../shared/types.js';
import { CRYPTO_ALIASES, FIAT_ALIASES, NETWORK_ALIASES, normalizeForMatch, VIP_RANKS } from '../domain/igaming.js';
import { buildAlternation, escapeRegExp, isMostlyCaps, phraseSource, STOPWORDS } from './text.js';

interface Candidate {
  type: EntityType;
  value: string;
  start: number;
  end: number;
  priority: number;
}

/** Tie-breaker when two overlapping candidates have the same length (higher wins). */
const PRIORITY: Record<EntityType, number> = {
  tx_hash: 100,
  crypto_address: 95,
  url: 90,
  email: 90,
  bet_id: 85,
  date: 70,
  amount: 65,
  duration: 60,
  phone: 55,
  vip_rank: 50,
  bonus_name: 50,
  document_type: 50,
  currency: 50,
  crypto: 50,
  network: 45,
  provider: 45,
  game: 40,
  username: 40,
  name: 30,
};

/** Per-call extraction state: the text, a few lazily useful flags and the candidate list. */
interface Ctx {
  text: string;
  norm: string;
  mostlyCaps: boolean;
  out: Candidate[];
}

function add(ctx: Ctx, type: EntityType, value: string, start: number, end: number, priority = PRIORITY[type]): void {
  if (end > start && value) ctx.out.push({ type, value, start, end, priority });
}

/** Start/end of capture group `g` of a match made with the `d` flag. */
function groupSpan(m: RegExpMatchArray, g: number): [number, number] | null {
  const span = m.indices?.[g];
  return span ? [span[0], span[1]] : null;
}

function capitalizedInText(ctx: Ctx, raw: string): boolean {
  return !ctx.mostlyCaps && /^\p{Lu}/u.test(raw);
}

// ---------------------------------------------------------------------------
// Contact data, links, hashes, addresses, bet ids
// ---------------------------------------------------------------------------

const EMAIL_RE = /\b[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}\b/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const BARE_DOMAIN_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,6}(?:com|net|org|io|bet|casino|gg|co|us|uk|app|ly|info|tv|xyz|games|eu)\b(?:\/[^\s<>"'`]*)?/gi;
const TRAILING_PUNCT_RE = /[.,!?;:)\]}'"’”]+$/;

function extractContacts(ctx: Ctx): void {
  for (const m of ctx.text.matchAll(EMAIL_RE)) {
    const start = m.index ?? 0;
    add(ctx, 'email', m[0].toLowerCase(), start, start + m[0].length);
  }
  for (const re of [URL_RE, BARE_DOMAIN_RE]) {
    for (const m of ctx.text.matchAll(re)) {
      const raw = m[0].replace(TRAILING_PUNCT_RE, '');
      const start = m.index ?? 0;
      add(ctx, 'url', raw, start, start + raw.length);
    }
  }
}

const TX_HASH_RE = /\b(?:0x)?[a-f0-9]{64}\b/gi;
const SOL_SIGNATURE_RE = /\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g;
/** Non-global test used by intent scoring. */
export const TX_HASH_TEST_RE = /\b(?:0x)?[a-f0-9]{64}\b/i;

const ETH_ADDRESS_RE = /\b0x[a-f0-9]{40}\b/gi;
const BECH32_RE = /\b(?:bc1|ltc1|tb1)[ac-hj-np-z02-9]{25,71}\b/gi;
const BASE58_PREFIXED_RE =
  /\b(?:[13LMD][1-9A-HJ-NP-Za-km-z]{25,34}|T[1-9A-HJ-NP-Za-km-z]{33}|r[1-9A-HJ-NP-Za-km-z]{24,34})\b/g;
const SOL_ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const ADDRESS_CONTEXT_RE = /\b(?:address|addr|wallet)\b/i;
const HAS_DIGIT_RE = /\d/;
const HAS_LETTER_RE = /[a-z]/i;

function looksLikeBase58Id(raw: string): boolean {
  return HAS_DIGIT_RE.test(raw) && HAS_LETTER_RE.test(raw);
}

function extractHashesAndAddresses(ctx: Ctx): void {
  for (const re of [TX_HASH_RE, SOL_SIGNATURE_RE]) {
    for (const m of ctx.text.matchAll(re)) {
      const start = m.index ?? 0;
      if (re === SOL_SIGNATURE_RE && !looksLikeBase58Id(m[0])) continue;
      add(ctx, 'tx_hash', m[0], start, start + m[0].length);
    }
  }
  for (const re of [ETH_ADDRESS_RE, BECH32_RE]) {
    for (const m of ctx.text.matchAll(re)) {
      const start = m.index ?? 0;
      add(ctx, 'crypto_address', m[0], start, start + m[0].length);
    }
  }
  for (const m of ctx.text.matchAll(BASE58_PREFIXED_RE)) {
    const start = m.index ?? 0;
    if (looksLikeBase58Id(m[0])) add(ctx, 'crypto_address', m[0], start, start + m[0].length);
  }
  for (const m of ctx.text.matchAll(SOL_ADDRESS_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const around = ctx.text.slice(Math.max(0, start - 48), Math.min(ctx.text.length, end + 48));
    if (looksLikeBase58Id(m[0]) && ADDRESS_CONTEXT_RE.test(around)) add(ctx, 'crypto_address', m[0], start, end);
  }
}

const BET_PREFIXED_RE = /\b(?:casino|sports?|sportsbook|house|racing|race|lottery|poker):\d{6,20}\b/gi;
const BET_LABEL_RE =
  /\b(?:bet|ticket|round|game|slip|wager)[ -]?(?:id|number|no\.?|nr\.?|#)(?:\s+(?:is|was)\b)?\s*[:#=-]?\s*((?:[a-z]+:)?\d{5,20})\b/gid;
const BET_NEAR_RE = /\b(?:bets?|ticket|round|slip|wager)\b[^\d\n.?!]{0,24}?(?<!\w)(\d{8,20})\b/gid;

function extractBetIds(ctx: Ctx): void {
  for (const m of ctx.text.matchAll(BET_PREFIXED_RE)) {
    const start = m.index ?? 0;
    add(ctx, 'bet_id', m[0].toLowerCase(), start, start + m[0].length);
  }
  for (const re of [BET_LABEL_RE, BET_NEAR_RE]) {
    for (const m of ctx.text.matchAll(re)) {
      const span = groupSpan(m, 1);
      if (span) add(ctx, 'bet_id', (m[1] ?? '').toLowerCase(), span[0], span[1]);
    }
  }
}

const PHONE_RE = /(?<![\w+])(?:\+|00)?\(?\d{1,4}\)?(?:[ .-]?\(?\d{2,4}\)?){2,5}(?!\w)/g;
const PHONE_CONTEXT_RE = /\b(?:phone|mobile|cell|number|tel|telephone|whatsapp|telegram|call me|sms|contact)\b[^\n]{0,30}$/i;
const US_PHONE_RE = /^\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}$/;
const NON_DIGIT_G_RE = /\D/g;

function extractPhones(ctx: Ctx): void {
  for (const m of ctx.text.matchAll(PHONE_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const digits = raw.replace(NON_DIGIT_G_RE, '');
    if (digits.length < 8 || digits.length > 15) continue;
    const international = raw.startsWith('+') || raw.startsWith('00');
    const context = PHONE_CONTEXT_RE.test(ctx.text.slice(Math.max(0, start - 40), start));
    if (international || context || US_PHONE_RE.test(raw)) {
      add(ctx, 'phone', `${raw.startsWith('+') ? '+' : ''}${digits}`, start, start + raw.length);
    }
  }
}

// ---------------------------------------------------------------------------
// Money: amounts, fiat currencies, crypto tickers, networks
// ---------------------------------------------------------------------------

type MoneyInfo = { type: 'currency' | 'crypto'; value: string };

const SYMBOLS: Record<string, string> = { 'us$': 'USD', 'a$': 'AUD' };
const CODES = new Map<string, MoneyInfo>();
for (const [k, v] of Object.entries(FIAT_ALIASES)) {
  if (/^[a-z]+$/.test(k)) CODES.set(k, { type: 'currency', value: v });
  else SYMBOLS[k] = v;
}
for (const [k, v] of Object.entries(CRYPTO_ALIASES)) CODES.set(k, { type: 'crypto', value: v });

/** Codes that are also common words: only accepted next to an amount or in obvious currency context. */
const AMBIGUOUS_CODES = new Set(['try', 'php', 'pen', 'cop', 'ars', 'link', 'uni', 'ape', 'sand', 'cro', 'ada', 'eos', 'dai', 'pol']);

const byLengthDesc = (a: string, b: string): number => b.length - a.length;
const codeKeys = [...CODES.keys()].sort(byLengthDesc);
const CODE_SRC = codeKeys.map(phraseSource).join('|');
const SAFE_CODE_SRC = codeKeys
  .filter((k) => !AMBIGUOUS_CODES.has(k))
  .map(phraseSource)
  .join('|');
const SYMBOL_SRC = Object.keys(SYMBOLS).sort(byLengthDesc).map(escapeRegExp).join('|');

const NUM_SRC = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+,\d+|\d{1,3}(?:\.\d{3}){2,}|\d+(?:[.,]\d+)?)(?:k(?![a-z]))?`;

const SYMBOL_AMOUNT_RE = new RegExp(`(?<![a-z0-9])(${SYMBOL_SRC})\\s?(${NUM_SRC})(?![\\w])`, 'gid');
const AMOUNT_SYMBOL_RE = new RegExp(`(?<![\\w.,])(${NUM_SRC})\\s?([$€£₹¥₺₦₩])`, 'gid');
const AMOUNT_CODE_RE = new RegExp(`(?<![\\w.,])(${NUM_SRC})\\s?(${CODE_SRC})(?![a-z0-9])`, 'gid');
const CODE_AMOUNT_RE = new RegExp(`\\b(${SAFE_CODE_SRC})\\s?(${NUM_SRC})(?![\\w.,]?\\d)(?!\\w)`, 'gid');
const VERB_AMOUNT_RE = new RegExp(
  String.raw`\b(?:deposit(?:ed)?|withdr(?:aw|ew|awn)|cash(?:ed)?\s?out|sent|send|paid|transferred|won|lost|wagered|balance(?:\s+(?:of|is|was))?|amount(?:\s+(?:of|is|was))?)\s+(?:of\s+|about\s+|around\s+|like\s+|~)?(${NUM_SRC})(?![\w.,%]|\s*(?:x|times|days?|hours?|hrs?|h|mins?|minutes?|weeks?|months?|years?|%)\b)`,
  'gid',
);
const CODE_WORD_RE = new RegExp(`\\b(${CODE_SRC})\\b`, 'gi');
const AMBIGUOUS_AFTER_RE = /^\s+(?:tokens?|coins?|currency|balance|wallet|network)\b/i;
const AMBIGUOUS_BEFORE_RE =
  /\b(?:in|to|from|into|with|my|some|of|convert|buy|sell|deposit|deposited|withdraw|withdrew|send|sent|swap|swapped|accept|support)\s+$/i;

const THOUSANDS_COMMA_RE = /^\d{1,3}(?:,\d{3})+$/;
const THOUSANDS_DOT_RE = /^\d{1,3}(?:\.\d{3}){2,}$/;

/**
 * Normalize a written amount: thousand separators removed, decimal comma -> dot, "k" suffix expanded.
 * "1,000.50" -> "1000.50", "1.000,50" -> "1000.50", "0,05" -> "0.05", "2.5k" -> "2500".
 */
export function normalizeNumber(raw: string): string {
  let s = raw.replace(/\s+/g, '');
  let multiplier = 1;
  if (/k$/i.test(s)) {
    multiplier = 1000;
    s = s.slice(0, -1);
  }
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = THOUSANDS_COMMA_RE.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (THOUSANDS_DOT_RE.test(s)) {
    s = s.replace(/\./g, '');
  }
  if (multiplier === 1) return s;
  return String(Math.round(Number(s) * multiplier * 1e8) / 1e8);
}

function addMoneyCode(ctx: Ctx, code: string, start: number, end: number): void {
  const info = CODES.get(code.toLowerCase().replace(/\s+/g, ' '));
  if (info) add(ctx, info.type, info.value, start, end);
}

function addAmount(ctx: Ctx, m: RegExpMatchArray, numGroup: number): void {
  const span = groupSpan(m, numGroup);
  if (span) add(ctx, 'amount', normalizeNumber(m[numGroup] ?? ''), span[0], span[1]);
}

function extractMoney(ctx: Ctx): void {
  for (const m of ctx.text.matchAll(SYMBOL_AMOUNT_RE)) {
    const sym = groupSpan(m, 1);
    const currency = SYMBOLS[(m[1] ?? '').toLowerCase()];
    if (sym && currency) add(ctx, 'currency', currency, sym[0], sym[1]);
    addAmount(ctx, m, 2);
  }
  for (const m of ctx.text.matchAll(AMOUNT_SYMBOL_RE)) {
    const sym = groupSpan(m, 2);
    const currency = SYMBOLS[(m[2] ?? '').toLowerCase()];
    if (sym && currency) add(ctx, 'currency', currency, sym[0], sym[1]);
    addAmount(ctx, m, 1);
  }
  for (const [re, numGroup, codeGroup] of [
    [AMOUNT_CODE_RE, 1, 2],
    [CODE_AMOUNT_RE, 2, 1],
  ] as const) {
    for (const m of ctx.text.matchAll(re)) {
      const code = groupSpan(m, codeGroup);
      if (code) addMoneyCode(ctx, m[codeGroup] ?? '', code[0], code[1]);
      addAmount(ctx, m, numGroup);
    }
  }
  for (const m of ctx.text.matchAll(VERB_AMOUNT_RE)) addAmount(ctx, m, 1);
  extractStandaloneCodes(ctx);
}

function extractStandaloneCodes(ctx: Ctx): void {
  for (const m of ctx.text.matchAll(CODE_WORD_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const end = start + raw.length;
    if (AMBIGUOUS_CODES.has(raw.toLowerCase()) && !ambiguousCodeInContext(ctx, raw, start, end)) continue;
    addMoneyCode(ctx, raw, start, end);
  }
}

function ambiguousCodeInContext(ctx: Ctx, raw: string, start: number, end: number): boolean {
  if (AMBIGUOUS_AFTER_RE.test(ctx.text.slice(end, end + 16))) return true;
  const upper = !ctx.mostlyCaps && raw === raw.toUpperCase();
  return upper && AMBIGUOUS_BEFORE_RE.test(ctx.text.slice(Math.max(0, start - 16), start));
}

const NETWORK_VALUES: Record<string, string> = {
  tron: 'TRC20',
  trx: 'TRC20',
  ethereum: 'ERC20',
  eth: 'ERC20',
  bnb: 'BEP20',
  'bnb chain': 'BEP20',
  'bnb smart chain': 'BEP20',
  'binance smart chain': 'BEP20',
  solana: 'Solana',
  sol: 'Solana',
  base: 'Base',
  polygon: 'Polygon',
  matic: 'Polygon',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  avalanche: 'Avalanche',
  avax: 'Avalanche',
};
const NETWORK = buildAlternation(
  Object.keys(NETWORK_ALIASES)
    .sort(byLengthDesc)
    .map((k) => [phraseSource(k), NETWORK_ALIASES[k] ?? k] as const),
  'gi',
);
const CHAIN_SRC = String.raw`tron|trx|ethereum|eth|bnb\s+smart\s+chain|binance\s+smart\s+chain|bnb\s+chain|bnb|solana|sol|base|polygon|matic|arbitrum|optimism|avalanche|avax`;
const NETWORK_CONTEXT_RE = new RegExp(
  String.raw`\b(?:on|via|over|using|through|thru)\s+(?:the\s+)?(${CHAIN_SRC})\b|\b(${CHAIN_SRC})\s+(?:network|chain|blockchain)\b`,
  'gid',
);
/** Network named with explicit context ("on Tron", "Solana network") outranks the same word as a coin. */
const CONTEXT_NETWORK_PRIORITY = 60;

function extractNetworks(ctx: Ctx): void {
  for (const m of ctx.text.matchAll(NETWORK.re)) {
    const start = m.index ?? 0;
    const value = NETWORK.valueOf(m);
    if (value) add(ctx, 'network', value, start, start + m[0].length);
  }
  for (const m of ctx.text.matchAll(NETWORK_CONTEXT_RE)) {
    const g = m[1] !== undefined ? 1 : 2;
    const span = groupSpan(m, g);
    const value = NETWORK_VALUES[(m[g] ?? '').toLowerCase().replace(/\s+/g, ' ')];
    if (span && value) add(ctx, 'network', value, span[0], span[1], CONTEXT_NETWORK_PRIORITY);
  }
}

// ---------------------------------------------------------------------------
// Stake vocabulary: VIP ranks, bonus names, documents, games, providers
// ---------------------------------------------------------------------------

const VIP_SET = new Map<string, string>(VIP_RANKS.map((r) => [r.toLowerCase(), r]));
const VIP_RE = /\b(platinum|diamond|obsidian|opal|bronze|silver|gold)\b(?:[ \t]+(vi|iv|v|iii|ii|i|[1-6])(?![\w'’]))?/gid;
const VIP_CONTEXT_RE = /\b(?:vip|rank|ranks|ranked|tier|level|levels|status|loyalty|host|reached|promoted|upgrade|upgraded|downgraded|progress)\b/;
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
const AFTER_NUMERAL_I_RE = /^(?:\s*$|\s*[.,!?;:)]|\s+(?:vip|rank|level|tier|status|member|player|user)\b)/i;

function vipNumeral(m: RegExpMatchArray, text: string): string | null {
  const numeral = m[2];
  if (!numeral) return null;
  if (/^\d$/.test(numeral)) return ROMAN[Number(numeral)] ?? null;
  if (numeral.toLowerCase() === 'i') {
    const end = groupSpan(m, 2)?.[1] ?? 0;
    return numeral === 'I' && AFTER_NUMERAL_I_RE.test(text.slice(end, end + 12)) ? 'I' : null;
  }
  return numeral.toUpperCase();
}

function extractVipRanks(ctx: Ctx): void {
  let vipContext: boolean | undefined;
  for (const m of ctx.text.matchAll(VIP_RE)) {
    const rankSpan = groupSpan(m, 1);
    if (!rankSpan) continue;
    const base = VIP_SET.get((m[1] ?? '').toLowerCase());
    if (!base) continue;
    const numeral = vipNumeral(m, ctx.text);
    const full = numeral ? VIP_SET.get(`${base} ${numeral}`.toLowerCase()) : undefined;
    if (full) {
      add(ctx, 'vip_rank', full, rankSpan[0], groupSpan(m, 2)?.[1] ?? rankSpan[1]);
      continue;
    }
    vipContext ??= VIP_CONTEXT_RE.test(ctx.norm);
    if (vipContext || capitalizedInText(ctx, m[1] ?? '')) add(ctx, 'vip_rank', base, rankSpan[0], rankSpan[1]);
  }
}

const BONUS = buildAlternation(
  [
    [String.raw`monthly\s+subscription\s+bonus(?:es)?`, 'Monthly Subscription Bonus'],
    [String.raw`pre[-\s]?monthly(?:\s+bonus(?:es)?)?`, 'Pre-Monthly Bonus'],
    [String.raw`post[-\s]?monthly(?:\s+bonus(?:es)?)?`, 'Post-Monthly Bonus'],
    [String.raw`monthly\s+bonus(?:es)?`, 'Monthly Bonus'],
    [String.raw`weekly\s+(?:bonus(?:es)?|boosts?)`, 'Weekly Bonus'],
    [String.raw`level[-\s]?up\s+bonus(?:es)?`, 'Level-Up Bonus'],
    [String.raw`(?:birthday|b-?day)\s+(?:bonus|gift|reward|present)`, 'Birthday Bonus'],
    [String.raw`welcome\s+(?:offer|package)`, 'Welcome Offer'],
    [String.raw`welcome\s+bonus|sign[-\s]?up\s+bonus`, 'Welcome Bonus'],
    [String.raw`bonus\s+drops?|drop\s+codes?`, 'Bonus Drop'],
    [String.raw`rake[-\s]?back`, 'Rakeback'],
    [String.raw`(?:daily\s+|hourly\s+)?reloads?(?!\s+(?:the\s+|my\s+|this\s+)?(?:page|site|website|browser|app|game|tab)\b)`, 'Reload'],
  ],
  'gi',
);

const DOCUMENT = buildAlternation(
  [
    [String.raw`proof\s+of\s+address`, 'proof of address'],
    [String.raw`proof\s+of\s+(?:identity|id)`, 'proof of identity'],
    [String.raw`proof\s+of\s+income`, 'proof of income'],
    [String.raw`source\s+of\s+(?:funds|wealth)`, 'source of funds'],
    [String.raw`driv(?:er['’]?s?|ing)\s+licen[cs]e`, "driver's license"],
    [String.raw`national\s+id(?:\s+card)?`, 'national ID'],
    [String.raw`(?:id|identity|identification)\s+card`, 'ID card'],
    [String.raw`passports?`, 'passport'],
    [String.raw`utility\s+bills?`, 'utility bill'],
    [String.raw`bank\s+statements?`, 'bank statement'],
    [String.raw`selfies?`, 'selfie'],
    [String.raw`residence\s+permit`, 'residence permit'],
  ],
  'gi',
);

/** Games: [regex source, display name, ambiguous (common English word)]. Longer names first. */
const GAMES: readonly (readonly [string, string, boolean])[] = [
  [String.raw`gates\s+of\s+olympus`, 'Gates of Olympus', false],
  [String.raw`sweet\s+bonanza`, 'Sweet Bonanza', false],
  [String.raw`big\s+bass\s+bonanza`, 'Big Bass Bonanza', false],
  [String.raw`sugar\s+rush`, 'Sugar Rush', false],
  [String.raw`the\s+dog\s+house`, 'The Dog House', false],
  [String.raw`wanted\s+dead\s+or\s+a\s+wild`, 'Wanted Dead or a Wild', false],
  [String.raw`starlight\s+princess`, 'Starlight Princess', false],
  [String.raw`rock\s+paper\s+scissors`, 'Rock Paper Scissors', false],
  [String.raw`lightning\s+roulette`, 'Lightning Roulette', false],
  [String.raw`dragon\s+tower`, 'Dragon Tower', false],
  [String.raw`dragon\s+tiger`, 'Dragon Tiger', false],
  [String.raw`video\s+poker`, 'Video Poker', false],
  [String.raw`blue\s+samurai`, 'Blue Samurai', false],
  [String.raw`scarab\s+spin`, 'Scarab Spin', false],
  [String.raw`tome\s+of\s+life`, 'Tome of Life', false],
  [String.raw`crazy\s+time`, 'Crazy Time', false],
  [String.raw`monopoly\s+live`, 'Monopoly Live', false],
  [String.raw`andar\s+bahar`, 'Andar Bahar', false],
  [String.raw`teen\s+patti`, 'Teen Patti', false],
  [String.raw`(?:texas\s+)?hold\s?['’]?em`, "Texas Hold'em", false],
  [String.raw`sic\s?bo`, 'Sic Bo', false],
  [String.raw`plinko`, 'Plinko', false],
  [String.raw`hi-?lo`, 'Hilo', false],
  [String.raw`keno`, 'Keno', false],
  [String.raw`blackjack`, 'Blackjack', false],
  [String.raw`baccarat`, 'Baccarat', false],
  [String.raw`roulette`, 'Roulette', false],
  [String.raw`craps`, 'Craps', false],
  [String.raw`poker`, 'Poker', false],
  [String.raw`crash`, 'Crash', true],
  [String.raw`dice`, 'Dice', true],
  [String.raw`limbo`, 'Limbo', true],
  [String.raw`mines`, 'Mines', true],
  [String.raw`wheel`, 'Wheel', true],
  [String.raw`diamonds`, 'Diamonds', true],
  [String.raw`slide`, 'Slide', true],
  [String.raw`pump`, 'Pump', true],
  [String.raw`flip`, 'Flip', true],
  [String.raw`snakes`, 'Snakes', true],
  [String.raw`cases`, 'Cases', true],
  [String.raw`darts`, 'Darts', true],
  [String.raw`bars`, 'Bars', true],
  [String.raw`tarot`, 'Tarot', true],
  [String.raw`chicken`, 'Chicken', true],
];
const GAME = buildAlternation(
  GAMES.map(([src, name, ambiguous]) => [src, { name, ambiguous }] as const),
  'gi',
);
const GAME_AFTER_RE = /^\s+(?:game|games|original|originals|round|bet|bets)\b/i;
const GAME_BEFORE_RE = /\b(?:play|playing|played|stake)\s+(?:on\s+|the\s+)?$/i;

const PROVIDERS: readonly (readonly [string, string])[] = [
  [String.raw`pragmatic(?:\s+play)?(?:\s+live)?`, 'Pragmatic Play'],
  [String.raw`evolution(?:\s+gaming)?`, 'Evolution'],
  [String.raw`hacksaw(?:\s+gaming)?`, 'Hacksaw Gaming'],
  [String.raw`no\s?limit\s+city|nolimit(?:\s+city)?`, 'Nolimit City'],
  [String.raw`play['’]?\s?n['’]?\s?go|playngo`, "Play'n GO"],
  [String.raw`push\s+gaming`, 'Push Gaming'],
  [String.raw`relax\s+gaming`, 'Relax Gaming'],
  [String.raw`net\s?ent`, 'NetEnt'],
  [String.raw`red\s+tiger(?:\s+gaming)?`, 'Red Tiger'],
  [String.raw`bgaming`, 'BGaming'],
  [String.raw`spribe`, 'Spribe'],
  [String.raw`thunderkick`, 'Thunderkick'],
  [String.raw`quickspin`, 'Quickspin'],
  [String.raw`elk\s+studios`, 'ELK Studios'],
  [String.raw`big\s+time\s+gaming`, 'Big Time Gaming'],
  [String.raw`yggdrasil`, 'Yggdrasil'],
  [String.raw`playtech`, 'Playtech'],
  [String.raw`microgaming`, 'Microgaming'],
  [String.raw`avatar\s?ux`, 'AvatarUX'],
  [String.raw`endorphina`, 'Endorphina'],
  [String.raw`wazdan`, 'Wazdan'],
  [String.raw`habanero`, 'Habanero'],
  [String.raw`booming\s+games`, 'Booming Games'],
  [String.raw`3\s?oaks(?:\s+gaming)?`, '3 Oaks Gaming'],
  [String.raw`massive\s+studios`, 'Massive Studios'],
  [String.raw`twist\s+gaming`, 'Twist Gaming'],
  [String.raw`print\s+studios`, 'Print Studios'],
  [String.raw`backseat\s+gaming`, 'Backseat Gaming'],
  [String.raw`titan\s+gaming`, 'Titan Gaming'],
  [String.raw`octoplay`, 'Octoplay'],
  [String.raw`peter\s*(?:&|and)\s*sons`, 'Peter & Sons'],
  [String.raw`slotmill`, 'Slotmill'],
  [String.raw`playson`, 'Playson'],
  [String.raw`ezugi`, 'Ezugi'],
];
const PROVIDER = buildAlternation(PROVIDERS, 'gi');

/** Non-global tests used by intent scoring (named provider or unambiguous game). */
export const PROVIDER_TEST_RE = new RegExp(PROVIDER.re.source, 'i');
export const GAME_TEST_RE = new RegExp(`\\b(?:${GAMES.filter(([, , a]) => !a).map(([src]) => src).join('|')})\\b`, 'i');

function extractVocabulary(ctx: Ctx): void {
  for (const [alt, type] of [
    [BONUS, 'bonus_name'],
    [DOCUMENT, 'document_type'],
    [PROVIDER, 'provider'],
  ] as const) {
    for (const m of ctx.text.matchAll(alt.re)) {
      const start = m.index ?? 0;
      const value = alt.valueOf(m);
      if (value) add(ctx, type, value, start, start + m[0].length);
    }
  }
  for (const m of ctx.text.matchAll(GAME.re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const game = GAME.valueOf(m);
    if (!game) continue;
    if (game.ambiguous && !gameInContext(ctx, m[0], start, end)) continue;
    add(ctx, 'game', game.name, start, end);
  }
}

function gameInContext(ctx: Ctx, raw: string, start: number, end: number): boolean {
  return (
    capitalizedInText(ctx, raw) ||
    GAME_AFTER_RE.test(ctx.text.slice(end, end + 12)) ||
    GAME_BEFORE_RE.test(ctx.text.slice(Math.max(0, start - 16), start))
  );
}

// ---------------------------------------------------------------------------
// Time: durations and dates
// ---------------------------------------------------------------------------

const DURATION_RE =
  /\b(\d+(?:[.,]\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|a\s+few|few|a\s+couple(?:\s+of)?|couple(?:\s+of)?|several|many)\s*\+?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|years?|yrs?)\b/gi;
const SHORT_DURATION_RE = /\b(\d{1,3})(h|d)\b/gi;
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
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
  forty: 40,
  fifty: 50,
  sixty: 60,
  couple: 2,
  'a couple': 2,
  'couple of': 2,
  'a couple of': 2,
};
const VAGUE_COUNTS: Record<string, number> = { few: 3, 'a few': 3, several: 4, many: 5 };
const UNIT_PREFIXES: readonly (readonly [string, string, number])[] = [
  ['sec', 'second', 1 / 3600],
  ['min', 'minute', 1 / 60],
  ['h', 'hour', 1],
  ['d', 'day', 24],
  ['w', 'week', 168],
  ['mo', 'month', 720],
  ['y', 'year', 8760],
];

function canonicalUnit(raw: string): readonly [string, string, number] | undefined {
  const u = raw.toLowerCase();
  return UNIT_PREFIXES.find(([prefix]) => u.startsWith(prefix));
}

function durationValue(countRaw: string, unitRaw: string): string | null {
  const unit = canonicalUnit(unitRaw);
  if (!unit) return null;
  const word = countRaw.toLowerCase().replace(/\s+/g, ' ');
  if (VAGUE_COUNTS[word] !== undefined) return `${word.replace(/^a /, '')} ${unit[1]}s`;
  const n = NUMBER_WORDS[word] ?? Number(word.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return `${n} ${unit[1]}${n === 1 ? '' : 's'}`;
}

/** Hours represented by a normalized duration value ("3 days" -> 72, "few hours" -> 3); null when unknown. */
export function durationHours(value: string): number | null {
  const [count = '', unitRaw = ''] = value.split(' ');
  const unit = canonicalUnit(unitRaw);
  if (!unit) return null;
  const n = VAGUE_COUNTS[count] ?? Number(count);
  return Number.isFinite(n) ? n * unit[2] : null;
}

const MONTHS_SRC = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
const DATE_RES: readonly RegExp[] = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  new RegExp(String.raw`\b(?:${MONTHS_SRC})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b`, 'gi'),
  new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTHS_SRC})\.?(?:,?\s+\d{4})?\b`, 'gi'),
  /\b(?:january|february|march|april|june|july|august|september|october|november|december)\s+\d{4}\b/gi,
  /\b(?:yesterday|today|tonight|tomorrow|last\s+night|this\s+morning|this\s+afternoon|this\s+evening|last\s+week|last\s+month)\b/gi,
  /\b(?:(?:last|this|next)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
];
const NUMERIC_DATE_RE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g;

function extractTime(ctx: Ctx): void {
  for (const m of ctx.text.matchAll(DURATION_RE)) {
    const value = durationValue(m[1] ?? '', m[2] ?? '');
    const start = m.index ?? 0;
    if (value) add(ctx, 'duration', value, start, start + m[0].length);
  }
  for (const m of ctx.text.matchAll(SHORT_DURATION_RE)) {
    const value = durationValue(m[1] ?? '', m[2] ?? '');
    const start = m.index ?? 0;
    if (value) add(ctx, 'duration', value, start, start + m[0].length);
  }
  for (const re of DATE_RES) {
    for (const m of ctx.text.matchAll(re)) {
      const start = m.index ?? 0;
      add(ctx, 'date', m[0].replace(/\s+/g, ' '), start, start + m[0].length);
    }
  }
  for (const m of ctx.text.matchAll(NUMERIC_DATE_RE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const plausible = a >= 1 && b >= 1 && a <= 31 && b <= 31 && (a <= 12 || b <= 12);
    const start = m.index ?? 0;
    if (plausible) add(ctx, 'date', m[0], start, start + m[0].length);
  }
}

// ---------------------------------------------------------------------------
// People: usernames and names
// ---------------------------------------------------------------------------

const USERNAME_RE =
  /\b(?:my\s+)?(?:stake\s+)?(?:user\s?name|user\s?id|nick\s?name|handle)\b(\s+(?:is|was)\s+|\s*[:=–-]\s*|\s+)["'“]?(@?[a-z0-9][a-z0-9_.-]{1,31})/gid;
const ACCOUNT_HANDLE_RE = /\b(?:my\s+)?(?:stake\s+)?account(?:\s+name)?\b(\s+is\s+|\s*[:=]\s*|\s+)(@?[a-z0-9][a-z0-9_.-]{2,31})/gid;
const NOT_A_HANDLE = new Set(['changed', 'change', 'reset', 'password', 'email', 'login', 'locked', 'blocked', 'banned', 'and', 'or', 'not', 'please']);

function isHandleLike(token: string): boolean {
  if (token.startsWith('@')) return true;
  const hasLetter = /[a-z]/i.test(token);
  return (hasLetter && /[\d_]/.test(token)) || /[a-z][A-Z]/.test(token) || (hasLetter && /.\../.test(token));
}

function extractUsernames(ctx: Ctx): void {
  for (const [re, explicit] of [
    [USERNAME_RE, true],
    [ACCOUNT_HANDLE_RE, false],
  ] as const) {
    for (const m of ctx.text.matchAll(re)) {
      const span = groupSpan(m, 2);
      if (!span) continue;
      let token = (m[2] ?? '').replace(/[.\-]+$/, '');
      const hasSeparator = (m[1] ?? '').trim() !== '';
      const lower = token.toLowerCase();
      const accepted = explicit
        ? !STOPWORDS.has(lower) && !NOT_A_HANDLE.has(lower) && (hasSeparator || isHandleLike(token) || /^\p{Lu}/u.test(token))
        : isHandleLike(token);
      if (!accepted) continue;
      let start = span[0];
      if (token.startsWith('@')) {
        token = token.slice(1);
        start++;
      }
      add(ctx, 'username', token, start, start + token.length);
    }
  }
}

/** Words that are never a customer's name even when capitalized ("Thanks, Waiting"). */
const NOT_A_NAME = new Set(
  `waiting here there again anyway guys team support stake so much lot everyone all you advance sir madam bro mate man buddy
  help please regards cheers thanks thank ok okay sorry hello hi hey dear best kind good great sincerely love bye asap urgent
  agent admin staff customer player user vip gold silver bronze platinum diamond obsidian opal for in the a an very guys
  again appreciated much soon god lord`
    .split(/\s+/)
    .filter(Boolean),
);
const NAME_TOKEN_RE = /^\p{Lu}[\p{L}'’-]*$/u;
const HAS_LOWER_RE = /\p{Ll}/u;

/** Leading capitalized, non-stoplisted tokens of a captured phrase (max 3), or null. */
function leadingName(phrase: string): string | null {
  const names: string[] = [];
  for (const token of phrase.split(/[ \t]+/)) {
    if (!NAME_TOKEN_RE.test(token) || !HAS_LOWER_RE.test(token)) break;
    const lower = token.toLowerCase();
    if (NOT_A_NAME.has(lower) || STOPWORDS.has(lower)) break;
    names.push(token);
    if (names.length === 3) break;
  }
  return names.length ? names.join(' ') : null;
}

const NAME_PHRASE_SRC = String.raw`([\p{L}'’-]+(?:[ \t]+[\p{L}'’-]+){0,2})`;
const MY_NAME_RE = new RegExp(String.raw`\bmy name is\s+${NAME_PHRASE_SRC}`, 'giud');
const THIS_IS_RE = new RegExp(String.raw`\bthis is\s+([\p{L}'’-]+(?:[ \t]+[\p{L}'’-]+)?)\s+here\b`, 'giud');
const SIGNOFF_RE = new RegExp(
  String.raw`(?:^|[\s.!?,])(?:thanks|thank you|thank u|thx|ty|many thanks|regards|best regards|kind regards|warm regards|best|cheers|sincerely|yours|respectfully)(?:\s+(?:in advance|again|so much|a lot|for (?:the|your) help))?\s*[,!.:;\-–—]*\s+${NAME_PHRASE_SRC}\s*[.!]*\s*$`,
  'iud',
);
const SIGNOFF_WINDOW = 120;

function extractNames(ctx: Ctx): void {
  for (const re of [MY_NAME_RE, THIS_IS_RE]) {
    for (const m of ctx.text.matchAll(re)) addName(ctx, m, 0);
  }
  const offset = Math.max(0, ctx.text.length - SIGNOFF_WINDOW);
  const m = ctx.text.slice(offset).match(SIGNOFF_RE);
  if (m) addName(ctx, m, offset);
}

function addName(ctx: Ctx, m: RegExpMatchArray, offset: number): void {
  const span = groupSpan(m, 1);
  const name = leadingName(m[1] ?? '');
  if (span && name) add(ctx, 'name', name, offset + span[0], offset + span[0] + name.length);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const EXTRACTORS: readonly ((ctx: Ctx) => void)[] = [
  extractContacts,
  extractHashesAndAddresses,
  extractBetIds,
  extractPhones,
  extractMoney,
  extractNetworks,
  extractVipRanks,
  extractVocabulary,
  extractTime,
  extractUsernames,
  extractNames,
];

/** Keep the longest candidates (ties: higher priority, then earlier), drop overlaps, sort by start. */
function resolveOverlaps(text: string, candidates: Candidate[]): Entity[] {
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || b.priority - a.priority || a.start - b.start);
  const taken = new Uint8Array(text.length);
  const kept: Entity[] = [];
  for (const c of candidates) {
    let free = true;
    for (let i = c.start; i < c.end; i++) {
      if (taken[i]) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    taken.fill(1, c.start, c.end);
    kept.push({ type: c.type, value: c.value, raw: text.slice(c.start, c.end), start: c.start, end: c.end });
  }
  return kept.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Extract entities with offsets into `text`. Values are normalized (amount "1000.50", currency "EUR", crypto
 * "BTC", network "TRC20", vip_rank "Platinum IV", duration "3 days"); results are sorted by start and never overlap.
 * An amount and its currency/crypto are separate, adjacent entities ("250 USDT" -> amount 250 + crypto USDT).
 */
export function extractEntities(text: string): Entity[] {
  if (!text.trim()) return [];
  const ctx: Ctx = { text, norm: normalizeForMatch(text), mostlyCaps: isMostlyCaps(text), out: [] };
  for (const extract of EXTRACTORS) extract(ctx);
  return resolveOverlaps(text, ctx.out);
}
