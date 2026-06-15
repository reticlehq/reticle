import { describe, expect, it } from 'vitest';
import { CLI_USAGE, parseCliArgs } from './cli.js';

const PORT = 7333;
const URL = 'http://localhost:3000';

describe('parseCliArgs', () => {
  it('no args defaults to serve on the default port', () => {
    expect(parseCliArgs([], PORT)).toEqual({ kind: 'serve', port: PORT, headless: true });
  });

  it('serve with no flags uses the default port', () => {
    expect(parseCliArgs(['serve'], PORT)).toEqual({ kind: 'serve', port: PORT, headless: true });
  });

  it('serve --port overrides the port', () => {
    expect(parseCliArgs(['serve', '--port', '5000'], PORT)).toEqual({
      kind: 'serve',
      port: 5000,
      headless: true,
    });
  });

  it('serve --drive sets driveUrl', () => {
    expect(parseCliArgs(['serve', '--drive', URL], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      driveUrl: URL,
      headless: true,
    });
  });

  it('serve --drive --headed sets headless false', () => {
    expect(parseCliArgs(['serve', '--drive', URL, '--headed'], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      driveUrl: URL,
      headless: false,
    });
  });

  it('stop returns stop result with quiet false', () => {
    expect(parseCliArgs(['stop'], PORT)).toEqual({ kind: 'stop', port: PORT, quiet: false });
  });

  it('stop --port overrides the port', () => {
    expect(parseCliArgs(['stop', '--port', '5000'], PORT)).toEqual({
      kind: 'stop',
      port: 5000,
      quiet: false,
    });
  });

  it('stop --quiet sets quiet true', () => {
    expect(parseCliArgs(['stop', '--quiet'], PORT)).toEqual({
      kind: 'stop',
      port: PORT,
      quiet: true,
    });
  });

  it('status returns status result', () => {
    expect(parseCliArgs(['status'], PORT)).toEqual({ kind: 'status', port: PORT });
  });

  it('status --port overrides the port', () => {
    expect(parseCliArgs(['status', '--port', '5000'], PORT)).toEqual({
      kind: 'status',
      port: 5000,
    });
  });

  it('drive <url> returns legacy drive result (headless)', () => {
    expect(parseCliArgs(['drive', URL], PORT)).toEqual({
      kind: 'drive',
      port: PORT,
      driveUrl: URL,
      headless: true,
    });
  });

  it('drive <url> --headed sets headless false', () => {
    expect(parseCliArgs(['drive', URL, '--headed'], PORT)).toEqual({
      kind: 'drive',
      port: PORT,
      driveUrl: URL,
      headless: false,
    });
  });

  it('drive --headed <url> (flag before url) sets headless false', () => {
    expect(parseCliArgs(['drive', '--headed', URL], PORT)).toEqual({
      kind: 'drive',
      port: PORT,
      driveUrl: URL,
      headless: false,
    });
  });

  it('drive without a url is a usage error', () => {
    expect(parseCliArgs(['drive'], PORT)).toEqual({ kind: 'error', message: CLI_USAGE });
  });

  it('drive with an unknown flag is a usage error', () => {
    expect(parseCliArgs(['drive', URL, '--nope'], PORT)).toEqual({
      kind: 'error',
      message: CLI_USAGE,
    });
  });

  it('_daemon returns _daemon result', () => {
    expect(parseCliArgs(['_daemon', '--port', '5000'], PORT)).toEqual({
      kind: '_daemon',
      port: 5000,
      headless: true,
    });
  });

  it('_daemon --drive sets driveUrl', () => {
    expect(parseCliArgs(['_daemon', '--drive', URL], PORT)).toEqual({
      kind: '_daemon',
      port: PORT,
      driveUrl: URL,
      headless: true,
    });
  });

  it('mcp returns mcp result on default port', () => {
    expect(parseCliArgs(['mcp'], PORT)).toEqual({ kind: 'mcp', port: PORT, headless: true });
  });

  it('mcp --port overrides the port', () => {
    expect(parseCliArgs(['mcp', '--port', '5000'], PORT)).toEqual({
      kind: 'mcp',
      port: 5000,
      headless: true,
    });
  });

  it('mcp --drive passes the drive url', () => {
    expect(parseCliArgs(['mcp', '--drive', 'http://localhost:3000'], PORT)).toEqual({
      kind: 'mcp',
      port: PORT,
      driveUrl: 'http://localhost:3000',
      headless: true,
    });
  });

  it('mcp --drive --headed passes both flags', () => {
    expect(parseCliArgs(['mcp', '--drive', 'http://localhost:3000', '--headed'], PORT)).toEqual({
      kind: 'mcp',
      port: PORT,
      driveUrl: 'http://localhost:3000',
      headless: false,
    });
  });

  it('unknown command is a usage error', () => {
    expect(parseCliArgs(['nope'], PORT)).toEqual({ kind: 'error', message: CLI_USAGE });
  });
});
