/**
 * The words the CLI grammar is made of, and what it says when it does not understand one.
 *
 * Split out of `cli-parse.ts` when that file crossed the line cap, and shared rather than copied for
 * one reason: a flag name written twice is a flag name that can be renamed once. The error
 * constructors travel with the flags because every one of them prints a flag.
 */

/** A command the grammar rejected, carrying the sentence the user reads. */
export type ParseError = { kind: 'error'; message: string };

export const unknownArgument = (arg: string): ParseError => ({
  kind: 'error',
  message: `unknown argument '${arg}'`,
});
/**
 * A flag that used to exist, answered by name rather than as "unknown argument".
 *
 * Getting started is three stages — installation, onboarding, the first run — and `init` owns the
 * middle one. The flags that configured the drive it used to do are still written down in agent
 * instruction files and in scripts, so the reader who passes one is following what we told them.
 * "unknown argument '--flow'" reads as a typo; naming the stage it moved to is the whole answer.
 */
export const retiredFlag = (flag: string, moved: string): ParseError => ({
  kind: 'error',
  message: `${flag} is no longer an \`init\` flag: ${moved}`,
});
export const missingValue = (flag: string): ParseError => ({
  kind: 'error',
  message: `${flag} needs a value`,
});
export const notANumber = (flag: string, value: string): ParseError => ({
  kind: 'error',
  message: `${flag} expects a number, got '${value}'`,
});
export const missingOperand = (command: string, what: string): ParseError => ({
  kind: 'error',
  message: `${command} needs ${what}`,
});

/** Show the browser. Shared by every command that can drive one. */
export const HEADED_FLAG = '--headed';
export const PORT_FLAG = '--port';
export const VERIFY_COMMAND = 'verify';
/**
 * The predicate flag, shared for the same reason the rest of this file is: two places have to name
 * it. The grammar reads it, and `verify` itself has to say IN PROSE which flag it could not honour
 * when the port is not serving a daemon — a refusal that never names the flag is how this one was
 * missed for a release.
 */
export const EXPECT_FLAG = '--expect';

/**
 * The account and cloud commands. They are dispatched before the typed parser, and listed here so
 * that the dispatcher and the telemetry vocabulary read one list instead of two.
 */
export const CLOUD_COMMANDS: readonly string[] = [
  'login',
  'connect',
  'try',
  'logout',
  'whoami',
  'link',
  'project',
  'config',
  'issues',
  'memory',
  'push',
  'sync',
  'runs',
  'regression',
  'share',
];

/**
 * Old command names that still run, for one release, under the name that replaced them. Each one
 * prints a single line saying so, then does what it always did.
 */
export const RENAMED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['kill', 'stop --force'],
  ['login', 'connect'],
  ['link', 'connect'],
  ['project', 'connect --project <name|id>'],
  ['whoami', 'status'],
  ['push', 'sync'],
  ['regression', 'runs regression'],
  ['share', 'runs share <runId>'],
  ['issues', 'runs issues'],
  ['memory', 'runs memory'],
]);

/**
 * Commands that were removed, and what to use instead. They stay in the telemetry vocabulary, so
 * the people still typing one show up as that name rather than as `unknown`.
 */
export const REMOVED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['hunt', 'it has no replacement'],
  ['watch', 'use `reticle affected` after you save, or `reticle gate` before you commit'],
  ['capsules', 'it has no replacement; saved capsules stay in .reticle/capsules'],
  ['tutorial', "use `reticle init` in your app's folder, or `reticle try <url>`"],
  [
    'identify',
    'it has no replacement; delete ~/.reticle/identity.json to forget a saved identity, and use `reticle feedback` to reach us',
  ],
]);

export const removedNote = (command: string, instead: string): string =>
  `\`reticle ${command}\` was removed in this version; ${instead}`;

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
/** One line on stderr when an old name ran: dim on a terminal, plain anywhere else. */
export const renamedNote = (command: string, now: string, colour: boolean): string => {
  const line = `\`reticle ${command}\` is now \`reticle ${now}\``;
  return colour ? `${DIM}${line}${RESET}` : line;
};
