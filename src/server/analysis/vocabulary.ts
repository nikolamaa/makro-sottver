/**
 * Stake / iGaming name lists used by entity extraction and intent scoring: bonus names, KYC document types,
 * games (Stake Originals, table games, popular slots) and game providers. Each list maps regex sources
 * (non-capturing groups only, longer names first) to a normalized display value.
 */
import { buildAlternation } from './text.js';

/** Stake bonus names -> display name ('reload' is not matched in "reload the page"). */
export const BONUS_NAMES = buildAlternation(
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

/** KYC document types -> normalized name ("passport", "ID card", "proof of address"...). */
export const DOCUMENT_TYPES = buildAlternation(
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
/** Game names -> { display name, ambiguous }; ambiguous names need context before they count. */
export const GAME_NAMES = buildAlternation(
  GAMES.map(([src, name, ambiguous]) => [src, { name, ambiguous }] as const),
  'gi',
);

/** Game providers: [regex source, display name]. */
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
/** Game provider names -> display name. */
export const PROVIDER_NAMES = buildAlternation(PROVIDERS, 'gi');

/** Non-global test used by intent scoring: a named game provider. */
export const PROVIDER_TEST_RE = new RegExp(PROVIDER_NAMES.re.source, 'i');
/** Non-global test used by intent scoring: an unambiguous game name (not "dice", "mines"...). */
export const GAME_TEST_RE = new RegExp(`\\b(?:${GAMES.filter(([, , a]) => !a).map(([src]) => src).join('|')})\\b`, 'i');
