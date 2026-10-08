/**
 * Read a secret (the recovery key) from the terminal without echoing it, so it does not end up on screen, in a
 * screen share, in scrollback or in terminal logs. When stdin is not a terminal (piped input) nothing is echoed
 * anyway, so a plain prompt is used.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export interface PromptIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

export class PromptCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PromptCancelledError';
  }
}

export async function promptSecret(question: string, io: PromptIo = { input: process.stdin, output: process.stdout }): Promise<string> {
  if (io.input.isTTY !== true) {
    const rl = createInterface({ input: io.input, output: io.output, terminal: false });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }

  // Terminal: readline still handles editing (backspace, arrows), but everything it echoes goes nowhere.
  let muted = false;
  const sink = new Writable({
    decodeStrings: false,
    write(chunk: string | Uint8Array, _encoding, callback) {
      if (!muted) io.output.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: io.input, output: sink, terminal: true });
  io.output.write(question);
  muted = true;
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once('SIGINT', () => reject(new PromptCancelledError()));
      rl.question('').then(resolve, reject);
    });
  } finally {
    rl.close();
    muted = false;
    io.output.write('\n');
  }
}
