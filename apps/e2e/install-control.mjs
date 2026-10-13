export const SESSION_CHECK = 'a session appears and can answer a state question';

/** Only the page opened by this run can prove its SDK connected. */
export function sessionMatchesPage(session, pageUrl) {
  if (typeof pageUrl !== 'string' || typeof session?.url !== 'string') return false;
  try {
    const expected = new URL(pageUrl);
    const actual = new URL(session.url);
    const run = expected.searchParams.get('reticle-install-run');
    return run !== null && run.length > 0 && actual.origin === expected.origin &&
      actual.pathname === expected.pathname && actual.searchParams.get('reticle-install-run') === run;
  } catch {
    return false;
  }
}

/** A session can answer a state question only if it SAID so: `hasCapabilities` is announced, not inferred. */
export function anyVerifiable(sessions) {
  return sessions.some((session) => true === session?.hasCapabilities);
}

/**
 * Wait for THIS run's session, then give `hasCapabilities` a budget of its own to flip true.
 *
 * Two loops, because they measure two different things. The first waits for the page the gate
 * opened to appear on the bridge at all. `hasCapabilities` is announced in HELLO at connect() and
 * re-announced when `registerCapabilities` runs after it, so the first snapshot of a correct
 * install can read false — the second loop is that wait. Connected is not verifiable, and a gate
 * that samples once sits outside the product's own protection against the race.
 *
 * The capabilities budget starts when the session appears. It used to be clipped to the connect
 * deadline, so a scaffold that connected 44s into a 45s window had one second to re-announce and
 * was then graded "connected but unobservable" — the harness filing a wrong reason against the
 * product, which is what harness rule 4 forbids. When no session appears there is nothing to wait
 * on, and the second loop does not run.
 *
 * A session that appeared and then vanished is reported as connected: it did connect, and "no
 * session ever appeared" would be the harness's own false claim.
 *
 * `now` and `sleep` are injected so a test can drive the loop on a fake clock.
 *
 * @param {() => Promise<unknown[]> | unknown[]} list  the bridge's current sessions.
 * @param {(session: unknown) => boolean} isOurs  only the page this run opened can answer for it.
 * @param {{ connectTimeoutMs: number, capabilitiesWaitMs: number, now: () => number,
 *   sleep: (ms: number) => Promise<void>, intervalMs?: number }} opts
 * @returns {Promise<{ sessions: unknown[], connected: boolean, verifiable: boolean }>}
 */
export async function waitForVerifiableSession(list, isOurs, opts) {
  const { connectTimeoutMs, capabilitiesWaitMs, now, sleep, intervalMs = 500 } = opts;
  const ours = async () => ((await list()) ?? []).filter(isOurs);
  const connectDeadline = now() + connectTimeoutMs;
  let sessions = await ours();
  while (sessions.length === 0 && now() < connectDeadline) {
    await sleep(intervalMs);
    sessions = await ours();
  }
  if (sessions.length === 0) return { sessions, connected: false, verifiable: false };
  const capabilitiesDeadline = now() + capabilitiesWaitMs;
  while (!anyVerifiable(sessions) && now() < capabilitiesDeadline) {
    await sleep(intervalMs);
    sessions = await ours();
  }
  return { sessions, connected: true, verifiable: anyVerifiable(sessions) };
}

/** A setup error is missing evidence, never a successful negative control. */
export function evaluateInstallControl(results, expectedIds) {
  const problems = [];
  if (expectedIds.length === 0) problems.push('no scaffolds requested');
  for (const id of expectedIds) {
    const rows = results.filter((result) => result.id === id);
    if (rows.length !== 1) {
      problems.push(`${id}: expected one result, got ${rows.length}`);
      continue;
    }
    const row = rows[0];
    if (row.fail !== 1 || row.failedChecks?.length !== 1 || row.failedChecks[0] !== SESSION_CHECK) {
      problems.push(`${id}: expected only the session failure; got ${JSON.stringify(row)}`);
    }
  }
  for (const row of results) {
    if (!expectedIds.includes(row.id)) problems.push(`unexpected result: ${row.id}`);
  }
  return { ok: problems.length === 0, problems };
}
