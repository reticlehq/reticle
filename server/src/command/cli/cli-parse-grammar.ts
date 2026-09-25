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
 * Same predicate as `--expect`, read from a file so the shell never has to quote JSON.
 * The reliable form on Windows PowerShell, where `npx.cmd` re-parses arguments and strips
 * inner double quotes from an inline `--expect` value (#1082).
 */
export const EXPECT_FILE_FLAG = '--expect-file';
