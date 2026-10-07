/**
 * The test run never writes the developer's real home.
 *
 * Incident: the impact tests flushed the machine-wide record into the real `~/.reticle/impact.json`
 * with a frozen clock, adding a 1970-01-01 day on every run. The machine streak read "1 day" for
 * anyone who ran the suite, and daemon-booting tests added tens of thousands of sessions and verdicts
 * to their totals. About twenty-five server modules resolve paths from `homedir()`, so the fix is the
 * test environment's HOME, not each test remembering to pass a temp root.
 */
import { describe, expect, it } from 'vitest';
import { homedir, userInfo } from 'node:os';

describe('the server test environment', () => {
  it('runs with a temporary home, never the real one', () => {
    expect(homedir()).not.toBe(userInfo().homedir);
  });
});
