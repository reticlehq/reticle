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
