/**
 * Bound a promise that may never settle.
 *
 * A drive waits in more than one place, and every one of them holds the same scarce thing while it
 * waits: a leased browser context pointed at the app under test. An unbounded wait therefore does not
 * cost one run, it wedges the browser — and it is silent, because nothing has failed yet.
 *
 * The timer is cleared on both paths. An outstanding timer keeps a short-lived process alive for its
 * full duration after the work has finished, which turns a fast CLI invocation into a mysteriously
 * slow one.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  /**
   * The whole phrase, subject and verb — "the model did not answer", "the browser never came free".
   * It is printed in a report somebody reads, and a generic "operation timed out" tells them nothing
   * about which of a run's several waits gave up.
   */
  gaveUp: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${gaveUp} within ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
