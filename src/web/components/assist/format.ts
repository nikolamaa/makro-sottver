/**
 * Display helpers shared by the Assist page and the quick-search palette: badge tones/labels for
 * verification, sentiment and urgency, plus compact number formatting. Pure functions only.
 */
import type { LlmUsage, RecommendResponse, Sentiment, Urgency, VerificationStatus } from '../../../shared/types';
import type { BadgeTone } from '../../ui';

export interface BadgeSpec {
  tone: BadgeTone;
  label: string;
}

const VERIFICATION_BADGES: Record<VerificationStatus, BadgeSpec> = {
  verified: { tone: 'success', label: 'verified' },
  unverified: { tone: 'neutral', label: 'not verified' },
  outdated: { tone: 'warning', label: 'outdated' },
  conflict: { tone: 'danger', label: 'conflict' },
};

/** Badge for a macro's fact verification roll-up. */
export function verificationBadge(status: VerificationStatus): BadgeSpec {
  return VERIFICATION_BADGES[status];
}

const SENTIMENT_TONES: Record<Sentiment, BadgeTone> = {
  angry: 'danger',
  frustrated: 'warning',
  confused: 'info',
  neutral: 'neutral',
  positive: 'success',
};

/** Badge tone for a detected customer sentiment. */
export function sentimentTone(sentiment: Sentiment): BadgeTone {
  return SENTIMENT_TONES[sentiment];
}

const URGENCY_TONES: Record<Urgency, BadgeTone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  critical: 'danger',
};

/** Badge tone for a detected urgency level. */
export function urgencyTone(urgency: Urgency): BadgeTone {
  return URGENCY_TONES[urgency];
}

/** 0..1 score -> "73%". */
export function percent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

/** LLM cost as shown in the mode badge: "free", "$0.0003", "$0.012", "$1.25". */
export function formatCost(usd: number): string {
  if (!(usd > 0)) return 'free';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Mode badge text: "fast" or "AI · claude-haiku-5-5 · $0.0003". */
export function modeLabel(llm: LlmUsage | null): string {
  return llm ? `AI · ${llm.model} · ${formatCost(llm.costUsd)}` : 'fast';
}

function ms(value: number): string {
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} ms`;
}

/** Tiny timing line: "analysis 2 ms · search 9 ms · builtin". */
export function timingLabel(res: Pick<RecommendResponse, 'timingMs' | 'embeddings'>): string {
  return `analysis ${ms(res.timingMs.analysis)} · search ${ms(res.timingMs.search)} · ${res.embeddings.provider}`;
}

/** "1 placeholder" / "3 placeholders". */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
