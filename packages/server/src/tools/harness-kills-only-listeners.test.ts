/**
 * No script in this repository may kill every holder of a port.
 *
 * `lsof -ti tcp:PORT` returns CLIENTS as well as the listener, so the recipe everyone reaches for —
 *
 *   lsof -ti tcp:4400 | xargs kill -9
 *
 * — kills the daemon AND every `reticle mcp` proxy attached to it. Measured on this machine:
 * listener and proxy pids both returned, the kill took the proxy with it, and every subsequent tool
 * call hung unanswered with nothing in the proxy log, because the process that writes that log was
 * the one that died. An agent in that state is not degraded, it is gone, and nothing says so.
 *
 * `-sTCP:LISTEN` restricts it to the process actually serving the port, which is the only one a
 * harness has any business killing.
 *
 * This guard exists because the rule was already written down. `apps/e2e/harness-rules.md` names
 * the unsafe form, `gate-harness.mjs` implements the safe one and explains why in a doc comment,
 * and `run-ci.sh` used the unsafe form anyway for months. A convention documented in one file and
 * violated in another is not a convention, it is a comment. This is the same rule with teeth.
 *
 * Reported from the field as a daemon that died on nearly every MCP connect: `status` from the
 * shell showing a healthy session, the next call over MCP returning `sse_aborted`, and a new pid
 * afterwards each time.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../../../..');

/** Where a harness could plausibly free a port. Not the whole tree: node_modules is not ours. */
const SEARCH_DIRS = ['apps/e2e', 'scripts', 'bench'];
const EXTENSIONS = ['.sh', '.mjs', '.js', '.ts'];

/**
 * `lsof` invocations that enumerate a TCP port WITHOUT restricting to listeners.
 *
 * Matches the spellings that actually appear in the wild — `-ti tcp:PORT`, `-ti "tcp:$port"` and
 * `-iTCP:PORT ... -t` — and then requires `-sTCP:LISTEN` somewhere in the same command. The quote
 * is not optional in practice: a shell script interpolating a variable writes `"tcp:$port"`, and the
 * first version of this guard missed exactly that, so it passed against the regression it was
 * written for. Verified by reintroducing the unsafe line and watching it go red.
 */
const LSOF_CALL = /lsof[^\n;]*?-[a-zA-Z]*i[a-zA-Z]*\s*["']?(?:tcp|TCP):[^\n;]*/g;

function filesUnder(dir: string): string[] {
  const root = join(REPO, dir);
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if ('node_modules' !== entry.name && !entry.name.startsWith('.')) walk(full);
      } else if (EXTENSIONS.some((e) => entry.name.endsWith(e))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe('a harness kills only the process serving a port', () => {
  it('finds the scripts to check, so a passing result means something', () => {
    const files = SEARCH_DIRS.flatMap(filesUnder);
    expect(files.length).toBeGreaterThan(5);
    // The file this guard was written for must be in scope, or the guard is checking thin air.
    expect(files.some((f) => f.endsWith('run-ci.sh'))).toBe(true);
  });

  it('no script enumerates a TCP port without restricting to LISTEN', () => {
    const offenders: string[] = [];
    for (const file of SEARCH_DIRS.flatMap(filesUnder)) {
      // Line by line, because the check that matters is about the LINE the call sits on. Matching
      // across the whole file and then asking whether the MATCH looks like prose does not work: a
      // match starts at `lsof`, so it never begins with a comment marker, and three doc comments
      // that quote the unsafe form precisely in order to warn about it were reported as offenders.
      // Those comments are the rule being taught; flagging them would delete the explanation.
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (/^\s*(?:\/\/|\*|#)/.test(line)) continue;
        // The dangerous idiom is specifically "enumerate the port, pipe it into a kill". Requiring
        // the kill on the same line is what keeps two legitimate neighbours out of the report: the
        // deliberate list-every-holder query that `portHolders` uses to NAME survivors without
        // touching them, and an error string that spells the safe recipe out across concatenated
        // lines. Both were flagged by a broader rule, and both are code we want to keep exactly.
        if (!/\||xargs|kill/.test(line)) continue;
        for (const call of line.match(LSOF_CALL) ?? []) {
          if (!call.includes('-sTCP:LISTEN')) {
            offenders.push(`${file.slice(REPO.length + 1)}: ${call.trim().slice(0, 90)}`);
          }
        }
      }
    }
    expect(
      offenders,
      'these kill every holder of the port, including any MCP proxy attached to it — add -sTCP:LISTEN',
    ).toEqual([]);
  });
});
