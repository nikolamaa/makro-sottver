import { runEval, EVAL_MESSAGES_FILE } from './eval-lib.js';
const r = await runEval({ messagesFile: process.argv[2] ?? EVAL_MESSAGES_FILE });
const pos: number[] = [], neg: number[] = [], wrong: number[] = [];
for (const d of r.details) {
  const c = d.results[0]?.confidence ?? 0;
  if (d.expected === 'NONE') neg.push(c);
  else if (d.results[0]?.title === d.expected) pos.push(c);
  else wrong.push(c);
}
const s = (a: number[]) => a.sort((x, y) => x - y).join(' ');
console.log('correct top1:', s(pos));
console.log('wrong top1  :', s(wrong));
console.log('NONE top1   :', s(neg));
