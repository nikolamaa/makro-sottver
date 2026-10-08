/**
 * Text normalization shared by the lexical index (MiniSearch) and the builtin embedder:
 * tokenizer, stopwords and a light English stemmer. Everything here is deterministic and allocation-light
 * because it runs for every macro on rebuild and for every keystroke-driven search.
 */
import { parseTemplate } from '../../shared/template.js';

const APOSTROPHE_RE = /(?<=\p{L})['’‘`](?=\p{L})/gu;
const WORD_RE = /[\p{L}\p{N}]+/gu;
const DIGITS_RE = /^\d+$/;
const HAS_DIGIT_RE = /\d/;
/** Long letter+digit runs: tx hashes, wallet addresses, bet ids. Useless (and private) as search terms. */
const HASH_LIKE_RE = /^(?=[a-z]*\d)[a-z0-9]{16,}$/;
const MAX_TOKEN_LENGTH = 32;

/**
 * English function words plus support-chat filler ("hi", "thanks", "please", "help") that appear in nearly
 * every message and macro and therefore carry no matching signal. Stored apostrophe-free ("dont", "cant").
 */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against ago all also am an and any anyone anything are aren arent as at be because been ' +
    'before being below between both but by can cannot cant could couldn couldnt did didn didnt do does doesn doesnt ' +
    'doing don dont down during each else even ever every few for from further get gets getting got gonna had hadn ' +
    'hadnt has hasn hasnt have haven havent having he hed her here hers herself hes hey hi him himself his how ' +
    'hows however i ill im ive if in into is isn isnt it its itd itll itself just let lets like ll me might mine ' +
    'more most much must mustn my myself need needs no nor not now of off ok okay on once one only or other others ' +
    'our ours ourselves out over own please pls plz really re same shall shan she shed shes should shouldn shouldnt since so ' +
    'some something still such than thank thanks thanx thx that thats the their theirs them themselves then there ' +
    'theres these they theyd theyll theyre theyve thing things this those though through to too under until up upon ' +
    'us very via want wanna wants was wasn wasnt way we wed well were weren werent weve what whats when whens where ' +
    'wheres whether which while who whom whos why will with within without wont would wouldn wouldnt yeah yes yet ' +
    'you youd youll your youre yours yourself yourselves youve hello dear regards cheers sir madam guys team support ' +
    'help helps helped already maybe pretty quite lot lots ve'
  ).split(' '),
);

/** Lowercase word tokens; apostrophes inside words are dropped ("can't" -> "cant", "player's" -> "players"). */
export function tokenize(text: string): string[] {
  const cleaned = text.toLowerCase().replace(APOSTROPHE_RE, '');
  return cleaned.match(WORD_RE) ?? [];
}

/** True for tokens that never help matching: stopwords, 1-char tokens, plain numbers, hashes/addresses. */
export function isNoiseToken(token: string): boolean {
  return (
    token.length < 2 ||
    token.length > MAX_TOKEN_LENGTH ||
    STOPWORDS.has(token) ||
    DIGITS_RE.test(token) ||
    HASH_LIKE_RE.test(token)
  );
}

const VOWEL_RE = /[aeiouy]/;
const SIBILANT_ES_RE = /(?:[sxz]|ch|sh)es$/;
const KEEP_FINAL_S_RE = /(?:ss|us|is)$/;
const UNDOUBLE_KEEP = new Set(['ll', 'ss', 'zz', 'ff']);

function undouble(base: string): string {
  const n = base.length;
  if (n < 3 || base[n - 1] !== base[n - 2]) return base;
  const pair = base.slice(-2);
  if (UNDOUBLE_KEEP.has(pair) || VOWEL_RE.test(pair)) return base;
  return base.slice(0, -1);
}

/** Strip one inflectional suffix (s/es/ies/ing/ed/ied/ly). Requires a stem of >= 3 chars that has a vowel. */
function stripSuffix(word: string): string {
  const n = word.length;
  if ((word.endsWith('ies') || word.endsWith('ied')) && n >= 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ing') && n >= 6) {
    const base = word.slice(0, -3);
    return VOWEL_RE.test(base) ? undouble(base) : word;
  }
  if (word.endsWith('ed') && n >= 5 && word[n - 3] !== 'e') {
    const base = word.slice(0, -2);
    return VOWEL_RE.test(base) ? undouble(base) : word;
  }
  if (word.endsWith('ly') && n >= 6) return word.slice(0, -2);
  if (word.endsWith('es') && n >= 5 && SIBILANT_ES_RE.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && n >= 4 && !KEEP_FINAL_S_RE.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Light, deterministic English stemmer: strips one inflectional suffix and a trailing "e" so that
 * "withdrawals" -> "withdrawal", "pending" -> "pend", "closed"/"close"/"closes" -> "clos", "verified" -> "verify".
 * Tokens containing digits are returned unchanged ("2fa", "trc20").
 */
export function stem(token: string): string {
  if (token.length <= 3 || HAS_DIGIT_RE.test(token)) return token;
  const s = stripSuffix(token);
  return s.length >= 5 && s.endsWith('e') && !s.endsWith('ee') ? s.slice(0, -1) : s;
}

/**
 * Terms stored in the lexical index for one token: the stem, plus the surface form when it differs, so that
 * fuzzy search can still match typos inside a suffix ("pendng" ~ "pending"). Null for noise tokens.
 */
export function indexTermForms(token: string): string[] | null {
  if (isNoiseToken(token)) return null;
  const s = stem(token);
  return s === token ? [s] : [s, token];
}

/** Macro body text with template variables removed ("Hi {{user}}, ..." -> "Hi , ..."). */
export function stripTemplateVariables(body: string): string {
  let out = '';
  for (const t of parseTemplate(body)) if (t.kind === 'text') out += t.text;
  return out;
}
