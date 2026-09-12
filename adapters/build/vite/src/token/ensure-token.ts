/**
 * Read the pairing token, or create it — whichever process gets there first.
 *
 * The token is read ONCE, when Vite resolves its config, and inlined as `__RETICLE_TOKEN__`. The
 * daemon is what normally writes it. So a dev server started BEFORE the daemon froze an empty
 * string, every page it served was refused by the bridge, and no session ever appeared — with the
 * SDK loading and the socket opening, so nothing looked broken. Bisected against a real SvelteKit
 * fixture, where it presented as a regression.
 *
 * Restarting the dev server was the only cure, because by the time the daemon minted a token the
 * empty value had already been baked in.
 *
 * The daemon READS-OR-CREATES this file (see the server's `readOrCreatePairingToken`, kept "stable
 * across restarts so a plugin-injected page keeps working after the daemon bounces"), so the plugin
 * doing the same makes the two agree whichever order they start in. Same path, same 0600 mode, same
 * random generation. An existing token is never replaced: overwriting would invalidate every page
 * the daemon has already handed one to.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** Matches the server's token size. */
const TOKEN_BYTES = 32;
const TOKEN_FILE = 'pairing-token';

export function ensurePairingToken(dir: string): string | undefined {
  try {
    const existing = readFileSync(join(dir, TOKEN_FILE), 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* missing or unreadable — fall through and create one */
  }
  try {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, TOKEN_FILE);
    writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
    // writeFile keeps a pre-existing looser mode, so set it explicitly — same as the daemon does.
    chmodSync(path, 0o600);
    return token;
  } catch {
    // A dev server must still start. Degrading to the previous tokenless behaviour is correct.
    return undefined;
  }
}
