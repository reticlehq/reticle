/**
 * `doctor` is what we tell people to run when the agent cannot reach the bridge, and it was the one
 * place that could see version skew and did not look.
 *
 * It already stopped lying about the port — `probePresence` distinguishes "a daemon is here", "a
 * stranger holds it" and "nothing is listening", which was the load-bearing half of #105. What it
 * still did not do is say WHICH daemon: the `/status` payload it already fetches carries `version`
 * and `contract`, and doctor discarded both.
 *
 * That matters because skew is invisible by design at the other end. Per #127, a CLI and a daemon on
 * different versions connect anyway and then disagree about behaviour, which surfaces to the agent
 * as "a bare -32000 with nothing naming a version". Doctor is the command a human runs precisely
 * when that is happening.
 */

import { describe, expect, it } from 'vitest';
import { daemonLine } from './doctor-daemon-line.js';

const SELF = { version: '2.6.0', contract: 'abc123' };

describe('the daemon line names which daemon, not just that there is one', () => {
  it('reports the running version', () => {
    const out = daemonLine(4400, 90210, { version: '2.6.0', contract: 'abc123' }, SELF);
    expect(out.text).toContain('4400');
    expect(out.text).toContain('90210');
    expect(out.text, 'the version is in the payload doctor already fetches').toContain('2.6.0');
    expect(out.skew).toBeUndefined();
  });

  it('flags a daemon on a different contract as skew', () => {
    const out = daemonLine(4400, 1, { version: '2.5.0', contract: 'oldfp' }, SELF);
    expect(
      out.skew,
      'a contract mismatch is exactly the -32000-with-no-version case',
    ).toBeDefined();
    expect(String(out.skew)).toContain('2.5.0');
  });

  it('still reports cleanly when the daemon is too old to state a version', () => {
    const out = daemonLine(4400, 1, {}, SELF);
    expect(out.text).toContain('4400');
    expect(out.text, 'an unknown version must not print as "undefined"').not.toContain('undefined');
  });

  it('omits the pid rather than printing null when there is no pid file', () => {
    const out = daemonLine(4400, null, { version: '2.6.0', contract: 'abc123' }, SELF);
    expect(out.text).not.toContain('null');
    expect(out.text).toContain('4400');
  });
});

/**
 * A remedy that names a command we do not ship is worse than no remedy.
 *
 * I shipped one. The skew line told the reader to run `reticle kill`, which does not exist — the
 * verbs are affected, capsules, doctor, drive, error, feedback, gate, help, hunt, identify, init,
 * license, mcp, open, rollback, serve, status, stop, telemetry, update, verify, version, watch.
 * `reticle kill` is a PROPOSAL (#114), correctly described as a gap in `docs/system-map.md`, and I
 * read it there as if it were real.
 *
 * This is the same defect class the rest of this file exists to prevent, committed by the file
 * itself: `doctor` is the command a human runs when they are already confused, and handing them a
 * command that errors is a second dead end on top of the first.
 *
 * Asserted against the CLI's own verb list rather than a hardcoded string, so a remedy naming a
 * command that is later renamed or removed fails here.
 */
describe('every command the daemon line suggests actually exists', () => {
  /** The verbs `cli.ts` dispatches on. Kept literal: importing the CLI would boot it. */
  const VERBS = new Set([
    'affected',
    'capsules',
    'doctor',
    'drive',
    'error',
    'feedback',
    'gate',
    'help',
    'hunt',
    'identify',
    'init',
    'license',
    'mcp',
    'open',
    'rollback',
    'serve',
    'status',
    'stop',
    'telemetry',
    'update',
    'verify',
    'version',
    'watch',
  ]);

  it('the skew remedy names a real verb', () => {
    const out = daemonLine(4400, 1, { version: '2.5.0', contract: 'oldfp' }, SELF);
    const suggested = [...String(out.skew).matchAll(/`reticle ([a-z-]+)/g)].map((m) => m[1] ?? '');
    expect(suggested.length, 'the remedy suggests no command at all').toBeGreaterThan(0);
    for (const verb of suggested) {
      expect(VERBS.has(verb), `\`reticle ${verb}\` is not a command this CLI dispatches`).toBe(
        true,
      );
    }
  });
});
