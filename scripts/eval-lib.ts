/**
 * Recommendation quality evaluation: loads the demo library (seed/stake-demo-macros.json) and a labeled set of
 * customer messages (default seed/eval-messages.json, used for tuning; blind holdout sets: seed/eval-holdout.json
 * and seed/eval-holdout-2.json, written by an independent evaluator and never used for tuning), runs the real
 * analyzer + hybrid index, and reports accuracy, "no good match" calibration and latency.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { Macro } from '../src/shared/types.js';
import { analyzeMessage } from '../src/server/analysis/analyzer.js';
import { parseImport } from '../src/server/importexport/importer.js';
import type { Embedder } from '../src/server/search/embedder.js';
import { createBuiltinEmbedder } from '../src/server/search/embedder.js';
import { MacroIndex } from '../src/server/search/macroIndex.js';

export interface EvalMessage {
  message: string;
  /** Macro title, or "NONE" when no macro should match. */
  expected: string;
  intent: string;
  sentiment: string;
}

export interface EvalFailure {
  message: string;
  expected: string;
  got: string[];
  confidences: number[];
  /** Why the result counts as a miss. */
  kind: 'wrong_top1' | 'none_matched' | 'false_no_match';
}

/** Top results of one message (for auditing reasons / matched terms). */
export interface EvalDetail {
  message: string;
  expected: string;
  noGoodMatch: boolean;
  results: { title: string; confidence: number; reason: string; matchedTerms: string[] }[];
}

export interface EvalReport {
  /** Label of the message set (file name without extension). */
  set: string;
  macros: number;
  messages: number;
  top1: number;
  top3: number;
  noneCorrect: number;
  noneTotal: number;
  /** Labeled messages flagged "no good match" although a macro answers them. */
  falseNoMatch: number;
  /** Mean top-1 confidence on labeled messages whose top-1 is correct. */
  meanCorrectConfidence: number;
  /** Mean top-1 confidence on NONE messages. */
  meanNoneConfidence: number;
  avgMs: number;
  p95Ms: number;
  failures: EvalFailure[];
  details: EvalDetail[];
}

const root = fileURLToPath(new URL('..', import.meta.url));

export const EVAL_MESSAGES_FILE = `${root}seed/eval-messages.json`;
export const HOLDOUT_MESSAGES_FILE = `${root}seed/eval-holdout.json`;
export const HOLDOUT2_MESSAGES_FILE = `${root}seed/eval-holdout-2.json`;

export function loadSeedMacros(file = `${root}seed/stake-demo-macros.json`): Macro[] {
  const preview = parseImport('json', readFileSync(file, 'utf8'), []);
  const now = new Date().toISOString();
  return preview.items.map((item, i) => ({
    id: `seed-${i}`,
    title: item.title,
    body: item.body,
    categoryId: item.category,
    tags: item.tags,
    intents: item.intents,
    triggers: item.triggers,
    notes: item.notes,
    shortcut: item.shortcut,
    version: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    isFavorite: false,
    useCount: 0,
    lastUsedAt: null,
    verification: 'verified',
    facts: [],
  }));
}

export function loadEvalMessages(file = EVAL_MESSAGES_FILE): EvalMessage[] {
  return JSON.parse(readFileSync(file, 'utf8')) as EvalMessage[];
}

function setName(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file).replace(/\.json$/, '');
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export interface RunEvalOptions {
  embedder?: Embedder;
  minConfidence?: number;
  /** Labeled messages file (default seed/eval-messages.json). */
  messagesFile?: string;
}

export async function runEval(opts: RunEvalOptions = {}): Promise<EvalReport> {
  const messagesFile = opts.messagesFile ?? EVAL_MESSAGES_FILE;
  const macros = loadSeedMacros();
  const messages = loadEvalMessages(messagesFile);
  const titles = new Set(macros.map((m) => m.title));
  for (const m of messages) {
    if (m.expected !== 'NONE' && !titles.has(m.expected)) throw new Error(`Unknown expected macro "${m.expected}" in ${messagesFile}`);
  }
  const index = new MacroIndex({ embedder: opts.embedder ?? createBuiltinEmbedder() });
  await index.rebuild(macros, (m) => m.id);
  const minConfidence = opts.minConfidence ?? 45;

  let top1 = 0;
  let top3 = 0;
  let noneCorrect = 0;
  let noneTotal = 0;
  let falseNoMatch = 0;
  const correctConfidences: number[] = [];
  const noneConfidences: number[] = [];
  const times: number[] = [];
  const failures: EvalFailure[] = [];
  const details: EvalDetail[] = [];

  for (const m of messages) {
    const t0 = performance.now();
    const analysis = analyzeMessage(m.message);
    const res = await index.search(m.message, analysis, { maxResults: 3, minConfidence });
    times.push(performance.now() - t0);
    const got = res.recommendations.map((r) => r.title);
    const confidences = res.recommendations.map((r) => r.confidence);
    details.push({
      message: m.message,
      expected: m.expected,
      noGoodMatch: res.noGoodMatch,
      results: res.recommendations.map((r) => ({ title: r.title, confidence: r.confidence, reason: r.reason, matchedTerms: r.matchedTerms })),
    });
    if (m.expected === 'NONE') {
      noneTotal++;
      noneConfidences.push(confidences[0] ?? 0);
      if (res.noGoodMatch) noneCorrect++;
      else failures.push({ message: m.message, expected: 'NONE', got, confidences, kind: 'none_matched' });
      continue;
    }
    if (got[0] === m.expected) {
      top1++;
      correctConfidences.push(confidences[0] ?? 0);
    }
    if (got.includes(m.expected)) top3++;
    if (got[0] !== m.expected) failures.push({ message: m.message, expected: m.expected, got, confidences, kind: 'wrong_top1' });
    else if (res.noGoodMatch) failures.push({ message: m.message, expected: m.expected, got, confidences, kind: 'false_no_match' });
    if (res.noGoodMatch) falseNoMatch++;
  }
  const labeled = messages.length - noneTotal;
  times.sort((a, b) => a - b);
  return {
    set: setName(messagesFile),
    macros: macros.length,
    messages: messages.length,
    top1: labeled ? top1 / labeled : 0,
    top3: labeled ? top3 / labeled : 0,
    noneCorrect,
    noneTotal,
    falseNoMatch,
    meanCorrectConfidence: mean(correctConfidences),
    meanNoneConfidence: mean(noneConfidences),
    avgMs: mean(times),
    p95Ms: times[Math.floor(times.length * 0.95)] ?? 0,
    failures,
    details,
  };
}
