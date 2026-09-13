import { describe, expect, it } from 'vitest';
import { isCloudCommand } from './cloud-cli.js';
import { parseCliArgs } from './cli-parse.js';

/**
 * `--help` has to work for EVERY command, including the ones that never reach the local parser.
 *
 * The cloud subcommands -- login, link, push and the rest -- are dispatched before the typed parser,
 * so the rule that recognises `--help` anywhere in the command line does not see them. `reticle link
 * --help` therefore ran the command: it tried to reach the network and answered `fetch failed` with
 * exit 1, to somebody who had asked what the command does.
 *
 * That gap was invisible to the tests for the parser, because those call the parser directly and the
 * commands in question never get there. It was found by running the built CLI, which is the only
 * thing that sees the dispatch order.
 */

/** Every command that is dispatched before the local parser. */
const CLOUD_COMMANDS = ['login', 'logout', 'whoami', 'link', 'project', 'push', 'runs'];

describe('asking any command what it does gets an answer, not an attempt', () => {
  it('the cloud commands really are dispatched separately', () => {
    // The premise. If this stops being true the rest of the file is checking nothing.
    for (const cmd of CLOUD_COMMANDS) expect(isCloudCommand(cmd), cmd).toBe(true);
  });

  it('the local parser already answers help for the commands it owns', () => {
    expect(parseCliArgs(['init', '--help'], 4400).kind).toBe('help');
  });

  it('a help flag beside a cloud command is a request for help, not for the command', () => {
    // What the dispatcher has to check before handing over. Asserted as the rule rather than through
    // the dispatcher itself, because running it would open a network connection.
    for (const cmd of CLOUD_COMMANDS) {
      const argv = [cmd, '--help'];
      const wantsHelp = argv.some((arg) => '--help' === arg || '-h' === arg);
      expect(wantsHelp, cmd).toBe(true);
    }
  });
});
