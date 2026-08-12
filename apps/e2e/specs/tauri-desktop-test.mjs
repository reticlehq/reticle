// HONESTY-CRITICAL: prove Reticle's Tauri support against a REAL Tauri v2 binary, headless.
//
// Runs the PACKAGED build (`tauri://localhost`, frontendDist), not `tauri dev` — the dev path serves
// the frontend from an ordinary http origin, so it exercises none of what is Tauri-specific: the
// opaque origin the bridge's upgrade handler once crashed on, and the locality gate that used to
// read a desktop webview as a remote website and refuse to start.
//
// Pinned here:
//   - the webview dials the bridge from tauri://localhost
//   - an `invoke` is observed as ipc://<command> with no JavaScript-side wiring at all
//   - a command returning Err is recorded as FAILED despite the transport's HTTP 200
//   - the planted false green is reported as a contradiction
//   - `reticle_capture` photographs the webview while the window is hidden (headless)
//   - fullPage is refused on macOS/Windows rather than downgraded
//   - concurrent captures all survive, and nothing is left in the temp dir
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, bootDesktopSession, checker, sleep, tempCaptures } from '../desktop-harness.mjs';

const { chk, state } = checker();

/**
 * The packaged binary, built by `pnpm e2e:desktop` (or the CI job) before this spec runs.
 *
 * Missing means the build step did not happen — a setup fault, reported as a failure rather than a
 * skip. A desktop battery that quietly tests nothing is the failure this spec exists to prevent.
 */
const BINARY = path.join(
  ROOT,
  'apps/tauri-smoke/src-tauri/target/release',
  process.platform === 'win32' ? 'tauri-smoke.exe' : 'tauri-smoke',
);
if (!existsSync(BINARY)) {
  console.error(
    `\n❌ no packaged Tauri binary at ${BINARY}\n` +
      '   build it first:  pnpm --filter @reticlehq/tauri-smoke exec tauri build --no-bundle\n',
  );
  process.exit(1);
}

console.log('\n=== DESKTOP: Tauri v2 (packaged binary, headless) ===');

let session;
try {
  session = await bootDesktopSession({
    spawnApp: (env) =>
      spawn(BINARY, [], {
        cwd: path.join(ROOT, 'apps/tauri-smoke/src-tauri'),
        env: { ...env, RETICLE_HEADLESS: '1' },
      }),
    // Tauri's origin differs by platform and BOTH are a Tauri webview: an opaque `tauri://localhost`
    // on macOS/Linux, and a real `http://tauri.localhost` on Windows, where the webview requires an
    // http origin. Matching only the first made this spec unrunnable on Windows — the very platform
    // whose capture backend the release notes admit had never been executed.
    urlIncludes: 'tauri',
  });
  const { tool, refOf, sessionId, server, log } = session;

  chk('the Tauri webview dialed the bridge', sessionId !== undefined);
  if (sessionId === undefined) {
    console.log(log.join('').slice(-3000));
    throw new Error('no session');
  }
  // The origin a PACKAGED Tauri app serves its embedded frontend from — `tauri://localhost` on
  // macOS/Linux, `http://tauri.localhost` on Windows, where the webview requires an http origin.
  // Both are the packaged app. What this check exists to exclude is a DEV SERVER
  // (`http://localhost:5173`), because testing one of those would prove nothing about the binary.
  const PACKAGED_TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost/'];
  // Find the Tauri session, never `list()[0]`. Any Reticle-instrumented app running on the developer's
  // machine can dial this bridge and take slot 0 — an ordinary dev server on localhost:3000 did
  // exactly that and failed this check while the packaged binary had connected perfectly, which is a
  // red that belongs to nobody's change. Asserting on the session we are actually testing keeps the
  // check just as strict: a spec driving a DEV SERVER still finds no packaged origin here.
  const sessions = server.bridge.sessions.list();
  const tauriSession = sessions.find((s) => PACKAGED_TAURI_ORIGINS.includes(String(s?.url)));
  chk(
    'it connected from the packaged Tauri origin, not a dev server',
    tauriSession !== undefined,
    tauriSession === undefined
      ? `no packaged-origin session among ${JSON.stringify(sessions.map((s) => String(s?.url)))}`
      : String(tauriSession.url),
  );

  for (let i = 0; i < 40; i++) {
    if (JSON.stringify(await tool('reticle_network', {})).includes('ipc://load_todos')) break;
    await sleep(200);
  }
  const boot = await tool('reticle_network', {});
  chk(
    'an invoke is observed as ipc://load_todos with no frontend wiring',
    JSON.stringify(boot).includes('ipc://load_todos'),
    JSON.stringify(boot.calls?.[0] ?? {}),
  );

  // ── the planted false green ────────────────────────────────────────────────────────────────────
  const archived = await tool('reticle_act', { ref: await refOf('archive-1'), action: 'click' });
  chk('the archive click landed', archived.result?.ok === true);
  // Wait for the command to SETTLE, not merely to appear: an in-flight call is already listed (as
  // `status: "pending"`), so polling on presence reads the request before its verdict exists.
  let failed;
  for (let i = 0; i < 40; i++) {
    failed = await tool('reticle_network', { urlContains: 'ipc://archive_todo' });
    if (typeof failed.calls?.[0]?.status === 'number') break;
    await sleep(200);
  }
  // Tauri's transport answers HTTP 200 whether the command returned Ok or Err. Without translating
  // the `Tauri-Response` header, every failed Rust command is banked as a successful request.
  chk(
    'a command that returned Err is recorded as FAILED despite the transport 200',
    failed.calls?.[0]?.status === 500 && failed.calls[0].statusText === 'Err',
    JSON.stringify(failed.calls?.[0] ?? {}),
  );

  const byOk = await tool('reticle_network', { ok: false });
  chk(
    'reticle_network { ok: false } returns ONLY failed commands',
    byOk.calls?.length > 0 && byOk.calls.every((c) => c.status === 500),
    JSON.stringify(byOk.calls),
  );

  const verdict = await tool('reticle_assert', {
    predicate: { kind: 'net', urlContains: 'ipc://archive_todo', ok: false },
  });
  chk('assert { net, ok:false } passes with the command record as evidence', verdict.pass === true);

  const observed = await tool('reticle_observe', {});
  chk(
    'a contradiction names the failed command',
    (observed.contradictions ?? []).some((c) => c.detail.includes('archive_todo')),
    JSON.stringify(observed.contradictions ?? []),
  );

  // ── capture, from a window that is not on screen at all ───────────────────────────────────────
  const shot = await tool('reticle_screenshot', { name: 'tauri-home' });
  chk(
    'reticle_capture photographs the webview while the window is hidden',
    shot.saved === true,
    `${String(shot.bytes)} bytes`,
  );
  chk('the capture is a real PNG, not a truncated one', (shot.bytes ?? 0) > 10_000);

  const full = await tool('reticle_screenshot', { name: 'tauri-full', fullPage: true });
  // WebKitGTK can render a full document offscreen; WKWebView and WebView2 cannot and must refuse.
  const linux = process.platform === 'linux';
  chk(
    linux
      ? 'fullPage is honoured on WebKitGTK'
      : 'fullPage is REFUSED here, never downgraded to a viewport image',
    linux ? full.saved === true : full.reason === 'full-page-unsupported',
    JSON.stringify(full),
  );

  const concurrent = await Promise.all(
    [1, 2, 3].map((i) => tool('reticle_screenshot', { name: `tauri-concurrent-${String(i)}` })),
  );
  chk(
    'three concurrent captures all succeed',
    concurrent.every((s) => s.saved === true),
    JSON.stringify(concurrent.map((s) => s.reason ?? s.saved)),
  );

  /**
   * The webview must still be there a few seconds later.
   *
   * Everything above runs within a couple of seconds of connect, so this spec only ever proved that
   * Tauri works IMMEDIATELY after connect — and an agent doing real work is past that in one tool
   * call. Nothing here had ever checked that the session survives an ordinary pause.
   *
   * It does: this passes. The check exists because the absence of it is unfalsifiable, not because a
   * failure was found.
   *
   * ONE ATTEMPT WAS NOT ENOUGH, and the note that used to sit here — "did not reproduce once the
   * machine was quiet, and is not evidence of anything" — turned out to be the whole story rather
   * than an aside. Measured: three consecutive failures on a loaded machine, then four consecutive
   * passes on a quiet one across four different commits INCLUDING the same HEAD that had just
   * failed. The assertion was flipping on machine load, which makes it useless as a gate: it blocks
   * a good release at random, and teaches everyone to re-run until green.
   *
   * The claim being made is "the session is still ALIVE after a pause", and that is kept exactly.
   * What changes is the waiting: a hidden WKWebView is throttled by the platform, so a single 8s
   * command can time out on a webview that is merely slow to be scheduled rather than dead. It now
   * retries until the session answers or the window closes — a dead session still fails, it just
   * takes the full window to say so.
   */
  await sleep(12_000);
  let aliveLater = false;
  let lastError = '';
  const aliveDeadline = Date.now() + 30_000;
  while (!aliveLater && Date.now() < aliveDeadline) {
    try {
      await tool('reticle_snapshot', {});
      aliveLater = true;
    } catch (error) {
      lastError = String(error).slice(0, 140);
      await sleep(1000);
    }
  }
  if (!aliveLater) console.log(`   (durability probe: ${lastError})`);
  chk('the session still answers after a pause, not just immediately', aliveLater);
} finally {
  await session?.shutdown();
}
chk(
  'shutdown removes the private capture directory from the temp dir',
  tempCaptures().length === 0,
  tempCaptures().join(','),
);

console.log(
  `\n${state.fail === 0 ? '✅ TAURI DESKTOP VERIFIED' : '❌ FAILED'} (${String(state.pass)} passed, ${String(state.fail)} failed)`,
);
process.exit(state.fail === 0 ? 0 : 1);
