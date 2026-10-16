import { getTestIdAttr, readTestId } from './addressing/testid-attr.js';

/**
 * A CSS selector that names `el` without a snapshot: its testid, or its id when the id is a plain
 * identifier. Absent when the element carries neither. A minted selector (an nth-of-type path)
 * rots with the next render, so the hint does not offer one (#1147).
 */
export function stableSelectorFor(el: HTMLElement): string | undefined {
  const testid = readTestId(el);
  if (null !== testid && 0 < testid.length) {
    const escaped = testid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `[${getTestIdAttr()}="${escaped}"]`;
  }
  const id = el.getAttribute('id');
  if (null !== id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return `#${id}`;
  return undefined;
}
