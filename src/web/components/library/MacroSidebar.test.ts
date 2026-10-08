import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Macro } from '../../../shared/types';
import { macroFixture } from '../assist/testFixtures';
import { MacroSidebar, type MacroSidebarProps } from './MacroSidebar';

function render(count: number): string {
  const macros: Macro[] = Array.from({ length: count }, (_, i) => macroFixture(`m${String(i).padStart(4, '0')}`, 0, { title: `Macro ${String(i).padStart(4, '0')}` }));
  const props: MacroSidebarProps = {
    macros,
    categories: [],
    activeId: null,
    onOpen: () => undefined,
    onNew: () => undefined,
    showArchived: false,
    onShowArchivedChange: () => undefined,
    archivedLoading: false,
  };
  return renderToStaticMarkup(createElement(MacroSidebar, props));
}

describe('MacroSidebar list', () => {
  it('renders a window of rows (not all 2000) with the full set size for screen readers', () => {
    const html = render(2000);
    const rows = html.match(/role="option"/g) ?? [];
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(60);
    expect(html).toContain('aria-setsize="2000"');
    expect(html).toContain('aria-posinset="1"');
    expect(html).toContain('id="lib-opt-m0000"');
    expect(html).not.toContain('id="lib-opt-m1999"');
    // Spacer below the rendered rows keeps the full scroll height.
    expect(html).toMatch(/padding-bottom:\s*\d{5}px/);
    expect(html).toContain('2000 macros');
  });

  it('renders every row of a short list', () => {
    const html = render(5);
    expect((html.match(/role="option"/g) ?? []).length).toBe(5);
  });
});
