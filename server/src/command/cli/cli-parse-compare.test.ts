import { describe, expect, it } from 'vitest';
import { parseCompareArgs } from './cli-parse.js';

const PORT = 4400;
const TEST_PORT = 14400;

describe('parseCompareArgs', () => {
  it('takes the reference url, then the candidate url', () => {
    expect(parseCompareArgs(['http://a/', 'http://b/'], PORT)).toEqual({
      kind: 'ok',
      reference: 'http://a/',
      candidate: 'http://b/',
      json: false,
      port: PORT,
    });
  });

  it('takes --base, --json and the daemon port', () => {
    expect(
      parseCompareArgs(
        ['http://a/', '--base', 'http://c/', 'http://b/', '--json', '--port', String(TEST_PORT)],
        PORT,
      ),
    ).toEqual({
      kind: 'ok',
      reference: 'http://a/',
      candidate: 'http://b/',
      base: 'http://c/',
      json: true,
      port: TEST_PORT,
    });
  });

  it('refuses a missing url, a third url, an unknown flag and a flag with no value', () => {
    expect(parseCompareArgs(['http://a/'], PORT).kind).toBe('error');
    expect(parseCompareArgs(['http://a/', 'http://b/', 'http://c/'], PORT).kind).toBe('error');
    expect(parseCompareArgs(['http://a/', 'http://b/', '--deep'], PORT).kind).toBe('error');
    expect(parseCompareArgs(['http://a/', 'http://b/', '--base'], PORT).kind).toBe('error');
    expect(parseCompareArgs(['http://a/', 'http://b/', '--port', 'x'], PORT).kind).toBe('error');
  });
});
