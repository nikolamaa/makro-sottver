/**
 * `npm run eval` - prints recommendation accuracy on the labeled demo messages (seed/eval-messages.json) and on
 * the blind holdout set (seed/eval-holdout.json).
 *   --verbose   list every miss
 *   --holdout   only the holdout set
 *   --tuning    only the original (tuning) set
 *   --reasons   print the top results with reasons and matched terms for every message
 */
import { EVAL_MESSAGES_FILE, HOLDOUT_MESSAGES_FILE, runEval, type EvalReport } from './eval-lib.js';

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');
const showReasons = args.has('--reasons');
const files = args.has('--holdout') ? [HOLDOUT_MESSAGES_FILE] : args.has('--tuning') ? [EVAL_MESSAGES_FILE] : [EVAL_MESSAGES_FILE, HOLDOUT_MESSAGES_FILE];
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function print(r: EvalReport): void {
  const labeled = r.messages - r.noneTotal;
  console.log(`\n=== ${r.set} ===`);
  console.log(`Macros: ${r.macros} · labeled messages: ${labeled} · "no match" messages: ${r.noneTotal}`);
  console.log(`Top-1 accuracy: ${pct(r.top1)}`);
  console.log(`Top-3 accuracy: ${pct(r.top3)}`);
  console.log(`"No good match" detected: ${r.noneCorrect}/${r.noneTotal}`);
  console.log(`Labeled messages wrongly flagged "no good match": ${r.falseNoMatch}/${labeled}`);
  console.log(`Mean top-1 confidence: correct ${r.meanCorrectConfidence.toFixed(1)} · NONE ${r.meanNoneConfidence.toFixed(1)}`);
  console.log(`Latency (analysis + search): avg ${r.avgMs.toFixed(1)} ms · p95 ${r.p95Ms.toFixed(1)} ms`);
  if (verbose || r.failures.length <= 15) {
    for (const f of r.failures) {
      const label = f.kind === 'false_no_match' ? ' (correct top-1, but flagged no good match)' : '';
      console.log(
        `\n✗ "${f.message.slice(0, 110)}"${label}\n  expected: ${f.expected}\n  got: ${f.got.map((t, i) => `${t} (${f.confidences[i]}%)`).join(' | ') || '-'}`,
      );
    }
  } else {
    console.log(`\n${r.failures.length} misses (run with --verbose to list them).`);
  }
  if (showReasons) {
    console.log(`\n--- reasons (${r.set}) ---`);
    for (const d of r.details) {
      console.log(`\n"${d.message.slice(0, 110)}" -> expected ${d.expected}${d.noGoodMatch ? ' [no good match]' : ''}`);
      for (const res of d.results) console.log(`  ${res.confidence}% ${res.title}\n      ${res.reason}  {${res.matchedTerms.join(', ')}}`);
    }
  }
}

for (const file of files) print(await runEval({ messagesFile: file }));
