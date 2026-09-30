import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli-parse.js';

const PORT = 4400;

/**
 * `--accept-coverage` is how a developer says a coverage drop was intended. Parsed as a file, it
 * would silently become a changed path and the gate would answer a different question.
 */
describe('reticle gate --accept-coverage', () => {
  it('is a flag, not a changed file', () => {
    expect(parseCliArgs(['gate', '--accept-coverage'], PORT)).toEqual({
      kind: 'gate',
      files: [],
      since: 'HEAD',
      acceptCoverage: true,
    });
  });

  it('is absent unless asked for', () => {
    expect(parseCliArgs(['gate', '--since', 'main'], PORT)).toEqual({
      kind: 'gate',
      files: [],
      since: 'main',
    });
  });
});
