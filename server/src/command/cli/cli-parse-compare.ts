/**
 * `reticle compare <reference-url> <candidate-url> [--base <url>] [--state <file>] [--json] [--report <file>]`. The
 * command has one recipe. `--state` names the app's stored data to read, and `--port` names the
 * daemon, as on every command that uses one.
 *
 * Split out of `cli-parse.ts` when that file came near the 1000-line cap.
 */
import {
  JSON_FLAG,
  PORT_FLAG,
  missingOperand,
  missingValue,
  notANumber,
  unknownArgument,
  type ParseError,
} from './cli-parse-grammar.js';

export const COMPARE_COMMAND = 'compare';
/** `compare --base <url>`: the build before the change. */
const BASE_FLAG = '--base';
/** `compare --state <file.json>`: the declared state sources to read after each sequence. */
const STATE_FLAG = '--state';
/** `compare --report <file>`: also write the result as one HTML page. */
const REPORT_FLAG = '--report';
/** `compare` takes exactly a reference url and a candidate url. */
const COMPARE_URLS = 2;

export type CompareArgs =
  | {
      kind: 'ok';
      reference: string;
      candidate: string;
      base?: string;
      /** The path of the state sources file. */
      state?: string;
      /** Where to write the HTML report. */
      report?: string;
      json: boolean;
      port: number;
    }
  | ParseError;

export function parseCompareArgs(args: readonly string[], defaultPort: number): CompareArgs {
  const urls: string[] = [];
  let base: string | undefined;
  let state: string | undefined;
  let report: string | undefined;
  let json = false;
  let port = defaultPort;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (JSON_FLAG === arg) {
      json = true;
      continue;
    }
    if (BASE_FLAG === arg || STATE_FLAG === arg || REPORT_FLAG === arg || PORT_FLAG === arg) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return missingValue(arg);
      }
      i += 1;
      if (BASE_FLAG === arg) {
        base = value;
        continue;
      }
      if (STATE_FLAG === arg) {
        state = value;
        continue;
      }
      if (REPORT_FLAG === arg) {
        report = value;
        continue;
      }
      const n = Number(value);
      if (!Number.isInteger(n)) {
        return notANumber(arg, value);
      }
      port = n;
      continue;
    }
    if (arg.startsWith('--') || COMPARE_URLS === urls.length) {
      return unknownArgument(arg);
    }
    urls.push(arg);
  }
  const [reference, candidate] = urls;
  if (reference === undefined || candidate === undefined) {
    return missingOperand(COMPARE_COMMAND, 'a reference url and a candidate url');
  }
  return {
    kind: 'ok',
    reference,
    candidate,
    ...(base === undefined ? {} : { base }),
    ...(state === undefined ? {} : { state }),
    ...(report === undefined ? {} : { report }),
    json,
    port,
  };
}
