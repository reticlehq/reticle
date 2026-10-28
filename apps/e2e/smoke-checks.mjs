import assert from 'node:assert/strict';

export function requireAssertion(result, expected) {
  assert.equal(result.pass, expected, JSON.stringify(result));
  assert.notEqual(result.observationLost, true, JSON.stringify(result));
  assert.ok(!result.inconclusive, JSON.stringify(result));
  requireVerdict(result, expected);
}

export function requireVerdict(result, expected) {
  assert.equal(result.verified, expected ? 'yes' : 'no', JSON.stringify(result));
}

/** Exercise the shipped MCP surface, with an independent oracle in the fixture's HTTP server. */
export async function checkSmoke({ call, refusal, url, writes, check }) {
  const lease = await call('reticle_run', {
    tool: 'reticle_lease',
    args: { action: 'acquire', url },
  });
  assert.equal(lease.ready, true, JSON.stringify(lease));
  assert.equal(typeof lease.sessionId, 'string');
  assert.ok(lease.sessionId.length > 0);
  const sessionId = lease.sessionId;
  check('a real browser connects through the default MCP surface');
  try {
    const snapshot = await call('reticle_look', { action: 'page', mode: 'interactive', sessionId });
    assert.match(JSON.stringify(snapshot), /Increment/);
    check('look sees the fixture controls');

    requireAssertion(
      await call('reticle_assert', {
        sessionId,
        predicate: { kind: 'text', contains: 'Count: 0' },
        timeout_ms: 5000,
      }),
      true,
    );
    check('a true assertion passes');

    requireVerdict(
      await call('reticle_act_and_wait', {
        sessionId,
        action: 'click',
        target: { testid: 'increment' },
        until: {
          kind: 'allOf',
          predicates: [
            { kind: 'net', urlContains: '/increment', method: 'POST', status: 200 },
            { kind: 'text', contains: 'Count: 1' },
          ],
        },
        timeout_ms: 5000,
      }),
      true,
    );
    assert.equal(writes(), 1, 'the fixture must receive exactly one real write');
    check('an action produces a verified DOM and network consequence');

    requireAssertion(
      await call('reticle_assert', {
        sessionId,
        predicate: { kind: 'text', contains: 'Count: 999' },
        timeout_ms: 250,
      }),
      false,
    );
    check('a false assertion is refused');

    requireVerdict(
      await call('reticle_act_and_wait', {
        sessionId,
        action: 'click',
        target: { testid: 'broken' },
        until: { kind: 'text', contains: 'Count: 2' },
        timeout_ms: 500,
      }),
      false,
    );
    assert.equal(writes(), 1, 'the broken control must not perform a write');
    check('a broken action is refused, rather than producing a false green');

    // One letter short of the real name: refused, and the refusal names the button with its ref.
    const { error: missed } = JSON.parse(await refusal('reticle_act_and_wait', {
      sessionId,
      action: 'click',
      target: { role: 'button', name: 'Incremen' },
      until: { kind: 'text', contains: 'Count: 2' },
      timeout_ms: 0,
    }));
    assert.match(missed, /target matched no element/);
    assert.match(missed, /e\d+ \(button "Increment"\)/);
    assert.equal(writes(), 1, 'a missed target must not act');
    check('a missed target is refused and names the nearest targets with refs');
  } finally {
    await call('reticle_run', {
      tool: 'reticle_lease',
      args: { action: 'release', sessionId },
    });
  }
}
