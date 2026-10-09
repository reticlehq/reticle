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
// number it prints today is seven of sixteen because our SUBJECT is incomplete, not because the
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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { start, WebRealm, conformanceClient } from '@reticlehq/server';
import { driveAll } from './drive.mjs';
import { writeWebHandoff } from './handoff.mjs';
import { BENCH_APP_CHANNELS, BENCH_APP_SUBJECT, plantUrl } from './subjects/bench-app.mjs';
import { Profile } from './scenarios/index.mjs';
// Batteries are not watched, and a shown browser changes their timing: hide every browser Reticle opens.
process.env.RETICLE_HEADLESS ??= '1';

/*
 * Overridable, because this repository gets worked on from more than one place at a time.
 *
 * The defaults are what CI uses and what the docs quote. The overrides exist for the case that
 * actually happened: a parallel session held 4318, and with no way to move there was nothing to do
 * but wait for somebody else's dev server to stop. The refusal below still applies to whatever
 * ports are chosen, so moving the run cannot quietly reintroduce the collision it is avoiding.
 */
const PORT = Number(process.env['CONFORMANCE_BRIDGE_PORT'] ?? 15401);
const APP_PORT = Number(process.env['CONFORMANCE_APP_PORT'] ?? 4318);
const API_PORT = Number(process.env['CONFORMANCE_API_PORT'] ?? 8787);
const APP = `http://localhost:${String(APP_PORT)}`;
const API = `http://localhost:${String(API_PORT)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Refuse to score against an app this runner did not start.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────────────────────────
 * `bootApp` binds 4318 with `--strictPort`, so when another process already holds it the vite dies
 * and the run carries on — driving whatever IS on 4318. That happened: a parallel session had
 * `apps/vibe-builder-demo` on the port, the runner drove it, and the gate reported
 *
 *   conformance: 2 plantable scenario(s) answered wrongly:
 *     claim-written-after-the-action, healthy-app-real-claim
 *
 * about an app it had never started, which was serving `?bug=mock-data` on purpose. A release was
 * held on it. The reverse is the worse case and the reason this is a refusal rather than a warning:
 * a stranger's app that happens to behave could score a PASS, and a green conformance run is the
 * one number here that is supposed to mean something.
 *
 * `apps/e2e/run-ci.sh` already refuses on exactly this reasoning. The rule was written down in one
 * place and not the other, twice now in this repository.
 */
function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 1000).unref?.();
  });
}

async function refuseIfPortsAreTaken() {
  for (const [port, what] of [
    [APP_PORT, 'the bench app'],
    [API_PORT, 'the demo API'],
    // The bridge was missing from this list, which is the port that actually collides: a daemon
    // left running by any other work on this machine owns 4400, and the run died on a raw
    // EADDRINUSE stack trace from inside `start()` instead of the sentence below. A guard that
    // checks two of the three ports reads as "ports are checked" and is why this was not noticed.
    [PORT, 'the bridge it starts itself'],
  ]) {
    if (!(await listening(port))) continue;
    console.error(
      `conformance: port ${port} is already in use, and this run would score against whatever is ` +
        `serving it rather than ${what} it starts itself. Free it and re-run.`,
    );
    process.exit(1);
  }
}

/** The app under test. Its own dev server, so the run needs nothing already running. */
/**
 * The bench app, in its own process GROUP so the whole thing can be killed.
 *
 * `pnpm exec vite` is a wrapper around a child, and killing the wrapper leaves vite holding
 * 4318 for the next run to trip over. The desktop runner already says this about Electron --
 * "killing the launcher leaves the window up to pollute the next run" -- and the shape here is
 * the same tree one level shallower. Measured after a clean conformance run: 8787 released,
 * 4318 still listening, owned by a vite whose wrapper had been asked to stop.
 */
function bootApp() {
  return spawn(
    'pnpm',
    [
      '--filter',
      '@reticlehq/bench-app',
      'exec',
      'vite',
      '--port',
      String(APP_PORT),
      '--strictPort',
    ],
    {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, RETICLE_PORT: String(PORT) },
    },
  );
}

/**
 * The backend the app posts to. Booting only the app was enough to make the page RENDER and
 * nowhere near enough to make it WORK: with nothing on 8787 every `POST /api/login` answered
 * `Failed to fetch`, in the planted runs and in the healthy control alike. A plant that makes a
 * request fail cannot be distinguished from a request that already fails, so three scenarios
 * scored `yes` off an app whose sign-in had never once succeeded -- including the negative
 * control, whose whole job is to be the one run where the app really works.
 */
function bootApi() {
  return spawn('node', ['server.mjs'], {
    cwd: new URL('../apps/api/', import.meta.url),
    stdio: 'ignore',
    // `API_PORT` is what apps/api/server.mjs reads. Passed explicitly so moving the run moves the
    // API with it: the refusal above would otherwise clear a port the API then does not use.
    env: { ...process.env, API_PORT: String(API_PORT) },
  });
}

/** Wait for the dev server to answer. Vite takes a moment, and a refused connection reads as a
 * broken runner rather than as one that started too early. */
async function waitFor(url, what) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${what} never answered on ${url}`);
}

/**
 * The negative control: make the subject lie, and require the gate to notice.
 *
 * `gate:install` has `gate:install:self-test`, which mis-wires every scaffold and demands a RED
 * run, and CI runs it FIRST: if the negative control ever passes, the real run's green means
 * nothing. `gate:multi` and the stale-issue check have the same. This gate did not, which is
 * the one that matters most -- it is the whole evidence for "our web and desktop surfaces
 * implement the protocol", and it had never been shown able to fail.
 *
 * The lie chosen is the most consequential one a subject can tell: every claim held. Scenarios
 * whose right answer is `no`, `unknown` or `no-fault` are then answered wrongly, `failed` rises
 * above zero, and `--gate` must exit non-zero. A subject that says yes to everything is exactly
 * the false green this entire product exists to prevent, so it is the right thing to plant.
 *
 * What this proves and what it does not. It exercises the real driver, the real scenarios, the
 * real adjudicator and the real scoring, and it proves the path from a wrong answer to a
 * non-zero exit is connected. It does NOT prove the browser automation is sound: the lie is
 * injected at the client seam rather than inside the app, so a subject that drives nothing at
 * all would still be caught here, and would not be caught by this alone.
 */
function dishonestIfSelfTesting(client) {
  if (!process.argv.includes('--self-test')) return client;
  return {
    ...client,
    verify: async () => ({ verdict: 'yes', ground: 'proved', reason: 'self-test: always yes' }),
  };
}

async function main() {
  const state = mkdtempSync(join(tmpdir(), 'reticle-web-conformance-'));
  const token = randomBytes(24).toString('hex');
  writeFileSync(join(state, 'pairing-token'), token, { mode: 0o600 });
  process.env.RETICLE_STATE_DIR = state;
  process.env.RETICLE_PAIRING_TOKEN_DIR = state;
  process.env.VITE_RETICLE_TOKEN = token;
  process.env.RETICLE_TELEMETRY = '0';
  // Declared out here and started INSIDE the try, so the finally can reach whatever got as far
  // as existing.
  //
  // They used to start above the try: app, api, bridge, browser, in that order. Anything that
  // threw after the first one leaked every process before it, and `start()` binding a busy port
  // is the one that actually does. Observed twice: a conformance run died on `EADDRINUSE 4400`
  // and left `apps/api` holding 8787 with its parent gone, which the e2e battery then refused to
  // run against -- correctly, since a battery pointed at somebody else's app is a measurement of
  // nothing. Forty minutes later the orphan was still there.
  let app;
  let api;
  let server;
  let browser;
  const report = { earned: undefined, failed: [], couldNotBePlanted: [], notes: {} };
  try {
    await refuseIfPortsAreTaken();
    app = bootApp();
    api = bootApi();
    server = await start({ port: PORT, mcp: false });
    browser = await chromium.launch();
    const page = await browser.newPage();
    // Open the app BEFORE the driver asks anything. `driveAll` checks the handshake first, and
    // a blank page has no session, so the declaration comes back empty and the run is refused
    // before a scenario is driven. The refusal was correct -- scoring an implementation that
    // declared nothing would have credited it for evidence it never had -- but the cause was
    // this runner, not the implementation.
    await waitFor(`${API}/api/health`, 'the demo backend');
    await waitFor(APP, 'the bench app');
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
          const receipt = await realm.client.command(entry.act.capability, {
            ref,
            action: entry.act.verb,
            // Only one scenario sets this: a window deliberately shorter than the work.
            ...(entry.budgetMs === undefined ? {} : { budgetMs: entry.budgetMs }),
          });
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
            // From the subject, not hardcoded. Both runners pinned this to `before-action`,
            // so clause 8 could never fire and an implementation that ignored the field
            // entirely would have scored exactly the same.
            declaredAt: entry?.declaredAt ?? 'before-action',
            assertions:
              entry?.claim === undefined
                ? []
                : [
                    {
                      id: 'a1',
                      // A subject that has one gets a real predicate the specification can
                      // evaluate; the rest still carry an empty one, which evaluates to
                      // "nobody checked" rather than to a pass.
                      predicate: entry?.predicate ?? {},
                      reads: entry.claim,
                      channels: entry.reads,
                    },
                  ],
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
      await driveAll(dishonestIfSelfTesting(client), {
        name: 'reticle',
        version: process.env['npm_package_version'] ?? 'dev',
        platform: 'web',
        // The first run registered without `state` and the handshake check refused to score,
        // which is the check doing its job: a registration that understates the implementation
        // would have it scored on fewer scenarios than it can answer, and one that overstates
        // it would have it scored on evidence it never had.
        channels: [...BENCH_APP_CHANNELS],
        // `effect`, and NOT because that is the most this implementation could claim. Measured:
        // the channels above satisfy every profile's requirement, `surface` included --
        //
        //   effect    net, log
        //   in-realm  net, log, state, signal
        //   surface   net, log, state, signal, ui
        //
        // so the channel gate in `profileEarned` would pass at any of the three. What stops a
        // higher claim is FIXTURES: `subjects/bench-app.mjs` can plant seven of sixteen
        // scenarios and none of the four above `effect`. Claiming `surface` would move those
        // four from "not asked" to ABSENT and buy no new evidence -- a bigger denominator and
        // the same numerator, which is the participation trophy this suite is built to refuse.
        //
        // The comment on `channels` above already reasons about understating and overstating a
        // registration. That reasoning applies to this line too and was not written here, so
        // the claim read as the ceiling when it is a floor. Raise it when the bench app grows a
        // planter for an `in-realm` scenario, not before.
        profile: Profile.EFFECT,
      }),
    );
  } finally {
    await browser?.close();
    await server?.stop?.();
    if (undefined !== app?.pid) {
      // The group, not the wrapper. See bootApp.
      try {
        process.kill(-app.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    api?.kill();
  }

  print(report);
  // ── EXIT ────────────────────────────────────────────────────────────────────────────────────
  //
  // Zero by default: this measures, and a measurement that fails a build teaches people to stop
  // taking it. `--gate` is the narrow promise it CAN keep.
  //
  // What is gated is REGRESSION, never the score. `earned` is `none` and will stay `none` until
  // the fixture grows, because five scenarios have no plant and ABSENT is never a pass -- gating
  // on that would be a red board nobody can clear, which is the objection recorded at the top of
  // this file and it still holds. `failed` is different: it means a scenario we CAN plant was
  // driven and the implementation gave the wrong answer. That is always a defect, and it is
  // clearable today, because the number is zero.
  // Hand this surface's answers to whatever runs next, so the desktop pass can check that the
  // two agree rather than only that each is internally fine. Written unconditionally and to a
  // temp path: it is a handoff between two processes in one `gate:conformance`, not an
  // artifact anybody keeps.
  writeWebHandoff(
    { at: Date.now(), outcomes: report.outcomes ?? {} },
    process.argv.includes('--self-test'),
  );

  const failed = report.failed.length;
  if (process.argv.includes('--self-test')) {
    // Inverted on purpose: the control passes only when the gate would have FAILED.
    if (0 === failed) {
      console.error(
        '\nSELF-TEST FAILED: a subject answering "yes" to every claim was scored clean.\n' +
          'Whatever this gate is measuring, it is not whether the answers are right, and a\n' +
          'green run of it proves nothing.\n',
      );
      process.exit(1);
    }
    console.log(
      `\nself-test passed: a subject that says yes to everything was caught on ` +
        `${String(failed)} scenario(s).\n`,
    );
    process.exit(0);
  }
  if (process.argv.includes('--gate') && failed > 0) {
    console.error(
      `\nconformance: ${String(failed)} plantable scenario(s) answered wrongly: ` +
        `${report.failed.join(', ')}\n` +
        'ABSENT scenarios are not counted here -- only ones that were driven and got it wrong.\n',
    );
    process.exit(1);
  }
  process.exit(0);
}

/** The live session as a realm, or undefined if the app has not connected yet. */
async function liveRealm(server, page) {
  for (let i = 0; i < 40; i++) {
    const info = server.bridge.sessions.list()[0];
    const session = info === undefined ? undefined : server.bridge.sessions.get(info.sessionId);
    if (session !== undefined) {
      const realm = new WebRealm({ session, now: () => session.elapsed() });
      return { realm, client: conformanceClient(realm, () => session.elapsed()) };
    }
    await sleep(250);
    void page;
  }
  return undefined;
}

function print(report) {
  console.log(
    '\n=== OpenVerification conformance: reticle, scored against its own specification ===\n',
  );
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
  // Not scored and not a mark against the implementation -- but printed, because "it could not
  // answer" and "we did not ask" are different facts and this block used to print only the
  // first. With `effect` claimed, four of sixteen scenarios appeared in no line at all while
  // the footer below called the list "the honest half of this score".
  if (report.outOfProfile?.length > 0) {
    console.log(
      `  not asked: ${report.outOfProfile.length} scenario(s) above the claimed profile ` +
        `(${String(report.claimed)})`,
    );
    for (const id of report.outOfProfile) console.log(`              ${id}`);
  }
  console.log(
    '\n  A scenario nobody could plant is ABSENT, never a pass. The absent list is the honest\n' +
      '  half of this score and it is the fixture that is missing, not the implementation.\n' +
      '  The "not asked" list is neither: those scenarios belong to a profile this subject did\n' +
      '  not claim, so they were never offered. Claiming higher is what puts them in play.\n',
  );
}

await main();
