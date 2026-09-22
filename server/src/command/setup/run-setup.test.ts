import { describe, expect, it } from 'vitest';
import { runSetupPhases, SetupPhase, type SetupEffects, type SetupInput } from './run-setup.js';
import { AppShape } from './desktop-shape.js';
import type { CandidateSession } from './session-pick.js';
import type { PageProbe } from './probe/page-probe.js';

const INPUT: SetupInput = {
  appDir: '/app',
  devCommand: 'npm run dev',
  openBrowser: true,
  shape: AppShape.WEB,
  phaseTimeoutMs: 1_000,
  pollMs: 1,
};

/** A world that behaves, with each part overridable to make exactly one thing go wrong. */
function world(
  over: Partial<SetupEffects> = {},
  opts: { url?: string } = {},
): SetupEffects & { opened: string[] } {
  let clock = 0;
  const opened: string[] = [];
  const url = opts.url ?? 'http://localhost:5173';
  const base: SetupEffects = {
    startDevServer: () => Promise.resolve(),
    devServerOutput: () => `  Local: ${url}`,
    devServerExited: () => false,
    devServerQuietForMs: () => 0,
    observedPorts: () => [],
    probePage: (): Promise<PageProbe> => Promise.resolve({ served: true, sdkInPage: true }),
    openBrowser: (u: string) => {
      opened.push(u);
      return Promise.resolve();
    },
    listSessions: (): Promise<CandidateSession[]> => Promise.resolve([{ sessionId: 'new', url }]),
    now: () => (clock += 10),
    sleep: () => Promise.resolve(),
    note: () => undefined,
    ...over,
  };
  return Object.assign(base, { opened });
}

describe('the whole sequence, when everything works', () => {
  /*
   * Onboarding ends at a connected app, and that IS the proof the install worked: the SDK is in
   * the page, the bridge paired, and the tools have something to talk to.
   *
   * Proving a FLOW is the next stage and a different command. This one used to spawn a SECOND
   * agent CLI to do it, which is why a run on Windows reported "⚠ setup did not finish" over
   * wiring that had succeeded completely — the `.cmd` shim npm installs cannot be spawned without
   * a shell, so the child never started.
   */
  it('ends when the app is connected, and drives nothing itself', async () => {
    const fx = world();
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(true);
    expect(r.reachedPhase).toBe(SetupPhase.CONNECT);
    expect(r.fallback).toEqual([]);
  });

  // The stage that DOES prove a flow has to be named, or "connected" reads as "finished".
  it('names the first run, so the caller knows this is not the end', async () => {
    const r = await runSetupPhases(INPUT, world());
    expect(r.notes.join(' ')).toContain('explore');
  });

  it('opens the url the dev server announced, never one it composed', async () => {
    const fx = world({ devServerOutput: () => '  ➜  Local: http://127.0.0.1:4321/' });
    const r = await runSetupPhases(INPUT, fx);
    expect(fx.opened).toEqual(['http://127.0.0.1:4321']);
    expect(r.url).toBe('http://127.0.0.1:4321');
  });

  it('starts nothing when the caller says the app is already served', async () => {
    let started = false;
    const fx = world({
      startDevServer: () => {
        started = true;
        return Promise.resolve();
      },
    });
    await runSetupPhases({ ...INPUT, suppliedUrl: 'http://localhost:3000' }, fx);
    expect(started).toBe(false);
  });
});

/**
 * `init` started a second Vite on 5174 while 5173 was already serving the same project, leaving
 * three sessions and no way to pick. The judgement already existed (`ALREADY_SERVING`); the spawn
 * path never asked it. Prefer the live server this project announced over starting another.
 */
describe('it never starts a second server for this project', () => {
  const EXISTING = 'http://localhost:5173';

  it('uses the running server instead of starting another', async () => {
    let started = false;
    const fx = world({
      startDevServer: () => {
        started = true;
        return Promise.resolve();
      },
      existingAppUrl: () => Promise.resolve(EXISTING),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(started, 'must not spawn a second Vite beside the one that is up').toBe(false);
    expect(r.url).toBe(EXISTING);
    expect(r.notes.join(' ')).toMatch(/already running/i);
  });

  it('drives the tab that is already connected, and does not open another', async () => {
    const fx = world({
      existingAppUrl: () => Promise.resolve(EXISTING),
      listSessions: () => Promise.resolve([{ sessionId: 'already-there', url: EXISTING }]),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(fx.opened, 'a second tab is how three sessions appear').toEqual([]);
    expect(r.sessionId).toBe('already-there');
    expect(r.ok).toBe(true);
  });

  it('still starts one when nothing for this project is up', async () => {
    let started = false;
    const fx = world({
      startDevServer: () => {
        started = true;
        return Promise.resolve();
      },
      existingAppUrl: () => Promise.resolve(undefined),
    });
    await runSetupPhases(INPUT, fx);
    expect(started).toBe(true);
  });

  it('still opens a tab when the server is up but nothing has connected', async () => {
    const fx = world({
      existingAppUrl: () => Promise.resolve(EXISTING),
      listSessions: () => Promise.resolve([]),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(fx.opened).toEqual([EXISTING]);
    expect(r.ok).toBe(false);
    expect(r.reachedPhase).toBe(SetupPhase.CONNECT);
  });

  it('still refuses a session that is not on this app', async () => {
    const fx = world({
      existingAppUrl: () => Promise.resolve(EXISTING),
      listSessions: () => Promise.resolve([{ sessionId: 'other', url: 'http://localhost:9999/' }]),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(false);
    expect(r.sessionId).toBeUndefined();
  });
});

describe('when it cannot continue, it says what is left', () => {
  // Writing files is not an install, so none of these may report ok.
  it('stops rather than inventing a dev command', async () => {
    const r = await runSetupPhases({ ...INPUT, devCommand: undefined }, world());
    expect(r.ok).toBe(false);
    expect(r.reachedPhase).toBe(SetupPhase.DEV_SERVER);
    expect(r.fallback.join(' ')).toContain('dev script');
  });

  it('reports a dev server that exited without serving', async () => {
    const fx = world({
      devServerExited: () => true,
      probePage: () => Promise.resolve({ served: false, sdkInPage: false }),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.reachedPhase).toBe(SetupPhase.DEV_SERVER);
    expect(r.notes.join(' ')).toContain('exited');
  });

  it('names the port when CRA says it is already in use (#802)', async () => {
    const fx = world({
      devServerExited: () => true,
      probePage: () => Promise.resolve({ served: false, sdkInPage: false }),
      devServerOutput: () =>
        'Something is already running on port 3000.\nWould you like to run the app on another port instead?',
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.reachedPhase).toBe(SetupPhase.DEV_SERVER);
    expect(r.notes.join(' ')).toContain('port 3000 is already in use');
    expect(r.notes.join(' ')).not.toContain('exited without serving anything');
  });

  // astro dev forks the real server and returns. serving outranks the launcher having exited.
  it('carries on when the launcher exited but the port answers', async () => {
    const fx = world({ devServerExited: () => true });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(true);
  });

  it('explains what the page looked like when nothing connected', async () => {
    const fx = world({
      listSessions: () => Promise.resolve([]),
      probePage: () => Promise.resolve({ served: true, sdkInPage: false }),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.reachedPhase).toBe(SetupPhase.CONNECT);
    expect(r.notes.join(' ')).toContain('before the build config was edited');
    expect(r.fallback.join(' ')).toContain('reticle_session { action: "list" }');
  });

  // The false green this guards: another tab on the same daemon is not this install.
  it("never accepts somebody else's session", async () => {
    const fx = world({
      listSessions: () => Promise.resolve([{ sessionId: 'other', url: 'http://localhost:9999/' }]),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(false);
    expect(r.sessionId).toBeUndefined();
  });

  /**
   * Onboarding stops at connected, so "the drive proved nothing" is no longer a thing this command
   * can report. It used to: a CI runner has no `claude`, `codex`, `opencode`, `cursor-agent` or
   * `gemini`, so `init` printed `⚠ setup did not finish` and exited 1 with every step ✓, the app
   * booted and the daemon up. On Windows it was worse — the agent CLIs npm installs are `.cmd`
   * shims, which cannot be spawned without a shell, so the drive failed on EVERY machine.
   *
   * The stage that proves a flow now runs a model inside the daemon, which needs no CLI on the box.
   */
  it('succeeds on a machine with no agent CLI at all', async () => {
    const r = await runSetupPhases(INPUT, world());
    expect(r.ok).toBe(true);
    expect(r.reachedPhase).toBe(SetupPhase.CONNECT);
  });

  it('does not claim a flow was saved, because it drove nothing', async () => {
    expect((await runSetupPhases(INPUT, world())).flowSaved).toBe(false);
  });
});

describe('a desktop app', () => {
  // The harmful one: the app's own window is the client, so a browser tab would be a SECOND session
  // that is not the app — the stale-tab false green, arranged deliberately.
  it('never opens a browser, even with openBrowser on', async () => {
    const fx = world();
    await runSetupPhases({ ...INPUT, shape: AppShape.TAURI, openBrowser: true }, fx);
    expect(fx.opened).toEqual([]);
  });

  // Tauri serves its webview from tauri://localhost. Nothing outside can fetch it, so waiting for an
  // HTTP response would fail an app that is running perfectly.
  it('does not require the url to answer before looking for a session', async () => {
    const fx = world({ probePage: () => Promise.resolve({ served: false, sdkInPage: false }) });
    const r = await runSetupPhases({ ...INPUT, shape: AppShape.TAURI }, fx);
    expect(r.ok).toBe(true);
    expect(r.reachedPhase).toBe(SetupPhase.CONNECT);
  });

  it('says why there is no browser and why the wait is long', async () => {
    const fx = world();
    const r = await runSetupPhases({ ...INPUT, shape: AppShape.ELECTRON }, fx);
    expect(r.notes.join(' ')).toContain('own window is the client');
  });

  // There is no page to describe when nothing outside the app can fetch it, so the advice has to be
  // desktop-shaped rather than "restart your dev server".
  it('gives desktop advice when nothing connects, not page advice', async () => {
    const fx = world({ listSessions: () => Promise.resolve([]) });
    const r = await runSetupPhases({ ...INPUT, shape: AppShape.TAURI, phaseTimeoutMs: 1 }, fx);
    expect(r.notes.join(' ')).toContain('preload');
    expect(r.notes.join(' ')).not.toContain('build config was edited');
  });
});

describe('opting out', () => {
  it('--no-open still requires something to connect', async () => {
    const fx = world({ listSessions: () => Promise.resolve([]) });
    const r = await runSetupPhases({ ...INPUT, openBrowser: false }, fx);
    expect(fx.opened).toEqual([]);
    expect(r.ok).toBe(false);
  });
});

/**
 * The words the break-matrix asserts.
 *
 * It is a negative control: it builds environments designed to break setup and judges each one on
 * whether the output NAMES the cause. The sentences were written in setup/reticle.mjs; porting the
 * runtime phase into `init` carried the behaviour but not the wording, so scenarios reported
 * `never said "..."` against runs that had diagnosed the problem correctly.
 *
 * Pinned here because prose is the deliverable on this path — a user reads it after waiting out a
 * timeout, and an agent greps it.
 */
describe('the dev-server diagnoses name their cause', () => {
  const notesFrom = async (
    over: Partial<SetupEffects>,
    input: Partial<SetupInput> = {},
  ): Promise<string> => {
    const lines: string[] = [];
    await runSetupPhases({ ...INPUT, ...input }, world({ ...over, note: (l) => lines.push(l) }));
    return lines.join('\n');
  };

  // "stop here rather than invent one" — the SKILL.md rule. Inventing a dev command is how a setup
  // script runs the wrong thing and reports success.
  it('refuses to invent a dev command, in those words', async () => {
    const out = await notesFrom({}, { devCommand: undefined });
    expect(out).toContain('rather than invent');
  });

  it('says the dev server exited', async () => {
    const out = await notesFrom({ devServerExited: () => true, devServerOutput: () => '' });
    expect(out).toContain('dev server exited');
  });

  // Both halves matter: a server that prints nothing but IS listening is the CRA case and must not
  // be failed, so the sentence has to say that both were checked.
  it('says it checked BOTH the output and the ports', async () => {
    const out = await notesFrom({
      devServerOutput: () => 'starting...',
      observedPorts: () => [],
      devServerQuietForMs: () => 60_000,
    });
    expect(out).toContain('neither printed a URL nor bound a port');
  });
});

/**
 * An explicit `--timeout` is the caller's budget, including for the connect wait.
 *
 * The deadline was `max(phaseTimeoutMs, policy.connectBudgetMs)`, so a caller asking for 3 seconds
 * got the policy's 120 — the flag could only ever LENGTHEN the wait, never shorten it. A timeout the
 * tool ignores is a lie, and it is the reason every hostile-environment scenario that reaches this
 * phase was killed by its own harness before setup could say what was wrong.
 *
 * The policy budget stays the DEFAULT — a desktop shell genuinely needs longer, and nobody who said
 * nothing should get a shorter wait than before.
 */
describe('the connect wait honours an explicit budget', () => {
  const ranFor = async (over: Partial<SetupInput>): Promise<number> => {
    let last = 0;
    const fx = world({
      listSessions: () => Promise.resolve([]),
      now: () => (last += 1000),
      // Served, WITH the SDK: this measures which budget is chosen, so the run has to be one that
      // opens a browser and therefore earns the full wait. A page that never serves now gets a
      // deliberate short grace instead (see "opening the browser at the moment the app can be
      // driven"), which would make these numbers a measurement of that rule rather than this one.
      probePage: () => Promise.resolve({ served: true, sdkInPage: true }),
    });
    // A supplied url skips the dev-server phase, so what this measures is the CONNECT wait and
    // nothing else. Without it the numbers came from the dev-server loop and said nothing about the
    // budget under test.
    await runSetupPhases({ ...INPUT, suppliedUrl: 'http://localhost:5173', ...over }, fx);
    return last;
  };

  it('gives up at the budget the caller named', async () => {
    const elapsed = await ranFor({ connectBudgetMs: 3_000, phaseTimeoutMs: 3_000 });
    expect(elapsed).toBeLessThan(30_000);
  });

  it('falls back to the policy budget when the caller said nothing', async () => {
    const elapsed = await ranFor({ phaseTimeoutMs: 1_000 });
    expect(elapsed).toBeGreaterThan(100_000);
  });
});

/**
 * The requirement has to REACH pickSession, which is the half a unit test of pickSession cannot see.
 *
 * A desktop shell serves its renderer from an ordinary dev server, so a browser tab left open on the
 * same origin looks like the app here — live, on the url, SDK present — while having none of its IPC.
 */
describe('a desktop setup is only satisfied by the desktop window', () => {
  const onUrl = (sessionId: string, runtime?: string): CandidateSession => ({
    sessionId,
    url: 'http://localhost:5173',
    ...(runtime === undefined ? {} : { runtime }),
  });

  it('does not accept a browser tab as an electron app', async () => {
    const outcome = await runSetupPhases(
      { ...INPUT, shape: AppShape.ELECTRON },
      world({ listSessions: () => Promise.resolve([onUrl('tab', 'web')]) }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reachedPhase).toBe(SetupPhase.CONNECT);
  });

  it('accepts the electron window', async () => {
    const outcome = await runSetupPhases(
      { ...INPUT, shape: AppShape.ELECTRON },
      world({ listSessions: () => Promise.resolve([onUrl('shell', 'electron')]) }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.sessionId).toBe('shell');
  });

  // Web is unchanged: the runtime is not a distinction there.
  it('still accepts a browser tab for a web app', async () => {
    const outcome = await runSetupPhases(
      { ...INPUT, shape: AppShape.WEB },
      world({ listSessions: () => Promise.resolve([onUrl('tab', 'web')]) }),
    );
    expect(outcome.ok).toBe(true);
  });
});

/**
 * The window is what the person watching actually sees, so WHEN it opens is the feature.
 *
 * Both halves of this were wrong in opposite directions within a day. First the browser opened
 * before anything checked the page, so a mis-wired app put a real window in front of someone and
 * then did nothing for the whole connect budget. Gating it on one probe fixed that and introduced
 * this: the probe runs the instant the dev server answers, which is NOT the instant its page
 * carries the SDK — after a config edit Vite restarts and re-optimises — so a perfectly good
 * install could read SDK_MISSING, open no window, and then wait out the entire budget for a session
 * that nothing was left to create.
 */
describe('opening the browser at the moment the app can be driven', () => {
  it('waits for the SDK to reach the page rather than judging on the first fetch', async () => {
    let fetches = 0;
    const fx = world({
      // Ready on the third look: the shape of a dev server that answered before its bundle caught up.
      probePage: () => {
        fetches += 1;
        return Promise.resolve({ served: true, sdkInPage: fetches >= 3 });
      },
    });
    await runSetupPhases({ ...INPUT }, fx);
    expect(fx.opened, 'a window that would have worked was never opened').toEqual([
      'http://localhost:5173',
    ]);
  });

  /**
   * The install gate caught this on Nuxt and React Router in the same run, and it is the reason the
   * presence check decides WHEN to open and never WHETHER. Nuxt's connect is a `.client.ts` plugin,
   * React Router's is a module in the route tree: both are delivered in the JS bundle, so the served
   * HTML never carries the SDK and never will. Gating the window on that signal meant the app was
   * never loaded, no session could appear, and `init` exited 1 on a correct install.
   */
  it('still opens for a framework that delivers the SDK in the bundle, not the HTML', async () => {
    const fx = world({
      // Served, forever without the SDK in the document — the Nuxt/React Router shape.
      probePage: () => Promise.resolve({ served: true, sdkInPage: false }),
    });
    const outcome = await runSetupPhases(INPUT, fx);
    expect(fx.opened, 'the window that loads the bundle was never opened').toEqual([
      'http://localhost:5173',
    ]);
    expect(outcome.ok, 'a correct install reported failure').toBe(true);
  });

  it('does not spend the whole connect budget waiting when it opened nothing', async () => {
    let now = 0;
    const fx = world({
      // Nothing answers: the only case where a window is certainly useless.
      probePage: () => Promise.resolve({ served: false, sdkInPage: false }),
      listSessions: () => Promise.resolve([]),
      now: () => (now += 100),
    });
    // A supplied url skips the dev-server phase, so `served: false` speaks only to the browser
    // decision under test rather than stalling the readiness wait ahead of it.
    const outcome = await runSetupPhases(
      { ...INPUT, suppliedUrl: 'http://localhost:5173', connectBudgetMs: 600_000 },
      fx,
    );
    expect(fx.opened, 'nothing should have been opened').toEqual([]);
    // The budget was ten minutes. A run that opened no window must not have burned it.
    expect(now, 'waited as if a browser had been opened').toBeLessThan(60_000);
    expect(outcome.reachedPhase).toBe(SetupPhase.CONNECT);
  });
});

/**
 * The daemon's account of why nothing connected, which setup had and did not print.
 *
 * `page-probe.ts` says in its own opening paragraph that the daemon's diagnosis "is the one to lead
 * with" and that the page finding "adds only the page-side fact". Only the second half was ever
 * wired: on a failed connect, setup printed the page sentence alone.
 *
 * That sentence is unconditional on SDK_PRESENT -- "never dialled the bridge", then three candidate
 * causes. Driven on a machine where a daemon belonging to ANOTHER project held the bridge port, it
 * was the opposite of the truth: the SDK dialled, presented its pairing token and was REFUSED, and
 * the daemon had logged `authentication_failed` with both project ids a second earlier. All three
 * causes it offers are wrong there, and each one sends the reader to inspect something that is fine.
 */
describe('a failed connect leads with what the daemon knows', () => {
  const noSession = {
    listSessions: (): Promise<CandidateSession[]> => Promise.resolve([]),
  };

  it("prints the daemon's reason before the page finding", async () => {
    const notes: string[] = [];
    const fx = world({
      ...noSession,
      daemonWhy: () =>
        Promise.resolve({
          lead: 'no browser session connected, and the reason is not the app: this daemon REFUSED the last page that dialled it',
        }),
      note: (line: string) => notes.push(line),
    });
    await runSetupPhases(INPUT, fx);
    const whyAt = notes.findIndex((n) => n.includes('REFUSED the last page'));
    const pageAt = notes.findIndex((n) => n.includes('never dialled the bridge'));
    expect(whyAt).toBeGreaterThanOrEqual(0);
    expect(pageAt).toBeGreaterThanOrEqual(0);
    expect(whyAt).toBeLessThan(pageAt);
  });

  it('still prints the page finding when the daemon has nothing to say', async () => {
    const notes: string[] = [];
    const fx = world({
      ...noSession,
      daemonWhy: () => Promise.resolve(undefined),
      note: (line: string) => notes.push(line),
    });
    await runSetupPhases(INPUT, fx);
    expect(notes.join('\n')).toContain('never dialled the bridge');
  });

  it('is unchanged when nothing supplies a daemon reason at all', async () => {
    const notes: string[] = [];
    const fx = world({ ...noSession, note: (line: string) => notes.push(line) });
    await runSetupPhases(INPUT, fx);
    expect(notes.join('\n')).toContain('never dialled the bridge');
  });

  /*
   * The agent surface must not be the human one.
   *
   * `init --json` is read by an agent, and what it acts on is the differential behind the lead --
   * the ports actually scanned, and the lease that opens a URL on a machine with no browser. When
   * the lead alone was both printed AND recorded, that differential vanished from `--json`
   * entirely: `break/break-matrix.mjs` (`no-browser-to-open`) greps the run for `reticle_lease` and
   * went red, because nothing in the output said it any more.
   */
  it('prints the lead to the person and records the full reason for the agent', async () => {
    const notes: string[] = [];
    const fx = world({
      ...noSession,
      daemonWhy: () =>
        Promise.resolve({
          lead: 'no browser session connected. Two things to weigh.',
          full: 'no browser session connected. Two things to weigh. The scan covers a fixed set of ports and nothing else, so open it with reticle_lease {action:"acquire", url}.',
        }),
      note: (line: string) => notes.push(line),
    });
    const out = await runSetupPhases(INPUT, fx);
    expect(notes.join('\n')).not.toContain('reticle_lease');
    expect(out.notes.join('\n')).toContain('reticle_lease');
  });

  it('records the lead when that is all the daemon has', async () => {
    const fx = world({
      ...noSession,
      daemonWhy: () => Promise.resolve({ lead: 'no browser session connected.' }),
    });
    const out = await runSetupPhases(INPUT, fx);
    expect(out.notes.join('\n')).toContain('no browser session connected.');
  });

  it('a daemon that cannot be asked does not fail the run', async () => {
    const notes: string[] = [];
    const fx = world({
      ...noSession,
      daemonWhy: () => Promise.reject(new Error('connection refused')),
      note: (line: string) => notes.push(line),
    });
    const out = await runSetupPhases(INPUT, fx);
    expect(out.ok).toBe(false);
    expect(notes.join('\n')).toContain('never dialled the bridge');
  });
});
