/**
 * The half of setup that happens after the files are written.
 *
 * `init` wires a project; this gets the app running with the SDK inside it and proves a session
 * connected. That is where ONBOARDING ends. The first flow comes after it, in `first-flow.ts`,
 * driven through the daemon that already holds the tools — this file never drives.
 *
 * Every effect is injected. That is not ceremony: the sequence has five phases, each with its own
 * way of going wrong, and the alternative to injecting them is a test that boots a real dev server
 * and a real browser to find out what happens when neither works.
 */

import {
  judgeWait,
  devServerDiedMessage,
  portBusyMessage,
  QUIET_MEANS_HUNG_MS,
  urlToWatch,
  WaitVerdict,
} from './bringup/dev-server-wait.js';
import { connectProgressLine, waitProgressLine } from './terminal/wait-progress.js';

/**
 * Windows gets longer to say something before silence counts as a wedge.
 *
 * A first `npm run dev` on a cold Windows runner optimises dependencies before the bundler prints a
 * line, and 45s of quiet is inside that window. Measured on the install gate: the Vue scaffold was
 * declared hung, `init` exited 1, and the gate then started the very same app and connected to it
 * on the next line. Nothing was wrong with the app; the wait was too impatient for the platform.
 *
 * Only the QUIET budget moves. The ceiling is unchanged, and a launcher that exits is still dead
 * immediately, so this buys patience for a starting server and never for a broken one.
 */
const WINDOWS_QUIET_MEANS_HUNG_MS = 3 * 60_000;
const WINDOWS_QUIET_MEANS_HUNG_MS_APPLIES = 'win32' === process.platform;
import { liveSessionOfProject, pickSession, type CandidateSession } from './session-pick.js';
import {
  readPage,
  describePage,
  findingBeforeOpen,
  PageFinding,
  type PageProbe,
} from './probe/page-probe.js';
import { remainingSteps, type Progress } from './remaining-steps.js';
import { AppShape, isDesktop, policyFor } from './desktop-shape.js';

/** Where a run got to, and why it stopped if it did. */
/**
 * How long to keep asking whether the SDK has reached the page before giving up on opening a window.
 * Bounded by the connect budget, so a short budget is never overrun by the readiness check.
 */
const SDK_READY_WINDOW_MS = 15_000;

/** The wait left when no browser was opened: only a tab that is ALREADY loaded can still appear. */
const NO_BROWSER_GRACE_MS = 3_000;
/**
 * How long a system browser that SAID it opened gets to produce a session before init proves the
 * connect in a Reticle-owned browser instead. A launcher's exit is not a window: macOS `open` against
 * a default browser that does not answer exits 1 only after the launch check has already counted it
 * as opened, and init then waited out its whole connect budget over a correct install.
 */
const SYSTEM_BROWSER_GRACE_MS = 15_000;

export const SetupPhase = {
  DEV_SERVER: 'dev-server',
  CONNECT: 'connect',
  DONE: 'done',
} as const;
export type SetupPhase = (typeof SetupPhase)[keyof typeof SetupPhase];

export interface SetupOutcome {
  /** True when the app is running, instrumented and connected. Writing files alone is not that. */
  readonly ok: boolean;
  readonly reachedPhase: SetupPhase;
  readonly url?: string | undefined;
  readonly sessionId?: string | undefined;
  /**
   * Always false from these phases, which never drive. `first-flow.ts` sets it when the first flow
   * it drove after them was saved.
   */
  readonly flowSaved: boolean;
  /**
   * The session was a Reticle-owned headless browser, now closed: there is no tab of the person's
   * own to drive a first flow in.
   */
  readonly leased?: boolean;
  /** What the caller should do next, when this did not finish. */
  readonly fallback: string[];
  readonly notes: string[];
}

/** Everything the sequence needs from the world, so none of it is reached for directly. */
/**
 * The daemon's reason for "no session", in the two lengths its two readers need.
 *
 * Same fact, not two facts: `full` is the lead plus the differential behind it, so a reader given
 * only one of them is never given something the other contradicts.
 */
export interface DaemonReason {
  /** One line, printed to the person watching the install. */
  readonly lead: string;
  /** The whole differential, recorded for the agent reading `--json`. Defaults to the lead. */
  readonly full?: string;
}

/** A lease this run opened for its connect proof, and the way to hand it back. */
export interface OwnedBrowser {
  readonly sessionId: string;
  readonly release: () => Promise<void>;
  /**
   * The page never dialled in, so the lease injected Reticle's own reader. That session proves the
   * reader, not this install, and must never end onboarding as "connected".
   */
  readonly zeroInstall?: boolean;
}

/** Hand a lease back. Best-effort: a lease that already expired is already gone. */
async function releaseLease(lease: OwnedBrowser | undefined): Promise<void> {
  try {
    await lease?.release();
  } catch {
    /* nothing to undo */
  }
}

export interface SetupEffects {
  /** Start the dev server. Resolves once started; the caller owns stopping it. */
  readonly startDevServer: (command: string, cwd: string) => Promise<void>;
  /**
   * A live server this project already announced, if any. Setup attaches to it rather than
   * starting a second one on the next port.
   */
  readonly existingAppUrl?: () => Promise<string | undefined>;
  /** Everything the dev server has printed so far. */
  readonly devServerOutput: () => string;
  readonly devServerExited: () => boolean;
  /** Milliseconds since it last printed anything. */
  readonly devServerQuietForMs: () => number;
  /** Ports our own process group is listening on. */
  readonly observedPorts: () => number[];
  /** Fetch the url and report what came back. */
  readonly probePage: (url: string) => Promise<PageProbe>;
  /**
   * Ask for the app to be opened. Deliberately `void`: whether a window APPEARED is not knowable here.
   *
   * This returned a boolean for one commit, so that a launcher which failed could shorten the wait
   * below instead of spending the whole connect budget on a session nothing could create. It was
   * reverted because the premise is false. On the ubuntu CI runners `xdg-open` exits 3 -- the exit
   * code this would have trusted -- and a browser STILL appears and dials in a little later, so
   * four install-gate scaffolds that had passed for releases went red the moment the wait was cut
   * short (`vite-react`, `vite-vue`, `next-app-router`, `monorepo-subdir`, run 35242186243 against
   * 35232727716). A non-zero launcher exit means UNKNOWN, not "no browser": it reports whether the
   * COMMAND succeeded, never whether a window opened. Do not shorten a wait on it.
   *
   * It may resolve with the launcher's own failure, and that is used for exactly one thing: to ALSO
   * open a Reticle-owned browser, so the proof does not depend on a window that may never appear.
   * Adding a second source of a session is safe on a false alarm; cutting the wait was not.
   */
  readonly openBrowser: (url: string) => Promise<string | void>;
  /**
   * Open the url in a browser Reticle owns (a pooled lease), for a run with no system browser to
   * lean on: `--no-open`, CI, a container, an agent. Optional: absent means no lease is attempted.
   */
  readonly openLease?: (url: string) => Promise<OwnedBrowser | { readonly failed: string }>;
  readonly listSessions: () => Promise<CandidateSession[]>;
  /**
   * The daemon's own account of why nothing connected, if it can be asked.
   *
   * The daemon is the only party that can see a hello it REFUSED, and a refusal is the one piece of
   * positive evidence in the whole failure -- only an SDK dials the bridge, so a turned-away page
   * proves the app is running, instrumented and pointed here. `page-probe.ts` has said since it was
   * written that this sentence is the one to lead with and that the page finding merely adds the
   * page-side fact; only the second half was wired.
   *
   * Optional, and allowed to fail: setup must still report what it saw when the daemon cannot be
   * reached, which is itself one of the states this runs in.
   */
  readonly daemonWhy?: () => Promise<DaemonReason | undefined>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly note: (line: string) => void;
}

export interface SetupInput {
  readonly appDir: string;
  /** This project's id, so a live tab of it can be told from another app's on the same url. */
  readonly projectId?: string | undefined;
  readonly devCommand?: string | undefined;
  /** The app is already served here, so nothing is started. */
  readonly suppliedUrl?: string | undefined;
  /**
   * The caller's own budget for the connect wait, when they named one.
   *
   * Absent, the shape's policy decides — a desktop shell genuinely needs longer than a browser tab.
   * Present, it WINS, including when it is shorter: the deadline used to be
   * `max(phaseTimeoutMs, policy)`, so `--timeout 3` could only ever lengthen the wait. A timeout the
   * tool ignores is a lie, and it left every hostile-environment check killed by its own harness
   * before setup could say what was wrong.
   */
  readonly connectBudgetMs?: number | undefined;
  /** Explicit --timeout for startup; absent preserves the adaptive build wait. */
  readonly startupBudgetMs?: number | undefined;
  readonly openBrowser: boolean;
  /** Web, Electron or Tauri. Desktop changes three things; see desktop-shape.ts. */
  readonly shape: AppShape;
  /**
   * The served HTML carries the SDK marker on this shape: Vite's index.html injection, or a plain
   * HTML page with the snippet pasted in. Every other framework delivers the connect in the JS
   * bundle, so "the SDK is NOT in the page" is the permanent state of a healthy page there, and
   * saying it sent people to restart a dev server that was fine.
   */
  readonly htmlCarriesSdk: boolean;
  readonly phaseTimeoutMs: number;
  readonly pollMs: number;
}

const asProgress = (input: SetupInput, o: Partial<SetupOutcome>): Progress => ({
  initDone: true,
  devServerUp: undefined !== o.url,
  sessionConnected: undefined !== o.sessionId,
  flowSaved: true === o.flowSaved,
  urlSuppliedByCaller: undefined !== input.suppliedUrl,
  ...(undefined === o.url ? {} : { url: o.url }),
  ...(undefined === input.devCommand ? {} : { devCommand: input.devCommand }),
});

const stop = (
  input: SetupInput,
  phase: SetupPhase,
  partial: Partial<SetupOutcome>,
  notes: string[],
): SetupOutcome => ({
  ok: false,
  reachedPhase: phase,
  flowSaved: false,
  ...partial,
  notes,
  fallback: remainingSteps(asProgress(input, partial)),
});

/**
 * Run the phases. Stops at the first one that cannot continue, and always says what is left.
 *
 * A phase that fails is not an error to throw: the caller is usually an agent, and a thrown
 * exception loses the four things it needs — how far this got, the url, the session, and what to do
 * about it.
 */
/**
 * Ask the daemon why, and treat every failure as "it did not say".
 *
 * A daemon that cannot be reached is one of the states this runs in, so an error here is data, not
 * an exception: the page finding below still prints and the run still ends with its own verdict.
 */
async function daemonWhy(fx: SetupEffects): Promise<DaemonReason | undefined> {
  if (undefined === fx.daemonWhy) return undefined;
  try {
    const why = await fx.daemonWhy();
    return undefined === why || 0 === why.lead.length ? undefined : why;
  } catch {
    return undefined;
  }
}

export async function runSetupPhases(input: SetupInput, fx: SetupEffects): Promise<SetupOutcome> {
  const notes: string[] = [];
  const note = (line: string): void => {
    // The page is probed before the browser opens and again after the wait, and an unchanged page
    // gave the reader the same paragraph twice in a row.
    if (notes.at(-1) === line) return;
    notes.push(line);
    fx.note(line);
  };

  // ── the app has to be running ────────────────────────────────────────────────────────────────
  let url = input.suppliedUrl;
  let attachedToExisting = false;
  if (undefined === url) {
    const announced = undefined === fx.existingAppUrl ? undefined : await fx.existingAppUrl();
    if (undefined !== announced && 0 < announced.length) {
      // The plugin already announced a live server for THIS project. Starting `dev` beside it is
      // how Vite binds 5174, a second tab opens, and `reticle_sessions` lists three with no way
      // to pick. The registry is scoped; an unscoped listen would attach to a sibling app.
      url = announced;
      attachedToExisting = true;
      note(
        `This project is already running at ${announced} — attaching instead of starting a second server.`,
      );
    } else if (undefined === input.devCommand) {
      note(
        // "stop here rather than invent one" is the SKILL.md rule, and the words are the contract —
        // inventing a dev command is how a setup script runs the wrong thing and reports success.
        'No dev command: the project names no dev, start or serve script, and there is no --url. ' +
          'Stopping here rather than invent one — start the app yourself and pass --url to say ' +
          'where it is serving, or add a dev/start/serve script to package.json and re-run.',
      );
      return stop(input, SetupPhase.DEV_SERVER, {}, notes);
    } else {
      await fx.startDevServer(input.devCommand, input.appDir);
      const startedAt = fx.now();
      // This loop used to poll in complete silence. Reported as thirty minutes of nothing ending in a
      // SIGKILL — and whatever made that wait long, a user who cannot tell "still starting" from
      // "wedged" has been given no way to act. See wait-progress.ts.
      let spokeAtMs: number | undefined;
      for (;;) {
        const watching = urlToWatch(fx.devServerOutput(), fx.observedPorts());
        const waitedMs = fx.now() - startedAt;
        const progress = waitProgressLine(waitedMs, watching, spokeAtMs);
        if (progress !== undefined) {
          note(progress);
          spokeAtMs = waitedMs;
        }
        const probe =
          undefined === watching
            ? { served: false as const, sdkInPage: false as const }
            : await fx.probePage(watching);
        const serving = probe.served;
        const verdict = judgeWait({
          output: fx.devServerOutput(),
          launcherExited: fx.devServerExited(),
          serving,
          quietForMs: fx.devServerQuietForMs(),
          elapsedMs: fx.now() - startedAt,
          budgetMs: input.startupBudgetMs,
          quietMeansHungMs: WINDOWS_QUIET_MEANS_HUNG_MS_APPLIES
            ? WINDOWS_QUIET_MEANS_HUNG_MS
            : QUIET_MEANS_HUNG_MS,
        });
        if (WaitVerdict.READY === verdict && undefined !== watching) {
          // Prefer the URL that answered when the announcement was the wrong family (#884).
          url = probe.reachedUrl ?? watching;
          break;
        }
        // A desktop shell serves its webview from inside the app, so there is no port to answer and
        // nothing to be READY. Once it has announced a url, or bound one we can see, that is as far
        // as this phase can get: the session it dials from its own window is the real signal.
        if (isDesktop(input.shape) && undefined !== watching) {
          url = watching;
          break;
        }
        if (WaitVerdict.DEAD === verdict) {
          note(portBusyMessage(fx.devServerOutput()) ?? devServerDiedMessage(fx.devServerOutput()));
          return stop(input, SetupPhase.DEV_SERVER, {}, notes);
        }
        if (WaitVerdict.HUNG === verdict) {
          // Says BOTH were checked. A server that prints nothing but IS listening is the CRA case and
          // must not be failed, so a reader has to be able to tell "we looked at the log" from "we
          // looked at the log AND the ports".
          const within =
            input.startupBudgetMs !== undefined && fx.now() - startedAt >= input.startupBudgetMs
              ? ` within ${String(input.startupBudgetMs)}ms`
              : undefined;
          note(
            (undefined === watching
              ? `The dev server neither printed a URL nor bound a port${within ?? ''}, so setup has nothing to open. `
              : undefined !== within
                ? `The dev server did not become ready${within}. `
                : `The dev server stopped making progress before ${watching} became ready. `) +
              'Check its log, increase --timeout for a slow build, or pass --url with the address it serves.',
          );
          return stop(input, SetupPhase.DEV_SERVER, {}, notes);
        }
        await fx.sleep(input.pollMs);
      }
    }
  }

  // ── and something has to connect from inside it ──────────────────────────────────────────────
  const policy = policyFor(input.shape);
  // Through `note`, not `fx.note`: a caller reading the result should see it too.
  if (undefined !== policy.note) note(policy.note);
  const listed = await fx.listSessions();
  const requiredRuntime = isDesktop(input.shape) ? input.shape : undefined;
  // A tab already on this URL is the answer. Opening another is how three sessions appear.
  // `before` is empty so pickSession will take that tab rather than waiting for a new one.
  //
  // Not only when attached: a server init started itself (Next, Angular — nothing announces) has a
  // url too, and a live tab of this project already on it is just as much the answer. Without this
  // every re-run opened one more tab.
  const alreadyConnected = attachedToExisting
    ? pickSession(listed, url, new Set(), requiredRuntime)
    : liveSessionOfProject(listed, url, input.projectId, requiredRuntime);
  const before = new Set(listed.map((s) => s.sessionId));
  // Do not put a window in front of somebody until the page behind it can actually do something.
  //
  // The probe that says whether the SDK is even IN the page used to run only in the failure branch
  // below, AFTER the browser was already open. So a mis-wired app opened a real window onto a page
  // that was never going to connect, and the person watching it saw a browser appear and then
  // nothing happen for the whole connect budget — which reads as "Reticle is broken" rather than
  // "the bundle predates the config edit". One fetch, before the window, turns that into a sentence.
  //
  // Only the browser is gated. The wait below still runs: something else may connect (an already
  // open tab, a desktop window), and the probe is a statement about one fetch of the document, not
  // proof that nothing can ever dial in.
  const budgetMs = input.connectBudgetMs ?? Math.max(input.phaseTimeoutMs, policy.connectBudgetMs);
  let openedBrowser = false;
  let lease: OwnedBrowser | undefined;
  // `--no-open` used to skip this whole block, so nothing was opened and the run ended on "never
  // dialled the bridge" over a correct install. With a lease to fall back on it is entered too, and
  // only the system browser is skipped.
  const canLease = undefined !== fx.openLease;
  const injected = new Set<string>();
  /**
   * The lease to keep, or undefined. A lease whose page only connected through Reticle's injected
   * reader is handed straight back and its session excluded: it would otherwise be picked below and
   * report a plain server with no SDK as an instrumented app.
   */
  const keepLease = async (
    owned: OwnedBrowser | { readonly failed: string },
  ): Promise<OwnedBrowser | undefined> => {
    if ('failed' in owned) {
      note(`Could not open ${url} in a Reticle-owned browser either: ${owned.failed}`);
      return undefined;
    }
    if (true !== owned.zeroInstall) return owned;
    injected.add(owned.sessionId);
    await releaseLease(owned);
    return undefined;
  };
  if (null === alreadyConnected && policy.openBrowser && (input.openBrowser || canLease)) {
    // SERVED is the precondition, not SDK_PRESENT: a url that answers nothing is the only state
    // where a window is certainly useless. Whether the SDK is in the served HTML is a DIFFERENT
    // question — Vite injects a marker, while Nuxt, React Router, Astro, SvelteKit and CRA deliver
    // the connect in the JS BUNDLE, so their HTML never carries it. Gating on presence failed five
    // of ten scaffolds in the install gate: no window, so no bundle, so no session, so exit 1 on a
    // correct install. page-probe.ts says it is a diagnostic for a connect that already failed; the
    // same signal as a precondition deadlocks every case it is wrong about.
    //
    // So presence decides only WHEN: open the moment it appears (the fast path for the frameworks
    // that inline it), otherwise once the short readiness window is out.
    const finding = await findingBeforeOpen(
      () => fx.probePage(url),
      { now: () => fx.now(), sleep: (ms: number) => fx.sleep(ms) },
      Math.min(SDK_READY_WINDOW_MS, budgetMs),
      input.pollMs,
      input.htmlCarriesSdk,
    );
    if (PageFinding.NOT_SERVED === finding || PageFinding.TLS_REFUSED === finding) {
      note(describePage(finding, url));
      note(
        'Not opening a browser: nothing answered that url, so the window could only show an error ' +
          'page. Fix the line above and re-run — `init` is idempotent.',
      );
    } else {
      // Said BEFORE the window appears, so somebody watching a page that stays inert has already
      // been told which of the two it is.
      if (PageFinding.SDK_MISSING === finding && input.htmlCarriesSdk) {
        note(describePage(finding, url));
      }
      // `= true` means ATTEMPTED, which is the most that is knowable — see openBrowser above for
      // why the launcher's own exit code must not be read as "no window appeared".
      const launcherFailed = input.openBrowser ? await fx.openBrowser(url) : undefined;
      openedBrowser = input.openBrowser;
      if (undefined !== fx.openLease && (!input.openBrowser || undefined !== launcherFailed)) {
        lease = await keepLease(await fx.openLease(url));
        if (undefined !== lease) openedBrowser = true;
      }
    }
  }
  // Waiting the full budget for a session when nothing was opened to create one is dead time, and
  // it used to be over two minutes of it: the browser is the session source on web, so declining to
  // open it and then waiting as if we had is a promise to the reader that cannot be kept. Something
  // else may still dial in — a tab the user already has open, a desktop window — and the existing
  // diagnosis says such a session "will appear within a second of the page loading", so a short
  // grace is the honest wait. A run that DID open a browser keeps the whole budget.
  const deadline =
    fx.now() +
    (openedBrowser || !(input.openBrowser && policy.openBrowser)
      ? budgetMs
      : Math.min(NO_BROWSER_GRACE_MS, budgetMs));
  let session: CandidateSession | null = alreadyConnected;
  const waitStartedAt = fx.now();
  let connectSpokeAtMs: number | undefined;
  let leaseFallbackTried = false;
  while (null === session) {
    // On a desktop app, only the desktop window counts. AppShape and the runtime a page reports use
    // the same three names, so the shape IS the requirement — see session-pick.
    const listedNow = (await fx.listSessions()).filter((s) => !injected.has(s.sessionId));
    session = pickSession(listedNow, url, before, requiredRuntime);
    if (null !== session) break;
    if (deadline <= fx.now()) break;
    if (
      !leaseFallbackTried &&
      undefined === lease &&
      undefined !== fx.openLease &&
      openedBrowser &&
      input.openBrowser &&
      !isDesktop(input.shape) &&
      fx.now() - waitStartedAt >= SYSTEM_BROWSER_GRACE_MS
    ) {
      leaseFallbackTried = true;
      lease = await keepLease(await fx.openLease(url));
      continue;
    }
    // Not in silence: a desktop run used to print one line and then nothing for ten minutes.
    const waitedMs = fx.now() - waitStartedAt;
    const progress = connectProgressLine(
      waitedMs,
      connectSpokeAtMs,
      deadline - waitStartedAt,
      policy.awaiting,
    );
    if (undefined !== progress) {
      // To the person only: it is progress, not a finding, and in `notes` it would split the
      // page description printed before and after this wait into two copies.
      fx.note(progress);
      connectSpokeAtMs = waitedMs;
    }
    await fx.sleep(input.pollMs);
  }
  if (null === session) {
    if (isDesktop(input.shape)) {
      // Nothing outside the app can fetch its webview, so there is no page to describe. What is
      // wrong here is desktop-shaped: the preload, the capture helper, or a CSP that blocks the
      // bridge — all of which `reticle doctor` checks.
      note(
        'The app never dialled in. For a desktop shell that is usually the preload not being required, ' +
          'the capture helper not installed, or a CSP that blocks the bridge: run `npx @reticlehq/server doctor`.',
      );
    } else {
      // The daemon first, when it has something to say: it is the only party that can see a hello it
      // refused, and that outranks anything inferred from an absence. Then the page, which is the
      // one thing the daemon cannot know, and worth one fetch.
      const why = await daemonWhy(fx);
      if (undefined !== why) {
        // Two readers, two lengths, one fetch.
        //
        // The person watching an install gets the LEAD — that is what trimming this diagnosis was
        // for. The agent reads `notes` out of `--json`, and what it acts on is the differential:
        // which ports were actually scanned (so an empty result is not proof), why a missing
        // `.reticle.json` is expected in a monorepo, and the lease that opens a URL on a box with
        // no browser at all.
        //
        // Printing only the lead put BOTH readers on the lead, which silently emptied the agent
        // surface: `init --json` stopped mentioning the lease, and `break/break-matrix.mjs`
        // (`no-browser-to-open`) went red for exactly that reason.
        fx.note(why.lead);
        notes.push(why.full ?? why.lead);
      }
      const finding = readPage(await fx.probePage(url));
      // Silent on a bundle-connect shape: its HTML never carries the SDK, so the absence says nothing.
      if (PageFinding.SDK_MISSING !== finding || input.htmlCarriesSdk) {
        note(describePage(finding, url, undefined !== why));
      }
    }
    await releaseLease(lease);
    return stop(input, SetupPhase.CONNECT, { url }, notes);
  }

  // ── connected, which is where ONBOARDING ends ────────────────────────────────────────────────
  //
  // Getting started is three stages — installation puts the CLI on the machine, onboarding wires
  // the project, the first run proves a flow — and this command owns the middle one. A connected
  // session is the whole proof that onboarding worked: the SDK is in the page, the bridge paired,
  // and the tools now have something to talk to. What to do next is the first flow's to say.
  note(`✓ Connected. ${url} is instrumented. Onboarding is done; nothing is verified yet.`);
  // Said, because "connected" otherwise reads as "your browser connected": the page that dialled
  // was a headless one Reticle launched and has now closed, and nothing is open on this screen.
  const leased = undefined !== lease && session.sessionId === lease.sessionId;
  if (leased) {
    note(
      'The proof came from a Reticle-owned headless browser (now closed), not a window of yours — ' +
        `open ${url} in your own browser to use the app.`,
    );
  }
  await releaseLease(lease);
  return {
    ok: true,
    reachedPhase: SetupPhase.CONNECT,
    url,
    sessionId: session.sessionId,
    flowSaved: false,
    leased,
    notes,
    fallback: [],
  };
}
