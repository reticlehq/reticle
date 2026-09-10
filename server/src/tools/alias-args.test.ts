/**
 * The same concept, spelled differently on neighbouring tools.
 *
 * Two more of these, both found by driving the surface as a naive caller:
 *
 *   reticle_act_and_wait { until }      vs  reticle_wait_for / reticle_assert { predicate }
 *   reticle_annotate     { flow }       vs  reticle_flow_save / _replay / _flow { flowName }
 *
 * Both cross a path the product itself prescribes. `act_and_wait` is the tool agents use most, so
 * `until` is the spelling they learn — and carrying it to `wait_for` earns "Unknown parameter for
 * reticle_wait_for: until", which is what happened on my first sweep. And `reticle_flow_save`'s own
 * description instructs the agent to call `reticle_annotate`, which is the one flow tool that does
 * not say `flowName`.
 *
 * It matters because of where these land: of the 25 sessions that called any tool in a day, 13 made
 * exactly ONE call and stopped. A rejected call early is a session that never comes back.
 */

import { describe, expect, it } from 'vitest';
import { aliasParam } from './alias-args.js';

describe('aliasParam', () => {
  it('fills the canonical name from an alias', () => {
    expect(aliasParam({ until: { kind: 'settled' } }, 'predicate', ['until'])).toMatchObject({
      predicate: { kind: 'settled' },
    });
  });

  it('leaves an explicit canonical value alone — the contract always wins', () => {
    const out = aliasParam(
      { predicate: { kind: 'net' }, until: { kind: 'settled' } },
      'predicate',
      ['until'],
    );
    expect(out['predicate']).toMatchObject({ kind: 'net' });
  });

  it('does nothing when neither is present, so the schema error still explains itself', () => {
    const out = aliasParam({ timeout_ms: 10 }, 'predicate', ['until']);
    expect(out['predicate']).toBeUndefined();
    expect(out['timeout_ms']).toBe(10);
  });

  it('tries aliases in order', () => {
    expect(aliasParam({ b: 2 }, 'x', ['a', 'b'])).toMatchObject({ x: 2 });
    expect(aliasParam({ a: 1, b: 2 }, 'x', ['a', 'b'])).toMatchObject({ x: 1 });
  });

  it('carries every other parameter through untouched', () => {
    const out = aliasParam(
      { until: { kind: 'settled' }, timeout_ms: 5, sessionId: 's' },
      'predicate',
      ['until'],
    );
    expect(out).toMatchObject({ timeout_ms: 5, sessionId: 's' });
  });

  it('treats an explicitly undefined canonical as absent', () => {
    expect(
      aliasParam({ predicate: undefined, until: { kind: 'settled' } }, 'predicate', ['until']),
    ).toMatchObject({
      predicate: { kind: 'settled' },
    });
  });
});
