import { useState } from 'react';

/**
 * The 401 → refresh → retry-once path, which is the dominant auth pattern on the web.
 *
 * It is here because it made Reticle produce two FALSE contradictions on an assertion that had
 * PASSED. A field reporter's `reticle_assert` returned `pass: true`, and Reticle overrode it to
 * `verified: "no", verifiedReason: "contradicted"` with:
 *
 *   - `ui-advanced-request-failed`: "POST /api/v0/studies/<id>/command -> 401"
 *   - `duplicate-request`: "the same write fired 2 times"
 *
 * Both described the app working correctly. `reticle_network` showed the exact shape: one 401 in
 * 51ms with a 35-byte body, immediately followed by one 200 in 2278ms carrying the real result.
 * Nothing fired twice in effect — the first attempt was rejected before doing any work — and the UI
 * advancing was right, not contradictory.
 *
 * Why that mattered more than a missed bug, in the reporter's words: it taught them, inside one
 * session, that a `contradicted` verdict may be noise worth arguing with. That is precisely the
 * reflex this product exists to suppress, so a false red here costs more than a false green
 * elsewhere.
 *
 * The fixture keeps the honest shape rather than simulating it: a real 401 on the wire, a real
 * refresh, and a real retry that succeeds — all from one click.
 */
const API = 'http://localhost:8787';

export function ExpiringAuth(): React.ReactElement {
  const [token, setToken] = useState('reticle-demo-token');
  const [result, setResult] = useState('');
  const [attempts, setAttempts] = useState(0);

  const write = async (): Promise<void> => {
    setResult('');
    const key = `k${String(Date.now())}`;
    const url = `${API}/api/expiring-write?expireFirst=1&key=${key}`;
    const send = (bearer: string): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ key }),
      });

    let res = await send(token);
    let tries = 1;
    if (401 === res.status) {
      // Re-hydrate and retry ONCE. Not a loop: a second 401 is a real failure and must surface.
      const refreshed = (await (
        await fetch(`${API}/api/auth/refresh`, { method: 'POST' })
      ).json()) as {
        token?: string;
      };
      if ('string' === typeof refreshed.token) {
        setToken(refreshed.token);
        res = await send(refreshed.token);
        tries = 2;
      }
    }
    setAttempts(tries);
    setResult(res.ok ? 'saved' : `failed ${String(res.status)}`);
  };

  return (
    <div className="view">
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3 data-testid="expiring-auth-heading">Expiring token</h3>
        <button data-testid="expiring-auth-write" onClick={() => void write()}>
          Save with an expired token
        </button>
        <output data-testid="expiring-auth-result">{result}</output>
        <output data-testid="expiring-auth-attempts">{attempts}</output>
      </div>
    </div>
  );
}
