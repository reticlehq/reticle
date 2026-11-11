import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli-parse.js';
import { parseCompareArgs } from './cli-parse-compare.js';

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

  it('takes --state, the file of state sources to read after each sequence', () => {
    expect(parseCompareArgs(['http://a/', 'http://b/', '--state', 's.json'], PORT)).toMatchObject({
      kind: 'ok',
      state: 's.json',
    });
    expect(parseCompareArgs(['http://a/', 'http://b/', '--state'], PORT).kind).toBe('error');
    expect(
      parseCliArgs(['compare', 'http://a/', 'http://b/', '--state', 's.json'], PORT),
    ).toMatchObject({
      kind: 'compare',
      state: 's.json',
    });
  });

  it('refuses a missing url, a third url, an unknown flag and a flag with no value', () => {
    expect(parseCompareArgs(['http://a/'], PORT).kind).toBe('error');
    expect(parseCompareArgs(['http://a/', 'http://b/', 'http://c/'], PORT).kind).toBe('error');
    expect(parseCompareArgs(['http://a/', 'http://b/', '--deep'], PORT).kind).toBe('error');
    expect(parseCompareArgs(['http://a/', 'http://b/', '--base'], PORT).kind).toBe('error');
    expect(parseCompareArgs(['http://a/', 'http://b/', '--port', 'x'], PORT).kind).toBe('error');
  });

  it('takes --report and the file to write the HTML report to', () => {
    expect(
      parseCompareArgs(['http://a/', 'http://b/', '--report', 'out/report.html'], PORT),
    ).toEqual({
      kind: 'ok',
      reference: 'http://a/',
      candidate: 'http://b/',
      report: 'out/report.html',
      json: false,
      port: PORT,
    });
  });

  it('refuses --report with no file', () => {
    expect(parseCompareArgs(['http://a/', 'http://b/', '--report'], PORT).kind).not.toBe('ok');
  });
});
