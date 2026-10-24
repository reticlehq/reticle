/**
 * Hold back "the last agent detached" for a short grace.
 *
 * The daemon ends every browser session when the last agent detaches. A proxy that reconnects
 * closes its stream and opens a new one, so a single drop of the link ended the user's session, and
 * the agent's next call found "no connected session". With the grace, an agent that comes back
 * inside it never detached, as far as the sessions can tell.
 */

/** Run `fn` after `ms`; the return value cancels it. Injected so a test needs no clock. */
export type Schedule = (fn: () => void, ms: number) => () => void;

const realSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  // The grace must never keep a daemon alive that is shutting down.
  timer.unref();
  return () => clearTimeout(timer);
};

export function withDetachGrace(
  onPresence: (connected: boolean) => void,
  graceMs: number,
  schedule: Schedule = realSchedule,
): (connected: boolean) => void {
  let cancelDetach: (() => void) | undefined;
  return (connected) => {
    if (!connected) {
      cancelDetach?.();
      cancelDetach = schedule(() => {
        cancelDetach = undefined;
        onPresence(false);
      }, graceMs);
      return;
    }
    if (cancelDetach !== undefined) {
      // Back inside the grace: the detach was never reported, so there is no attach to report.
      cancelDetach();
      cancelDetach = undefined;
      return;
    }
    onPresence(true);
  };
}
