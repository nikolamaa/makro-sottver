import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeAction } from './shortcuts';

class FakeElement {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false,
  ) {}
}

/** A page that "contains" exactly the given elements. */
function fakePage(...children: FakeElement[]): Element {
  return { contains: (node: unknown) => children.includes(node as FakeElement) } as unknown as Element;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Esc on the Assist page', () => {
  it('clears from the customer message box, where focus sits after Ctrl+V', () => {
    vi.stubGlobal('HTMLElement', FakeElement);
    const messageBox = new FakeElement('TEXTAREA');
    const page = fakePage(messageBox);
    expect(escapeAction(messageBox as unknown as HTMLElement, messageBox as unknown as Element, page)).toBe('clear');
  });

  it('clears from the page itself (buttons, cards, no focus)', () => {
    vi.stubGlobal('HTMLElement', FakeElement);
    const messageBox = new FakeElement('TEXTAREA') as unknown as Element;
    const card = new FakeElement('BUTTON');
    const page = fakePage(card);
    expect(escapeAction(card as unknown as HTMLElement, messageBox, page)).toBe('clear');
    expect(escapeAction(new FakeElement('BODY') as unknown as HTMLElement, messageBox, page)).toBe('clear');
    expect(escapeAction(null, messageBox, page)).toBe('clear');
  });

  it('only leaves the reply editor and the other fields of the page (never wipes a reply being edited)', () => {
    vi.stubGlobal('HTMLElement', FakeElement);
    const messageBox = new FakeElement('TEXTAREA') as unknown as Element;
    const editor = new FakeElement('TEXTAREA');
    const name = new FakeElement('INPUT');
    const select = new FakeElement('SELECT');
    const rich = new FakeElement('DIV', true);
    const page = fakePage(editor, name, select, rich);
    for (const field of [editor, name, select, rich]) {
      expect(escapeAction(field as unknown as HTMLElement, messageBox, page), field.tagName).toBe('blur');
    }
  });

  it('ignores text fields outside the page', () => {
    vi.stubGlobal('HTMLElement', FakeElement);
    const messageBox = new FakeElement('TEXTAREA') as unknown as Element;
    const elsewhere = new FakeElement('INPUT');
    expect(escapeAction(elsewhere as unknown as HTMLElement, messageBox, fakePage())).toBe('none');
    expect(escapeAction(elsewhere as unknown as HTMLElement, messageBox, null)).toBe('none');
  });
});
