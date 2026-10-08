import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Analysis, Intent, Macro, QuestionSpan } from '../../shared/types.js';
import { createBuiltinEmbedder } from './embedder.js';
import { MacroIndex } from './macroIndex.js';

function analysisOf(intents: [Intent, number][] = [], questions: QuestionSpan[] = []): Analysis {
  return { intents: intents.map(([intent, score]) => ({ intent, score })), sentiment: 'neutral', sentimentScore: 0, urgency: 'normal', urgencyReasons: [], entities: [], questions, keywords: [], rgRisk: false, rgSignals: [], isLikelyNonEnglish: false, wordCount: 0, source: 'local' };
}
const seed = JSON.parse(readFileSync('seed/stake-demo-macros.json', 'utf8'));
const items: any[] = Array.isArray(seed) ? seed : seed.macros;
function toMacro(x: any, i: number): Macro {
  return { id: `m${i}`, title: x.title, body: x.body, categoryId: null, tags: x.tags ?? [], intents: x.intents ?? [], triggers: x.triggers ?? [], notes: '', shortcut: x.shortcut ?? '', version: 1, createdAt: '', updatedAt: '', archivedAt: null, isFavorite: false, useCount: 0, lastUsedAt: null, verification: 'unverified', facts: [] };
}

it('edge inputs', async () => {
  const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
  await index.rebuild(items.map(toMacro), (m) => m.id);
  const msgs = ['', '   ', '🙂🙂', '0x3fa85f6457174562b3fc2c963f66afa6', 'WITHDRAWAL PENDING!!!', '<b>withdrawal</b> &nbsp; pending', 'hi', 'ok thanks', '?', 'wd-pending', 'retiro pendiente', 'a'.repeat(5000)];
  for (const m of msgs) {
    const r = await index.search(m, analysisOf(), { maxResults: 3, minConfidence: 45 });
    console.log(JSON.stringify(m.slice(0, 40)), r.noGoodMatch, r.recommendations.map((x) => `${x.title.slice(0, 30)}:${x.confidence}`).join(' | '), r.uncoveredIntents);
  }
  const r = await index.search('my withdrawal is pending', analysisOf([['withdrawal_pending', 0.9]]), { maxResults: 0, minConfidence: 45 });
  console.log('max0', r.recommendations.length);
  const r2 = await index.search('my withdrawal is pending', analysisOf([['withdrawal_pending', 0.9]]), { maxResults: 10, minConfidence: 45 });
  console.log('max10', r2.recommendations.map((x) => `${x.title.slice(0, 30)}:${x.confidence}:${x.reason}`).join('\n'));
});
