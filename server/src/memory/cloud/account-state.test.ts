/**
 * "Is this machine signed in?" — asked once, answered in one place.
 *
 * The HUD has no notion of auth at all today: `dashboardUrl` is read off disk and only decides
 * whether a "more" link renders. Everything that gates on login — the defect sync button, the
 * prompt to sign in — needs a real answer, and the answer has two sources that must not be
 * reimplemented per caller: the `reticle login` session file, and `RETICLE_CLOUD_KEY` for agents.
 *
 * The security rule is the reason this is a type and not an ad-hoc read: this state is pushed to a
 * BROWSER. A token that reaches the page is a token in the DOM of the user's own app, readable by
 * anything else on it. Nothing here may carry one, and that is pinned below rather than trusted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAccountState } from './account-state.js';

const homes: string[] = [];
function tempHome(session?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-home-'));
  homes.push(dir);
  if (session !== undefined) {
    mkdirSync(join(dir, '.reticle'), { recursive: true });
    writeFileSync(join(dir, '.reticle', 'session.json'), JSON.stringify(session), 'utf8');
  }
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = {
  url: 'https://app.reticle.sh',
  token: 'super-secret-token-value',
  orgName: 'Acme',
};

describe('reading the account state', () => {
  it('is signed out when there is no session and no key', () => {
    expect(readAccountState(tempHome(), {})).toEqual({ signedIn: false });
  });

  it('is signed in from the session file `reticle login` writes', () => {
    const state = readAccountState(tempHome(SESSION), {});
    expect(state.signedIn).toBe(true);
    expect(state.org).toBe('Acme');
    expect(state.host).toBe('https://app.reticle.sh');
  });

  it('is signed in from RETICLE_CLOUD_KEY, which is how an agent authenticates', () => {
    const state = readAccountState(tempHome(), {
      RETICLE_CLOUD_KEY: 'k-123',
      RETICLE_CLOUD_URL: 'https://reticle.internal',
    });
    expect(state.signedIn).toBe(true);
    expect(state.host, 'a self-hosted install is not app.reticle.sh').toBe(
      'https://reticle.internal',
    );
  });

  it('NEVER carries the token, however it was found', () => {
    // This object is pushed to the page. A token in the DOM of the user's own app is readable by
    // anything else running there.
    const fromFile = JSON.stringify(readAccountState(tempHome(SESSION), {}));
    const fromEnv = JSON.stringify(
      readAccountState(tempHome(), { RETICLE_CLOUD_KEY: 'k-123', RETICLE_CLOUD_URL: 'https://x' }),
    );
    expect(fromFile).not.toContain('super-secret-token-value');
    expect(fromFile).not.toMatch(/token/i);
    expect(fromEnv).not.toContain('k-123');
    expect(fromEnv).not.toMatch(/token|apiKey/i);
  });

  it('treats a session file with no token as signed OUT', () => {
    // A half-written or hand-edited file must not read as authenticated. Signed-in is the claim that
    // costs something when wrong: it hides the way in.
    expect(
      readAccountState(tempHome({ url: 'https://app.reticle.sh', orgName: 'Acme' }), {}),
    ).toEqual({ signedIn: false });
  });

  it('survives a corrupt session file rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-home-'));
    homes.push(dir);
    mkdirSync(join(dir, '.reticle'), { recursive: true });
    writeFileSync(join(dir, '.reticle', 'session.json'), '{ not json', 'utf8');
    expect(readAccountState(dir, {})).toEqual({ signedIn: false });
  });

  it('prefers the explicit env key over a stale session file', () => {
    // An agent that was handed a key is authenticating as that key, whatever a human left on disk.
    const state = readAccountState(tempHome(SESSION), {
      RETICLE_CLOUD_KEY: 'k-123',
      RETICLE_CLOUD_URL: 'https://reticle.internal',
    });
    expect(state.host).toBe('https://reticle.internal');
  });
});
