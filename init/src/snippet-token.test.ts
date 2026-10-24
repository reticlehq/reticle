import { describe, expect, it } from 'vitest';
import { htmlManual } from './patch/snippets.js';

/**
 * A connect snippet without the pairing token cannot connect. Ever.
 *
 * `Bridge` closes the socket with AUTH_FAILED whenever it holds a token and the `hello` does not
 * carry a matching one (`bridge.ts`), and the daemon PROVISIONS one on startup unless it cannot
 * write to `$HOME` — so in the ordinary case the token is always set. A snippet that omits it
 * produces "bridge refused the connection: authentication failed" and no session, every time.
 *
 * Every other stack already knew this. Next reads `NEXT_PUBLIC_RETICLE_TOKEN`, SvelteKit and Vite
 * take `__RETICLE_TOKEN__` from the plugin's `define`, Astro reads the token file in frontmatter, and
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
describe('the manual connect snippet reads the pairing token from a local module', () => {
  it('never prints the token itself', () => {
    // A token in printed output stays in terminal history and agent transcripts.
    expect(htmlManual(4400, 'demo', 'tok_abc123')).not.toContain('tok_abc123');
  });

  it('keeps the token on the SAME connect call as the projectId', () => {
    // Two connect calls, or a token in prose beside a tokenless call, is the same bug wearing a
    // different shape: what matters is that the call the user pastes carries it.
    const snippet = htmlManual(4400, 'demo', 'tok_abc123');
    const calls = snippet.match(/reticle\.connect\(\{[^)]*\}\)/g) ?? [];
    // Change how the snippet spells the call and this matches nothing, passing green
    // without having looked at a single connect call.
    expect(calls.length, 'no connect call found in the snippet').toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, 'a connect call without the token').toContain('token: local.token');
      expect(call).toContain("projectId: 'demo'");
    }
  });

  it('imports the gitignored module on both forms', () => {
    const snippet = htmlManual(4400, 'demo', 'tok_abc123');
    expect(snippet.match(/import\('\.\/reticle\.local\.js'\)/g)?.length).toBe(2);
  });

  it('says why the token is there, so nobody deletes it as noise', () => {
    const snippet = htmlManual(4400, 'demo', 'tok_abc123');
    expect(snippet).toContain('reticle.local.js');
    expect(snippet).toMatch(/refus|reject|authentication/i);
  });

  it('degrades honestly when there is no token', () => {
    // An unwritable $HOME means the daemon runs WITHOUT auth and trusts loopback, so a tokenless
    // snippet is correct there, and there is no module to import.
    const snippet = htmlManual(4400, 'demo');
    expect(snippet).not.toContain('reticle.local.js');
    expect(snippet).not.toMatch(/token:\s*''/);
  });
});
