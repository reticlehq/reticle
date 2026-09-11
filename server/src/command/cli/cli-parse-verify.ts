/**
 * The `reticle verify` grammar.
 *
 * Split out of `cli-parse.ts` when that file crossed the line cap. Cohesive on its own terms: this is
 * the one command that takes a preview URL, a browser, a timeout, a saved storage state, a session to
 * pin, a predicate to assert AND a persona to drive as — so it carries more grammar than the rest of
 * the CLI put together.
 */
import {
  HEADED_FLAG,
  PORT_FLAG,
  VERIFY_COMMAND,
  missingOperand,
  missingValue,
  notANumber,
  unknownArgument,
} from './cli-parse-grammar.js';

const TIMEOUT_FLAG = '--timeout';
const STORAGE_STATE_FLAG = '--storage-state';
const EXPECT_FLAG = '--expect';
const SESSION_ID_FLAG = '--session-id';
/** Let Reticle drive the app itself and record what it drove, when nothing is saved yet. */
const EXPLORE_FLAG = '--explore';
/** Who to be while exploring — a persona, or the business outcome to reach. Implies --explore. */
const PERSONA_FLAG = '--persona';
/** Narrow the suite to flows carrying this label. Repeatable — a set is the union of what you name. */
const SELECT_FLAG = '--select';

export type VerifySuffix =
  | {
      kind: 'ok';
      url: string;
      headless: boolean;
      port: number;
      timeoutMs?: number;
      storageState?: string;
      sessionId?: string;
      expect?: unknown;
      explore?: boolean;
      persona?: string;
      select?: string[];
    }
  | { kind: 'error'; message: string };

/**
 * Parse `verify <url> [--port N] [--headed] [--timeout N] [--storage-state <file>]
 * [--session-id <id>]`. The first non-flag token is the preview URL. `defaultPort` is already
 * env + `.reticle.json` + 4400.
 */
export function parseVerifySuffix(args: string[], defaultPort: number): VerifySuffix {
  let headless = true;
  let url: string | undefined;
  let timeoutMs: number | undefined;
  let storageState: string | undefined;
  let sessionId: string | undefined;
  let expect: unknown;
  let explore = false;
  let persona: string | undefined;
  const select: string[] = [];
  let port = defaultPort;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === HEADED_FLAG) {
      headless = false;
    } else if (arg === PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(PORT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(PORT_FLAG, n);
      port = parsed;
    } else if (arg === TIMEOUT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(TIMEOUT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(TIMEOUT_FLAG, n);
      timeoutMs = parsed;
    } else if (arg === STORAGE_STATE_FLAG) {
      i++;
      const v = args[i];
      if (v === undefined) return missingValue(STORAGE_STATE_FLAG);
      storageState = v;
    } else if (arg === SESSION_ID_FLAG) {
      i++;
      const v = args[i];
      if (v === undefined) return missingValue(SESSION_ID_FLAG);
      sessionId = v;
    } else if (arg === SELECT_FLAG) {
      i++;
      const v = args[i];
      if (v === undefined) return missingValue(SELECT_FLAG);
      // Repeatable rather than comma-split: a label is free-form, and a comma inside one would
      // silently become two selections that match nothing.
      select.push(v);
    } else if (arg === EXPLORE_FLAG) {
      explore = true;
    } else if (arg === PERSONA_FLAG) {
      i++;
      const v = args[i];
      if (v === undefined) return missingValue(PERSONA_FLAG);
      // A persona is what to explore AS, so naming one is asking for the drive. Requiring both
      // flags would only give a user a way to say something they cannot mean.
      persona = v;
      explore = true;
    } else if (arg === EXPECT_FLAG) {
      i++;
      const v = args[i];
      if (v === undefined) return missingValue(EXPECT_FLAG);
      try {
        expect = JSON.parse(v);
      } catch {
        // Named as a JSON problem rather than an unknown argument: the value IS the predicate, and
        // "unknown argument" would send the reader looking at the flag instead of at their quoting.
        return {
          kind: 'error',
          message: `${EXPECT_FLAG} needs a JSON predicate; could not parse: ${v}`,
        };
      }
    } else if (arg.startsWith('--')) {
      return unknownArgument(arg);
    } else if (url === undefined) {
      url = arg;
    } else {
      return unknownArgument(arg);
    }
    i++;
  }
  if (url === undefined) return missingOperand(VERIFY_COMMAND, 'a url');
  return {
    kind: 'ok',
    url,
    headless,
    port,
    ...(expect !== undefined ? { expect } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(storageState !== undefined ? { storageState } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(explore ? { explore } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(select.length > 0 ? { select } : {}),
  };
}
