import { describe, expect, it } from 'vitest';
import { CLI_USAGE, parseCliArgs } from './cli.js';
import { summarizeStatus } from './cli-launch.js';

const PORT = 7333;
const URL = 'http://localhost:3000';

describe('summarizeStatus', () => {
  it('reduces the /status payload to a compact per-session health view', () => {
    const out = summarizeStatus({
      running: true,
      sessionCount: 2,
      sessions: [
        { sessionId: 'a', url: 'http://localhost:5173/app', throttled: false, pendingMarks: 2 },
        { sessionId: 'b', url: 'http://localhost:5173/x', throttled: true, stale: true },
      ],
    });
    expect(out.sessionCount).toBe(2);
    expect(out.sessions).toEqual([
      {
        sessionId: 'a',
        url: 'http://localhost:5173/app',
        throttled: false,
        stale: false,
        pendingMarks: 2,
      },
      {
        sessionId: 'b',
        url: 'http://localhost:5173/x',
        throttled: true,
        stale: true,
        pendingMarks: 0,
      },
    ]);
  });

  it('degrades a missing/partial body to running with zero sessions (never throws)', () => {
    expect(summarizeStatus(undefined)).toEqual({ sessionCount: 0, sessions: [] });
    expect(summarizeStatus({ running: true })).toEqual({ sessionCount: 0, sessions: [] });
    expect(summarizeStatus({ sessions: 'nope' })).toEqual({ sessionCount: 0, sessions: [] });
  });

  it('drops malformed session entries but keeps the well-formed ones', () => {
    const out = summarizeStatus({
      sessions: [null, 42, { url: 'no id' }, { sessionId: 'ok', url: 'u' }],
    });
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]?.sessionId).toBe('ok');
    expect(out.sessionCount).toBe(1);
  });
});

describe('parseCliArgs', () => {
  it('no args defaults to serve on the default port', () => {
    expect(parseCliArgs([], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      headless: true,
      http: false,
    });
  });

  it('serve with no flags uses the default port', () => {
    expect(parseCliArgs(['serve'], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      headless: true,
      http: false,
    });
  });

  it('serve --port overrides the port', () => {
    expect(parseCliArgs(['serve', '--port', '5000'], PORT)).toEqual({
      kind: 'serve',
      port: 5000,
      headless: true,
      http: false,
    });
  });

  it('serve --drive sets driveUrl', () => {
    expect(parseCliArgs(['serve', '--drive', URL], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      driveUrl: URL,
      headless: true,
      http: false,
    });
  });

  it('serve --drive --headed sets headless false', () => {
    expect(parseCliArgs(['serve', '--drive', URL, '--headed'], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      driveUrl: URL,
      headless: false,
      http: false,
    });
  });

  it('init with no flags defaults to mcp + install on, no dry run, no port', () => {
    expect(parseCliArgs(['init'], PORT)).toEqual({
      kind: 'init',
      port: undefined,
      mcp: true,
      dryRun: false,
      install: true,
    });
  });

  it('init --dry-run --no-mcp --no-install --port sets each flag', () => {
    expect(
      parseCliArgs(['init', '--dry-run', '--no-mcp', '--no-install', '--port', '4500'], PORT),
    ).toEqual({
      kind: 'init',
      port: 4500,
      mcp: false,
      dryRun: true,
      install: false,
    });
  });

  it('init --yes is accepted', () => {
    expect(parseCliArgs(['init', '--yes'], PORT)).toEqual({
      kind: 'init',
      port: undefined,
      mcp: true,
      dryRun: false,
      install: true,
    });
  });

  it('init rejects unknown flags', () => {
    expect(parseCliArgs(['init', '--bogus'], PORT)).toEqual({
      kind: 'error',
      message: CLI_USAGE,
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

  it('open with no url → reuse-a-connected-tab intent (no url field)', () => {
    expect(parseCliArgs(['open'], PORT)).toEqual({ kind: 'open', port: PORT });
  });

  it('open <url> carries the url', () => {
    expect(parseCliArgs(['open', URL], PORT)).toEqual({ kind: 'open', port: PORT, url: URL });
  });

  it('open <url> --port overrides the port', () => {
    expect(parseCliArgs(['open', URL, '--port', '5000'], PORT)).toEqual({
      kind: 'open',
      port: 5000,
      url: URL,
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
      http: false,
    });
  });

  it('_daemon --drive sets driveUrl', () => {
    expect(parseCliArgs(['_daemon', '--drive', URL], PORT)).toEqual({
      kind: '_daemon',
      port: PORT,
      driveUrl: URL,
      headless: true,
      http: false,
    });
  });

  it('serve --http with port + token parses the verify-endpoint flags', () => {
    expect(
      parseCliArgs(['serve', '--http', '--http-port', '7331', '--http-token', 'sek'], PORT),
    ).toEqual({
      kind: 'serve',
      port: PORT,
      headless: true,
      http: true,
      httpPort: 7331,
      httpToken: 'sek',
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
