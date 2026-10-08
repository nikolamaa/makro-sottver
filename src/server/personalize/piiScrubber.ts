/**
 * Built-in PII scrubber for text that goes to a cloud LLM. pseudonymize() runs it in addition to the analyzer's
 * entities, so personal data the analyzer does not tokenize is still replaced:
 *   - self-introduced names: "I'm Jovana Petrovic", "I am Peter Parker", "It's Ana here", "Ana Ivanovic here",
 *     "Name: John Smith", "call me Ana"
 *   - IBANs (checksum-valid, or any IBAN-shaped value right after the word "IBAN")
 *   - Luhn-valid payment card numbers (13-19 digits, plain or in groups)
 *   - dates of birth (a date near "DOB", "born", "birthday", "date of birth")
 *   - passport / ID / document numbers after a document keyword ("passport no. X1234567", "ID number ...")
 *   - street addresses (house number + street word + optional city/postcode, plus common European forms)
 *   - phone numbers (international prefix, or right after a phone keyword)
 * Pure functions, no I/O. Tuned for few false positives: amounts, tx hashes, wallet addresses, bet ids and ordinary
 * capitalized words are left alone (stoplists, keyword context, Luhn / IBAN checksums). Over-masking is the safe
 * failure mode: every value is restored in the reply the agent gets.
 */

export type PiiKind = 'NAME' | 'PHONE' | 'IBAN' | 'CARD' | 'DOB' | 'DOC_ID' | 'ADDRESS';

export interface PiiMatch {
  /** Token label, e.g. "IBAN" -> ⟦IBAN_1⟧. */
  kind: PiiKind;
  /** Exact text as it appears in the input. */
  value: string;
  start: number;
  end: number;
}

/** Overlapping matches: the more specific kind wins, then the longer match, then the earlier one. */
const KIND_PRIORITY: Readonly<Record<PiiKind, number>> = { IBAN: 6, CARD: 5, DOC_ID: 4, DOB: 3, ADDRESS: 2, PHONE: 1, NAME: 0 };

function words(list: string): string[] {
  return list.split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Capitalized words that are not a customer's name (compared lowercased). */
const NOT_A_NAME = new Set(
  words(`
  i a an the and or but so not no nor yes yeah yep nope my me mine you your yours u ur we us our he him his she her they
  them their it its this that these those here there where when what who why how which from in on at to of for with
  without by about as into over under after before since until than then too very really just still also again now
  even only quite rather pretty super totally extremely completely absolutely literally actually basically honestly
  seriously definitely probably maybe already almost currently based living located

  sure sorry ok okay done finished back new old ready able unable available happy glad fine good great bad sad tired
  sick angry mad upset furious frustrated disappointed annoyed confused worried scared afraid nervous shocked
  surprised stuck lost broke poor rich serious desperate ridiculous unacceptable insane crazy terrible horrible awful
  disgusting unbelievable amazing interested verified unverified banned blocked locked suspended excluded restricted
  eligible registered being been going trying waiting writing asking contacting reaching playing using having getting
  looking wondering hoping talking messaging sending

  stake support team agent admin staff customer player user member vip bonus casino sports sportsbook poker plinko
  crash dice mines limbo keno roulette blackjack baccarat slots slot originals rakeback reload weekly monthly daily
  vault wallet account deposit deposits withdrawal withdrawals withdraw payment payments money balance funds
  verification kyc level rank tier platinum gold silver bronze diamond obsidian opal everything nothing something
  anything everyone someone anyone nobody everybody somebody anybody all none both each other same more most less
  much many few some any every help problem issue question request ticket bet bets game games

  bitcoin btc ethereum eth litecoin ltc tether usdt usdc dogecoin doge solana sol ripple xrp tron trx bnb binance
  cardano ada polygon matic monero xmr coinbase metamask kraken bybit okx ledger trezor exodus visa mastercard skrill
  neteller paypal revolut moonpay apple google

  hi hello hey hiya yo dear greetings morning afternoon evening night thanks thank thx ty regards cheers please pls
  plz kindly sir madam maam mister miss mr mrs ms dr bro mate man buddy guys god lord jesus omg lol wtf

  monday tuesday wednesday thursday friday saturday sunday today tomorrow yesterday tonight january february march
  april may june july august september october november december week weekend month year

  english british american canadian australian german french spanish italian portuguese brazilian dutch belgian swiss
  austrian swedish norwegian danish finnish polish czech slovak hungarian romanian bulgarian greek turkish russian
  ukrainian serbian croatian bosnian slovenian macedonian montenegrin albanian indian pakistani chinese japanese
  korean vietnamese thai filipino indonesian malaysian mexican argentinian argentine chilean colombian peruvian
  nigerian kenyan african european asian arab arabic muslim christian
`),
);
const NAME_TOKEN_RE = /^\p{Lu}[\p{L}'’-]*$/u;
const HAS_LOWER_RE = /\p{Ll}/u;
const POSSESSIVE_RE = /['’]s$/;
const PHRASE_TOKEN_RE = /[\p{L}'’-]+/gu;
const MAX_NAME_TOKENS = 3;

function isStopWord(token: string): boolean {
  return NOT_A_NAME.has(token.toLowerCase().replace(POSSESSIVE_RE, ''));
}

function isNameToken(token: string): boolean {
  return token.length >= 2 && NAME_TOKEN_RE.test(token) && HAS_LOWER_RE.test(token) && !isStopWord(token);
}

/** Words of a captured phrase with their offsets in the phrase. */
function phraseTokens(phrase: string): { text: string; start: number; end: number }[] {
  return [...phrase.matchAll(PHRASE_TOKEN_RE)].map((m) => ({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** Leading name tokens of a phrase (max 3) as [start, end] offsets in the phrase, or null. */
function leadingNameSpan(phrase: string): [number, number] | null {
  let end = -1;
  for (const [i, token] of phraseTokens(phrase).entries()) {
    if (i === MAX_NAME_TOKENS || !isNameToken(token.text)) break;
    end = token.end;
  }
  return end > 0 ? [0, end] : null;
}

/** A phrase that is a name as a whole, after dropping leading greeting/filler words ("Hey Ana here"). */
function wholeNameSpan(phrase: string): [number, number] | null {
  const tokens = phraseTokens(phrase);
  let i = 0;
  while (i < tokens.length && isStopWord(tokens[i]!.text)) i++;
  const rest = tokens.slice(i);
  if (!rest.length || !rest.every((t) => isNameToken(t.text))) return null;
  return [rest[0]!.start, rest.at(-1)!.end];
}

const PHRASE_SRC = String.raw`([\p{L}'’-]+(?:[ \t]+[\p{L}'’-]+){0,${MAX_NAME_TOKENS - 1}})`;
const TITLE_SRC = String.raw`(?:(?:mr|mrs|ms|miss|dr)\.?[ \t]+)?`;
/** Name labels that are not about a person ("Game name: Sweet Bonanza", "Bank name: Revolut"). */
const OTHER_NAME_LABELS_SRC = String.raw`game|bonus|promo|coupon|bank|company|file|domain|network|token|coin|currency|event|tournament`;
const NAME_LABEL_SRC = String.raw`(?<!\b(?:${OTHER_NAME_LABELS_SRC})[ \t]*)(?:my[ \t]+)?(?:full[ \t]+|real[ \t]+|first[ \t]+|last[ \t]+|sur)?name`;
/** Free-standing self-introductions: anything capitalized after them is a name candidate. */
const SELF_INTRO_RE = new RegExp(
  String.raw`\b(?:(?:i['’]?m|i[ \t]+am|call[ \t]+me|${NAME_LABEL_SRC}(?:['’]s|[ \t]+is))[ \t]+|${NAME_LABEL_SRC}[ \t]*[:=][ \t]*)${TITLE_SRC}${PHRASE_SRC}`,
  'giud',
);
/** "It's Ana here", "this is Ana," - only at the start of a clause and when the name ends the clause. */
const CLAUSE_INTRO_RE = new RegExp(String.raw`\b(?:it['’]s|this[ \t]+is)[ \t]+${TITLE_SRC}${PHRASE_SRC}`, 'giud');
const CLAUSE_START_BEFORE_RE = /(?:^|[.!?,;:\n(]|\b(?:hi|hello|hey|hiya|dear|yes|yeah|ok|okay|there))[ \t]*$/i;
const CLAUSE_END_AFTER_RE = /^[ \t]*(?:[.,!?;:\n)\-–—]|$|here\b)/i;
/** "Ana Ivanovic here." at the start of a clause, followed by the end of the clause (or "and"/"again"/"from"/"with"). */
const HERE_RE = new RegExp(
  String.raw`(?<=(?:^|[.!?,;:\n(])[ \t]*)${PHRASE_SRC}[ \t]+here\b(?=[ \t]*(?:[.,!?;:\n)\-–—]|$|(?:again|and|from|with)\b))`,
  'gud',
);

function groupSpan(m: RegExpMatchArray, group: number): [number, number] | null {
  const span = m.indices?.[group];
  return span ? [span[0], span[1]] : null;
}

function findNames(text: string, out: PiiMatch[]): void {
  const push = (phraseStart: number, span: [number, number] | null): void => {
    if (!span) return;
    const start = phraseStart + span[0];
    const end = phraseStart + span[1];
    out.push({ kind: 'NAME', value: text.slice(start, end), start, end });
  };
  for (const m of text.matchAll(SELF_INTRO_RE)) {
    const g = groupSpan(m, 1);
    if (g) push(g[0], leadingNameSpan(m[1] ?? ''));
  }
  for (const m of text.matchAll(CLAUSE_INTRO_RE)) {
    const g = groupSpan(m, 1);
    const at = m.index ?? 0;
    if (!g || !CLAUSE_START_BEFORE_RE.test(text.slice(Math.max(0, at - 20), at))) continue;
    const span = leadingNameSpan(m[1] ?? '');
    if (span && CLAUSE_END_AFTER_RE.test(text.slice(g[0] + span[1]))) push(g[0], span);
  }
  for (const m of text.matchAll(HERE_RE)) {
    const g = groupSpan(m, 1);
    if (g) push(g[0], wholeNameSpan(m[1] ?? ''));
  }
}

// ---------------------------------------------------------------------------
// IBANs and payment cards
// ---------------------------------------------------------------------------

/** Compact (DE89370400440532013000) or grouped in fours (DE89 3704 0044 0532 0130 00). */
const IBAN_SHAPE_SRC = String.raw`[A-Z]{2}\d{2}(?:[A-Z0-9]{10,30}|(?:[ ][A-Z0-9]{4}){2,7}(?:[ ][A-Z0-9]{1,4})?)`;
const IBAN_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])${IBAN_SHAPE_SRC}(?![\p{L}\p{N}_])`, 'gu');
/** After the word IBAN any case is accepted and the checksum is not required (typos must not leak either). */
const LABELED_IBAN_RE = new RegExp(String.raw`\biban\b[ \t]*(?:(?:no\.?|number|is)[ \t]*)?[:#=-]?[ \t]*(${IBAN_SHAPE_SRC})(?![\p{L}\p{N}_])`, 'giud');
const SPACES_G_RE = /[ \t]/g;
const MIN_IBAN_LENGTH = 15;
const MAX_IBAN_LENGTH = 34;

/** ISO 13616 mod-97 check. */
export function ibanChecksumOk(iban: string): boolean {
  const compact = iban.replace(SPACES_G_RE, '').toUpperCase();
  if (compact.length < MIN_IBAN_LENGTH || compact.length > MAX_IBAN_LENGTH) return false;
  let rem = 0;
  for (const ch of compact.slice(4) + compact.slice(0, 4)) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? code - 55 : code - 48;
    rem = (value >= 10 ? rem * 100 + value : rem * 10 + value) % 97;
  }
  return rem === 1;
}

/** Drops trailing groups without a digit ("... 0130 00 Bank" read case-insensitively). */
function trimIbanGroups(value: string): string {
  const groups = value.split(' ');
  while (groups.length > 3 && !/\d/.test(groups.at(-1)!)) groups.pop();
  return groups.join(' ');
}

function findIbans(text: string, out: PiiMatch[]): void {
  for (const m of text.matchAll(IBAN_RE)) {
    const start = m.index ?? 0;
    if (ibanChecksumOk(m[0])) out.push({ kind: 'IBAN', value: m[0], start, end: start + m[0].length });
  }
  for (const m of text.matchAll(LABELED_IBAN_RE)) {
    const g = groupSpan(m, 1);
    if (!g) continue;
    const value = trimIbanGroups(m[1] ?? '');
    const length = value.replace(SPACES_G_RE, '').length;
    if (length >= MIN_IBAN_LENGTH && length <= MAX_IBAN_LENGTH) out.push({ kind: 'IBAN', value, start: g[0], end: g[0] + value.length });
  }
}

/** 13-19 digits: plain, 4-4-4-x groups or the Amex 4-6-5 layout (spaces or dashes). */
const CARD_RE = /(?<![\w.,+\-/])(?:\d{13,19}|\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}|\d{4}([ -])\d{6}\2\d{4,5})(?![\w\-/]|[.,]\d)/g;
const NON_DIGITS_G_RE = /\D/g;
/** First digit of the major card networks (Mastercard 2/5, Amex/JCB/Diners 3, Visa 4, Discover/Maestro/UnionPay 6). */
const CARD_FIRST_DIGIT_RE = /^[2-6]/;
const SAME_DIGIT_RE = /^(\d)\1+$/;

export function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function findCards(text: string, out: PiiMatch[]): void {
  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[0].replace(NON_DIGITS_G_RE, '');
    if (digits.length < 13 || digits.length > 19 || !CARD_FIRST_DIGIT_RE.test(digits) || SAME_DIGIT_RE.test(digits) || !luhnOk(digits)) continue;
    const start = m.index ?? 0;
    out.push({ kind: 'CARD', value: m[0], start, end: start + m[0].length });
  }
}

// ---------------------------------------------------------------------------
// Dates of birth and document numbers
// ---------------------------------------------------------------------------

const MONTH_SRC = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
const FULL_DATE_SRC =
  String.raw`(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}[./-]\d{1,2}[./-]\d{1,2}` +
  String.raw`|\d{1,2}(?:st|nd|rd|th)?[ \t]+(?:of[ \t]+)?(?:${MONTH_SRC})\.?,?[ \t]+\d{4}` +
  String.raw`|(?:${MONTH_SRC})\.?[ \t]+\d{1,2}(?:st|nd|rd|th)?,?[ \t]+\d{4})(?!\d)`;
const BIRTH_KEYWORD_SRC = String.raw`d\.?o\.?b\.?|date[ \t]+of[ \t]+birth|birth[ \t-]?date|birthday|year[ \t]+of[ \t]+birth|born(?:[ \t]+(?:on|in))?`;
/** Keyword first: "DOB: 14/03/1991", "born on 14 March 1991", "born in 1991". */
const DOB_AFTER_KEYWORD_RE = new RegExp(
  String.raw`\b(?:${BIRTH_KEYWORD_SRC})(?![\p{L}])[^\n\d.!?]{0,20}?(${FULL_DATE_SRC}|(?:19|20)\d{2}(?!\d))`,
  'giud',
);
/** Date first: "14/03/1991 is my date of birth", "14.03.1991 (DOB)". */
const DOB_BEFORE_KEYWORD_RE = new RegExp(
  String.raw`(?<![\w./-])(${FULL_DATE_SRC})[ \t]*[(,–-]?[ \t]*(?:(?:is|was)[ \t]+)?(?:my[ \t]+)?(?:d\.?o\.?b\b|date[ \t]+of[ \t]+birth|birth[ \t-]?date|birthday)`,
  'giud',
);

function findDatesOfBirth(text: string, out: PiiMatch[]): void {
  for (const re of [DOB_AFTER_KEYWORD_RE, DOB_BEFORE_KEYWORD_RE]) {
    for (const m of text.matchAll(re)) {
      const g = groupSpan(m, 1);
      if (g) out.push({ kind: 'DOB', value: text.slice(g[0], g[1]), start: g[0], end: g[1] });
    }
  }
}

const DOC_NUMBER_WORD_SRC = String.raw`(?:no\.?|nr\.?|num(?:ber)?\.?|#)`;
/** Ids of bets, transactions etc. are not identity documents (and the analyzer handles bet ids). */
const NOT_A_DOCUMENT_SRC = String.raw`bet|ticket|round|game|slip|wager|tx|txn|transaction|order|deposit|withdrawal`;
const DOC_ID_RE = new RegExp(
  String.raw`\b(?:(?:passport|ssn|social[ \t]+security)(?:[ \t]*${DOC_NUMBER_WORD_SRC})?` +
    String.raw`|(?<!\b(?:${NOT_A_DOCUMENT_SRC})[ \t-]?)(?:id|identity[ \t]+card|id[ \t]+card|national[ \t]+id|personal[ \t]+id|document|doc|(?:driver['’]?s?|driving)[ \t]+licen[cs]e|licen[cs]e|residence[ \t]+permit|tax[ \t]+id)[ \t]*${DOC_NUMBER_WORD_SRC})` +
    String.raw`[ \t]*(?:(?:is|was)[ \t]+)?[:=#-]?[ \t]*([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){4,24})(?![\w-])`,
  'giud',
);
const HAS_DIGIT_RE = /\d/;

function findDocumentIds(text: string, out: PiiMatch[]): void {
  for (const m of text.matchAll(DOC_ID_RE)) {
    const g = groupSpan(m, 1);
    if (g && HAS_DIGIT_RE.test(m[1] ?? '')) out.push({ kind: 'DOC_ID', value: m[1] ?? '', start: g[0], end: g[1] });
  }
}

// ---------------------------------------------------------------------------
// Street addresses
// ---------------------------------------------------------------------------

/** Street words that are unambiguous enough to accept lowercase street names ("12 baker street"). */
const PLAIN_STREET_WORDS = new Set(words('street road avenue boulevard lane drive'));
const STREET_WORD_SRC = String.raw`street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd|drive|dr|way|court|ct|place|pl|square|sq|terrace|close|crescent|highway|hwy|parkway|pkwy`;
/** House number + 1-4 words + street word: "221B Baker Street", "12 Old Kent Rd" (a final dot may end the sentence). */
const STREET_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.,$€£#:/+-])(\d{1,5}[a-z]?)[ \t]+((?:(?:\d{1,3}(?:st|nd|rd|th)|[\p{L}'’.-][\p{L}\p{N}'’.-]*)[ \t]+){1,4}?)(${STREET_WORD_SRC})\b`,
  'giu',
);
/** Words that never belong to a street name between the house number and the street word. */
const NOT_A_STREET_NAME = new Set(
  words(`a an the of on in at to from for with and or my your his her our their is was are be been per by via times time
  days hours minutes weeks months years usd eur btc eth usdt bets games spins rounds`),
);
const UPPER_START_RE = /^\p{Lu}/u;
const LETTER_RE = /\p{L}/u;
/** European forms: "Hauptstraße 5", "Calle Mayor 12", "Bulevar kralja Aleksandra 73". */
const SUFFIX_STREET_RE =
  /(?<![\p{L}\p{N}])\p{Lu}[\p{L}-]*(?:straße|strasse|str\.|gasse|weg|allee|platz|laan|straat|gatan|vej|veien|utca)[ \t]+\d{1,4}[a-zA-Z]?(?![\p{L}\p{N}])/gu;
const PREFIX_STREET_RE =
  /(?<![\p{L}\p{N}])(?:Calle|Carrer|Rue|Avenida|Rua|Ulica|Ul\.|Bulevar|Bul\.|Trg|Viale|Piazza|Plaza)[ \t]+(?:[\p{L}'’.-]+[ \t]+){1,4}?\d{1,4}[a-zA-Z]?(?![\p{L}\p{N}])/gu;
const POSTCODE_SRC = String.raw`(?:[A-Z]{1,2}\d[A-Z\d]?[ \t]?\d[A-Z]{2}|[A-Z]\d[A-Z][ \t]?\d[A-Z]\d|\d{4}[ \t]?[A-Z]{2}|\d{5}-\d{4}|\d{4,6})`;
const CITY_SRC = String.raw`\p{Lu}[\p{L}'’-]+(?:[ \t]+\p{Lu}[\p{L}'’-]+){0,2}`;
const CITY_END_SRC = String.raw`(?=[ \t]*(?:[,.;!?\n]|$|and\b))`;
/** City and/or postcode after the street: ", London NW1 6XE", "St. NW1 6XE", ", 10115 Berlin", ", London." */
const ADDRESS_TAIL_RES: readonly RegExp[] = [
  new RegExp(String.raw`^\.?,?[ \t]+(?:${CITY_SRC},?[ \t]+)?${POSTCODE_SRC}(?:,?[ \t]+${CITY_SRC}${CITY_END_SRC})?(?![\p{L}\p{N}])`, 'u'),
  new RegExp(String.raw`^,[ \t]*${CITY_SRC}${CITY_END_SRC}`, 'u'),
];

function addressTail(text: string, end: number): number {
  const rest = text.slice(end, end + 80);
  for (const re of ADDRESS_TAIL_RES) {
    const m = rest.match(re);
    if (m) return end + m[0].length;
  }
  return end;
}

function plausibleStreet(nameWords: string, streetWord: string): boolean {
  const tokens = nameWords.trim().split(/[ \t]+/);
  const plain = PLAIN_STREET_WORDS.has(streetWord.toLowerCase());
  return tokens.every(
    (t) => LETTER_RE.test(t) && !NOT_A_STREET_NAME.has(t.toLowerCase()) && (plain || UPPER_START_RE.test(t) || HAS_DIGIT_RE.test(t)),
  );
}

function findStreetAddresses(text: string, out: PiiMatch[]): void {
  const push = (start: number, streetEnd: number): void => {
    const end = addressTail(text, streetEnd);
    out.push({ kind: 'ADDRESS', value: text.slice(start, end), start, end });
  };
  // exec loop: after a rejected candidate ("2 BTC to 221B Baker Street") the search resumes one character later,
  // so an address inside it is still found.
  const re = new RegExp(STREET_RE.source, STREET_RE.flags);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (plausibleStreet(m[2] ?? '', m[3] ?? '')) push(m.index, m.index + m[0].length);
    else re.lastIndex = m.index + 1;
  }
  for (const re of [SUFFIX_STREET_RE, PREFIX_STREET_RE]) {
    for (const m of text.matchAll(re)) push(m.index ?? 0, (m.index ?? 0) + m[0].length);
  }
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

const PHONE_RE = /(?<![\w+])(?:\+|00)?\(?\d{1,4}\)?(?:[ .-]?\(?\d{2,4}\)?){2,5}(?!\w)/g;
/** Phone keywords only ("number" alone is too vague: bet, account and order numbers). */
const PHONE_CONTEXT_RE = /\b(?:phone|mobile|cell|tel|telephone|whatsapp|telegram|viber|call me|text me|sms)\b[^\n]{0,30}$/i;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

function findPhones(text: string, out: PiiMatch[]): void {
  for (const m of text.matchAll(PHONE_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const digits = raw.replace(NON_DIGITS_G_RE, '').length;
    if (digits < MIN_PHONE_DIGITS || digits > MAX_PHONE_DIGITS) continue;
    const international = raw.startsWith('+') || raw.startsWith('00');
    if (international || PHONE_CONTEXT_RE.test(text.slice(Math.max(0, start - 40), start))) {
      out.push({ kind: 'PHONE', value: raw, start, end: start + raw.length });
    }
  }
}

// ---------------------------------------------------------------------------

const DETECTORS: readonly ((text: string, out: PiiMatch[]) => void)[] = [
  findNames,
  findIbans,
  findCards,
  findDatesOfBirth,
  findDocumentIds,
  findStreetAddresses,
  findPhones,
];

/**
 * Personal data in `text` the analyzer's entities may miss, sorted by start and never overlapping (on overlap the
 * more specific kind wins: IBAN > CARD > DOC_ID > DOB > ADDRESS > PHONE > NAME, then the longer match).
 */
export function findPii(text: string): PiiMatch[] {
  if (!text.trim()) return [];
  const found: PiiMatch[] = [];
  for (const detect of DETECTORS) detect(text, found);
  found.sort((a, b) => KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: PiiMatch[] = [];
  for (const match of found) {
    if (match.value.trim() && !kept.some((k) => k.start < match.end && match.start < k.end)) kept.push(match);
  }
  return kept.sort((a, b) => a.start - b.start);
}
