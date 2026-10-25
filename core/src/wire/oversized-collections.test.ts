import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { HelloMessageSchema } from './messages.js';

/**
 * An oversized list is refused before its items are checked.
 *
 * Shipped defect: zod below 4.6.6 checked every item of an array before its `.max()`
 * (GHSA-mrhx-c7xc-m3w5). A frame of 100,000 items against a list capped at 4 ran 100,000 item
 * checks and could exhaust the bridge's memory. zod 3 has no fixed release, so 3.8.1 moves to zod 4.
 */
describe('an oversized constrained list', () => {
  it('is refused without one item check', () => {
    let checks = 0;
    const capped = z
      .array(
        z.string().refine(() => {
          checks += 1;
          return true;
        }),
      )
      .max(4);

    const result = capped.safeParse(Array.from({ length: 100_000 }, () => 'x'));

    expect(result.success).toBe(false);
    expect(checks).toBe(0);
  });

  it('is refused on a real wire message', () => {
    const hello = {
      kind: 'hello',
      protocolVersion: 1,
      sessionId: 's1',
      url: 'http://localhost/',
      title: 't',
      adapters: Array.from({ length: 100_000 }, () => 'react'),
    };

    expect(HelloMessageSchema.safeParse(hello).success).toBe(false);
  });
});
