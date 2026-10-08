import { readFileSync } from 'node:fs';
import { analyzeMessage } from '../src/server/analysis/analyzer.js';
for (const f of ['seed/eval-messages.json']) {
  const msgs = JSON.parse(readFileSync(f, 'utf8')) as { message: string; expected: string }[];
  for (const m of msgs) {
    const a = analyzeMessage(m.message);
    console.log(`${m.message.slice(0, 90)}\n   Q=${JSON.stringify(a.questions.map((q) => [q.text, q.intent]))} I=${a.intents.map((i) => i.intent + ':' + i.score).join(',')}`);
  }
}
