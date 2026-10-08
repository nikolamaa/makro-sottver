/**
 * Fixed-row-height windowing for the Library list (up to thousands of macros): only the rows in view plus some
 * overscan are rendered, and padding above and below the rendered rows keeps the scroll height exact.
 *
 *   const win = listWindow(items.length, ROW_HEIGHT, scrollTop, viewportHeight, OVERSCAN, INSET);
 *   items.slice(win.start, win.end) rendered inside <div style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
 *
 * `inset` is the list's own vertical padding (space above the first and below the last row).
 */

export interface ListWindow {
  /** First rendered index (inclusive). */
  start: number;
  /** End of the rendered range (exclusive). */
  end: number;
  /** Space above / below the rendered rows (inset included), in px. */
  padTop: number;
  padBottom: number;
}

/** Rows to render for a scroll position. A scrollTop past the end (list just got shorter) is clamped. */
export function listWindow(
  count: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  inset = 0,
): ListWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: inset, padBottom: inset };
  const maxScroll = Math.max(0, count * rowHeight + 2 * inset - viewportHeight);
  const top = Math.min(Math.max(0, scrollTop), maxScroll) - inset;
  const first = Math.min(count - 1, Math.max(0, Math.floor(top / rowHeight)));
  const last = Math.min(count, Math.max(first + 1, Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight)));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, last + overscan);
  return { start, end, padTop: inset + start * rowHeight, padBottom: inset + (count - end) * rowHeight };
}

/**
 * Scroll position that shows row `index` (with the inset around it) using the least movement, like
 * scrollIntoView({ block: 'nearest' }) - which cannot be used for a row that is not rendered yet.
 */
export function scrollTopToReveal(index: number, rowHeight: number, scrollTop: number, viewportHeight: number, inset = 0): number {
  const top = index * rowHeight;
  const bottom = (index + 1) * rowHeight + 2 * inset;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.min(top, Math.max(0, bottom - viewportHeight));
  return scrollTop;
}
