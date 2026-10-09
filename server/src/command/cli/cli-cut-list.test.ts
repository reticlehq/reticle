import { describe, expect, it } from 'vitest';
import { knownCommand, LOCAL_COMMANDS, parseCliArgs } from './cli-parse.js';
import {
  CLOUD_COMMANDS,
  REMOVED_COMMANDS,
  RENAMED_COMMANDS,
  renamedNote,
} from './cli-parse-grammar.js';
import { CLI_USAGE, CLI_USAGE_ALL, DOCUMENTED_COMMANDS, renderHelp } from './cli-usage.js';
import { statusLines } from './status/status-lines.js';

/**
 * The command surface: a short help page, old names that still run, removed names that say so.
 */
const PORT = 4400;
const SHORT_HELP = [
  'init',
  'connect',
  'try',
  'verify',
  'gate',
  'status',
  'doctor',
  'open',
  'stop',
  'restart',
  'update',
  'logout',
  'feedback',
  'telemetry',
];
const HIDDEN = ['mcp', 'serve', 'drive', 'affected', 'setup', 'config', 'license', 'rollback'];
const commandLines = (page: string): string[] =>
  page
    .split('\n')
    .filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.trim().split(/\s+/)[0] ?? '');

describe('reticle --help', () => {
  it('lists exactly the everyday commands, one line each', () => {
    expect(commandLines(CLI_USAGE).sort()).toEqual([...SHORT_HELP].sort());
  });

  it('is short', () => {
    expect(CLI_USAGE.split('\n').length).toBeLessThanOrEqual(30);
  });

  it('help all adds the hidden commands', () => {
    const all = commandLines(CLI_USAGE_ALL);
    for (const cmd of [...SHORT_HELP, ...HIDDEN, 'report', 'sync', 'runs']) {
      expect(all, cmd).toContain(cmd);
    }
  });

  it('every documented command is one the CLI runs', () => {
    const runnable = new Set([...LOCAL_COMMANDS, ...CLOUD_COMMANDS]);
    for (const cmd of DOCUMENTED_COMMANDS) expect(runnable.has(cmd), cmd).toBe(true);
  });

  it('no removed or renamed name is advertised', () => {
    for (const cmd of [...REMOVED_COMMANDS.keys(), ...RENAMED_COMMANDS.keys()]) {
      expect(commandLines(CLI_USAGE_ALL), cmd).not.toContain(cmd);
    }
  });

  it('parses help topics', () => {
    expect(parseCliArgs(['--help'], PORT)).toEqual({ kind: 'help' });
    expect(parseCliArgs(['help'], PORT)).toEqual({ kind: 'help' });
    expect(parseCliArgs(['help', 'all'], PORT)).toEqual({ kind: 'help', topic: 'all' });
    expect(parseCliArgs(['--help', 'all'], PORT)).toEqual({ kind: 'help', topic: 'all' });
    expect(parseCliArgs(['help', 'init'], PORT)).toEqual({ kind: 'help', topic: 'init' });
    expect(parseCliArgs(['init', '--help'], PORT)).toEqual({ kind: 'help', topic: 'init' });
  });

  it('a command page carries the detail the short page dropped', () => {
    expect(renderHelp('init')).toContain('--files-only');
    expect(renderHelp('verify')).toContain('http-transport');
    expect(renderHelp(undefined)).toBe(CLI_USAGE);
    expect(renderHelp('all')).toBe(CLI_USAGE_ALL);
  });

  it('an old name answers with the new page and says so', () => {
    const page = renderHelp('link', RENAMED_COMMANDS);
    expect(page).toContain('usage:  reticle connect');
    expect(page).toContain('`reticle link` is now `reticle connect`');
  });
});

describe('renamed commands still run', () => {
  it('stop --force is what kill was', () => {
    expect(parseCliArgs(['stop', '--force'], PORT)).toEqual({
      kind: 'kill',
      port: PORT,
      force: false,
    });
    expect(parseCliArgs(['kill'], PORT)).toEqual({ kind: 'kill', port: PORT, force: false });
  });

  it('each old name is still dispatched', () => {
    const runnable = new Set([...LOCAL_COMMANDS, ...CLOUD_COMMANDS]);
    for (const cmd of RENAMED_COMMANDS.keys()) expect(runnable.has(cmd), cmd).toBe(true);
  });

  it('the note is one plain line, dimmed only when asked', () => {
    expect(renamedNote('push', 'sync', false)).toBe('`reticle push` is now `reticle sync`');
    expect(renamedNote('push', 'sync', true)).toContain('\u001b[2m');
  });
});

describe('removed commands say so and fail', () => {
  it.each([...REMOVED_COMMANDS.keys()])('%s', (cmd) => {
    for (const argv of [[cmd], [cmd, '--help']]) {
      const parsed = parseCliArgs(argv, PORT);
      expect(parsed.kind).toBe('removed');
      expect('removed' === parsed.kind && parsed.message).toContain('was removed in this version');
    }
    // Still named in telemetry, so the people typing it are visible.
    expect(knownCommand(cmd)).toBe(cmd);
  });
});

describe('status says who is signed in', () => {
  it('names the account and the linked project', () => {
    const out = statusLines({ running: false, signedInAs: 'Acme', linkedProject: 'shop' }).join(
      '\n',
    );
    expect(out).toContain('signed in as Acme');
    expect(out).toContain('shop');
  });

  it('points a signed-out reader at connect', () => {
    const out = statusLines({ running: false, signedInAs: null, linkedProject: null }).join('\n');
    expect(out).toContain('reticle connect');
  });
});
