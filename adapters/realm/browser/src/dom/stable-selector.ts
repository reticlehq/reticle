import { getTestIdAttr, readTestId } from './addressing/testid-attr.js';

/**
 * A CSS selector that names `el` without a snapshot: its testid, or its id when the id is a plain
 * identifier. Absent when the element carries neither. A minted selector (an nth-of-type path)
 * rots with the next render, so the hint does not offer one (#1147).
 *
 * Offered only when it names exactly this element. A testid that repeats down a list — or a
 * duplicated id — resolves through `querySelector`, which takes the first match, so the scoped
 * retry would check the wrong row. In that case saying nothing beats naming the wrong element.
 */
export function stableSelectorFor(el: HTMLElement): string | undefined {
  const candidate = candidateSelectorFor(el);
  if (undefined === candidate) return undefined;
  const matches = el.ownerDocument.querySelectorAll(candidate);
  return 1 === matches.length && matches[0] === el ? candidate : undefined;
}

function candidateSelectorFor(el: HTMLElement): string | undefined {
  const testid = readTestId(el);
  if (null !== testid && 0 < testid.length) {
    const escaped = testid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `[${getTestIdAttr()}="${escaped}"]`;
  }
  const id = el.getAttribute('id');
  if (null !== id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return `#${id}`;
  return undefined;
}
