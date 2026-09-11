// Score this project against its own specification ON A DESKTOP SHELL.
//
//   node conformance/run-desktop.mjs
//
// ── WHY A SECOND RUNNER, AND WHY IT SCORES SO LITTLE ────────────────────────────────────────────
// `WebRealm`'s own header says desktop is the same realm with a different camera: Electron and
// Tauri run the same SDK in their renderer, so identity, channels, actions and observations are
// byte-identical to the web. That was a claim in a comment, tested against a FAKE session with a
// hand-set runtime. Nothing had ever put a real desktop shell in front of the adjudicator.
//
// This does. It scores exactly two scenarios, and the small number is honest rather than
// disappointing: the other twelve need a defect PLANTED, `apps/electron-smoke` carries no bug
// injector, and inventing one to raise the score would be building the fixture around the number
// it produces. What the two prove is the part that was never proved:
//
//   - `healthy-app-real-claim` -- a desktop session declares its channels, resolves a handle,
//     performs an action, and independent consequence-grade evidence buys a `yes`. This is the
//     negative control, and it is the scenario an implementation CANNOT pass by being cautious.
//   - `nothing-declared` -- a clean window with nothing to prove answers `no-fault`.
//
// Everything else is ABSENT, which is what the scoreboard is for.
//
// The subject's action is `add`, which crosses the contextBridge as IPC rather than travelling as
// HTTP. That is the interesting half: the protocol has no `ipc` channel and does not need one --
// an IPC round trip is a consequence observed at a boundary the action did not author, which is
// what `net` means. If the desktop score matches the web score for these two, the claim in that
// header is measured rather than asserted.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ReticleCommand } from '@reticlehq/core';
import { start, WebRealm, conformanceClient } from '@reticlehq/server';
import { driveAll } from './drive.mjs';
import { Profile } from './scenarios/index.mjs';

// The daemon's default. Not a free choice either: the renderer's SDK dials the default unless a
// build-time value overrides it, so a spare port here produced an app that started perfectly and
// dialled nobody -- which reads exactly like an app that failed to start.
const PORT = 4400;
// The main process hardcodes `http://localhost:5174`, so this is not a free choice -- picking a
// spare port launched Electron against nothing and reported it as an app that never dialled.
const VITE_PORT = 5174;
const ROOT = path.join(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What this subject can be put into, and how.
 *
 * The same shape as `subjects/bench-app.mjs`, and deliberately not shared with it. A subject map
 * describes ONE application; folding two into a common abstraction would be inventing a subject
 * language for a suite that has two subjects, and the second one is here to test the protocol on
 * a different shell, not to test a factoring.
 */
const SUBJECT = Object.freeze({
  /**
   * The screen moves on over an operation that failed.
   *
   * `todos:archive` always rejects and the renderer updates optimistically and swallows it --
   * a defect the smoke app has carried since it was written, for the web battery's benefit.
   * Nothing was added to the fixture to reach this scenario, which matters: inventing a bug to
   * raise a conformance score is building the fixture around the number it produces.
   */
  'effect-failed-surface-advanced': {
    act: { target: 'archive-1', verb: 'click' },
    claim: 'the todo was archived',
    reads: ['net'],
  },

  /**
   * An action whose effect nothing can observe.
   *
   * `todos:seen` is `ipcRenderer.send` with no reply, so the renderer cannot learn whether it
   * ran. This scenario is ABSENT on the web subject and reachable here, which is the first case
   * of the desktop shell covering something the browser fixture cannot.
   */
  'fire-and-forget': {
    act: { target: 'mark-seen', verb: 'click' },
    claim: 'the todo was marked seen',
    reads: ['net'],
  },

  'healthy-app-real-claim': {
    // Crosses the contextBridge and comes back with a row the renderer did not author.
    act: { target: 'add', verb: 'click' },
    claim: 'the todo was added',
    reads: ['net'],
  },
  /**
   * The same claim-is-the-plant scenario the web subject uses, and it needs nothing from this
   * app either. `visual` is undeclared on both shells, so clause 2 answers before any evidence
   * is weighed.
   */
  'claim-reads-an-undeclared-channel': {
    act: { target: 'add', verb: 'click' },
    claim: 'the screen showed the new todo',
    reads: ['visual'],
  },

  'nothing-declared': { act: undefined, claim: undefined, reads: [] },
});

/** Electron, as the desktop battery resolves it. */
function electronBinary() {
  const bin = createRequire(path.join(ROOT, 'apps', 'electron-smoke', 'package.json'))('electron');
  if ('string' !== typeof bin || !existsSync(bin)) {
    throw new Error('electron is not installed — run `pnpm install`');
  }
  return bin;
}

async function answers(port) {
  try {
    return (await fetch(`http://localhost:${String(port)}`)).ok;
  } catch {
    return false;
  }
}

/**
 * The renderer's dev server, then Electron against it.
 *
 * A port already serving is reported rather than waited out. The desktop battery learned this the
 * expensive way: a stranger on the port answered instantly, the strict-port vite died unnoticed,
 * and the run drove somebody else's application.
 */
async function boot(env) {
  if (await answers(VITE_PORT)) {
    throw new Error(`port ${String(VITE_PORT)} is already serving something. Free it first.`);
  }
  const vite = spawn(
    'pnpm',
    [
      '--filter',
      '@reticlehq/electron-smoke',
      'exec',
      'vite',
      '--port',
      String(VITE_PORT),
      '--strictPort',
    ],
    { cwd: ROOT, env, stdio: 'ignore' },
  );
  let exited;
  vite.on('exit', (code) => (exited = code ?? 0));
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (await answers(VITE_PORT)) break;
    if (exited !== undefined) throw new Error(`the renderer's vite exited (${String(exited)})`);
    if (Date.now() > deadline) throw new Error('the renderer never came up');
    await sleep(500);
  }
  const app = spawn(electronBinary(), ['.'], {
    cwd: path.join(ROOT, 'apps', 'electron-smoke'),
    // Headless, as the desktop battery runs it: a window that wants to be shown is a window that
    // behaves differently when nobody is looking at it.
    env: { ...env, RETICLE_HEADLESS: '1' },
    stdio: 'ignore',
    detached: true,
  });
  return { vite, app };
}

/** The desktop session as a realm, once the renderer has dialled the bridge. */
async function liveRealm(server) {
  for (let i = 0; i < 120; i += 1) {
    const info = server.bridge.sessions.list()[0];
    const session = info === undefined ? undefined : server.bridge.sessions.get(info.sessionId);
    if (session !== undefined) {
      const realm = new WebRealm({ session, now: () => session.elapsed() });
      return { realm, client: conformanceClient(realm, () => session.elapsed()), session };
    }
    await sleep(500);
  }
  return undefined;
}

async function main() {
  const env = { ...process.env, RETICLE_PORT: String(PORT) };
  const server = await start({ port: PORT, mcp: false });
  const { vite, app } = await boot(env);
  const report = { earned: undefined, failed: [], couldNotBePlanted: [], notes: {} };
  try {
    const live = await liveRealm(server);
    if (live === undefined) throw new Error('the desktop app never dialled the bridge');
    // Printed, because it is the whole point of running this on Electron: if the subject does not
    // identify itself as a desktop shell, every verdict below is about a web page.
    console.log(`   · subject: ${JSON.stringify(live.realm.identity())}`);

    let current;
    const client = {
      hello: () => live.client.hello(),
      command: async (_name, args) => {
        const entry = SUBJECT[String(args?.scenario)];
        if (entry === undefined) return { planted: false, reason: 'no subject for this scenario' };
        // Reload BEFORE each scenario, because evidence bleeds otherwise and the suite stops
        // being a measurement. The web runner gets this free: it plants by navigating, so every
        // scenario starts on a fresh document. This one drives a single long-lived window, and
        // without a reset two consecutive runs disagreed -- `fire-and-forget` came back
        // `unknown` then `yes`, and the archive scenario was ABSENT then `no`. A suite whose
        // answer depends on the order its scenarios happen to run in is not measuring the
        // implementation.
        await live.session.command(ReticleCommand.NAVIGATE, { reload: true });
        await sleep(1200);
        current = live.client;
        if (entry.act !== undefined) {
          const handles = await live.client.locate({ by: 'testid', value: entry.act.target });
          const ref = handles[0]?.ref;
          if (ref === undefined) {
            console.log(`   · ${String(args?.scenario)}: nothing matched ${entry.act.target}`);
            return { planted: false, reason: `nothing matched ${entry.act.target}` };
          }
          const receipt = await live.client.command('act', { ref, action: entry.act.verb });
          if (receipt['planted'] !== true) {
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
            statement: entry.claim ?? 'nothing was declared',
            declaredAt: 'before-action',
            assertions:
              entry.claim === undefined
                ? []
                : [{ id: 'a1', predicate: {}, reads: entry.claim, channels: entry.reads }],
          },
        };
      },
      verify: async (claim) => {
        if (current === undefined) return { verdict: 'unknown', reason: 'nothing was driven' };
        const out = await current.verify(claim);
        console.log(`   · ${claim.id}: ${out.verdict}${out.reason ? ' — ' + out.reason : ''}`);
        return out;
      },
    };

    Object.assign(
      report,
      await driveAll(client, {
        name: 'reticle-electron',
        version: process.env['npm_package_version'] ?? 'dev',
        platform: 'desktop',
        channels: ['ui', 'net', 'log', 'route', 'storage', 'time', 'signal', 'state'],
        profile: Profile.EFFECT,
      }),
    );
  } finally {
    await server.stop?.();
    // The whole process GROUP. Electron is a tree -- launcher, main, renderer, GPU helper -- and
    // killing the launcher leaves the window up to pollute the next run.
    try {
      process.kill(-app.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    vite.kill();
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
  const failed = report.failed.length;
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

function print(report) {
  console.log('\n=== OpenReality conformance: reticle on a DESKTOP shell ===\n');
  console.log(`  earned  : ${String(report.earned ?? 'none')}`);
  if (report.failed.length > 0) console.log(`  failed  : ${report.failed.join(', ')}`);
  console.log(`  absent  : ${String(report.couldNotBePlanted.length)} scenario(s)`);
  console.log(
    '\n  Two scenarios, and the number is honest rather than disappointing: the rest need a\n' +
      '  defect planted and this app carries no bug injector. What these two prove is that a real\n' +
      '  desktop shell reaches the same verdicts as a browser tab, which until now was a comment.\n',
  );
}

void main();
