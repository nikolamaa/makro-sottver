import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Macro } from '../shared/types';
import { macroFixture } from './components/assist/testFixtures';
import { actions, getState, setState, type NavigationGuard } from './store';

/** Guard like the Library's unsaved-changes modal: takes over and keeps `proceed` for the user's answer. */
function holdingGuard(): { pending: (() => void) | null } {
  const held: { pending: (() => void) | null } = { pending: null };
  const guard: NavigationGuard = (_to, proceed) => {
    held.pending = proceed;
    return true;
  };
  actions.setNavigationGuard(guard);
  return held;
}

beforeEach(() => {
  setState({ page: 'library', assistPickId: null, libraryFocusId: null, macros: [] });
});

afterEach(() => {
  actions.setNavigationGuard(null);
});

describe('navigation with a pick for the target page', () => {
  it('useInAssist without a guard opens Assist with the pick', () => {
    actions.useInAssist('x');
    expect(getState()).toMatchObject({ page: 'assist', assistPickId: 'x' });
  });

  it('a cancelled navigation ("Keep editing") leaves no pick behind for a later visit', () => {
    const held = holdingGuard();
    actions.useInAssist('x');
    expect(held.pending).not.toBeNull();
    expect(getState()).toMatchObject({ page: 'library', assistPickId: null });

    // The user keeps editing (proceed is dropped), saves, and later opens Assist normally.
    held.pending = null;
    actions.setNavigationGuard(null);
    actions.navigate('assist');
    expect(getState()).toMatchObject({ page: 'assist', assistPickId: null });
  });

  it('applies the pick once the guard lets the navigation proceed', () => {
    const held = holdingGuard();
    actions.useInAssist('x');
    held.pending?.();
    expect(getState()).toMatchObject({ page: 'assist', assistPickId: 'x' });
  });

  it('openInLibrary sets the focus request only when the navigation happens', () => {
    setState({ page: 'settings' });
    const held = holdingGuard();
    actions.openInLibrary('m1');
    expect(getState()).toMatchObject({ page: 'settings', libraryFocusId: null });
    held.pending?.();
    expect(getState()).toMatchObject({ page: 'library', libraryFocusId: 'm1' });
  });

  it('openInLibrary on the Library itself sets the focus request right away (no guard involved)', () => {
    const held = holdingGuard();
    actions.openInLibrary('m1');
    expect(held.pending).toBeNull();
    expect(getState()).toMatchObject({ page: 'library', libraryFocusId: 'm1' });
  });
});

describe('recordUse', () => {
  it('bumps use count and last use of the copied macros only, once per macro', () => {
    const other: Macro = macroFixture('c', 7);
    setState({ macros: [macroFixture('a', 2), macroFixture('b', 0), other] });
    actions.recordUse(['a', 'b', 'a'], '2026-10-08T12:00:00.000Z');
    const byId = new Map(getState().macros.map((m) => [m.id, m]));
    expect(byId.get('a')).toMatchObject({ useCount: 3, lastUsedAt: '2026-10-08T12:00:00.000Z' });
    expect(byId.get('b')).toMatchObject({ useCount: 1, lastUsedAt: '2026-10-08T12:00:00.000Z' });
    // Untouched macros keep their identity, so memoized rows do not re-render.
    expect(byId.get('c')).toBe(other);
  });

  it('keeps the list as is when none of the macros is loaded (e.g. archived meanwhile)', () => {
    setState({ macros: [macroFixture('a', 2)] });
    const before = getState().macros;
    actions.recordUse(['gone'], '2026-10-08T12:00:00.000Z');
    expect(getState().macros).toBe(before);
  });
});
