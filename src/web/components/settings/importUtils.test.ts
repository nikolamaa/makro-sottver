import { describe, expect, it } from 'vitest';
import {
  addCommitResults,
  chunkForCommit,
  COMMIT_BATCH_BYTES,
  COMMIT_BATCH_ITEMS,
  decodeFileBytes,
  exceedsImportLimit,
  formatFromFileName,
  guessFormat,
  IMPORT_MAX_CONTENT_BYTES,
  utf8Length,
} from './importUtils';

describe('formatFromFileName', () => {
  it('maps extensions to import tabs, case-insensitively', () => {
    expect(formatFromFileName('Macros.CSV')).toBe('csv');
    expect(formatFromFileName('sheet.export.tsv')).toBe('csv');
    expect(formatFromFileName('macropilot-macros.json')).toBe('json');
    expect(formatFromFileName('notes.Md')).toBe('text');
    expect(formatFromFileName('copy.txt')).toBe('text');
  });
  it('rejects unsupported or missing extensions', () => {
    expect(formatFromFileName('macros.xlsx')).toBeNull();
    expect(formatFromFileName('README')).toBeNull();
  });
});

describe('guessFormat', () => {
  it('does not mistake Intercom text that starts with [ or {{ for JSON', () => {
    expect(guessFormat('[VIP] Weekly bonus\nHi {{first_name}}, your bonus is ready.')).not.toBe('json');
    expect(guessFormat('{{first_name | fallback: "there"}}, thanks for waiting!')).not.toBe('json');
  });
  it('recognizes JSON arrays and objects', () => {
    expect(guessFormat('  [\n  {\n "title": "A", "body": "B" }]')).toBe('json');
    expect(guessFormat('{"format":"macropilot-export","macros":[]}')).toBe('json');
    expect(guessFormat('[]')).toBe('json');
  });
  it('recognizes CSV headers with the same synonyms and delimiters as the server', () => {
    expect(guessFormat('title,body,category\n"A","B","C"')).toBe('csv');
    expect(guessFormat('Macro name;Reply;Tags\nA;B;c')).toBe('csv');
    expect(guessFormat('"Name"\t"Template"\nA\tB')).toBe('csv');
    expect(guessFormat('Hi there, thanks for the message, body text\nmore')).toBeNull();
  });
  it('recognizes the text format', () => {
    expect(guessFormat('### Pending withdrawal\nHi {{user}}')).toBe('text');
    expect(guessFormat('Pending withdrawal\nHi\n---\nNext\nBody')).toBe('text');
    expect(guessFormat('   ')).toBeNull();
  });
});

describe('decodeFileBytes', () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);

  it('decodes UTF-8 and strips the BOM', () => {
    expect(decodeFileBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('title,body\nČ,ž')]))).toBe('title,body\nČ,ž');
    expect(decodeFileBytes(utf8('We’ll check — thanks'))).toBe('We’ll check — thanks');
  });

  it('decodes Windows-1252 CSV saved by Excel instead of producing replacement characters', () => {
    // "We’ll" with a cp1252 right single quote (0x92) and "café" (0xE9).
    const bytes = new Uint8Array([0x57, 0x65, 0x92, 0x6c, 0x6c, 0x20, 0x63, 0x61, 0x66, 0xe9]);
    const text = decodeFileBytes(bytes);
    expect(text).toBe('We’ll café');
    expect(text).not.toContain('�');
  });

  it('decodes UTF-16 files with a BOM (Excel "Unicode text")', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00, 0x19, 0x20]);
    expect(decodeFileBytes(le)).toBe('Hi’');
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
    expect(decodeFileBytes(be)).toBe('Hi');
  });
});

describe('chunkForCommit', () => {
  const item = (title: string, bodySize = 10) => ({ title, body: 'x'.repeat(bodySize) });

  it('returns one batch for a normal import', () => {
    const items = [item('a'), item('b'), item('c')];
    expect(chunkForCommit(items, 1_000_000, 500)).toEqual([items]);
  });

  it('keeps every batch under the byte limit and preserves order', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`m${i}`, 1000));
    const batches = chunkForCommit(items, 10_000, 500);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(items);
    for (const b of batches) expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThanOrEqual(10_000);
  });

  it('counts multi-byte characters as bytes', () => {
    const items = [item('a'), item('b')].map((it) => ({ ...it, body: 'ž'.repeat(400) }));
    // Each body is 400 chars but 800 bytes: they must not share a 1200-byte batch.
    expect(chunkForCommit(items, 1200, 500)).toHaveLength(2);
  });

  it('respects the item limit and gives an oversized item its own batch', () => {
    expect(chunkForCommit([item('a'), item('b'), item('c')], 1_000_000, 2).map((b) => b.length)).toEqual([2, 1]);
    const big = item('big', 5000);
    expect(chunkForCommit([item('a'), big, item('b')], 1000, 500)).toEqual([[item('a')], [big], [item('b')]]);
    expect(chunkForCommit([], 1000, 10)).toEqual([]);
  });

  it('adds commit results', () => {
    expect(addCommitResults({ created: 1, updated: 2, skipped: 3 }, { created: 4, updated: 0, skipped: 1 })).toEqual({
      created: 5,
      updated: 2,
      skipped: 4,
    });
  });
});

describe('import size limits', () => {
  it('matches the server: 30 MB of content, committed in batches below the 40 MB request limit', () => {
    expect(IMPORT_MAX_CONTENT_BYTES).toBe(30 * 1024 * 1024);
    expect(COMMIT_BATCH_BYTES).toBeLessThan(40 * 1024 * 1024);
    expect(COMMIT_BATCH_ITEMS).toBeLessThanOrEqual(20_000);
  });

  it('counts UTF-8 bytes like the server', () => {
    for (const text of ['', 'abc', 'ž', '€uro', '😀', 'a\ud800b', '\udc00', 'mixé 😀 €']) {
      expect(utf8Length(text), JSON.stringify(text)).toBe(Buffer.byteLength(text, 'utf8'));
    }
  });

  it('accepts content up to 30 MB (the old 2 million character cap is gone) and rejects more', () => {
    expect(exceedsImportLimit('x'.repeat(5_000_000))).toBe(false);
    expect(exceedsImportLimit('x'.repeat(IMPORT_MAX_CONTENT_BYTES))).toBe(false);
    expect(exceedsImportLimit('x'.repeat(IMPORT_MAX_CONTENT_BYTES + 1))).toBe(true);
    // 11 million two-byte characters are 22 MB (fine), 16 million are 32 MB (too much).
    expect(exceedsImportLimit('ž'.repeat(11_000_000))).toBe(false);
    expect(exceedsImportLimit('ž'.repeat(16_000_000))).toBe(true);
  });

  it('commits a 20000-macro import in a few batches', () => {
    const items = Array.from({ length: 20_000 }, (_, i) => ({ title: `Macro ${i}`, body: 'x'.repeat(500) }));
    const batches = chunkForCommit(items, COMMIT_BATCH_BYTES, COMMIT_BATCH_ITEMS);
    expect(batches.length).toBe(4);
    expect(batches.flat()).toHaveLength(20_000);
  });
});
