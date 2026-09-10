/**
 * Say what the dev-server wait is waiting FOR, while it waits.
 *
 * `init`'s wait loop polled in complete silence. Reported as thirty minutes of nothing, ending in a
 * SIGKILL: no output, no exit, no verdict. The cause of that particular wait is still unexplained,
 * but the silence is a failure on its own terms — a user cannot tell "still starting" from "wedged",
 * and cannot see the thing most likely to be wrong, which is the URL being watched rather than the
 * server itself.
 *
 * That distinction is not hypothetical: `dev-server-wait.ts` already reasons about a server that
 * serves happily on a port we never found (the CRA case, where no url is printed outside a tty), and
 * has never said so out loud while it happens.
 *
 * Pure, and the clock is the caller's. `elapsedMs` and `lastSpokeAtMs` come in; nothing here reads a
 * real clock, so the decision is testable without one and cannot assert a duration.
 */

/**
 * How often to speak. Long enough that a normal start — under a second — says nothing at all, since
 * announcing a wait that is not happening is noise in the first command a user ever runs.
 */
export const WAIT_PROGRESS_EVERY_MS = 15_000;

/**
 * The line to print now, or undefined to stay quiet.
 *
 * `lastSpokeAtMs` is when this last returned a line, so the caller can poll as fast as it likes
 * without a line per poll burying the output it exists to explain.
 */
export function waitProgressLine(
  elapsedMs: number,
  watching: string | undefined,
  lastSpokeAtMs: number | undefined,
): string | undefined {
  if (elapsedMs < WAIT_PROGRESS_EVERY_MS) return undefined;
  const since = elapsedMs - (lastSpokeAtMs ?? 0);
  if (lastSpokeAtMs !== undefined && since < WAIT_PROGRESS_EVERY_MS) return undefined;
  const seconds = `${String(Math.floor(elapsedMs / 1000))}s`;
  if (watching === undefined) {
    // A different problem, and one the reader can act on: we do not know where to look. The CRA
    // case reaches here, and so does any launcher whose url never appears in its output.
    return (
      `Waiting ${seconds} for the dev server. It has not announced a url yet and no port was ` +
      `observed, so there is nothing to watch — if it IS up, stop this and pass --url <its url>.`
    );
  }
  return (
    `Waiting ${seconds} for the dev server — watching ${watching}. If the app is already up ` +
    `somewhere else, that url is the thing to check first.`
  );
}
