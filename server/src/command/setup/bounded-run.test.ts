import { describe, expect, it } from 'vitest';
import { run } from './node-effects.js';

// `init` on a Windows install cell printed "starting: npm run dev" and then nothing for 9.5 minutes,
// until the gate killed it at 600s (upstream run 38129228877, next-app-router). Every wait in the
// dev-server loop is bounded except the process listing it calls on each poll: wmic, PowerShell and
// netstat through spawnSync with no timeout. One stalled WMI query froze the event loop.
describe('run', () => {
  it('returns what the command printed', () => {
    expect(run(process.execPath, ['-e', 'process.stdout.write("ok")'])).toBe('ok');
  });

  // Bounded by the test's own timeout, not by a duration assertion: a run that still waits on the
  // child never returns inside it. Half an answer is not an answer, so it is dropped.
  it('gives up on a command that hangs, and returns nothing', { timeout: 20_000 }, () => {
    const hangs = 'process.stdout.write("partial"); setTimeout(() => {}, 60_000)';
    expect(run(process.execPath, ['-e', hangs], 300)).toBe('');
  });
});
