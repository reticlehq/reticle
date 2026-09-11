import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The e2e retry must WAIT for the ports it just killed, not assume they are free.
 *
 * Observed on main (run 31480427989): attempt 1 crashed, cleanup ran, and attempt 2 failed six
 * seconds later with
 *
 *   Error: listen EADDRINUSE: address already in use :::3100
 *
 * The cleanup is not missing 3100 — it kills it explicitly. The problem is that `kill -9` does not
 * wait: the process is signalled, the socket is still closing, and the next attempt binds into it.
 * So the retry, which exists so a transient flake does not red CI, could not succeed — the same
 * failure it was added to absorb.
 *
 * This is the identical defect fixed one layer down in `mcp-stress-test.mjs` (#238): a flat sleep or
 * a bare kill standing in for "the port is free". A retry that cannot succeed is worse than no
 * retry, because it turns one red into two and hides the cause behind a second, different error.
 *
 * Asserted on the workflow text because CI is the one place where a rule left to prose is never
 * re-read until it is already costing someone a build.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CI = readFileSync(
  join(HERE, '..', '..', '..', '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);

/**
 * The e2e job's retry block, bounded at BOTH ends.
 *
 * My first version sliced to end-of-file and passed immediately — it was matching `while`/`until`
 * from later jobs. A guard that reads past its subject is not guarding it.
 */
const RETRY_BLOCK = CI.slice(
  CI.indexOf('for attempt in 1 2; do'),
  CI.indexOf('e2e battery failed after 2 attempts'),
);

describe('the e2e retry frees its ports before retrying', () => {
  it('still kills the app servers it started', () => {
    // Guards the guard: if the cleanup disappears, the wait below is meaningless.
    for (const port of ['8787', '4310', '3100']) expect(RETRY_BLOCK).toContain(port);
  });

  it('waits for the ports to actually close, rather than assuming kill -9 is synchronous', () => {
    expect(RETRY_BLOCK, 'a flat `sleep N` is a guess about how fast a socket closes').not.toMatch(
      /^\s*sleep \d+\s*$/m,
    );
    expect(RETRY_BLOCK, 'it must poll for the ports to be free').toMatch(/until|while/);
    expect(RETRY_BLOCK, 'the wait must be bounded, or a stuck port hangs the job').toMatch(
      /-lt|-le|-gt|-ge/,
    );
  });
});
