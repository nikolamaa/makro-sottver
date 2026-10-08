import { analyzeMessage } from '../src/server/analysis/analyzer.js';
import { createBuiltinEmbedder } from '../src/server/search/embedder.js';
import { MacroIndex } from '../src/server/search/macroIndex.js';
import { buildLexicalQuery } from '../src/server/search/query.js';
import { loadSeedMacros } from './eval-lib.js';

const msgs = process.argv.slice(2);
const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
await index.rebuild(loadSeedMacros(), (m) => m.id);
for (const m of msgs) {
  const a = analyzeMessage(m);
  const q = buildLexicalQuery(m);
  console.log(`\n"${m}"`);
  console.log('  intents', JSON.stringify(a.intents), 'questions', JSON.stringify(a.questions), 'keywords', JSON.stringify(a.keywords));
  console.log('  terms', q.terms.join(','), '| exp', [...q.expansions].join(','), '| concepts', JSON.stringify([...q.concepts]));
  const r = await index.search(m, a, { maxResults: 3, minConfidence: 45 });
  console.log('  noGoodMatch', r.noGoodMatch, 'uncovered', r.uncoveredIntents);
  for (const x of r.recommendations) console.log(`   ${x.confidence}% ${x.title} ${JSON.stringify(x.breakdown)}\n      ${x.reason} {${x.matchedTerms.join(', ')}}`);
}
