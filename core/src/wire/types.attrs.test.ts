/**
 * `attrs` PROJECTS attribute values, it never filters on them.
 *
 * Field report (#1057): on an element rendering `data-status="running"`, all three of
 * `attrs:["data-status=running"]`, `["data-status=complete"]` and `["data-status=bogusvalue"]`
 * returned `verified:"yes"` at presence grade — the reporter asserted a pipeline stage had reached
 * `complete` and got a pass while it was still running. `projectAttrs` calls
 * `getAttribute("data-status=complete")`, which is null for every element alive, so the whole string
 * dropped out and the verdict rested on the locator alone.
 */
import { describe, it, expect } from 'vitest';
import { ElementQuerySchema } from './types.js';

describe('ElementQuery.attrs', () => {
  it('refuses a `name=value` string rather than ignoring the value half', () => {
    const parsed = ElementQuerySchema.safeParse({
      testid: 'job',
      attrs: ['data-status=bogusvalue'],
    });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? '' : JSON.stringify(parsed.error.issues);
    expect(message).toContain('data-status=bogusvalue');
    expect(message).toContain('attribute NAMES');
  });

  it('keeps a bare attribute name — the supported spelling — working', () => {
    expect(ElementQuerySchema.safeParse({ testid: 'job', attrs: ['data-status'] }).success).toBe(
      true,
    );
  });
});
