/**
 * `reticle open` rejects flags it cannot honour (#1684).
 *
 * Before this fix, `open` silently ignored every flag it did not read, so
 * `open <url> --storage-state auth.json` opened a signed-out page and reported
 * success. Now `open` returns an error for every unrecognised flag, and names
 * the command the caller most likely wanted when the flag belongs to another
 * command.
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli-parse.js';

describe('reticle open flag validation', () => {
  it('rejects --storage-state and names the commands that accept it', () => {
    const result = parseCliArgs(
      ['open', 'http://localhost:3000', '--storage-state', 'auth.json'],
      4400,
    );
    expect(result.kind).toBe('error');
    expect('message' in result && result.message).toMatch(/--storage-state/);
    expect('message' in result && result.message).toMatch(/verify/);
  });

  it('rejects --headed and names the alternative', () => {
    const result = parseCliArgs(['open', 'http://localhost:3000', '--headed'], 4400);
    expect(result.kind).toBe('error');
    expect('message' in result && result.message).toMatch(/--headed/);
    expect('message' in result && result.message).toMatch(/verify/);
  });

  it('rejects an arbitrary unknown flag', () => {
    const result = parseCliArgs(['open', 'http://localhost:3000', '--unknown-flag'], 4400);
    expect(result.kind).toBe('error');
    expect('message' in result && result.message).toMatch(/--unknown-flag/);
  });

  it('still parses valid open args without error', () => {
    expect(
      parseCliArgs(['open', 'http://localhost:3000', '--navigate', '--port', '4401'], 4400),
    ).toMatchObject({ kind: 'open', url: 'http://localhost:3000', navigate: true, port: 4401 });

    expect(parseCliArgs(['open'], 4400)).toMatchObject({ kind: 'open', navigate: false });
  });
});
