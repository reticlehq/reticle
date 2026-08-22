// HONESTY-CRITICAL: prove Reticle's Electron support against a REAL Electron app, headless.
//
// Everything here failed silently at least once while desktop was being built, and none of it was
// covered by any gate: the unit suite cannot boot a main process, and the web battery boots three
// HTTP servers and no desktop runtime. Specifically pinned:
//   - `ipcRenderer.invoke` is observed as ipc://<channel>, including the failure
//   - a one-way `ipcRenderer.send` is observed too, as DISPATCHED with no invented verdict
//   - the planted false green (UI says archived, IPC says 500) is reported as a contradiction
//   - reticle_network { ok: false } actually filters (it silently did not)
//   - screenshots go through the main process, concurrent ones do not eat each other, and the
//     temp file is gone afterwards
//   - fullPage is REFUSED, never downgraded to a viewport image
//   - a renderer with NO preload shim declares the blind spot instead of reading clean
//   - `verified` itself, in BOTH directions — this battery never asserted on it, so a change that
//     made every ordinary Electron action return `unknown` passed all 18 checks
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  ROOT,
  bootDesktopSession,
  checker,
  sleep,
  spawnElectronSmoke,
  tempCaptures,
} from '../desktop-harness.mjs';

const { chk, state } = checker();
const smokeDir = path.join(ROOT, 'apps/electron-smoke');

/** Launch the smoke app's Electron main process with a never-shown window. */
function electronLauncher(electronBin) {
  return (env) =>
    spawn(electronBin, ['.'], { cwd: smokeDir, env: { ...env, RETICLE_HEADLESS: '1' } });
}

console.log('\n=== DESKTOP: Electron (real main process, headless) ===');

const { vite, electronBin } = await spawnElectronSmoke(process.env);
let session;
try {
  session = await bootDesktopSession({
    spawnApp: electronLauncher(electronBin),
    urlIncludes: ':5174',
  });
  const { tool, refOf, sessionId, log } = session;

  chk('the Electron renderer dialed the bridge', sessionId !== undefined);
  if (sessionId === undefined) {
    console.log(log.join('').slice(-3000));
    throw new Error('no session');
  }
  // The app loads its todos over IPC on mount; wait for that round trip rather than a fixed sleep.
  for (let i = 0; i < 40; i++) {
    if (JSON.stringify(await tool('reticle_network', {})).includes('ipc://todos:load')) break;
    await sleep(200);
  }

  const boot = await tool('reticle_network', {});
  chk(
    'ipcRenderer.invoke is observed as ipc://todos:load',
    JSON.stringify(boot).includes('ipc://todos:load'),
    JSON.stringify(boot.calls?.[0] ?? {}),
  );

  // ── the planted false green ────────────────────────────────────────────────────────────────────
  const archived = await tool('reticle_act', { ref: await refOf('archive-1'), action: 'click' });
  chk('the archive click landed', archived.result?.ok === true);
  // Wait for the call to SETTLE, not merely to appear: an in-flight IPC call is already listed (as
  // `status: "pending"`), so polling on presence reads the request before its verdict exists.
  let failed;
  for (let i = 0; i < 40; i++) {
    failed = await tool('reticle_network', { urlContains: 'ipc://todos:archive' });
    if (typeof failed.calls?.[0]?.status === 'number') break;
    await sleep(200);
  }
  chk(
    'the failing IPC call is recorded, with the main process’s own error',
    failed.calls?.[0]?.status === 500,
    JSON.stringify(failed.calls?.[0] ?? {}),
  );

  // The tool's own description tells the agent to filter desktop IPC on `ok`. It used to accept the
  // key and ignore it, so "show me what failed" answered with calls that had SUCCEEDED.
  const byOk = await tool('reticle_network', { ok: false });
  chk(
    'reticle_network { ok: false } returns ONLY failed calls',
    byOk.calls?.length > 0 && byOk.calls.every((c) => c.status === 500),
    JSON.stringify(byOk.calls),
  );

  const verdict = await tool('reticle_assert', {
    predicate: { kind: 'net', urlContains: 'ipc://todos:archive', ok: false },
  });
  chk('assert { net, ok:false } passes with the IPC record as evidence', verdict.pass === true);

  const observed = await tool('reticle_observe', {});
  // What must hold is that the UI moving forward over a FAILED IPC call is contradicted and the call
  // is named. WHICH classifier fires (ui-advanced-request-failed vs signal-contradicted) depends on
  // what else landed in the same window, so pinning one would be an assertion about scheduling.
  chk(
    'a contradiction names the failed IPC call the UI advanced over',
    (observed.contradictions ?? []).some((c) => c.detail.includes('todos:archive')),
    JSON.stringify(observed.contradictions ?? []),
  );

  // ── the VERDICT itself, which no desktop check ever looked at ─────────────────────────────────
  //
  // This battery asserted on network records, captures and coverage, and never once on `verified` —
  // the single field an agent gates on. A change that made every ordinary Electron action return
  // `unknown` passed all 18 checks here. Both directions are pinned now, because either one alone is
  // satisfiable by a broken rule: a rule that always says `no` catches the false green and cries wolf
  // on everything else; a rule that always says `yes` is silent and green.
  const falseGreen = await tool('reticle_assert', {
    predicate: { kind: 'text', contains: 'Archived' },
  });
  chk(
    'the verdict REFUSES the archive false green even though the assertion passed',
    falseGreen.pass === true && falseGreen.verified === 'no',
    `pass=${String(falseGreen.pass)} verified=${String(falseGreen.verified)}`,
  );

  // A healthy action in the same app: adding a todo works, and must read as verified.
  await tool('reticle_act', {
    ref: await refOf('draft'),
    action: 'fill',
    args: { value: 'verdict probe' },
  });
  const added = await tool('reticle_act', { ref: await refOf('add'), action: 'click' });
  await sleep(900);
  const healthy = await tool('reticle_assert', {
    predicate: { kind: 'text', contains: 'verdict probe' },
    since: added.since,
  });
  chk(
    'a healthy IPC action reads as verified, so the field still means something',
    healthy.verified === 'yes',
    `verified=${String(healthy.verified)} because=${String(healthy.because ?? '').slice(0, 90)}`,
  );

  // ── one-way send: visible, and NOT credited with a verdict nobody produced ─────────────────────
  await tool('reticle_act', { ref: await refOf('mark-seen'), action: 'click' });
  let oneWay;
  for (let i = 0; i < 30; i++) {
    oneWay = await tool('reticle_network', { urlContains: 'ipc://todos:seen' });
    if (oneWay.calls?.length > 0) break;
    await sleep(200);
  }
  chk(
    'a fire-and-forget ipcRenderer.send is observed at all',
    oneWay.calls?.length > 0,
    JSON.stringify(oneWay.calls ?? []),
  );
  chk(
    'and is reported as one-way with NO status — dispatched is not succeeded',
    oneWay.calls?.[0]?.oneWay === true && oneWay.calls[0].status === undefined,
    JSON.stringify(oneWay.calls?.[0] ?? {}),
  );
  const okTrue = await tool('reticle_network', { ok: true });
  chk(
    'and { ok: true } does not claim it as a success',
    !JSON.stringify(okTrue.calls ?? []).includes('todos:seen'),
    JSON.stringify(okTrue.calls ?? []),
  );

  // ── screenshots through the main process ──────────────────────────────────────────────────────
  // The capture provider is registered by `installReticleCapture(win)` in the MAIN process, which is
  // a different process from the renderer that dialed the bridge. Those two do not land in a fixed
  // order, so the renderer can be connected and driveable while the provider is still absent — and
  // this spec asserted on whichever side of that race the runner happened to land on. It failed
  // intermittently in CI, always here, always on runs that changed no desktop code.
  //
  // Poll for the provider rather than hoping. Crucially this retries ONLY on `no-visual-provider`:
  // any other failure (a capture that returned no image, a truncated PNG, a missing helper) returns
  // immediately and still fails the gate, which is the whole point of these two assertions.
  const screenshotOnceProviderReady = async (args) => {
    let last;
    for (let i = 0; i < 40; i++) {
      last = await tool('reticle_screenshot', args);
      if (last.reason !== 'no-visual-provider') return last;
      await sleep(200);
    }
    return last;
  };

  const shot = await screenshotOnceProviderReady({ name: 'electron-home' });
  // Print the REASON, not only the byte count. This failed once in CI as "undefined bytes", which
  // says nothing: an empty capture, a missing helper and a capture that never ran all render
  // identically. The tool already reports a reason (`capture returned no image` and friends) and the
  // spec was throwing it away, so diagnosing a red run meant re-running the whole battery locally.
  // A gate is only as useful as what it says when it goes red.
  chk(
    'reticle_screenshot captured the window via capturePage',
    shot.saved === true,
    shot.saved === true ? `${String(shot.bytes)} bytes` : JSON.stringify(shot),
  );
  chk(
    'the capture is a real PNG, not a truncated one',
    (shot.bytes ?? 0) > 10_000,
    `${String(shot.bytes)} bytes`,
  );

  const full = await tool('reticle_screenshot', { name: 'electron-full', fullPage: true });
  chk(
    'fullPage is REFUSED, never downgraded to a viewport image',
    full.saved !== true && full.reason === 'full-page-unsupported',
    JSON.stringify(full),
  );

  // Three at once: the helper's temp-file sweep used to delete a sibling capture before the daemon
  // had read it, and the daemon then blamed a missing capture helper that was installed and working.
  const concurrent = await Promise.all(
    [1, 2, 3].map((i) => tool('reticle_screenshot', { name: `electron-concurrent-${String(i)}` })),
  );
  chk(
    'three concurrent screenshots all succeed',
    concurrent.every((s) => s.saved === true),
    JSON.stringify(concurrent.map((s) => s.reason ?? s.saved)),
  );
} finally {
  await session?.shutdown();
}
chk(
  'shutdown removes the private capture directory from the temp dir',
  tempCaptures().length === 0,
  tempCaptures().join(','),
);

// ── the same app with the ONE line an integrator forgets ──────────────────────────────────────────
// Without the preload shim every IPC call is invisible. The failure mode this pins is not the
// missing data — it is the SILENCE: an empty network view and a green assert read as "this app makes
// no backend calls" rather than "you are blind to all of them".
console.log('\n--- and again with no preload shim ---');
let blind;
try {
  blind = await bootDesktopSession({
    spawnApp: electronLauncher(electronBin),
    extraEnv: { RETICLE_SMOKE_NO_PRELOAD: '1' },
    urlIncludes: ':5174',
  });
  await sleep(2500);

  const net = await blind.tool('reticle_network', {});
  // Document-initiated subresource observation means the network view is no longer guaranteed
  // empty without the preload: the page's own <script>/<link>/<img> loads are seen at the
  // session layer. What must still be EMPTY here is the IPC half: no preload, no invoke patch,
  // so every ipc:// record would be an invention.
  const calls = net.calls ?? [];
  chk(
    'an un-instrumented renderer really does report no IPC at all',
    calls.every((c) => !String(c.url ?? '').startsWith('ipc://')),
    JSON.stringify(calls.filter((c) => String(c.url ?? '').startsWith('ipc://')).slice(0, 3)),
  );
  chk(
    'but document-initiated loads of the page itself are now observed even here',
    calls.some((c) => /:5174/.test(String(c.url ?? ''))),
    JSON.stringify(calls.slice(0, 3)),
  );

  const green = await blind.tool('reticle_assert', {
    predicate: { kind: 'text', contains: '2 todos' },
  });
  chk('a passing assert still passes', green.pass === true);
  chk(
    'but it now carries coverage: partial naming the missing preload',
    typeof green.coverage === 'string' && green.coverage.includes('@reticlehq/electron/preload'),
    String(green.coverage),
  );
} finally {
  await blind?.shutdown();
  vite.kill();
}

console.log(
  `\n${state.fail === 0 ? '✅ ELECTRON DESKTOP VERIFIED' : '❌ FAILED'} (${String(state.pass)} passed, ${String(state.fail)} failed)`,
);
process.exit(state.fail === 0 ? 0 : 1);
