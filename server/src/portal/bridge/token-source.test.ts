/**
 * Where did each side's pairing token come from?
 *
 * Reported repeatedly (#685): several IDEs register the MCP server GLOBALLY, the daemon starts with
 * a cwd of `/` or `$HOME`, and the app's dial is refused with `authentication_failed` while
 * `doctor`, run from the app directory, reports the project correctly wired. The report's own
 * diagnosis was that the daemon could not find `.reticle.json` in its cwd — and that cannot be it.
 * The daemon's token is `options.token`, then RETICLE_TOKEN, then `~/.reticle/pairing-token`; the
 * Vite plugin reads the same `~/.reticle` path. Neither consults the project config, so a daemon's
 * cwd cannot change the value it compares.
 *
 * What CAN differ is the environment the two processes were started in — an IDE spawning a global
 * MCP server does not inherit the shell a dev server was launched from. Either override moves one
 * side's token and not the other's, and both are invisible in every surface we print.
 *
 * So the refusal log names the SOURCE, not the secret. A reporter pasting that line then shows which
 * of the two mechanisms they hit, instead of us guessing from a symptom that has no other witness.
 */
import { describe, expect, it } from 'vitest';
import { PAIRING_TOKEN_DIR_ENV, pairingTokenSource } from './pairing-token.js';
import { resolveBridgeSecurity } from './bridge-security.js';

const NO_ENV = {} as NodeJS.ProcessEnv;

describe('the daemon can say where its token came from', () => {
  it('names an explicitly-passed token, which no environment explains', () => {
    expect(pairingTokenSource({ explicit: true, env: NO_ENV })).toBe('explicit');
  });

  it('names RETICLE_TOKEN, which one process can have and its sibling not', () => {
    expect(pairingTokenSource({ explicit: false, env: { RETICLE_TOKEN: 'abc' } })).toBe(
      'env:RETICLE_TOKEN',
    );
  });

  it(`names ${PAIRING_TOKEN_DIR_ENV}, the override that moves the FILE rather than the value`, () => {
    const env = { [PAIRING_TOKEN_DIR_ENV]: '/somewhere/else' } as NodeJS.ProcessEnv;
    expect(pairingTokenSource({ explicit: false, env })).toBe(`env:${PAIRING_TOKEN_DIR_ENV}`);
  });

  it('reports the default when nothing overrides it — the case that needs no explanation', () => {
    expect(pairingTokenSource({ explicit: false, env: NO_ENV })).toBe('default');
  });

  it('prefers the explicit token over any environment, matching resolution order', () => {
    const env = { RETICLE_TOKEN: 'abc', [PAIRING_TOKEN_DIR_ENV]: '/x' } as NodeJS.ProcessEnv;
    expect(
      pairingTokenSource({ explicit: true, env }),
      'the bridge takes options.token first, so reporting an env source there would be a lie',
    ).toBe('explicit');
  });

  it('prefers RETICLE_TOKEN over the dir override, which it makes irrelevant', () => {
    const env = { RETICLE_TOKEN: 'abc', [PAIRING_TOKEN_DIR_ENV]: '/x' } as NodeJS.ProcessEnv;
    expect(
      pairingTokenSource({ explicit: false, env }),
      'with RETICLE_TOKEN set the file is never read, so naming the dir would misdirect',
    ).toBe('env:RETICLE_TOKEN');
  });

  it('treats an empty variable as unset, the way the resolver does', () => {
    expect(pairingTokenSource({ explicit: false, env: { RETICLE_TOKEN: '' } })).toBe('default');
  });
});

/**
 * The wiring, not just the function.
 *
 * The first version of this fix computed the source inside the Bridge, where it is WRONG: an
 * auto-provisioned token and one a caller passed both arrive as `options.token`, so every daemon
 * would have reported `explicit` and the log line would have described nothing while looking
 * informative. Resolution order is only visible in the resolver, so the answer is decided there.
 */
describe('the resolver reports the source, and reports it correctly', () => {
  it('says default for the ordinary daemon — no caller token, no env', () => {
    const before = { ...process.env };
    delete process.env.RETICLE_TOKEN;
    delete process.env[PAIRING_TOKEN_DIR_ENV];
    try {
      expect(
        resolveBridgeSecurity({}).tokenSource,
        'the common case must not read as "explicit" — that was the bug in the first attempt',
      ).toBe('default');
    } finally {
      process.env = before;
    }
  });

  it('says explicit only when a caller really passed one', () => {
    expect(resolveBridgeSecurity({ token: 'abc' }).tokenSource).toBe('explicit');
  });
});
