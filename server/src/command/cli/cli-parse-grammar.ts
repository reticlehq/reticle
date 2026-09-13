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
