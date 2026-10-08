import { readFileSync } from 'node:fs';
import { analyzeMessage } from '../src/server/analysis/analyzer.js';
import { createBuiltinEmbedder } from '../src/server/search/embedder.js';
import { MacroIndex } from '../src/server/search/macroIndex.js';
import { buildLexicalQuery } from '../src/server/search/query.js';
import { matchConcepts } from '../src/server/search/concepts.js';
import { tokenize, isNoiseToken, stem, stripTemplateVariables } from '../src/server/search/text.js';
import { INTENT_LABELS } from '../src/shared/types.js';
import { loadSeedMacros } from './eval-lib.js';

const GENERIC_CONCEPTS = new Set(['time', 'account', 'complaint']);
const macros = loadSeedMacros();
const N = macros.length;
const docText = (m: (typeof macros)[0]) => [m.title, ...m.triggers, ...m.tags, ...m.intents.map((i) => INTENT_LABELS[i]), stripTemplateVariables(m.body)].join('\n');
const macroConcepts = new Map(macros.map((m) => [m.title, new Set(matchConcepts(docText(m)).keys())]));
const macroTerms = new Map(macros.map((m) => [m.title, new Set(tokenize(docText(m)).filter((t) => !isNoiseToken(t)).map(stem))]));
const cdf = new Map<string, number>();
for (const s of macroConcepts.values()) for (const c of s) cdf.set(c, (cdf.get(c) ?? 0) + 1);
const tdf = new Map<string, number>();
for (const s of macroTerms.values()) for (const t of s) tdf.set(t, (tdf.get(t) ?? 0) + 1);
const idf = (df: number) => Math.log(1 + (N - df + 0.5) / (df + 0.5));
const has = (set: Set<string>, t: string) => set.has(t) || (t.length >= 4 && [...set].some((x) => x.startsWith(t)));

const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
await index.rebuild(macros, (m) => m.id);
const file = process.argv[2] ?? 'seed/eval-messages.json';
const msgs = JSON.parse(readFileSync(file, 'utf8')) as { message: string; expected: string }[];
for (const m of msgs) {
  const a = analyzeMessage(m.message);
  const q = buildLexicalQuery(m.message);
  const r = await index.search(m.message, a, { maxResults: 3, minConfidence: 45 });
  const top = r.recommendations[0];
  if (!top) continue;
  const mc = macroConcepts.get(top.title)!;
  const mt = macroTerms.get(top.title)!;
  const qc = [...q.concepts.keys()].filter((c) => !GENERIC_CONCEPTS.has(c));
  const cw = qc.map((c) => [c, idf(cdf.get(c) ?? 0), mc.has(c)] as const);
  const cc = cw.reduce((s, x) => s + (x[2] ? x[1] : 0), 0) / Math.max(1e-9, cw.reduce((s, x) => s + x[1], 0));
  const terms = q.terms.filter((t) => !q.expansions.has(t));
  const tw = terms.map((t) => [t, tdf.get(t) ?? 0, has(mt, t)] as const);
  const tc = tw.reduce((s, x) => s + (x[2] ? idf(x[1]) : 0), 0) / Math.max(1e-9, tw.reduce((s, x) => s + idf(x[1]), 0));
  const ok = m.expected === 'NONE' ? 'NONE' : top.title === m.expected ? 'OK  ' : 'MISS';
  console.log(`${ok} ${top.confidence} cc=${cc.toFixed(2)} tc=${tc.toFixed(2)} "${m.message.slice(0, 70)}" -> ${top.title.slice(0, 40)}`);
  console.log(`      concepts ${cw.map((x) => `${x[0]}${x[2] ? '+' : '-'}(${x[1].toFixed(1)})`).join(' ')} | terms ${tw.map((x) => `${x[0]}${x[2] ? '+' : '-'}${x[1]}`).join(' ')}`);
}
