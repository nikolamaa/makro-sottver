import { readFileSync } from 'node:fs';
import { analyzeMessage } from '../src/server/analysis/analyzer.js';
import { createBuiltinEmbedder } from '../src/server/search/embedder.js';
import { MacroIndex } from '../src/server/search/macroIndex.js';
import { buildLexicalQuery } from '../src/server/search/query.js';
import { matchConcepts } from '../src/server/search/concepts.js';
import { loadSeedMacros } from './eval-lib.js';
const G = new Set(['time', 'account', 'complaint']);
const macros = loadSeedMacros();
const byTitle = new Map(macros.map((m) => [m.title, m]));
const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
await index.rebuild(macros, (m) => m.id);
const msgs = JSON.parse(readFileSync(process.argv[2] ?? 'seed/eval-messages.json', 'utf8')) as { message: string; expected: string }[];
for (const m of msgs) {
  const a = analyzeMessage(m.message);
  const q = buildLexicalQuery(m.message);
  const r = await index.search(m.message, a, { maxResults: 3, minConfidence: 45 });
  const t = m.expected === 'NONE' ? r.recommendations[0]?.title : m.expected;
  if (!t) continue;
  const mac = byTitle.get(t)!;
  const tc = [...matchConcepts(mac.title).keys()].filter((c) => !G.has(c));
  const hc = [...matchConcepts([mac.title, ...mac.tags.map((x) => x.replace(/[-_]/g, ' '))].join('\n')).keys()].filter((c) => !G.has(c));
  const qc = new Set(q.concepts.keys());
  const titleHit = tc.length === 0 ? 'n/a' : tc.some((c) => qc.has(c)) ? 'yes' : 'NO';
  const headHit = hc.length === 0 ? 'n/a' : hc.some((c) => qc.has(c)) ? 'yes' : 'NO';
  const intentHit = mac.intents.some((i) => a.intents.some((x) => x.intent === i && x.score >= 0.35)) ? 'yes' : 'no';
  console.log(`${m.expected === 'NONE' ? 'NONE' : 'POS '} title=${titleHit.padEnd(3)} head=${headHit.padEnd(3)} intent=${intentHit.padEnd(3)} [${tc.join(',')}] {${hc.join(',')}} msg=[${[...qc].join(',')}] "${m.message.slice(0, 60)}" -> ${t.slice(0, 40)}`);
}
