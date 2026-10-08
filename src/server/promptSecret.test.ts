import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PromptCancelledError, promptSecret } from './promptSecret.js';

function terminal(isTTY: boolean) {
  const input = Object.assign(new PassThrough(), { isTTY });
  const output = new PassThrough();
  let printed = '';
  output.on('data', (d: Buffer) => (printed += d.toString('utf8')));
  return { input, output, printed: () => printed };
}

const KEY = 'MPRK-ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567-89AB';

describe('promptSecret', () => {
  it('does not echo what is typed in a terminal', async () => {
    const t = terminal(true);
    const answer = promptSecret('Recovery key: ', t);
    for (const ch of KEY) t.input.write(ch);
    t.input.write('\r');
    expect(await answer).toBe(KEY);
    expect(t.printed()).toContain('Recovery key: ');
    expect(t.printed()).not.toContain('MPRK');
    expect(t.printed()).not.toContain('ABCD');
  });

  it('supports editing (backspace) while hidden', async () => {
    const t = terminal(true);
    const answer = promptSecret('Key: ', t);
    t.input.write('MPRK-X\x7fA\r');
    expect(await answer).toBe('MPRK-A');
  });

  it('rejects on Ctrl+C', async () => {
    const t = terminal(true);
    const answer = promptSecret('Key: ', t);
    t.input.write('\x03');
    await expect(answer).rejects.toBeInstanceOf(PromptCancelledError);
  });

  it('reads a plain line from piped input', async () => {
    const t = terminal(false);
    const answer = promptSecret('Key: ', t);
    t.input.write(`${KEY}\n`);
    expect(await answer).toBe(KEY);
  });
});
