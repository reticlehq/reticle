// Wait for the session a spec actually addresses — and say so loudly when it never arrives.
//
// Every spec here drives ONE app and then addresses it (`sessionId: 'next-smoke'`, or "the session
// on :4310"). Two things make "is it connected yet?" harder than it looks:
//
//   1. run.mjs frees the bridge port between specs, so every connected app must RECONNECT, with
//      backoff. A spec that starts work a beat too early dies with a product-shaped error —
//      "no connected session with id 'next-smoke'" — that is really a harness race.
//   2. `sessions.length > 0` is the wrong question. It is satisfied by ANY session, including an app
//      tab open in the developer's own browser (run.mjs warns about exactly this at startup). The
//      wait passes, the spec then addresses a session that is not there, and the failure names the
//      product instead of the cause.
//
// So: wait for the SPECIFIC session, with a generous timeout, and when it does not turn up print who
// WAS connected and exit — a named cause beats a stack trace pointing at the SDK.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Block until `count` sessions matching `want` are connected; exit(1) with a diagnosis if not.
 *
 * @param {() => unknown[] | Promise<unknown[]>} list  reads the current sessions. In-process specs
 *   pass `() => server.bridge.sessions.list()`; MCP specs pass a `reticle_sessions` call.
 * @param {string | ((s: any) => boolean)} want  a session id, or a predicate (e.g. match on `url`
 *   when the app self-assigns a per-tab id, as bench-app does).
 * @param {{ what?: string, count?: number, timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<any[]>} the matching sessions.
 */
export async function waitForSession(list, want, opts = {}) {
  const count = opts.count ?? 1;
  const what = opts.what ?? (typeof want === 'string' ? `session '${want}'` : 'a matching session');
  // 60s, not the 10s these specs used to spend: a reconnect with backoff, behind a cold dev-server
  // compile, routinely needs more than ten seconds on a loaded machine. The timeout is a backstop,
  // not a pacing device — the loop exits the moment the session is there.
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 200;
  const matches = typeof want === 'function' ? want : (s) => want === (s?.sessionId ?? s?.id);
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  for (;;) {
    seen = (await list()) ?? [];
    const hits = seen.filter(matches);
    if (count <= hits.length) return hits;
    if (deadline <= Date.now()) break;
    await sleep(intervalMs);
  }
  const listing =
    0 === seen.length
      ? '        (none)'
      : seen
          .map((s) => `        ${String(s?.sessionId ?? s?.id)}  ${String(s?.url ?? '')}`)
          .join('\n');
  console.error(
    `\n❌ ${what}${1 < count ? ` (needed ${String(count)})` : ''} never connected to the bridge ` +
      `within ${String(Math.round(timeoutMs / 1000))}s.\n` +
      `   Connected right now (${String(seen.length)}):\n${listing}\n` +
      `   This spec addresses that session specifically, so everything below it would fail for THIS\n` +
      `   reason and not its own. Check the app is running and dialing this bridge port; a session in\n` +
      `   the list above that is not yours is a stray tab, and it does not count.\n`,
  );
  process.exit(1);
}
