// HONESTY-CRITICAL: prove `reticle init` can wire an electron-vite app, against a REAL
// electron-vite process (not a plain Vite + Electron pair).
//
// #723: init looked for vite.config.*, found none, and reported ⚠. A naive patch of the first
// `plugins: [` would have wired the SDK into `main` and reported ✓ for an app that cannot connect.
// This spec is the thing that would have caught both: the renderer must dial the bridge, IPC must
// be visible, and screenshots must go through the main-process helper.
import {
  bootDesktopSession,
  checker,
  sleep,
  spawnElectronVite,
  tempCaptures,
} from '../desktop-harness.mjs';

const { chk, state } = checker();

console.log('\n=== DESKTOP: electron-vite (renderer plugin, headless) ===');

let session;
try {
  session = await bootDesktopSession({
    spawnApp: (env) => spawnElectronVite(env),
    urlIncludes: 'localhost',
    timeoutMs: 90_000,
    port: Number(process.env['RETICLE_PORT'] ?? 4400),
  });
  const { tool, refOf, sessionId, log } = session;

  chk('the electron-vite renderer dialed the bridge', sessionId !== undefined);
  if (sessionId === undefined) {
    console.log(log.join('').slice(-3000));
    throw new Error('no session');
  }

  const send = await refOf('send-ipc');
  chk('the send-ipc testid is queryable', send !== undefined);
  if (send !== undefined) {
    const clicked = await tool('reticle_act', { ref: send, action: 'click' });
    chk('the Send IPC click landed', clicked.result?.ok === true);
  }

  let ping;
  for (let i = 0; i < 40; i++) {
    ping = await tool('reticle_network', {});
    if (JSON.stringify(ping).includes('ipc://ping')) break;
    await sleep(200);
  }
  chk(
    'the preload shim observes ipcRenderer.send as ipc://ping',
    JSON.stringify(ping).includes('ipc://ping'),
    JSON.stringify(ping?.calls?.[0] ?? {}),
  );

  const shot = await tool('reticle_screenshot', { name: 'electron-vite-viewport' });
  chk(
    'main-process capture is installed (screenshot saves)',
    shot.saved === true,
    JSON.stringify(shot),
  );
} finally {
  await session?.shutdown();
}

chk(
  'shutdown removes the private capture directory from the temp dir',
  tempCaptures().length === 0,
  tempCaptures().join(','),
);

console.log(
  `\n${state.fail === 0 ? '✅ ELECTRON-VITE DESKTOP VERIFIED' : '❌ FAILED'} (${String(state.pass)} passed, ${String(state.fail)} failed)`,
);
process.exit(state.fail === 0 ? 0 : 1);
