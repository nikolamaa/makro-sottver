/**
 * Recommendation quality evaluation: loads the demo library (seed/stake-demo-macros.json) and the labeled
 * customer messages (seed/eval-messages.json), runs the real analyzer + hybrid index, and reports accuracy.
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
}

export interface EvalReport {
  macros: number;
  messages: number;
  top1: number;
  top3: number;
  noneCorrect: number;
  noneTotal: number;
  avgMs: number;
  p95Ms: number;
  failures: EvalFailure[];
}

const root = fileURLToPath(new URL('..', import.meta.url));

export function loadSeedMacros(file = `${root}seed/stake-demo-macros.json`): Macro[] {
  const preview = parseImport('json', readFileSync(file, 'utf8'), []);
  if (preview.errors.length) throw new Error(`Seed errors: ${preview.errors.join('; ')}`);
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

export function loadEvalMessages(file = `${root}seed/eval-messages.json`): EvalMessage[] {
  return JSON.parse(readFileSync(file, 'utf8')) as EvalMessage[];
}

export async function runEval(opts: { embedder?: Embedder; minConfidence?: number } = {}): Promise<EvalReport> {
  const macros = loadSeedMacros();
  const messages = loadEvalMessages();
  const index = new MacroIndex({ embedder: opts.embedder ?? createBuiltinEmbedder() });
  await index.rebuild(macros, (m) => m.id);
  const minConfidence = opts.minConfidence ?? 45;

  let top1 = 0;
  let top3 = 0;
  let noneCorrect = 0;
  let noneTotal = 0;
  const times: number[] = [];
  const failures: EvalFailure[] = [];

  for (const m of messages) {
    const t0 = performance.now();
    const analysis = analyzeMessage(m.message);
    const res = await index.search(m.message, analysis, { maxResults: 3, minConfidence });
    times.push(performance.now() - t0);
    const titles = res.recommendations.map((r) => r.title);
    if (m.expected === 'NONE') {
      noneTotal++;
      if (res.noGoodMatch) noneCorrect++;
      else failures.push({ message: m.message, expected: 'NONE', got: titles, confidences: res.recommendations.map((r) => r.confidence) });
      continue;
    }
    if (titles[0] === m.expected) top1++;
    if (titles.includes(m.expected)) top3++;
    if (titles[0] !== m.expected) {
      failures.push({ message: m.message, expected: m.expected, got: titles, confidences: res.recommendations.map((r) => r.confidence) });
    }
  }
  const labeled = messages.length - noneTotal;
  times.sort((a, b) => a - b);
  return {
    macros: macros.length,
    messages: messages.length,
    top1: labeled ? top1 / labeled : 0,
    top3: labeled ? top3 / labeled : 0,
    noneCorrect,
    noneTotal,
    avgMs: times.reduce((s, t) => s + t, 0) / Math.max(1, times.length),
    p95Ms: times[Math.floor(times.length * 0.95)] ?? 0,
    failures,
  };
}
