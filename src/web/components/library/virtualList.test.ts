import { describe, expect, it } from 'vitest';
import { listWindow, scrollTopToReveal } from './virtualList';

const ROW = 48;
const INSET = 4;

describe('listWindow', () => {
  it('renders only the rows in view plus overscan, with spacers for the rest', () => {
    const win = listWindow(2000, ROW, 0, 600, 8, INSET);
    expect(win.start).toBe(0);
    expect(win.end).toBe(21); // 13 rows reach into a 600 px viewport, + 8 overscan
    expect(win.padTop).toBe(INSET);
    expect(win.padTop + (win.end - win.start) * ROW + win.padBottom).toBe(2000 * ROW + 2 * INSET);
  });

  it('follows the scroll position', () => {
    const win = listWindow(2000, ROW, 1000 * ROW + INSET, 600, 8, INSET);
    expect(win.start).toBe(992);
    expect(win.end).toBe(1021);
    expect(win.padTop).toBe(INSET + 992 * ROW);
    expect(win.padTop + (win.end - win.start) * ROW + win.padBottom).toBe(2000 * ROW + 2 * INSET);
  });

  it('clamps a stale scroll position after the list got shorter', () => {
    const win = listWindow(10, ROW, 50_000, 300, 2, INSET);
    expect(win.end).toBe(10);
    expect(win.start).toBeLessThanOrEqual(10 - Math.floor(300 / ROW));
    expect(win.padBottom).toBe(INSET);
  });

  it('renders every row of a short list and nothing for an empty one', () => {
    expect(listWindow(3, ROW, 0, 600, 8, INSET)).toEqual({ start: 0, end: 3, padTop: INSET, padBottom: INSET });
    expect(listWindow(0, ROW, 0, 600, 8, INSET)).toEqual({ start: 0, end: 0, padTop: INSET, padBottom: INSET });
  });

  it('still renders rows before the list is measured', () => {
    const win = listWindow(2000, ROW, 0, 0, 8, INSET);
    expect(win.end - win.start).toBeGreaterThan(0);
  });
});

describe('scrollTopToReveal', () => {
  it('keeps the position when the row is already fully in view', () => {
    expect(scrollTopToReveal(5, ROW, 0, 600, INSET)).toBe(0);
    expect(scrollTopToReveal(1000, ROW, 1000 * ROW - 100, 600, INSET)).toBe(1000 * ROW - 100);
  });

  it('scrolls up so the row (and the inset above it) is at the top', () => {
    expect(scrollTopToReveal(0, ROW, 5000, 600, INSET)).toBe(0);
    expect(scrollTopToReveal(100, ROW, 5000, 600, INSET)).toBe(100 * ROW);
  });

  it('scrolls down just enough to show the row at the bottom', () => {
    const top = scrollTopToReveal(1999, ROW, 0, 600, INSET);
    expect(top).toBe(2000 * ROW + 2 * INSET - 600); // the very end of the list
    expect(INSET + 1999 * ROW).toBeGreaterThanOrEqual(top);
    expect(INSET + 2000 * ROW).toBeLessThanOrEqual(top + 600);
  });

  it('prefers the row top when the viewport is smaller than a row', () => {
    expect(scrollTopToReveal(10, ROW, 0, 20, INSET)).toBe(10 * ROW);
  });
});
