import { join } from 'node:path';

/**
 * Where the web pass leaves its answers for the desktop pass.
 *
 * One `gate:conformance` is two `node` invocations chained with `&&`, so the two surfaces can only
 * agree through a file. That file used to be `join(tmpdir(), 'reticle-conformance-web.json')` — a
 * fixed, guessable name in a world-writable directory, which CodeQL flags as insecure temporary
 * file creation and which on a shared machine another user can pre-create or point elsewhere.
 *
 * It lives in the checkout instead. Nothing about the handoff needed the OS temp dir: it is a
 * message between two processes that both already run from here, and a directory inside the repo
 * is not writable by anybody who could not already edit the code being tested. Gitignored, because
 * the comment at the write site is still true — it is a handoff, not an artifact anybody keeps.
 */
export const WEB_HANDOFF = join(import.meta.dirname, '.handoff', 'web.json');
