/**
 * `npm run eval` - prints recommendation accuracy on the labeled demo messages.
 *   --verbose   list every miss
 */
import { runEval } from './eval-lib.js';

const verbose = process.argv.includes('--verbose');
const r = await runEval();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`Macros: ${r.macros} · labeled messages: ${r.messages - r.noneTotal} · "no match" messages: ${r.noneTotal}`);
console.log(`Top-1 accuracy: ${pct(r.top1)}`);
console.log(`Top-3 accuracy: ${pct(r.top3)}`);
console.log(`"No good match" detected: ${r.noneCorrect}/${r.noneTotal}`);
console.log(`Latency (analysis + search): avg ${r.avgMs.toFixed(1)} ms · p95 ${r.p95Ms.toFixed(1)} ms`);
if (verbose || r.failures.length <= 15) {
  for (const f of r.failures) {
    console.log(`\n✗ "${f.message.slice(0, 110)}"\n  expected: ${f.expected}\n  got: ${f.got.map((t, i) => `${t} (${f.confidences[i]}%)`).join(' | ') || '-'}`);
  }
} else {
  console.log(`\n${r.failures.length} misses (run with --verbose to list them).`);
}
