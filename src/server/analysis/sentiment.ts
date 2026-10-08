/**
 * Sentiment detection: angry > frustrated > confused > positive > neutral (first category with cues wins;
 * positive only when there are no negative cues).
 */
import type { Sentiment } from '../../shared/types.js';
import { normalizeForMatch } from '../domain/igaming.js';
import { capsRatio, round2 } from './text.js';

const INSULT_PROFANITY_RE =
  /\b(?:idiots?|stupid|morons?|clowns?|incompetent|useless|liars?|lying|pathetic|disgusting|garbage|trash|rubbish|crooks?|criminals?|bastards?|scumbags?|scammers?|scamming|scammed|thie(?:f|ves)|stealing|robbed|robbing|rip[- ]?off|ripped off|rigged|fraudsters?|mafia|shameless|disgrace(?:ful)?|(?:this is|what) a joke|joke of a|hate (?:you|this|stake)|f+u+c+k+\w*|fuk\w*|fck\w*|fking|fkn|shit\w*|bullshit|bs|wtf|stfu|damn\w*|crap|crappy|assholes?|bitch\w*|dickheads?|pissed(?: off)?|go to hell|screw you)\b/g;
const SCAM_ACCUSATION_RE =
  /(?<!\b(?:is|was|isn't|is not) (?:this|it|that|stake) (?:a |an )?)\bscam(?!\s+(?:e-?mails?|messages?|links?|sites?|websites?|calls?|sms|texts?|dms?|bots?|alerts?))\b/g;
const FRAUD_ACCUSATION_RE = /\bfraud(?!\s+(?:team|checks?|reviews?|department|prevention|alerts?|detection))\b/g;
const STOLE_RE = /\b(?:you|they|stake|u)\s+(?:guys\s+)?(?:stole|steal|are stealing|robbed)\b/g;
const MASKED_PROFANITY_RE =
  /\b(?:f[*#@$%!]{1,4}(?:k|ck|ing|in|ed|er)?|f[*#@]ck\w*|sh[*#@!]{1,2}t|s[*#@]{2,3}t?|b[*#@]{1,3}(?:ch|tch)|a[*#@]{2,3}(?:hole)?|[a-z]{1,2}[*#@$%]{2,}[a-z]{0,4})(?![a-z0-9*#@$%])/g;
const THREAT_RE =
  /\b(?:lawyers?|attorney|legal action|take (?:legal )?action|sue (?:you|stake)|suing|court|regulators?|curacao|gaming (?:authority|commission)|licen[cs]e holder|report (?:you|this|stake)|reporting you|chargeback|charge back|trustpilot|askgamblers|casino ?guru|police|authorities|expose you|go public)\b/g;
const DEMAND_RE =
  /\b(?:fix (?:it|this|that)(?: right)? (?:now|immediately|asap)|(?:i want|give me|i need|give) (?:it|my money|my funds|it back|them|them back)\b[^.!?]{0,25}\b(?:right now|immediately|now))\b/g;
const ANGRY_EMOJI_RE = /[😡🤬😠👿🖕]/gu;

const FRUSTRATED_RE =
  /\b(?:still(?!\s+(?:possible|available|valid|active|open|eligible|able|the case|have (?:a|another|one|some) questions?))|(?:happened|happening|failed|failing|stuck|declined|rejected|denied|pending|broken|down|not working|wrong|same thing|this|asking|ask) again|again and again|third time|second time|(?:asked|told|contacted|written|wrote|messaged|emailed|tried|sent|explained|called|requested|repeated)\s+(?:\w+\s+){0,2}?(?:\d+|two|three|four|five|several|many|multiple|so many) times|ridiculous|unacceptable|waiting for (?:days|hours|weeks|ages|so long|a long time|too long|forever)|been waiting|nobody|no one (?:answers|responds|replies|helps|is helping|cares)|no (?:response|reply|answer|update|updates)|not helpful|unhelpful|frustrat\w*|annoy\w*|fed up|sick (?:of|and tired)|tired of|how many times|keep (?:asking|telling|saying|getting|sending)|same (?:answer|response|reply|thing|message)|copy[- ]?paste|(?:a|the|talking to a) bot|(?:i )?got nothing|never (?:get|got|receive|received)|keeps? (?:saying|telling|showing|giving)|why is this so hard|(?:hours?|days?|weeks?) already|since (?:yesterday|last week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|already (?:sent|told|asked|provided|explained|did|done|submitted|uploaded)|taking forever|forever|disappoint\w*|seriously|come on|sucks|what is going on|what's going on|whats going on|ignored|ignoring|not (?:great|good|helpful|happy|satisfied|awesome|amazing|nice|cool|ok|okay|fine))\b/g;
const FRUSTRATED_EMOJI_RE = /[😤😩😫😢😭🙄😒😞]/gu;
/** "why...??" / "where...??": impatience rather than confusion. */
const IMPATIENT_QUESTION_RE = /\b(?:why|where)\b[^.?!]*\?{2,}/g;

const CONFUSED_RE =
  /\b(?:(?:don't|dont|do not|didn't|didnt) (?:understand|get it|know how)|not understanding|confus\w*|what does (?:this|that|it)(?: even)? mean|where (?:do|can) i find|(?:can't|cant|cannot) find|how am i supposed to|is (?:that|this) (?:a mistake|right|correct|normal|legit)|what do you mean|how do i|how can i|how does|how do you|not sure|unsure|no idea|unclear|(?:doesn't|does not) make sense|makes no sense|(?:i'm|im|i am) lost|(?:can|could) you explain|explain|what(?: is|'s) the difference|clarify)\b/g;
const CONFUSED_EMOJI_RE = /[🤔😕❓😵]/gu;

const POSITIVE_RE =
  /\b(?:thanks|thank you|thank u|thx|ty|tysm|great|awesome|love|appreciate\w*|amazing|perfect|excellent|wonderful|good job|well done|helpful|cheers|nice|cool|fantastic|brilliant|happy|glad)\b/g;
const POSITIVE_EMOJI_RE = /[😊🙂😀😁😃😄🥰😍❤🙏👍💯🎉👌]/gu;

const EXCLAMATION_RE = /!/g;
/** Problem/contrast wording: with it, shouting and "!!!" in a message that also says "thanks" still read as anger. */
const NEGATIVE_HINT_RE =
  /\b(?:but|however|where(?:'s| is| are)|why|not(?!\s+(?:bad|a problem))|no(?!\s+(?:problem|problems|worries|rush))|never|nothing|missing|pending|stuck|lost|gone|wrong|(?<!\b(?:no|not a) )problem|issue|error|declined|rejected|denied|cancel\w*|refund|money back)\b/;

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

/** Anger expressed in words: insults/profanity (incl. masked), accusations, threats, demands, angry emoji. */
function angerWordCues(text: string, norm: string): number {
  return (
    count(INSULT_PROFANITY_RE, norm) +
    count(SCAM_ACCUSATION_RE, norm) +
    count(FRAUD_ACCUSATION_RE, norm) +
    count(STOLE_RE, norm) +
    count(MASKED_PROFANITY_RE, norm) +
    count(THREAT_RE, norm) +
    count(DEMAND_RE, norm) +
    count(ANGRY_EMOJI_RE, text)
  );
}

/** Intensity cues that amplify anger: shouting (ALL CAPS, or 2+ shouted words) and "!!!". */
function intensityCues(text: string, shouting: { ratio: number; words: number; caps: number }): number {
  const allCaps = shouting.words >= 4 && shouting.ratio > 0.6;
  return (count(EXCLAMATION_RE, text) >= 3 ? 1 : 0) + (allCaps || shouting.caps >= 2 ? 1 : 0);
}

/**
 * Sentiment with a score in -1..1:
 *  angry (insults, scam/thieves/fraud accusations, profanity incl. masked "f***", threats, ALL CAPS, "!!!"),
 *  frustrated (still/again/waiting for days/no response...), confused (don't understand/how do I/not sure...),
 *  positive (thanks/great/appreciate...) only without negative cues, else neutral.
 * Shouting and "!!!" only amplify: in a purely positive message ("THANK YOU SO MUCH!!!") they are enthusiasm.
 */
export function detectSentiment(text: string): { sentiment: Sentiment; score: number } {
  const norm = normalizeForMatch(text);
  if (!norm) return { sentiment: 'neutral', score: 0 };
  const shouting = capsRatio(text);
  const angerWords = angerWordCues(text, norm);
  const frustratedWords = count(FRUSTRATED_RE, norm) + count(FRUSTRATED_EMOJI_RE, text) + count(IMPATIENT_QUESTION_RE, norm);
  const positive = count(POSITIVE_RE, norm) + count(POSITIVE_EMOJI_RE, text);
  const amplify = angerWords > 0 || frustratedWords > 0 || positive === 0 || NEGATIVE_HINT_RE.test(norm);
  const angry = angerWords + (amplify ? intensityCues(text, shouting) : 0);
  const frustrated = frustratedWords + (amplify && shouting.caps === 1 ? 1 : 0);
  if (angry > 0) return { sentiment: 'angry', score: -round2(Math.min(1, 0.6 + 0.1 * (angry - 1) + 0.05 * frustrated)) };
  if (frustrated > 0) return { sentiment: 'frustrated', score: -round2(Math.min(0.59, 0.35 + 0.08 * (frustrated - 1))) };
  const confused = count(CONFUSED_RE, norm) + count(CONFUSED_EMOJI_RE, text);
  if (confused > 0) return { sentiment: 'confused', score: -round2(Math.min(0.3, 0.1 + 0.05 * (confused - 1))) };
  if (positive > 0) return { sentiment: 'positive', score: round2(Math.min(1, 0.4 + 0.15 * (positive - 1))) };
  return { sentiment: 'neutral', score: 0 };
}
