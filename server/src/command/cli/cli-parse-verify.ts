/**
 * The `reticle verify` grammar.
 *
 * Split out of `cli-parse.ts` when that file crossed the line cap. Cohesive on its own terms: this is
 * the one command that takes a preview URL, a browser, a timeout, a saved storage state, a session to
 * pin, a predicate to assert AND a persona to drive as — so it carries more grammar than the rest of
 * the CLI put together.
 */
import { readFileSync } from 'node:fs';

import {
  EXPECT_FILE_FLAG,
  EXPECT_FLAG,
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
const SESSION_ID_FLAG = '--session-id';

/**
 * `--expect` and `--storage-state` cannot both be honoured, so the pair is refused rather than
 * half-applied.
 *
 * `--expect` takes its verdict from the tab a running daemon already owns — it binds nothing and
 * launches nothing, which is exactly what makes it work while the port is busy. There is nowhere in
 * that path to load a storage state, and the flag was not refused, it was dropped: a restricted-user
 * absence assertion was graded against a logged-in admin tab and PASSED. A false green is worse than
 * a missing answer, and the only honest reply to a question this command cannot ask is to say so.
 */
const MSG_EXPECT_WITH_STORAGE_STATE =
  `${EXPECT_FLAG} cannot be combined with ${STORAGE_STATE_FLAG}: the predicate is graded against ` +
  'the tab the running daemon already owns, so the storage state would never be loaded and the ' +
  'verdict would be about whoever is signed in there.\n' +
  `  Use one of them: ${EXPECT_FLAG} on its own asserts against the session you have, and ` +
  `${STORAGE_STATE_FLAG} without ${EXPECT_FLAG} makes Reticle drive the url with that state and ` +
  'replay the saved flows.';

const MSG_EXPECT_WITH_EXPECT_FILE =
  `${EXPECT_FLAG} and ${EXPECT_FILE_FLAG} cannot both be set: pick one source for the predicate.`;
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
      if (expect !== undefined) return { kind: 'error', message: MSG_EXPECT_WITH_EXPECT_FILE };
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
    } else if (arg === EXPECT_FILE_FLAG) {
      i++;
      const v = args[i];
      if (v === undefined) return missingValue(EXPECT_FILE_FLAG);
      if (expect !== undefined) return { kind: 'error', message: MSG_EXPECT_WITH_EXPECT_FILE };
      // Prefer over --expect on Windows PowerShell: npx.cmd strips inline JSON quotes (#1082).
      let raw: string;
      try {
        raw = readFileSync(v, 'utf8');
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          kind: 'error',
          message: `${EXPECT_FILE_FLAG} could not read ${v}: ${detail}`,
        };
      }
      try {
        expect = JSON.parse(raw);
      } catch {
        return {
          kind: 'error',
          message: `${EXPECT_FILE_FLAG} needs a JSON predicate in ${v}; could not parse the file`,
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
  // Refused here, where nothing has been bound and no browser exists yet, because the damage this
  // pair does is a verdict taken against the wrong user.
  if (expect !== undefined && storageState !== undefined) {
    return { kind: 'error', message: MSG_EXPECT_WITH_STORAGE_STATE };
  }
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
