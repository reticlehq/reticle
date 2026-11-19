import { DEFAULT_TESTID_ATTR, TESTID_ATTR_PATTERN } from '@reticlehq/core/page';

/**
 * The attribute this page's test ids live in. Module state because it is configuration, set once by
 * `connect()` before any observer or query runs, and read from a dozen places that have no options
 * object to thread it through.
 */
let testIdAttr: string = DEFAULT_TESTID_ATTR;

export function getTestIdAttr(): string {
  return testIdAttr;
}

/** `[attr]`, for a selector or a closest(). */
export function testIdSelector(): string {
  return `[${testIdAttr}]`;
}

/** The test id on `el`, or null. */
export function readTestId(el: Element): string | null {
  return el.getAttribute(testIdAttr);
}

/**
 * Name the attribute. A value that is not a plain attribute name is ignored rather than thrown on —
 * it ends up in a selector, and a bad one must not take a page's connect() down.
 */
export function setTestIdAttr(name: string | undefined): void {
  testIdAttr = undefined !== name && TESTID_ATTR_PATTERN.test(name) ? name : DEFAULT_TESTID_ATTR;
}
