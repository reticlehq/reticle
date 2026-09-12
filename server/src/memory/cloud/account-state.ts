/**
 * Is this machine signed in to a Reticle workspace?
 *
 * Asked by the HUD, and there are two sources that must not be reimplemented per caller: the session
 * file `reticle login` writes to `~/.reticle/session.json`, and `RETICLE_CLOUD_KEY` for an agent that
 * was handed a key instead. Everything that gates on login — the defect sync button, the prompt to sign
 * in — resolves through here.
 *
 * Node-only by design: it reads the filesystem and the environment, so it lives in the server and
 * only the SHAPE (`AccountState`) is in core, where the contract belongs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir, type AccountState } from '@reticlehq/core';
import { CloudEnv } from './cloud-sync.js';
import { SESSION_FILE } from '../../command/cli/cloud-kit.js';

/** Signed OUT is the safe answer: it shows the way in, where a wrong "signed in" hides it. */
const SIGNED_OUT: AccountState = { signedIn: false };

/**
 * The fields we read off the session file, and nothing else.
 *
 * Narrowed by hand rather than parsed with the login schema on purpose: this function must be unable
 * to carry a token even if the file grows one, and the surest way to guarantee that is never to bind
 * it to a name here.
 */
function fromSessionFile(home: string): AccountState | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(home, ReticleDir.ROOT, SESSION_FILE), 'utf8'),
    );
    if ('object' !== typeof raw || null === raw) return undefined;
    const record = raw as Record<string, unknown>;
    // A half-written or hand-edited file must not read as authenticated. `signedIn: true` is the
    // claim that costs something when wrong, because it hides the way in.
    if ('string' !== typeof record['token'] || 0 === record['token'].length) return undefined;
    const org = record['orgName'];
    const host = record['url'];
    return {
      signedIn: true,
      ...('string' === typeof org && org.length > 0 ? { org } : {}),
      ...('string' === typeof host && host.length > 0 ? { host } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Read the account state for this machine.
 *
 * The env key WINS over the session file: an agent handed a key is authenticating as that key,
 * whatever a human left on disk, and reporting the human's org there would be a lie about who is
 * acting.
 */
export function readAccountState(home: string, env: NodeJS.ProcessEnv): AccountState {
  const key = env[CloudEnv.KEY];
  const url = env[CloudEnv.URL];
  if ('string' === typeof key && key.length > 0) {
    return {
      signedIn: true,
      ...('string' === typeof url && url.length > 0 ? { host: url.replace(/\/+$/, '') } : {}),
    };
  }
  return fromSessionFile(home) ?? SIGNED_OUT;
}
