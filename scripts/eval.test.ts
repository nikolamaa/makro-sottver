/**
 * Regression guard for recommendation quality (see `npm run eval`): the labeled demo messages used for tuning
 * (seed/eval-messages.json) and two blind holdout sets that were never used for tuning (seed/eval-holdout.json,
 * seed/eval-holdout-2.json; the second was written by an independent evaluator).
 *
 * Minimums are the measured counts minus one message per metric, so that a real regression fails but a single
 * borderline case flipping does not. Measured: tuning top-1 75/81, top-3 81/81, NONE 7/12, 0 wrongly flagged;
 * holdout 28/30, 29/30, 10/16, 1; holdout-2 52/61, 59/61, 10/19, 6.
 */
import { describe, expect, it } from 'vitest';
import { EVAL_MESSAGES_FILE, HOLDOUT2_MESSAGES_FILE, HOLDOUT_MESSAGES_FILE, runEval } from './eval-lib.js';

interface Expectation {
  name: string;
  file: string;
  /** Exact set sizes, so the count minimums below keep their meaning. */
  labeled: number;
  none: number;
  minTop1: number;
  minTop3: number;
  minNoneDetected: number;
  /** Labeled messages flagged "no good match" although a macro answers them. */
  maxFalseNoMatch: number;
}

const SETS: Expectation[] = [
  { name: 'tuning set', file: EVAL_MESSAGES_FILE, labeled: 81, none: 12, minTop1: 74, minTop3: 80, minNoneDetected: 6, maxFalseNoMatch: 1 },
  { name: 'blind holdout', file: HOLDOUT_MESSAGES_FILE, labeled: 30, none: 16, minTop1: 27, minTop3: 28, minNoneDetected: 9, maxFalseNoMatch: 2 },
  { name: 'blind holdout 2', file: HOLDOUT2_MESSAGES_FILE, labeled: 61, none: 19, minTop1: 51, minTop3: 58, minNoneDetected: 9, maxFalseNoMatch: 7 },
];

describe('recommendation quality (demo library + labeled messages)', () => {
  for (const s of SETS) {
    it(`keeps top-1 / top-3 accuracy, "no good match" detection and latency on the ${s.name}`, async () => {
      const r = await runEval({ messagesFile: s.file });
      const labeled = r.messages - r.noneTotal;
      expect(r.macros).toBeGreaterThanOrEqual(50);
      expect(labeled).toBe(s.labeled);
      expect(r.noneTotal).toBe(s.none);
      expect(Math.round(r.top1 * labeled)).toBeGreaterThanOrEqual(s.minTop1);
      expect(Math.round(r.top3 * labeled)).toBeGreaterThanOrEqual(s.minTop3);
      expect(r.noneCorrect).toBeGreaterThanOrEqual(s.minNoneDetected);
      expect(r.falseNoMatch).toBeLessThanOrEqual(s.maxFalseNoMatch);
      expect(r.avgMs).toBeLessThan(10);
    });
  }
});
