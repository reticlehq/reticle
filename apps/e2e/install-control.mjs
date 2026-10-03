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
