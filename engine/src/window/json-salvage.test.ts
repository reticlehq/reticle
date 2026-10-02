import { describe, expect, it } from 'vitest';
import { salvageJson } from './json-salvage.js';

/**
 * Response bodies are capped at 8192 bytes. Treating what the cap produces as "no body" made every
 * body-based check silent on the page with the most data on it — a 10,000-row console whose list
 * response is 19,932 bytes.
 */
describe('reading a truncated payload', () => {
  it('parses a whole body normally and reports it complete', () => {
    const result = salvageJson('{"rows":[{"id":"a"}]}');
    expect(result.partial).toBe(false);
    expect(result.values).toEqual([{ rows: [{ id: 'a' }] }]);
  });

  it('recovers the records that closed before the cut', () => {
    const cut = '{"rows":[{"id":"a","amount":1},{"id":"b","amount":2},{"id":"c","amo';
    const result = salvageJson(cut);
    expect(result.partial).toBe(true);
    expect(result.values).toEqual([
      { id: 'a', amount: 1 },
      { id: 'b', amount: 2 },
    ]);
  });

  it('keeps records, not their nested children', () => {
    // Legs carry their own id and status; returning them would pollute a status comparison with
    // values that were never meant to be rendered as rows.
    const cut = '{"rows":[{"id":"a","legs":[{"id":"l1","status":"pending"}]},{"id":"b","le';
    expect(salvageJson(cut).values).toEqual([{ id: 'a', legs: [{ id: 'l1', status: 'pending' }] }]);
  });

  it('is not fooled by braces inside strings', () => {
    const cut = '{"rows":[{"id":"a","note":"} not a brace {"},{"id":"b","no';
    expect(salvageJson(cut).values).toEqual([{ id: 'a', note: '} not a brace {' }]);
  });

  it('handles an escaped quote before a brace', () => {
    const cut = '{"rows":[{"id":"a","note":"say \\"hi\\" }"},{"id":"b';
    expect(salvageJson(cut).values).toEqual([{ id: 'a', note: 'say "hi" }' }]);
  });

  it('returns nothing when not one record survived', () => {
    const result = salvageJson('{"rows":[{"id":"a","amo');
    expect(result.partial).toBe(true);
    expect(result.values).toEqual([]);
  });

  it('returns nothing for a body that is not JSON at all', () => {
    expect(salvageJson('<html>oops</html>').values).toEqual([]);
  });
});
