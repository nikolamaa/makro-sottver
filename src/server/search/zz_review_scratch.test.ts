import { it } from 'vitest';
import type { Analysis, Intent, Macro, QuestionSpan } from '../../shared/types.js';
import { createBuiltinEmbedder, createOllamaEmbedder, resolveEmbedder } from './embedder.js';
import { MacroIndex } from './macroIndex.js';

function analysisOf(intents: [Intent, number][] = [], questions: QuestionSpan[] = []): Analysis {
  return { intents: intents.map(([intent, score]) => ({ intent, score })), sentiment: 'neutral', sentimentScore: 0, urgency: 'normal', urgencyReasons: [], entities: [], questions, keywords: [], rgRisk: false, rgSignals: [], isLikelyNonEnglish: false, wordCount: 0, source: 'local' };
}
function macro(id: string, title: string, intents: Intent[], body: string): Macro {
  return { id, title, body, categoryId: null, tags: [], intents, triggers: [], notes: '', shortcut: '', version: 1, createdAt: '', updatedAt: '', archivedAt: null, isFavorite: false, useCount: 0, lastUsedAt: null, verification: 'unverified', facts: [] };
}

it('general question floor', async () => {
  const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
  await index.rebuild([
    macro('betid', 'How to find your sports bet ID', ['general'], 'Open My Bets and copy the bet ID.'),
    macro('chat', 'Chat access and rain', ['general'], 'You need to verify your email to use the chat.'),
    macro('wd', 'Withdrawal pending', ['withdrawal_pending'], 'Your withdrawal is pending.'),
  ], (m) => m.id);
  const r = await index.search("what's the weather in Paris tomorrow?", analysisOf([['general', 0.3]], [{ text: "what's the weather in Paris tomorrow?", intent: 'general' }]), { maxResults: 3, minConfidence: 45 });
  console.log(r.recommendations.map((x) => `${x.macroId} ${x.confidence} ${JSON.stringify(x.breakdown)} ${x.coversIntents}`));
  const r2 = await index.search("what's the weather in Paris tomorrow?", analysisOf([['general', 0.3]]), { maxResults: 3, minConfidence: 45 });
  console.log(r2.recommendations.map((x) => `${x.macroId} ${x.confidence} ${JSON.stringify(x.breakdown)}`));
});

it('ollama status after runtime failure', async () => {
  let up = true;
  const e = createOllamaEmbedder({ url: 'http://x', model: 'm', fetch: async () => { if (!up) throw new TypeError('fetch failed'); return new Response(JSON.stringify({ embeddings: [[1, 0]] })); } });
  await e.init();
  up = false;
  await e.embed(['a'], 'query').catch((err) => console.log('err', String(err)));
  console.log('status after failure', JSON.stringify(e.status()));
});

it('resolveEmbedder never throws', async () => {
  try {
    const e = await resolveEmbedder({ provider: 'ollama', ollamaModel: 'x' }, { cacheDir: '/m', ollamaUrl: undefined as unknown as string });
    console.log('ok', e.provider, e.status().detail);
  } catch (err) {
    console.log('THREW', String(err));
  }
});
