/**
 * Regression guard for recommendation quality on the labeled demo messages (see `npm run eval`).
 */
import { describe, expect, it } from 'vitest';
import { runEval } from './eval-lib.js';

describe('recommendation quality (demo library + labeled messages)', () => {
  it('keeps top-1 / top-3 accuracy and latency', async () => {
    const r = await runEval();
    expect(r.macros).toBeGreaterThanOrEqual(50);
    expect(r.top1).toBeGreaterThanOrEqual(0.85);
    expect(r.top3).toBeGreaterThanOrEqual(0.97);
    expect(r.avgMs).toBeLessThan(25);
  });
});
