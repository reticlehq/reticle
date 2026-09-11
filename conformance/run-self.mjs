// Score this project against the specification this project publishes.
//
// The last piece of the conformance chain. The scenarios, the scoring rules, the driver, the
// binding and the subject all existed and none of them had ever been pointed at anything: a
// suite that cannot run is not a suite that passes, and a suite whose author has never run it is
// worse, because the author is the one person who could.
//
//   node conformance/run-self.mjs
//
// It boots the bench app and a daemon in one process, drives each plantable scenario through
// `conformanceClient`, and prints what was earned. Not a gate: it is a measurement, and the
// number it prints today is five of fourteen because our SUBJECT is incomplete, not because the
// implementation failed. Making it a gate before the subject is finished would turn a known gap
// into a red board nobody can clear.
//
// ── WHY IT CURRENTLY EARNS NOTHING, WITH THE EVIDENCE ───────────────────────────────────────────
// Measured, not guessed. Every scenario answers *"nothing independent of the action supports
// this at consequence grade"*, while the session's buffer holds two hundred network events. So
// the evidence exists and the claim never reaches it, and the reason is upstream of the verdict:
// **every plant is REFUSED**. `testid=login-submit` is how a person names a control; `act` takes
// a REF, which a query mints. The refusal is correct and was invisible -- the driver reported
// four driven scenarios because this runner reported a plant where the realm had reported a
// refusal.
//
// Fixing it needs something the interface does not currently offer. `Realm.perform` returns a
// RECEIPT and never data, which is right for an action and wrong for a query -- a query is a
// read. Reads are supposed to go through `describe`, and `describe` hardcodes a snapshot. So a
// driver cannot resolve a ref through the SPI at all. That is a gap in the interface, found by
// trying to use it, and it is recorded rather than patched around here: routing a read through
// `perform` would make the receipt carry data, which is exactly the shape the separation exists
// to prevent.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────────
// Ask Reticle's own verdict kernel anything. Every answer comes from the specification's
// `adjudicate`, through the binding, because scoring an implementation against its own rules
// makes every implementation conformant by construction.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { start, WebRealm, conformanceClient } from '@reticlehq/server';
import { driveAll } from './drive.mjs';
import { BENCH_APP_SUBJECT, plantUrl } from './subjects/bench-app.mjs';
import { Profile } from './scenarios/index.mjs';

const PORT = 4400;
const APP = 'http://localhost:4318';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The app under test. Its own dev server, so the run needs nothing already running. */
function bootApp() {
  return spawn(
    'pnpm',
    ['--filter', '@reticlehq/bench-app', 'exec', 'vite', '--port', '4318', '--strictPort'],
    {
      stdio: 'ignore',
      env: { ...process.env, RETICLE_PORT: String(PORT) },
    },
  );
}

/** Wait for the dev server to answer. Vite takes a moment, and a refused connection reads as a
 * broken runner rather than as one that started too early. */
async function waitForApp() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(APP);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`the bench app never answered on ${APP}`);
}

async function main() {
  const app = bootApp();
  const server = await start({ port: PORT, mcp: false });
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const report = { earned: undefined, failed: [], couldNotBePlanted: [], notes: {} };
  try {
    // Open the app BEFORE the driver asks anything. `driveAll` checks the handshake first, and
    // a blank page has no session, so the declaration comes back empty and the run is refused
    // before a scenario is driven. The refusal was correct -- scoring an implementation that
    // declared nothing would have credited it for evidence it never had -- but the cause was
    // this runner, not the implementation.
    await waitForApp();
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await liveRealm(server, page);
    // A client that plants by NAVIGATING, which is how this subject is put into a state. The
    // driver never learns that; it asks for a plant and is told whether one happened.
    /** The client that performed the last action, so `verify` sees its window. */
    let current;
    const client = {
      hello: async () => {
        const realm = await liveRealm(server, page);
        return realm === undefined ? { channels: [], commands: [] } : realm.client.hello();
      },
      command: async (_name, args) => {
        const url = plantUrl(APP, String(args?.scenario));
        if (url === undefined) return { planted: false, reason: 'no subject for this scenario' };
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const realm = await liveRealm(server, page);
        if (realm === undefined)
          return { planted: false, reason: 'the app never dialled the bridge' };
        // Held so `verify` gets the SAME client, and therefore the window the action happened
        // inside. A fresh client per call would open a new window after the fact and observe an
        // empty one -- which is how the first run of this scored the healthy app as unproved.
        current = realm.client;
        const entry = BENCH_APP_SUBJECT[String(args?.scenario)];
        if (entry?.act !== undefined) {
          // Resolve a handle first. `testid=login-submit` is how a person names a control; `act`
          // takes a ref. Handing the selector straight to `act` had every plant refused -- the
          // refusal was correct, and the interface had no way to bridge the two until `locate`.
          const handles = await realm.client.locate({
            by: 'testid',
            value: entry.act.target.replace('testid=', ''),
          });
          const ref = handles[0]?.ref;
          if (ref === undefined) {
            return { planted: false, reason: `nothing matched ${entry.act.target}` };
          }
          const receipt = await realm.client.command(entry.act.capability, { ref });
          if (receipt['planted'] !== true) {
            // Printed: an action refused after a handle resolved is the next thing to diagnose,
            // and a silent ABSENT would hide which half failed.
            console.log('   · act refused: ' + String(receipt['reason'] ?? 'no reason given'));
            return {
              planted: false,
              reason: String(receipt['reason'] ?? 'the action was refused'),
            };
          }
          await sleep(800);
        }
        return {
          planted: true,
          claim: {
            id: String(args?.scenario),
            statement: entry?.claim ?? 'nothing was declared',
            declaredAt: 'before-action',
            assertions:
              entry?.claim === undefined
                ? []
                : [{ id: 'a1', predicate: {}, reads: entry.claim, channels: entry.reads }],
          },
        };
      },
      verify: async (claim) => {
        if (current === undefined) return { verdict: 'unknown', reason: 'nothing was driven' };
        const out = await current.verify(claim);
        // Printed per scenario. A score that says only "failed" cannot be diagnosed, and four
        // things could produce a failure here of which only one is the implementation.
        console.log(`   · ${claim.id}: ${out.verdict}${out.reason ? ' — ' + out.reason : ''}`);
        return out;
      },
    };

    Object.assign(
      report,
      await driveAll(client, {
        name: 'reticle',
        version: process.env['npm_package_version'] ?? 'dev',
        platform: 'web',
        // Exactly what the SDK declares on connect, including `state` -- the bench app
        // registers a store, so the channel is real. The first run registered without it and the
        // handshake check refused to score, which is the check doing its job: a registration
        // that understates the implementation would have it scored on fewer scenarios than it
        // can answer, and one that overstates it would have it scored on evidence it never had.
        channels: ['ui', 'net', 'log', 'route', 'storage', 'time', 'signal', 'state'],
        profile: Profile.EFFECT,
      }),
    );
  } finally {
    await browser.close();
    await server.stop?.();
    app.kill();
  }

  print(report);
  // Exit 0 whichever way it lands. This measures; it does not gate. See the note at the top.
  process.exit(0);
}

/** The live session as a realm, or undefined if the app has not connected yet. */
async function liveRealm(server, page) {
  for (let i = 0; i < 40; i++) {
    const info = server.bridge.sessions.list()[0];
    const session = info === undefined ? undefined : server.bridge.sessions.get(info.sessionId);
    if (session !== undefined) {
      const realm = new WebRealm({ session, surface: 'web', now: () => session.elapsed() });
      return { realm, client: conformanceClient(realm, () => session.elapsed()) };
    }
    await sleep(250);
    void page;
  }
  return undefined;
}

function print(report) {
  console.log('\n=== OpenReality conformance: reticle, scored against its own specification ===\n');
  console.log(`  claimed : ${String(report.claimed ?? '-')}`);
  console.log(`  earned  : ${String(report.earned ?? 'none')}`);
  // The rejection path returns before a single scenario is driven, and printing only "none"
  // hides the difference between "we were scored and failed" and "we were never scored". Those
  // are the two facts this whole suite exists to keep apart.
  if (report.rejected !== undefined) {
    console.log(`  REJECTED: ${report.rejected.join('; ')}`);
    console.log('            nothing was driven -- this is not a score, it is a refusal to score');
  }
  if (report.failed?.length > 0) console.log(`  failed  : ${report.failed.join(', ')}`);
  if (report.couldNotBePlanted?.length > 0) {
    console.log(
      `  absent  : ${report.couldNotBePlanted.length} scenario(s) this subject cannot plant`,
    );
    for (const id of report.couldNotBePlanted) console.log(`              ${id}`);
  }
  console.log(
    '\n  A scenario nobody could plant is ABSENT, never a pass. The absent list is the honest\n' +
      '  half of this score and it is the fixture that is missing, not the implementation.\n',
  );
}

await main();
