import { describe, expect, it } from 'vitest';
import { EventType } from './constants/constants.js';
import { EVENT_PAYLOAD_SCHEMAS } from './event-payloads.js';

/**
 * The page tells us which shell it is running in, and the wire never said so.
 *
 * `PAGE_HEALTH` carries `runtime` (web / electron / tauri) and `engine` (the rendering engine). The
 * SDK has always sent them and the server has always read them, but the schema declared neither, so
 * they travelled through `.passthrough()`.
 *
 * Two costs, and the second is the one that matters for v3:
 *
 *  1. The server re-checked the value by hand, because nothing upstream had.
 *  2. **They do not appear in the generated `dist/schema/*.json`.** Anyone implementing this
 *     contract from the published schemas -- which is exactly what a third-party realm would do --
 *     cannot see that the field exists, let alone that the server depends on it.
 *
 * Declared as a plain string on purpose, NOT as a closed list of the three shells we ship today.
 * A future realm has to be able to name itself without every older server rejecting the whole event,
 * and a `nativeEnum` here would do precisely that: one unknown value and the entire health report
 * fails to parse, taking visibility, focus and the heartbeat down with it.
 *
 * So the wire says "this field exists and is a string"; deciding which values mean something stays
 * with the reader, where it already is.
 */
describe('PAGE_HEALTH declares the shell the page is running in', () => {
  const schema = EVENT_PAYLOAD_SCHEMAS[EventType.PAGE_HEALTH];

  it('DECLARES runtime and engine, so they reach the generated schema', () => {
    // The assertion that matters, and the one a looser test misses: `.passthrough()` means a field
    // can be accepted without being DECLARED, so parsing it proves nothing about whether anyone
    // implementing from `dist/schema/*.json` can see it. Verified before this change: `runtime` and
    // `engine` appeared in none of the four generated schema files.
    const declared = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);
    expect(declared).toContain('runtime');
    expect(declared).toContain('engine');
  });

  it('accepts what the SDK actually sends', () => {
    const parsed = schema.parse({
      hidden: false,
      focused: true,
      runtime: 'web',
      engine: 'blink',
      reason: 'heartbeat',
    });
    expect(parsed).toMatchObject({ runtime: 'web', engine: 'blink' });
  });

  it('keeps the fields typed rather than dropping them', () => {
    const parsed = schema.parse({ hidden: false, focused: true, runtime: 'electron' }) as {
      runtime?: string;
    };
    expect(parsed.runtime).toBe('electron');
  });

  it('still accepts a report from an older SDK that sends neither', () => {
    expect(() => schema.parse({ hidden: true, focused: false })).not.toThrow();
  });

  it('accepts a shell this version has never heard of', () => {
    // The forward-compatibility case, and the reason this is not an enum. A realm that does not
    // exist yet must not be able to break the heartbeat of a server that predates it.
    const parsed = schema.parse({
      hidden: false,
      focused: true,
      runtime: 'a-realm-from-the-future',
    }) as { runtime?: string };
    expect(parsed.runtime).toBe('a-realm-from-the-future');
  });
});
