/**
 * Small text helpers shared by the analyzer modules. Pure functions, precompiled regexes.
 */

/** Escape a string for literal use inside a RegExp source. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex source for a lowercase phrase: spaces match any whitespace run, apostrophes match ' or ’. */
export function phraseSource(phrase: string): string {
  return escapeRegExp(phrase).replace(/ /g, '\\s+').replace(/'/g, "['’]");
}

const WHITESPACE_G_RE = /\s+/g;

/** Collapse whitespace runs to single spaces (no trimming). */
export function collapseWhitespace(s: string): string {
  return s.replace(WHITESPACE_G_RE, ' ');
}

/** Round to two decimals (scores shown in the UI). */
export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Common English function words and chat filler. Lowercase, apostrophes normalized to '. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a about above after again against all already also am an and any anyone anything are aren't as at back be because been
  before being below between both but by can can't cannot cant could couldn't did didn't didnt do does doesn't doesnt doing
  don't dont down during each even every everything few for from further get gets got had hadn't has hasn't hasnt have haven't
  havent having he her here hers herself him himself his how i i'd i'll i'm i've id im ive if in into is isn't isnt it it's
  its itself just know let like me more most much my myself need no nor not nothing now of off oh ok okay on once one only or
  other our ours ourselves out over own please pls plz really said same say see she should shouldn't since so some someone
  something still such sure than that that's the their theirs them themselves then there there's these they this those
  though through to too u under until up ur us very via want was wasn't we well were weren't what what's whats when where
  which while who whom why will with won't wont would wouldn't yeah yes yet you you're your yours yourself hi hii hello hey
  thanks thank thx ty guys dear team regards sir madam bro mate lol hmm help etc per ago anybody everyone`
    .split(/\s+/)
    .filter(Boolean),
);

const WORD_RE = /[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu;

/** Number of words (letter/digit runs; contractions count once). Emoji and punctuation are not words. */
export function countWords(text: string): number {
  return text.match(WORD_RE)?.length ?? 0;
}

/** Letter/digit runs; runs that contain a digit ("2FA", "TRC20", "CS2") are codes, not shouted words. */
const CAPS_WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const UPPER_RE = /\p{Lu}/u;
const LOWER_RE = /\p{Ll}/u;
const DIGIT_RE = /\p{N}/u;

/** Upper-case acronyms that are normally written in caps and must not count as "shouting". */
const NATURAL_ACRONYMS: ReadonlySet<string> = new Set(
  `btc eth ltc usdt usdc trx xrp doge sol bch bnb ada eos dai usd eur gbp inr cad jpy brl try ngn vip kyc id otp vpn faq
  ok erc trc bep bsc poa poi uk us eu nba nfl nhl mlb ufc api sms pdf url iban upi pix tx txid asap pm am atm nft fyi btw
  lol ip dm utc gmt swift busd shib matic pol link uni ape cro sand tron aud nzd chf mxn ars clp cop pen idr php vnd krw
  rub uah pln zar sek nok dkk czk huf kzt eta rtp rng aml sof edd pep tos ios pc tv gif jpg jpeg png ceo usa uae fifa
  uefa epl ipl mvp ftd pin nfts cs csgo`.split(/\s+/),
);

/**
 * "Shouted" words: words of 2+ letters written fully in upper case, ignoring common acronyms (BTC, KYC, RTP...) and
 * codes that contain digits (2FA, TRC20). Returns the number of words considered, how many are shouted, and the ratio.
 */
export function capsRatio(text: string): { ratio: number; words: number; caps: number } {
  let words = 0;
  let caps = 0;
  for (const m of text.matchAll(CAPS_WORD_RE)) {
    const w = m[0];
    if (w.length < 2 || DIGIT_RE.test(w) || NATURAL_ACRONYMS.has(w.toLowerCase())) continue;
    words++;
    if (UPPER_RE.test(w) && !LOWER_RE.test(w)) caps++;
  }
  return { ratio: words ? caps / words : 0, words, caps };
}

/** True when the message is mostly written in capital letters (used to ignore capitalization cues). */
export function isMostlyCaps(text: string): boolean {
  const { ratio, words } = capsRatio(text);
  return words >= 3 && ratio > 0.5;
}

/**
 * Build one alternation regex from (source, value) pairs, in the given order (put longer phrases first).
 * Sources must only use non-capturing groups; `valueOf` maps a match back to its value through the index of
 * the participating capture group.
 */
export function buildAlternation<V>(
  entries: readonly (readonly [source: string, value: V])[],
  flags: string,
  wrap: (alternation: string) => string = (alt) => `\\b(?:${alt})\\b`,
): { re: RegExp; valueOf: (m: RegExpMatchArray) => V | undefined } {
  const alt = entries.map(([src]) => `(${src})`).join('|');
  const re = new RegExp(wrap(alt), flags);
  return {
    re,
    valueOf(m) {
      for (let i = 0; i < entries.length; i++) if (m[i + 1] !== undefined) return entries[i]?.[1];
      return undefined;
    },
  };
}
