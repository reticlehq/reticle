/**
 * A message that names a flag the parser does not have is a dead end with a confident tone.
 *
 * `run-setup` told anyone whose project had no dev script to "pass --dev-cmd or --url". There is no
 * --dev-cmd. `init` rejects it as an unknown argument, so the one instruction given to the person
 * who is already stuck sends them into a second failure — and the flag was named in the agent-facing
 * options doc too, so an agent reading that would reach for it just as confidently.
 *
 * preflight.test.ts already pins this for ONE message ("points at a flag that exists"), which is a
 * check of that message rather than of the rule. This reads the flags out of the setup sources and
 * asks the parser about each, so the next message to invent a flag fails on the day it is written.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SETUP_SOURCES = ['run-setup.ts', 'setup-options.ts', 'init-runtime.ts', 'setup-command.ts'];

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8');

/** Long-form flags as they appear in prose and code, e.g. `--dev-cmd`. */
const flagsIn = (source: string): string[] => [
  ...new Set(source.match(/--[a-z][a-z-]{1,}/g) ?? []),
];

/**
 * Flags that are real but belong to another command's parser or to a tool we only TELL people to
 * run, so `init`'s own flag table is the wrong place to look for them.
 */
const NOT_INIT_FLAGS = new Set([
  '--resume', // the client's own flag, printed for the user to run
  '--self-check',
  '--update-baseline',
]);

describe('every flag a setup message names', () => {
  it('is one the CLI actually accepts', () => {
    const parser = readFileSync(join(__dirname, '..', 'cli', 'cli-parse.ts'), 'utf8');
    const unknown: string[] = [];
    for (const file of SETUP_SOURCES) {
      for (const flag of flagsIn(read(file))) {
        if (NOT_INIT_FLAGS.has(flag)) continue;
        if (!parser.includes(flag)) unknown.push(`${file}: ${flag}`);
      }
    }
    expect(unknown, 'these flags are named to users but do not exist').toEqual([]);
  });
});
