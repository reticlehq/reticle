import { describe, expect, it } from 'vitest';
import { isCloudCommand } from './cloud-cli.js';
import { LOCAL_COMMANDS, knownCommand, parseCliArgs, UNKNOWN_COMMAND } from './cli-parse.js';
import { CLOUD_COMMANDS } from './cli-parse-grammar.js';

/**
 * Telemetry names the command that ran from a closed vocabulary, and that vocabulary used to be a
 * hand-written list beside the parser. `reticle sync` was parsed, dispatched and run, and reported
 * as `unknown`, because nobody added it to the second list. The vocabulary is now the parser's own
 * lists, so a command cannot be accepted without also being named.
 */
const PORT = 4400;
const isUnknownCommandError = (argv: string[]): boolean => {
  const parsed = parseCliArgs(argv, PORT);
  return 'error' === parsed.kind && parsed.message.startsWith('unknown command');
};

describe('every command the CLI accepts reports its own name', () => {
  it('each local command is parsed, and reported by name', () => {
    for (const cmd of LOCAL_COMMANDS) {
      expect(isUnknownCommandError([cmd]), cmd).toBe(false);
      expect(knownCommand(cmd), cmd).toBe(cmd);
    }
  });

  it('each cloud command is dispatched, and reported by name', () => {
    for (const cmd of CLOUD_COMMANDS) {
      expect(isCloudCommand(cmd), cmd).toBe(true);
      expect(knownCommand(cmd), cmd).toBe(cmd);
    }
  });

  it('sync and try, the two that slipped, are named', () => {
    expect(knownCommand('sync')).toBe('sync');
    expect(knownCommand('try')).toBe('try');
  });

  it('the flag spellings report the command they mean', () => {
    expect(knownCommand('--version')).toBe('version');
    expect(knownCommand('-v')).toBe('version');
    expect(knownCommand('--help')).toBe('help');
    expect(knownCommand('-h')).toBe('help');
  });

  it('a word the parser does not accept is neither run nor echoed', () => {
    expect(isUnknownCommandError(['statsu'])).toBe(true);
    expect(knownCommand('statsu')).toBe(UNKNOWN_COMMAND);
    expect(knownCommand('/Users/ada/app')).toBe(UNKNOWN_COMMAND);
  });
});
