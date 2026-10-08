/**
 * Tone adjustment: one short empathy/reassurance/thanks sentence after the greeting. Pure functions, no I/O.
 *
 * Sentences never admit fault and never promise outcomes. The variant is chosen deterministically from the
 * analysed customer message, so the same message always gets the same sentence.
 */
import type { Analysis } from '../../shared/types.js';
import { splitGreeting } from './greeting.js';
import { capitalizeFirst, fnv1a } from './text.js';

/** angry / frustrated: sincere apology + empathy, no admission of fault, no promised outcome. */
export const APOLOGY_SENTENCES = [
  "I'm really sorry for the frustration this has caused, and I understand how important this is to you.",
  "I'm sorry to hear about the trouble you've experienced, and I completely understand your concern.",
  "I'm truly sorry for the inconvenience, and I understand how frustrating this situation must be.",
  "I'm sorry you've had to deal with this, and I appreciate you bringing it to our attention.",
] as const;

/** confused: reassurance. */
export const REASSURANCE_SENTENCES = [
  "No worries, I'll walk you through it.",
  "No problem at all, I'm happy to explain how this works.",
  "Don't worry, I'll help you make sense of this.",
  'Happy to clear this up for you.',
] as const;

/** positive: thanks. */
export const THANKS_SENTENCES = [
  'Thank you so much for your kind message!',
  "Thanks a lot for reaching out, it's great to hear from you!",
  "Thank you for your message, I'm happy to help!",
] as const;

/** Responsible-gambling risk: calm and caring, never cheerful. Used instead of every other bank. */
export const CARE_SENTENCES = [
  "Thank you for reaching out to us about this, we're here to help.",
  "Thank you for letting us know, and please know that we're here to support you.",
  "Thank you for sharing this with us. Your wellbeing matters to us and we're here to help.",
] as const;

const APOLOGY_RE = /\bsorry\b|\bapologi|\bunderstand how frustrating/i;
const REASSURANCE_RE = /\bno worries\b|\bno problem\b|\bdon'?t worry\b|\bwalk you through\b|\bhappy to (?:help|explain|clarify|clear)\b/i;
const THANKS_RE = /\bthank(?:s|\s+you)\b|\bappreciate/i;
const CARE_RE = /\bthank(?:s|\s+you)\s+for\s+(?:reaching\s+out|contacting|getting\s+in\s+touch|letting\s+us\s+know|telling\s+us|sharing)|\bhere\s+to\s+(?:help|support)\b/i;

/** Content that must stay on its own line (lists, quotes, placeholders) rather than be joined to a sentence. */
const BLOCK_START_RE = /^\s*(?:[-*•>]|\d{1,2}[.)]\s|\[)/;

/** The sentence bank for this message, or null when no sentence should be added. */
function toneBank(text: string, analysis: Analysis): readonly string[] | null {
  if (analysis.rgRisk) return CARE_RE.test(text) ? null : CARE_SENTENCES;
  switch (analysis.sentiment) {
    case 'angry':
    case 'frustrated':
      return APOLOGY_RE.test(text) ? null : APOLOGY_SENTENCES;
    case 'confused':
      return REASSURANCE_RE.test(text) ? null : REASSURANCE_SENTENCES;
    case 'positive':
      return THANKS_RE.test(text) ? null : THANKS_SENTENCES;
    default:
      return null;
  }
}

/** Stable fingerprint of the analysed message (same message -> same analysis -> same fingerprint). */
function messageFingerprint(analysis: Analysis): string {
  return [
    analysis.wordCount,
    analysis.sentiment,
    analysis.keywords.join(','),
    analysis.questions.map((q) => q.text).join('|'),
    analysis.entities.map((e) => e.raw).join('|'),
  ].join('#');
}

/** Put `sentence` in front of `body`: joined into the first paragraph, or on its own line before lists/placeholders. */
function prependSentence(sentence: string, body: string, blockSeparator: string): string {
  if (!body.trim()) return sentence;
  if (BLOCK_START_RE.test(body)) return `${sentence}${blockSeparator}${body}`;
  return `${sentence} ${capitalizeFirst(body)}`;
}

/** A greeting that ends with a comma ("Hi John,") belongs on its own line, never in front of a sentence. */
const COMMA_GREETING_RE = /,\s*$/;
const LEADING_SPACE_RE = /^\s+/;

/**
 * Insert a sentence right after the greeting. A greeting ending with ',' stays on (or is moved to) its own line:
 * "Hi John, your withdrawal ..." becomes "Hi John,\n\n<sentence> Your withdrawal ...". A greeting ending with
 * '!' may stay inline ("Hi John! <sentence> ...").
 */
export function insertAfterGreeting(text: string, sentence: string): string {
  const split = splitGreeting(text);
  if (!split) return prependSentence(sentence, text.replace(LEADING_SPACE_RE, ''), '\n\n');
  const inline = split.separator === ' ' && !COMMA_GREETING_RE.test(split.greeting);
  const separator = inline || (split.rest && split.separator !== ' ') ? split.separator : '\n\n';
  const blockSeparator = separator === ' ' ? '\n\n' : separator;
  return `${split.greeting}${separator}${prependSentence(sentence, split.rest, blockSeparator)}`;
}

/**
 * Tone adjustment based on the analysed message. Inserts at most one short sentence right after the greeting:
 *   rgRisk           -> calm, caring sentence (never cheerful/thanks), regardless of sentiment
 *   angry/frustrated -> sincere apology + empathy (no admission of fault, no promised outcome)
 *   confused         -> reassurance ("No worries, I'll walk you through it.")
 *   positive         -> thanks
 *   neutral          -> nothing
 * The variant (>= 3 per bank) is picked deterministically from the message. Skips insertion when the body
 * already contains an apology (angry/frustrated), reassurance (confused), thanks (positive) or a caring line (RG).
 */
export function applyTone(text: string, analysis: Analysis, enabled: boolean): { text: string; added: string[] } {
  if (!enabled) return { text, added: [] };
  const bank = toneBank(text, analysis);
  if (!bank) return { text, added: [] };
  const sentence = bank[fnv1a(messageFingerprint(analysis)) % bank.length];
  if (!sentence) return { text, added: [] };
  return { text: insertAfterGreeting(text, sentence), added: [sentence] };
}
