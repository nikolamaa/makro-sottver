/**
 * Responsible-gambling / player-wellbeing risk detection (word-boundary phrase matching on normalized text).
 */
import { normalizeForMatch, RG_CRITICAL_PHRASES, RG_RISK_PHRASES } from '../domain/igaming.js';
import { escapeRegExp } from './text.js';

export interface RgRisk {
  risk: boolean;
  critical: boolean;
  /** Matched phrases (lowercase), in vocabulary order. */
  signals: string[];
}

/** Extra wording for an immediate wellbeing emergency, on top of RG_CRITICAL_PHRASES. Errs on recall. */
const EXTRA_CRITICAL = [
  'killing myself',
  'kill my self',
  'end it all',
  'take my own life',
  'hurt myself',
  'harm myself',
  "don't want to live",
  'dont want to live',
  'do not want to live',
  'better off dead',
  'not worth living',
];

/** Extra problem-gambling wording, on top of RG_RISK_PHRASES. */
const EXTRA_RISK = [
  "can't stop betting",
  'cant stop betting',
  'cannot stop betting',
  'lost all my savings',
  'lost my life savings',
  'lost my salary',
  'lost my house',
  'took a loan to',
  'gambling addiction',
  'addicted to gambling',
  'i have a problem with gambling',
];

interface PhraseMatcher {
  phrase: string;
  re: RegExp;
  critical: boolean;
}

const CRITICAL_SET = new Set([...RG_CRITICAL_PHRASES, ...EXTRA_CRITICAL]);

const MATCHERS: PhraseMatcher[] = [...new Set([...RG_RISK_PHRASES, ...RG_CRITICAL_PHRASES, ...EXTRA_RISK, ...EXTRA_CRITICAL])].map(
  (phrase) => ({
    phrase,
    re: new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(phrase)}(?=$|[^a-z0-9])`),
    critical: CRITICAL_SET.has(phrase),
  }),
);

/** Detect RG risk signals in already-normalized text. */
export function detectRgRiskNorm(norm: string): RgRisk {
  const signals: string[] = [];
  let critical = false;
  for (const m of MATCHERS) {
    if (!m.re.test(norm)) continue;
    signals.push(m.phrase);
    if (m.critical) critical = true;
  }
  return { risk: signals.length > 0, critical, signals };
}

/**
 * Responsible-gambling risk: any RG_RISK_PHRASES hit => risk; any RG_CRITICAL_PHRASES hit (self-harm wording)
 * => critical. `signals` lists the matched phrases.
 */
export function detectRgRisk(text: string): RgRisk {
  return detectRgRiskNorm(normalizeForMatch(text));
}
