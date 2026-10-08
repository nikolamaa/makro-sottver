/**
 * iGaming domain vocabulary shared by the analyzer (intent/entity detection) and the
 * search layer (query expansion + builtin concept embeddings).
 *
 * CONCEPTS: groups of words/phrases customers use for the same thing. The first entry is the
 * canonical concept id. Matching is done on lowercase, whitespace-normalized text; multi-word
 * phrases are allowed. Keep entries lowercase.
 */

export interface ConceptGroup {
  id: string;
  terms: string[];
}

export const CONCEPTS: ConceptGroup[] = [
  { id: 'withdrawal', terms: ['withdrawal', 'withdraw', 'withdrew', 'withdrawing', 'withdrawals', 'cashout', 'cash out', 'cashed out', 'payout', 'pay out', 'paid out', 'cash-out', 'take out my money', 'get my money', 'my money out', 'wd'] },
  { id: 'deposit', terms: ['deposit', 'deposited', 'depositing', 'deposits', 'top up', 'topped up', 'top-up', 'fund my account', 'funded', 'add funds', 'sent funds', 'sent crypto', 'transferred'] },
  { id: 'missing', terms: ['missing', 'not arrived', "hasn't arrived", 'has not arrived', "didn't arrive", 'did not arrive', 'not received', "haven't received", 'have not received', 'not showing', "doesn't show", 'not credited', "wasn't credited", 'never arrived', 'not reflected', 'lost', 'disappeared', 'where is my', "where's my", 'not in my balance', 'no show'] },
  { id: 'pending', terms: ['pending', 'stuck', 'processing', 'still waiting', 'waiting for', 'on hold', 'taking long', 'taking so long', 'delayed', 'delay', 'not processed', 'under review', 'in review', 'how long', 'when will'] },
  { id: 'limit', terms: ['limit', 'limits', 'maximum', 'max', 'minimum', 'min', 'cap', 'capped', 'threshold', 'how much can i'] },
  { id: 'crypto', terms: ['crypto', 'cryptocurrency', 'btc', 'bitcoin', 'eth', 'ethereum', 'ltc', 'litecoin', 'usdt', 'tether', 'usdc', 'trx', 'tron', 'xrp', 'ripple', 'doge', 'dogecoin', 'sol', 'solana', 'bch', 'bnb', 'ada', 'cardano', 'pol', 'matic', 'polygon', 'eos', 'wallet', 'blockchain', 'coin', 'coins', 'token'] },
  { id: 'network', terms: ['network', 'chain', 'erc20', 'erc-20', 'trc20', 'trc-20', 'bep20', 'bep-20', 'bsc', 'arbitrum', 'optimism', 'base network', 'wrong network', 'wrong chain', 'memo', 'destination tag', 'tag'] },
  { id: 'tx_hash', terms: ['tx hash', 'txid', 'tx id', 'transaction hash', 'transaction id', 'hash', 'txn', 'blockchain explorer', 'explorer', 'confirmations', 'confirmation'] },
  { id: 'fiat', terms: ['bank transfer', 'bank', 'wire', 'iban', 'credit card', 'debit card', 'card', 'visa', 'mastercard', 'local currency', 'fiat', 'inr', 'rupee', 'cad', 'canadian dollar', 'interac', 'upi', 'pix', 'apple pay', 'google pay', 'moonpay', 'onramper', 'swapped', 'binance', 'buy crypto', 'purchase crypto'] },
  { id: 'bonus', terms: ['bonus', 'bonuses', 'promo', 'promotion', 'promotions', 'offer', 'reward', 'rewards', 'free spins', 'freespins', 'free bet', 'freebet', 'cashback', 'drop', 'bonus drop', 'code', 'promo code', 'bonus code'] },
  { id: 'reload', terms: ['reload', 'reloads', 'daily reload', 'claim reload'] },
  { id: 'weekly_bonus', terms: ['weekly bonus', 'weekly', 'saturday bonus', 'weekly boost'] },
  { id: 'monthly_bonus', terms: ['monthly bonus', 'monthly', 'pre-monthly', 'post-monthly', 'monthly subscription bonus'] },
  { id: 'rakeback', terms: ['rakeback', 'rake back', 'rake'] },
  { id: 'welcome_offer', terms: ['welcome offer', 'welcome bonus', 'sign up bonus', 'signup bonus', 'new player bonus', 'first deposit bonus', 'deposit bonus'] },
  { id: 'birthday', terms: ['birthday', 'bday', 'b-day'] },
  { id: 'wagering', terms: ['wager', 'wagering', 'wager requirement', 'wagering requirement', 'playthrough', 'play through', 'rollover', 'roll over', 'turnover', 'wagered', 'bet through'] },
  { id: 'vip', terms: ['vip', 'vip level', 'vip rank', 'rank', 'level up', 'tier', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'obsidian', 'opal', 'vip host', 'host', 'account manager', 'vip progress', 'loyalty'] },
  { id: 'kyc', terms: ['kyc', 'verify', 'verification', 'verified', 'verifying', 'level 2', 'level 3', 'level 4', 'documents', 'document', 'proof of identity', 'proof of address', 'proof of income', 'source of funds', 'source of income', 'id card', 'passport', 'driver license', "driver's license", 'drivers licence', 'selfie', 'utility bill', 'bank statement', 'poa', 'poi', 'rejected documents', 'document rejected'] },
  { id: 'access', terms: ['login', 'log in', 'logged out', 'sign in', 'cant login', "can't log in", 'cannot log in', 'locked out', 'password', 'reset password', 'forgot password', 'forgot my password', '2fa', 'two factor', 'two-factor', 'authenticator', 'google authenticator', 'otp', 'lost access', 'lost my email', 'lost my phone', 'email access', 'passkey', 'passkeys'] },
  { id: 'security', terms: ['hacked', 'compromised', 'phishing', 'scam email', 'fake email', 'suspicious email', 'unauthorized', 'someone logged', 'vault', 'stake shield', 'shield', 'mirror site', 'mirror', 'oauth', 'secure my account', 'security'] },
  { id: 'closure', terms: ['close my account', 'close account', 'delete my account', 'delete account', 'deactivate', 'remove my account', 'account closure', 'closing my account'] },
  { id: 'responsible_gambling', terms: ['self exclusion', 'self-exclusion', 'self exclude', 'self-exclude', 'exclude me', 'block me', 'cooling off', 'cool off', 'break in play', 'take a break', 'time out', 'timeout', 'deposit limit', 'loss limit', 'gambling limit', 'gambling limits', 'product exclusion', 'poker exclusion', 'gamstop', 'gamban', 'betblocker', 'addiction', 'addicted', 'problem gambling', 'gambling problem', 'responsible gambling', 'responsible gaming'] },
  { id: 'sports', terms: ['sports', 'sport', 'bet slip', 'betslip', 'parlay', 'multi', 'multi bet', 'accumulator', 'acca', 'same game multi', 'sgm', 'single bet', 'handicap', 'asian handicap', 'over under', 'over/under', 'totals', 'odds', 'settled', 'settlement', 'void', 'voided', 'cancelled bet', 'canceled bet', 'cashout not available', 'live bet', 'match', 'game result', 'resettled', 'market'] },
  { id: 'casino', terms: ['casino', 'slot', 'slots', 'game', 'games', 'spin', 'spins', 'live casino', 'table game', 'blackjack', 'roulette', 'baccarat', 'crash', 'plinko', 'dice', 'mines', 'limbo', 'originals', 'stake originals', 'provably fair', 'provable fairness', 'seed', 'server seed', 'client seed', 'provider', 'pragmatic', 'evolution', 'hacksaw', 'nolimit', 'third party game'] },
  { id: 'bet_limits', terms: ['betting limit', 'betting limits', 'bet limit', 'max bet', 'maximum bet', 'max win', 'maximum win', 'stake limit', 'limited account', 'restricted bet'] },
  { id: 'technical', terms: ['error', 'bug', 'glitch', 'freeze', 'froze', 'frozen', 'crash', 'crashed', 'not loading', "won't load", 'wont load', 'loading', 'black screen', 'white screen', 'lag', 'lagging', 'disconnected', 'connection', 'cache', 'cookies', 'clear cache', 'browser', 'app', 'website down', 'site down', 'payments temporarily unavailable', 'temporarily unavailable', 'blocked', 'vpn', 'restricted region', 'not working', 'broken'] },
  { id: 'bet_id', terms: ['bet id', 'betid', 'bet number', 'ticket id', 'round id', 'game id', 'casino bet id', 'sports bet id'] },
  { id: 'affiliate', terms: ['affiliate', 'affiliates', 'referral', 'refer', 'referred', 'referral code', 'commission', 'campaign', 'affiliate code', 'affiliate bonus'] },
  { id: 'complaint', terms: ['complaint', 'complain', 'unacceptable', 'ridiculous', 'scam', 'scammed', 'fraud', 'thief', 'thieves', 'stealing', 'stole', 'worst', 'terrible', 'awful', 'disgusting', 'pathetic', 'joke', 'lawyer', 'legal action', 'regulator', 'curacao', 'report you', 'trustpilot', 'chargeback'] },
  { id: 'account', terms: ['account', 'profile', 'username', 'email address', 'change email', 'change username', 'settings'] },
  { id: 'time', terms: ['how long', 'when', 'today', 'yesterday', 'hours', 'hour', 'days', 'day', 'week', 'weeks', 'minutes', 'asap', 'urgent', 'immediately', 'right now'] },
];

/** Gambling products a question or macro can be specific to. */
export type Product = 'sports' | 'casino' | 'poker';

/**
 * Unambiguous words for each product, used by search to detect product mismatch (a tennis betting-limit question
 * vs a casino-only macro). Deliberately strict: "game", "bet", "match", "crash" and "cash out" are left out
 * because they are used for several products (or for technical problems / withdrawals). Lowercase; multi-word
 * phrases allowed. The sports names mirror the analyzer's sports evidence (analysis/intents.ts).
 */
export const PRODUCT_TERMS: Record<Product, string[]> = {
  sports: [
    'sport', 'sports', 'sportsbook', 'sports bet', 'sports bets', 'bet slip', 'betslip', 'parlay', 'parlays', 'multi', 'multis',
    'multi bet', 'same game multi', 'sgm', 'accumulator', 'acca', 'leg', 'legs', 'handicap', 'asian handicap', 'over under',
    'asian total', 'player prop', 'player props', 'prop bet', 'prop bets', 'live bet', 'fixture', 'goal', 'goals',
    'football', 'soccer', 'tennis', 'basketball', 'baseball', 'hockey', 'cricket', 'rugby', 'golf', 'boxing', 'ufc', 'mma',
    'nba', 'nfl', 'nhl', 'mlb', 'esports', 'e-sports', 'cs2', 'csgo', 'dota', 'valorant', 'horse racing', 'formula 1', 'f1',
    'premier league', 'champions league', 'la liga', 'serie a', 'bundesliga', 'world cup',
  ],
  casino: [
    'casino', 'live casino', 'slot', 'slots', 'blackjack', 'roulette', 'baccarat', 'dice', 'plinko', 'mines', 'limbo', 'keno',
    'originals', 'stake originals', 'table game', 'table games', 'game show', 'dealer', 'live dealer', 'free spins', 'bonus buy',
    'provably fair', 'provable fairness', 'pragmatic', 'evolution', 'hacksaw', 'nolimit', 'third party game', 'third-party games',
  ],
  poker: ['poker', 'holdem', "hold'em", 'texas holdem', 'omaha', 'poker tournament', 'sit and go'],
};

/** VIP ranks as written by customers (normalized display form). */
export const VIP_RANKS = [
  'Bronze',
  'Silver',
  'Gold',
  'Platinum I',
  'Platinum II',
  'Platinum III',
  'Platinum IV',
  'Platinum V',
  'Platinum VI',
  'Diamond I',
  'Diamond II',
  'Diamond III',
  'Diamond IV',
  'Diamond V',
  'Obsidian I',
  'Obsidian II',
  'Obsidian III',
  'Opal I',
  'Opal II',
  'Opal III',
  'Platinum',
  'Diamond',
  'Obsidian',
  'Opal',
] as const;

/** Crypto tickers -> canonical display symbol. */
export const CRYPTO_ALIASES: Record<string, string> = {
  btc: 'BTC',
  bitcoin: 'BTC',
  eth: 'ETH',
  ethereum: 'ETH',
  ether: 'ETH',
  ltc: 'LTC',
  litecoin: 'LTC',
  usdt: 'USDT',
  tether: 'USDT',
  usdc: 'USDC',
  trx: 'TRX',
  tron: 'TRX',
  xrp: 'XRP',
  ripple: 'XRP',
  doge: 'DOGE',
  dogecoin: 'DOGE',
  sol: 'SOL',
  solana: 'SOL',
  bch: 'BCH',
  'bitcoin cash': 'BCH',
  bnb: 'BNB',
  ada: 'ADA',
  cardano: 'ADA',
  pol: 'POL',
  matic: 'POL',
  eos: 'EOS',
  dai: 'DAI',
  link: 'LINK',
  shib: 'SHIB',
  uni: 'UNI',
  ape: 'APE',
  busd: 'BUSD',
  cro: 'CRO',
  sand: 'SAND',
};

/** Fiat currency words/symbols -> ISO code. */
export const FIAT_ALIASES: Record<string, string> = {
  $: 'USD',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  '€': 'EUR',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  '£': 'GBP',
  gbp: 'GBP',
  '₹': 'INR',
  inr: 'INR',
  rupee: 'INR',
  rupees: 'INR',
  cad: 'CAD',
  'c$': 'CAD',
  jpy: 'JPY',
  '¥': 'JPY',
  yen: 'JPY',
  brl: 'BRL',
  'r$': 'BRL',
  try: 'TRY',
  '₺': 'TRY',
  ngn: 'NGN',
  '₦': 'NGN',
  ars: 'ARS',
  mxn: 'MXN',
  cop: 'COP',
  clp: 'CLP',
  pen: 'PEN',
  idr: 'IDR',
  php: 'PHP',
  vnd: 'VND',
  krw: 'KRW',
  '₩': 'KRW',
};

export const NETWORK_ALIASES: Record<string, string> = {
  erc20: 'ERC20',
  'erc-20': 'ERC20',
  trc20: 'TRC20',
  'trc-20': 'TRC20',
  bep20: 'BEP20',
  'bep-20': 'BEP20',
  bsc: 'BEP20',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  polygon: 'Polygon',
  solana: 'Solana',
  'base network': 'Base',
};

/** Phrases indicating responsible-gambling / wellbeing risk. Any hit => rgRisk = true. */
export const RG_RISK_PHRASES = [
  'addicted',
  'addiction',
  "can't stop gambling",
  'cant stop gambling',
  'cannot stop gambling',
  "can't stop playing",
  'cant stop playing',
  'gambling problem',
  'problem gambling',
  'lost everything',
  'lost all my money',
  'lost my savings',
  'lost my rent',
  'borrowed money to',
  'chasing losses',
  'chasing my losses',
  'ruined my life',
  'destroyed my life',
  'kill myself',
  'end my life',
  'suicide',
  'suicidal',
  'want to die',
  'no reason to live',
  'self harm',
  'self-harm',
  'please block me',
  'block my account',
  'exclude me',
  'self exclude',
  'self-exclude',
  'self exclusion',
  'self-exclusion',
  'i need help with gambling',
];

/** Subset of RG phrases that indicate an immediate wellbeing emergency (urgency=critical). */
export const RG_CRITICAL_PHRASES = ['kill myself', 'end my life', 'suicide', 'suicidal', 'want to die', 'no reason to live', 'self harm', 'self-harm'];

const conceptIndex = new Map<string, string[]>();
for (const g of CONCEPTS) {
  for (const t of g.terms) {
    const list = conceptIndex.get(t) ?? [];
    list.push(g.id);
    conceptIndex.set(t, list);
  }
}

/** Lowercase, collapse whitespace, normalize quotes. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const conceptMatchers: { id: string; term: string; re: RegExp }[] = CONCEPTS.flatMap((g) =>
  g.terms.map((term) => ({ id: g.id, term, re: new RegExp(`(?:^|[^a-z0-9])${escapeRe(term)}(?=$|[^a-z0-9])`, 'i') })),
);

/**
 * Concept ids mentioned in a text, with the matched terms. Word-boundary matching on normalized text.
 * Example: "my btc cashout is stuck" -> { withdrawal: ['cashout'], crypto: ['btc'], pending: ['stuck'] }
 */
export function findConcepts(text: string): Map<string, string[]> {
  const norm = normalizeForMatch(text);
  const out = new Map<string, string[]>();
  for (const m of conceptMatchers) {
    if (m.re.test(norm)) {
      const list = out.get(m.id) ?? [];
      list.push(m.term);
      out.set(m.id, list);
    }
  }
  return out;
}

/** Concept ids a single (lowercase) term belongs to. */
export function conceptsOfTerm(term: string): string[] {
  return conceptIndex.get(term.toLowerCase()) ?? [];
}
