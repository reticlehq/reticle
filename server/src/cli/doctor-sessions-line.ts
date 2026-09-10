import { SELF_RECOVERING_MARKER } from '../session/no-session-diagnosis.js';
import { DoctorRow, doctorRow } from './doctor-rows.js';

/**
 * The line `doctor` was missing: is anything actually CONNECTED?
 *
 * `doctor` collapses the first-run failure modes into one command, and it checked every one of them
 * except the one the funnel actually stalls on. A user who has installed the SDK, wired the plugin
 * and started the daemon runs `doctor`, gets node, chromium, daemon, bridge port and desktop wiring
 * all ✓, and is no better off — because the thing that is wrong is that no page has ever dialled in,
 * and nothing on that screen mentions pages.
 *
 * The daemon has always known. `/status` carries `sessionCount`, the session list, and `why` — the
 * same no-session diagnosis an agent gets from an empty `reticle_sessions`, which is careful about
 * what it can and cannot prove. `reticle status` prints it. `doctor` fetched the identical payload
 * to read `version` and `contract` off it and dropped the rest on the floor.
 *
 * So this invents no new diagnosis. It surfaces one that already exists, on the command a stuck human
 * runs, which is the difference between a checklist that ends in "everything is fine" and one that
 * ends in a next action.
 *
 * Pure and payload-shaped rather than reaching for the bridge: `doctor` runs in a separate process
 * from the daemon and can only ever know what `/status` told it.
 */

/**
 * The diagnosis is written for an AGENT, and `doctor` has a human in front of it.
 *
 * Every branch of it ends by telling the reader to call `reticle_sessions` again, which is right for
 * the caller it was written for and useless to somebody in a shell: an MCP tool is not something you
 * can type. Printing it unchanged would make `doctor` end on a recovery its reader cannot perform,
 * which is the same defect as the aged-out lease message that told an agent to ask a human to reopen
 * a tab that never existed.
 *
 * So the last sentence is swapped for the shell equivalent of itself. Only that sentence — the rest
 * of the diagnosis is about the app and reads the same to either audience.
 */
const HUMAN_RETRY =
  'Then run `reticle doctor` again — it will appear within a second of the page loading.';

function forAHuman(why: string): string {
  // Imported, not re-typed: a copy of a sentence that has to match another file's byte-for-byte is a
  // drift bug with a delay on it, and the failure is silent — the swap simply stops happening and
  // doctor goes back to telling a human to call an MCP tool.
  return why.replace(SELF_RECOVERING_MARKER, HUMAN_RETRY);
}

/** What this reads off `/status`. Everything is optional — an older daemon may send none of it. */
export interface SessionFacts {
  sessionCount?: unknown;
  why?: unknown;
}

export interface SessionsLine {
  /** The `sessions` row itself. */
  text: string;
  /** The diagnosis to print underneath, when there is one and it is not contradicted by a session. */
  why?: string;
}

function countOf(facts: SessionFacts): number | undefined {
  const raw = facts.sessionCount;
  return 'number' === typeof raw && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

export function sessionsLine(facts: SessionFacts): SessionsLine {
  const count = countOf(facts);
  if (count === undefined) {
    // An older daemon that does not report it. Saying "0 connected" here would be a claim about the
    // app made from a payload that never mentioned the app — the exact kind of confident wrong
    // sentence the no-session diagnosis exists to avoid.
    return {
      text: doctorRow(
        DoctorRow.SESSIONS,
        '? this daemon did not report connected pages (older build)',
      ),
    };
  }
  if (count > 0) {
    const plural = 1 === count ? 'page' : 'pages';
    return { text: doctorRow(DoctorRow.SESSIONS, `✓ ${String(count)} ${plural} connected`) };
  }
  const why =
    'string' === typeof facts.why && facts.why.length > 0 ? forAHuman(facts.why) : undefined;
  return {
    // Deliberately ✗ rather than a neutral note. Zero connected pages is why somebody is running
    // doctor, and a ✓-coloured checklist that hides the one failing thing is how the old output
    // convinced people their setup was fine.
    text: doctorRow(DoctorRow.SESSIONS, '✗ no page has connected to this daemon'),
    ...(why === undefined ? {} : { why }),
  };
}
