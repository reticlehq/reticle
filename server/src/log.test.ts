import { describe, expect, it, vi, afterEach } from 'vitest';
import { log } from './log.js';

/**
 * Every log line carries a timestamp.
 *
 * Reported from a real disconnect investigation: `~/.reticle/daemon-4400.log` had grown to 24MB of
 * events and NOT ONE of them could be placed on a wall clock. The reporter could see
 * `mcp_client_disconnected` as the last line before the process vanished, and had no way to say
 * whether it happened at the moment the tools died or four minutes earlier. Their words: this is
 * "the single highest-value fix here — it's why the above is 'points at' instead of 'is'."
 *
 * A log you cannot correlate with anything is a log that can only ever support a guess.
 */
describe('log — a line nobody can place in time is a line nobody can use', () => {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });

  afterEach(() => {
    written.length = 0;
  });

  it('stamps an ISO-8601 timestamp on every line', () => {
    log('something_happened', { detail: 1 });
    const parsed = JSON.parse(written[0] ?? '{}') as { t?: string };
    expect(parsed.t, 'every line needs a wall clock').toBeDefined();
    expect(new Date(parsed.t ?? '').toString()).not.toBe('Invalid Date');
  });

  it('keeps the event and its fields, so nothing that exists today is displaced', () => {
    log('daemon_started', { port: 4400 });
    const parsed = JSON.parse(written[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['event']).toBe('daemon_started');
    expect(parsed['port']).toBe(4400);
  });

  it('puts the timestamp FIRST, so a 24MB log can be scanned and bisected by eye', () => {
    log('ordering_matters');
    expect(written[0]?.startsWith('{"t":')).toBe(true);
    spy.mockRestore();
  });
});
