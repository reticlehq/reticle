import { EventType, SnapshotMode, asNumber, asRecord, asString } from '@reticlehq/core';

/**
 * How much DOM there is under the mount container, when the tree is empty and nothing was skipped.
 *
 * A handful of elements is a container with nothing in it. React's own root div counts as one, and a
 * wrapper or two is ordinary, so this is deliberately not `=== 0`.
 */
const UNMOUNTED_ROOT_MAX_ELEMENTS = 3;

/**
 * The third cause of an empty tree, and the one the walk cannot see: the app is not mounted.
 *
 * Reported from the field with the react-three-fiber crash. The source-mapping stamp threw inside
 * R3F's commit phase, React unmounted the entire tree, and the page went white — and the snapshot
 * answered `{ tree: "", nodes: 0 }`, which is also what a page that has not rendered yet answers.
 * The reporter spent a diagnosis pass separating the two, and said that detecting a dead root would
 * have pointed straight at the cause.
 *
 * The other two notes here explain an empty tree by what the WALK passed over. This one cannot: a
 * walk that visited nothing has nothing to have skipped. It reads the DOM count instead, which is
 * why the browser now reports it, and it fires only when the skip counts are silent — a page whose
 * elements were all hidden has plenty of DOM and belongs to `noteHiddenPage`.
 *
 * Like both of its neighbours it names a fact and hands over the next read, and does not diagnose:
 * "not mounted" is certain from the count, WHY is not, and the console is where the answer is.
 */
/**
 * The uncaught errors already in the session buffer, if there are any.
 *
 * An unmounted root has two readings that call for opposite next moves: an app that has not started
 * yet (load it), and an app that started and threw (read the error). The count above settles that it
 * is unmounted and cannot settle which — but the buffer beside it usually can, and the note used to
 * send the reader to `reticle_console` to fetch a fact the server was already holding. That round
 * trip is the whole of #899: the reporter took a screenshot, then read the console, and found five
 * `Uncaught Error` entries about fifteen tool calls after the crash.
 *
 * Read defensively off the resolved session rather than through a narrowed type: the snapshot
 * handler's only contract with `resolve()` is `id` and `command`, and a session that cannot answer
 * for its buffer must degrade to the old note rather than fail the snapshot.
 */
interface CrashEvidence {
  readonly count: number;
  readonly first: string;
}

function crashEvidence(session: unknown): CrashEvidence | undefined {
  const since = asRecord(session)['eventsSince'];
  if ('function' !== typeof since) return undefined;
  let events: unknown;
  try {
    events = (since as (cursor: number) => unknown).call(session, 0);
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  const errors = events.filter((e) => {
    const type = asString(asRecord(e)['type']);
    return EventType.CONSOLE_ERROR === type || EventType.ERROR_UNCAUGHT === type;
  });
  if (0 === errors.length) return undefined;
  const first = errors
    .map((e) => asString(asRecord(asRecord(e)['data'])['message']))
    .find((m): m is string => undefined !== m && '' !== m);
  return { count: errors.length, first: first ?? '' };
}

export function noteUnmountedRoot(
  result: unknown,
  mode: string,
  session?: unknown,
  scope?: string,
): unknown {
  // A scope narrows the walk to one element, so a near-empty DOM under it says nothing about the app.
  if (SnapshotMode.STATUS === mode || (scope ?? '') !== '') return result;
  const row = asRecord(result);
  if (0 !== asNumber(row['nodes'])) return result;
  if (row['note'] !== undefined) return result;
  const elements = asNumber(row['domElements']);
  if (elements === undefined || elements > UNMOUNTED_ROOT_MAX_ELEMENTS) return result;
  const mount =
    `the tree is empty because there is almost nothing in the DOM: ${String(elements)} ` +
    `element(s) under this scope. That is a mount container with nothing rendered into it, not a ` +
    `page whose contents were skipped — so the app is UNMOUNTED rather than slow, and waiting ` +
    `will not change it. `;
  // An uncaught error beside an empty mount container is the difference between "has not started"
  // and "started and died", which are the two readings of this count and want opposite next moves.
  // Nothing here is framework-specific, and deliberately so: the condition is a known mount
  // container that holds nothing with an uncaught error beside it, which is as true of a Vue or
  // Svelte root as a React one.
  const crash = crashEvidence(session);
  if (crash !== undefined) {
    return {
      ...row,
      note:
        mount +
        `The app did not merely fail to start — it CRASHED: ${String(crash.count)} uncaught ` +
        `error(s) were logged in this session` +
        ('' === crash.first ? '' : `, the first: "${crash.first}"`) +
        `. Read reticle_console for the rest, and check anything that runs inside a framework ` +
        `commit phase. Loading the app again will reproduce it rather than fix it.`,
    };
  }
  return {
    ...row,
    note:
      mount +
      `An app that was rendering and then stopped has usually thrown: read ` +
      `reticle_console for an uncaught error, and check anything that runs inside a framework ` +
      `commit phase. If the app has genuinely not started yet, load it and snapshot again.`,
  };
}
