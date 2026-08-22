import { describe, expect, it } from 'vitest';
import { htmlManual } from './snippets.js';

/**
 * A connect snippet without the pairing token cannot connect. Ever.
 *
 * `Bridge` closes the socket with AUTH_FAILED whenever it holds a token and the `hello` does not
 * carry a matching one (`bridge.ts`), and the daemon PROVISIONS one on startup unless it cannot
 * write to `$HOME` — so in the ordinary case the token is always set. A snippet that omits it
 * produces "bridge refused the connection: authentication failed" and no session, every time.
 *
 * Every other stack already knew this. Next reads `NEXT_PUBLIC_RETICLE_TOKEN`, SvelteKit and Vite
 * take `__RETICLE_TOKEN__` from the plugin's `define`, Astro reads the token file in its config, and
 * CRA gets a `Pairing token` step writing `.env` — that step is built two branches above this one in
 * the same planner, from the same `input.pairingToken`.
 *
 * The manual path got none of it. `htmlManual` was called with only a port and a projectId, so the
 * snippet it printed was `reticle.connect({ projectId: '...' })` — and that is the snippet handed to
 * plain static HTML, webpack, Parcel and any hand-wired setup, i.e. every stack with no build plugin
 * to inline it for them. Reported from the field, where it cost a long diagnostic session reading
 * bridge-security.ts before the cause was found.
 *
 * Kept as a snippet test for the same reason as `snippets-compile.test.ts`: this string is never
 * parsed, linted or run inside this repo. It is only ever executed on a stranger's machine.
 */
describe('the manual connect snippet carries the pairing token', () => {
  it('inlines the token it was given', () => {
    const snippet = htmlManual(4400, 'demo', 'tok_abc123');
    expect(snippet).toContain('tok_abc123');
    // Passed as `token`, the field the bridge reads off `hello` — not as some adjacent name.
    expect(snippet).toMatch(/token:\s*'tok_abc123'/);
  });

  it('keeps the token on the SAME connect call as the projectId', () => {
    // Two connect calls, or a token in prose beside a tokenless call, is the same bug wearing a
    // different shape: what matters is that the call the user pastes carries it.
    const snippet = htmlManual(4400, 'demo', 'tok_abc123');
    const calls = snippet.match(/reticle\.connect\(\{[^)]*\}\)/g) ?? [];
    // The control. If the snippet's formatting drifts past what this regex matches, the loop below
    // runs zero times and the guard passes having checked nothing.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, 'a connect call without the token').toContain('tok_abc123');
    }
  });

  it('says why the token is there, so nobody deletes it as noise', () => {
    const snippet = htmlManual(4400, 'demo', 'tok_abc123');
    expect(snippet.toLowerCase()).toContain('token');
    expect(snippet).toMatch(/refus|reject|authentication/i);
  });

  it('carries the token on the no-build-step path too, which needs it most', () => {
    // The CDN path has no bundler, no `define`, and no `.env` — the literal in the snippet is the
    // only way a token ever reaches that page.
    const snippet = htmlManual(4400, 'demo', 'tok_abc123');
    const cdn = snippet.slice(snippet.indexOf('script type="module"'));
    expect(cdn).toContain('tok_abc123');
  });

  it('degrades honestly when there is no token to inline', () => {
    // An unwritable $HOME means the daemon runs WITHOUT auth and trusts loopback, so a tokenless
    // snippet is correct there. It must not emit `token: ''`, which would fail the comparison
    // against a daemon that does hold one — the failure this test exists to prevent.
    const snippet = htmlManual(4400, 'demo');
    expect(snippet).not.toMatch(/token:\s*''/);
    expect(snippet).not.toMatch(/token:\s*undefined/);
  });
});
