/**
 * Local, deterministic, dependency-free message analyzer (target: < 5 ms per message).
 * Uses the domain vocabulary in ../domain/igaming.ts. No network, no LLM.
 *
 * The steps live in sibling modules (concepts, intents, entities, sentiment, urgency, rg, questions, keywords);
 * this file is the public entry point and assembles the full Analysis.
 */
import type { Analysis, Intent } from '../../shared/types.js';
import { prepare } from './concepts.js';
import { extractEntities } from './entities.js';
import { scoreIntentsPrepared } from './intents.js';
import { extractKeywordsPrepared, isLikelyNonEnglish } from './keywords.js';
import { splitQuestions } from './questions.js';
import { detectRgRiskNorm } from './rg.js';
import { detectSentiment } from './sentiment.js';
import { countWords } from './text.js';
import { detectUrgency } from './urgency.js';

export { extractEntities } from './entities.js';
export { scoreIntents } from './intents.js';
export { extractKeywords, isLikelyNonEnglish } from './keywords.js';
export { splitQuestions } from './questions.js';
export { detectRgRisk } from './rg.js';
export { detectSentiment } from './sentiment.js';
export { detectUrgency } from './urgency.js';

function emptyAnalysis(text: string): Analysis {
  return {
    intents: [],
    sentiment: 'neutral',
    sentimentScore: 0,
    urgency: 'normal',
    urgencyReasons: [],
    entities: [],
    questions: [],
    keywords: [],
    rgRisk: false,
    rgSignals: [],
    isLikelyNonEnglish: false,
    wordCount: countWords(text),
    source: 'local',
  };
}

/** Full analysis of a customer message (English). Empty/whitespace input returns a neutral, empty analysis. */
export function analyzeMessage(text: string): Analysis {
  if (!text.trim()) return emptyAnalysis(text);
  const p = prepare(text);
  const rg = detectRgRiskNorm(p.norm);
  const intents = scoreIntentsPrepared(p, rg);
  const entities = extractEntities(text);
  const { sentiment, score } = detectSentiment(text);
  const { urgency, reasons } = detectUrgency(text, { sentiment, entities, rgCritical: rg.critical, rgRisk: rg.risk, intents });
  return {
    intents,
    sentiment,
    sentimentScore: score,
    urgency,
    urgencyReasons: reasons,
    entities,
    questions: splitQuestions(text),
    keywords: extractKeywordsPrepared(p, entities),
    rgRisk: rg.risk,
    rgSignals: rg.signals,
    isLikelyNonEnglish: isLikelyNonEnglish(text),
    wordCount: countWords(text),
    source: 'local',
  };
}

export type { Intent };
