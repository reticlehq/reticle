/**
 * Keeps the "why is nothing connected" diagnosis fresh, without putting a probe on the hot path.
 *
 * `SessionManager.resolve` is synchronous and runs on every tool call, so it cannot await a port
 * scan. This refreshes the answer in the background and hands the manager a closure that reads the
 * cached result — a hint in an error message is exactly the sort of thing that may be a few seconds
 * stale.
 *
 * It only probes while NOTHING is connected. Once a session is live the question is moot, and a
 * daemon that outlives the agent by hours has no business scanning ports it does not need.
 */

import { probeRouteStatus } from './dev-server/route-status-probe.js';
import { probeDevServerStates } from './dev-server/dev-server-probe.js';
import type { NoSessionReason } from '@reticlehq/core/telemetry';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registeredElsewhere } from '@/memory/recall/registered-projects.js';
import { explainNoSession } from './no-session-diagnosis.js';
import type { NoSessionFacts } from './no-session-diagnosis.js';
import { detectDevCommandInProject } from './dev-server/dev-command.js';
import { nextActionFor, portOfUrl, renderNextAction } from './no-session-next-action.js';
import type { NoSessionNextAction } from './no-session-next-action.js';
import {
  DEV_SERVER_PORTS,
  readProjectFramework,
  readProjectId,
  readProjectIsDesktop,
  readProjectPort,
} from '@/command/cli/ports/resolve/cli-port.js';
import { discoverProjectConfigs } from '@/command/cli/config/config-discovery.js';
import {
  hasProjectConnectedBefore,
  rememberConnected,
} from '@/memory/recall/prior/connection-memory.js';
import { isAlive, reticleStateHome } from '@/command/daemon/daemon.js';
import {
  daemonsServingProjectElsewhere,
  projectDaemonsElsewhere,
  projectlessNote,
  splitBrainNote,
} from '@/command/daemon/daemon-resolve.js';
import { stallUptime } from './stall-clock.js';
import type { SessionManager } from './session-manager.js';
import { probeDaemon } from '@/surface/mcp/mcp-proxy.js';
import { findOccupiedSiblings } from '@/command/cli/ports/sibling-ports.js';
import { isAuthRefusalReason } from '@/portal/bridge/auth-failure-reason.js';
import { devServersForProject } from '@reticlehq/core';
import { readDevServers } from '@/command/daemon/dev-servers.js';

/** Slow enough to be free, fast enough that a dev server started 15s ago is already reflected. */
const REFRESH_MS = 15_000;

/** The URL an auto-attach opens. `localhost` for the same reason the probe uses it: both stacks. */
const LOCALHOST = 'http://localhost';

/**
 * What the failure path says, always naming the reason rather than swallowing it.
 *
 * An auto-attach that fails silently is the same class of defect as the message it replaces: the
 * agent is told absence and never learns that Reticle tried and could not.
 */
function attachFailureClause(port: number, reason: string): string {
  const collision = /EADDRINUSE|address already in use/i.test(reason);
  return (
    ` Reticle also tried to open ${LOCALHOST}:${String(port)} in a browser it owns and could not: ` +
    `${reason}.` +
    (collision
      ? ' That is a port collision — something already holds the port this daemon needs, so the ' +
        'browser Reticle drives could not be started. Stop the other Reticle process and retry, ' +
        'rather than treating this as a problem with the app.'
      : '')
  );
}

interface NoSessionWatchOptions {
  sessions: SessionManager;
  port: number;
  /** Whether this project has been through `reticle init` (a projectId is stamped in .reticle.json). */
  initialized: boolean;
  /** Where that was decided — this daemon's working directory unless a caller says otherwise. */
  directory?: string;
  /**
   * File-existence predicate for the project directory. Injected for tests; defaults to
   * checking the directory on disk.
   */
  exists?: (file: string) => boolean;
  /**
   * The background port scan. Injected for tests; production probes each port on both loopback
   * families.
   *
   * Receives the candidate list — the well-known ports plus the ones that name THIS project
   * (#1367) — so a test can pin the observation without opening a socket. A test that injects it
   * owns the scan.
   */
  probe?: (ports: readonly number[]) => Promise<number[]>;
  /**
   * Well-known Reticle ports other than ours that currently accept a connection.
   *
   * Remaining half of #261. Injected so tests can pin the observation without opening a socket.
   * Production (no `probe` override) probes those ports itself. A test that injects `probe` and
   * omits this is opting out: it owns the scan.
   */
  occupiedSiblings?: () => Promise<readonly number[]>;
  /**
   * Whether a given session id belonged to a pooled lease that aged out, if a pool exists.
   * Injected as a predicate rather than the pool itself: the diagnosis needs one answer, and
   * taking the whole pool would tie the session layer to the browser layer for it.
   *
   * Was a lifetime `reapedLeases: () => number` count, asked as `> 0`. That latched: after the
   * first reap, every closed human tab was reported as an expired lease for the rest of the
   * daemon's life, and the recovery it named would have thrown away the app session (#611).
   */
  wasReapedLease?: (sessionId: string) => boolean;
  /**
   * Opens a URL in a browser Reticle owns, and resolves once it is open.
   *
   * The daemon passes the POOL's acquire — the same path `reticle_lease` takes — rather than
   * `reticle drive`. Deliberate: the pool runs inside this process and binds nothing, so it needs no
   * port arbitration, while `reticle drive` starts a second daemon that fights this one for the port.
   * Omitted on a daemon with no pool, and auto-attach is then simply off.
   */
  attach?: (url: string) => Promise<unknown>;
  /**
   * The ports THIS project's dev servers announced into the registry the build plugins write.
   *
   * Auto-attach opens a port only when it can be attributed to this project. The port scan is
   * machine-wide, so its one hit is as likely to be another repo's app as this one's — and now that
   * the attach path can launch an installed Chrome, a wrong guess parks a hidden headless browser on
   * somebody else's app. Injected for tests; production reads the registry scoped by projectId/root.
   */
  ownDevServerPorts?: () => readonly number[];
  /**
   * What the route the last session was on answers right now, as an HTTP status, or undefined
   * when there is no answer to report.
   *
   * Injected so tests can pin the observation without opening a socket. Production (no override)
   * asks the route itself — see route-status-probe. The one fact that separates a route that 500s
   * from a closed tab (#808, option 3).
   */
  routeStatus?: (url: string) => Promise<number | undefined>;
  /**
   * Where the durable "an app has connected here before" bit lives. The daemon's state home unless
   * a test says otherwise.
   */
  stateDir?: string;
}

/**
 * Start the watch. Returns a stop function; the timer is unref'd so it never holds the daemon up.
 *
 * Exported for the test that pins the after-boot config read below — the daemon itself starts this
 * through `wireSessionScope`.
 */
export function startNoSessionWatch(options: NoSessionWatchOptions): () => void {
  let listening: readonly number[] = [];
  /**
   * Ports that accepted a connection and then answered nothing in time.
   *
   * Tracked beside `listening` rather than folded into it: they are not dev servers as far as the
   * probe knows, so they must not be spent as proof the app is up, and they are not absent either,
   * so the diagnosis must stop telling people to start a server that is already running. A custom
   * `options.probe` returns only the serving set, so this stays empty for injected probes.
   */
  let slowListeners: readonly number[] = [];
  let siblingListeners: readonly number[] = [];
  /**
   * What the last-known route answered, cached beside the port scan for the same reason the scan
   * is cached: the hint is read synchronously, so every fact it carries has to be gathered before
   * it is asked. Keyed by URL so a status is never attributed to a route other than the one it
   * came from — a fresh departure on a different URL reads as "not asked yet", not as the old
   * answer.
   */
  let lastKnownStatus: { url: string; status: number } | undefined;
  const routeStatus = options.routeStatus ?? probeRouteStatus;
  let running = false;
  /** Ports auto-attach has already spent its one attempt on. Bounded: never a loop, never a retry. */
  const attempted = new Set<number>();
  /** Set only when an attempt actually failed, so the diagnosis can say so instead of hiding it. */
  let attachFailure: string | undefined;

  const directory = options.directory ?? process.cwd();
  const exists = options.exists ?? ((file: string) => existsSync(join(directory, file)));
  // The boot answer still counts (it is what the daemon scoped its sessions with), but `.reticle.json`
  // is routinely written by `init` AFTER this daemon started, so re-read rather than cache. See the
  // `initialized` comment below, which this shares.
  const isWired = (): boolean => options.initialized || readProjectId(directory) !== undefined;

  type ProjectScopeFacts = Pick<
    NoSessionFacts,
    'initialized' | 'configsElsewhere' | 'searchedDirectories'
  >;

  /**
   * Resolve the daemon's current project scope once for both halves of a sessions response.
   *
   * This remains a live read because `init` commonly writes the config after the daemon starts.
   */
  const projectScopeFacts = (): ProjectScopeFacts => {
    const initialized = isWired();
    if (initialized) return { initialized };
    const discovery = discoverProjectConfigs(directory);
    const elsewhere = discovery.found.filter((config) => config.directory !== directory);
    if (elsewhere.length > 0) {
      return {
        initialized,
        configsElsewhere: elsewhere.map((config) => ({
          directory: config.directory,
          ...(config.projectId === undefined ? {} : { projectId: config.projectId }),
        })),
      };
    }
    // The walk found nothing — which is the honest answer from a daemon standing at `/` or `$HOME`,
    // where several IDEs start a GLOBALLY registered MCP server. There is nothing above `/` and no
    // repo root at either, so the walk cannot reach a project it has nonetheless paired with before.
    // The registry can. See registeredElsewhere: "I am standing in the wrong place" and "you never
    // installed this" are opposite diagnoses with opposite fixes, and without this we gave the
    // second one — six times, on projects that were already correctly instrumented.
    const registered = registeredElsewhere(homedir(), directory);
    if (registered.length > 0) {
      return {
        initialized,
        configsElsewhere: registered.map((project) => ({
          directory: project.directory,
          ...(project.projectId === undefined ? {} : { projectId: project.projectId }),
        })),
      };
    }
    return { initialized, searchedDirectories: discovery.searched };
  };

  // Read at boot: the daemon's own identity does not change under it, and this is the key the
  // durable bit is stored under.
  const stateDir = options.stateDir ?? reticleStateHome();
  /**
   * Only ever asked ABOUT A NAMED PROJECT.
   *
   * With no projectId the memory can still answer the weaker "has anything connected on this port",
   * and that answer must not be spent here: a shared 4400 on a machine with several repos would
   * then soften a genuinely-unwired directory's diagnosis on the strength of an unrelated app. That
   * is the same over-confident claim this whole file exists to remove, pointing the other way.
   */
  const connectedBefore = (): boolean =>
    hasProjectConnectedBefore(stateDir, options.port, readProjectId(directory));

  /**
   * The split brain, asked fresh every time like everything else here.
   *
   * Cheap — a directory listing of `~/.reticle` and a few small JSON reads — and only ever reached
   * on a daemon with no session, which is the state this whole file exists for. Reading it once at
   * boot would miss the ordinary case entirely: the app connects to the other daemon SECONDS after
   * this one starts, which is precisely the window the agent then spends being told to start a dev
   * server that is already running.
   */
  const splitBrain = (): string | undefined => {
    const projectId = readProjectId(directory);
    if (projectId === undefined) {
      return projectlessNote(
        options.port,
        projectDaemonsElsewhere(options.port, stateDir, isAlive),
      );
    }
    return splitBrainNote(
      options.port,
      daemonsServingProjectElsewhere(projectId, options.port, stateDir, isAlive, (port) =>
        hasProjectConnectedBefore(stateDir, port, projectId),
      ),
    );
  };

  // Every path that registers a session goes through SessionManager.add, so this is the one hook
  // that makes the bit durable. Recorded per port + projectId so a shared 4400 cannot make one
  // project's success into evidence about another's.
  options.sessions.setConnectionRecorder((projectId) => {
    rememberConnected(stateDir, options.port, projectId);
  });

  /**
   * Open the app ourselves when there is exactly one unambiguous candidate.
   *
   * AUTOMATIC, not offered — the deliberate call. Offering means a round trip and a decision by an
   * agent that has strictly less evidence than this daemon does, on the one case where there is
   * nothing left to decide: the project is wired, so a page WILL connect, and exactly one dev server
   * is listening, so there is no ambiguity about which. That case is the bulk of the loss. Every
   * other shape (several listeners, an unwired project, no listener) still returns prose, because
   * there the daemon would be guessing and a guess that opens a browser is worse than a sentence.
   *
   * Bounded by construction: one attempt per port per daemon. A failure is recorded, never retried —
   * a retry loop against a broken Chromium install would spin for the daemon's whole life.
   */
  const ownDevServerPorts =
    options.ownDevServerPorts ??
    ((): readonly number[] =>
      devServersForProject(readDevServers(stateDir), {
        projectId: readProjectId(directory),
        root: directory,
      }).map((entry) => entry.port));

  /**
   * The ports the background scan must cover: the well-known list plus the facts that name THIS
   * repo's port without guessing it (#1367).
   *
   * The scan is machine-wide, so it knows 3000/5173/8080… and nothing about this checkout: with a
   * Next app already running on :3005 (`next dev -p 3005`) the diagnosis said nothing was listening
   * and named a command that would have started a duplicate. Three facts name the port instead —
   * the project's own dev script pins it in its own text, the build plugins announced theirs
   * (already trusted for auto-attach), and the last session was on one.
   */
  const scanPorts = (): readonly number[] => {
    const ports = new Set<number>(DEV_SERVER_PORTS);
    for (const port of ownDevServerPorts()) ports.add(port);
    const pinned = detectDevCommandInProject(directory)?.port;
    if (pinned !== undefined) ports.add(pinned);
    const known = options.sessions.lastKnown?.();
    const knownPort = known === undefined ? undefined : portOfUrl(known.url);
    if (knownPort !== undefined) ports.add(knownPort);
    return [...ports];
  };

  /**
   * Is `port` demonstrably this project's app? Either its dev server announced it, or this
   * project's own last session was on it. Anything else is a guess, and a guess that opens a
   * browser is worse than the sentence the diagnosis already writes about the ports it saw.
   */
  const attributable = (port: number): boolean => {
    if (ownDevServerPorts().includes(port)) return true;
    const known = options.sessions.lastKnown?.();
    const projectId = readProjectId(directory);
    if (known === undefined || projectId === undefined || known.projectId !== projectId) {
      return false;
    }
    try {
      return Number(new URL(known.url).port) === port;
    } catch {
      return false;
    }
  };

  const autoAttach = async (ports: readonly number[]): Promise<void> => {
    const attach = options.attach;
    if (attach === undefined) return;
    if (1 !== ports.length) return;
    const [only] = ports;
    if (only === undefined || attempted.has(only)) return;
    if (!isWired()) return;
    if (!attributable(only)) return;
    attempted.add(only);
    try {
      await attach(`${LOCALHOST}:${String(only)}`);
    } catch (error) {
      attachFailure = attachFailureClause(
        only,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const refresh = (): void => {
    // Nothing to diagnose while a session is live, and no reason to scan.
    if (running || options.sessions.count() > 0) return;
    running = true;
    const candidates = scanPorts();
    void (
      options.probe === undefined
        ? probeDevServerStates(candidates).then((states) => {
            slowListeners = states.slow;
            return states.serving;
          })
        : options.probe(candidates)
    )
      .then(async (ports) => {
        listening = ports;
        siblingListeners =
          options.occupiedSiblings !== undefined
            ? await options.occupiedSiblings()
            : options.probe === undefined
              ? await findOccupiedSiblings(options.port, probeDaemon)
              : [];
        // Asked once per departed URL, on the same background cadence as the port scan, and never
        // on the hint's own path. A url already answered is not asked again; a new departure is.
        const known = options.sessions.lastKnown?.();
        if (known !== undefined && lastKnownStatus?.url !== known.url) {
          const status = await routeStatus(known.url);
          if (status !== undefined) lastKnownStatus = { url: known.url, status };
        }
        await autoAttach(ports);
      })
      .catch(() => {
        /* a diagnostic hint must never take the daemon down */
      })
      .finally(() => {
        running = false;
      });
  };

  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();

  /**
   * Is a refusal on the pairing token the CURRENT state of the bridge?
   *
   * The bridge records the refusal (the sentence it closed the socket with) and nothing read it
   * as a DIAGNOSIS. It is the one fact that proves an app is running and instrumented: only an SDK
   * dials the bridge, so a refused hello means the wiring works and this daemon would not serve it.
   *
   * Two clauses, because `lastClosure` alone answers a slightly different question than the one the
   * diagnosis asks. It records only the closes the BRIDGE initiated, so an ordinary disconnect never
   * reaches it: a refusal, then a good session, then a closed tab leaves it still reading
   * `AUTH_FAILED` hours later. `connectedSinceLastClosure` is the ordering fact that tells a live
   * refusal from a remembered one, and without it this reports a token problem for a closed tab.
   *
   * Called optionally because this watch is constructed against a structural slice of the manager,
   * and several callers pass a double that predates these methods. A manager that cannot answer has
   * recorded no refusal, which falls through to the behaviour that was there before -- the safe
   * direction for a fact whose job is to SUPPRESS advice rather than to add any.
   */
  const lastCloseWasAuthFailure = (): boolean =>
    isAuthRefusalReason(options.sessions.lastClosure?.()?.reason) &&
    true !== options.sessions.connectedSinceLastClosure?.();

  /**
   * A hello refused for anything but its token, while it is still the bridge's current state.
   *
   * Only closures that carry the refused page count: the bridge attaches one exactly when a HELLO
   * was turned away, so an origin or handshake-pool refusal (which has its own sentence on
   * `resolve`) is not mistaken for one. Same ordering clause as the token refusal above.
   */
  const currentHelloRefusal = (): NoSessionFacts['helloRefused'] => {
    const closure = options.sessions.lastClosure?.();
    if (closure?.page === undefined || isAuthRefusalReason(closure.reason)) return undefined;
    if (true === options.sessions.connectedSinceLastClosure?.()) return undefined;
    return { reason: closure.reason, ...closure.page };
  };

  const nextAction = (scope: ProjectScopeFacts): NoSessionNextAction => {
    const split = splitBrain();
    return nextActionFor({
      everConnected: options.sessions.everConnected(),
      initialized: scope.initialized,
      ...(scope.configsElsewhere === undefined ? {} : { configsElsewhere: scope.configsElsewhere }),
      previouslyConnected: connectedBefore(),
      exists,
      // Read when asked, like every other fact here: a page can dial at any moment, and a daemon
      // that cached "nothing has been refused" at boot would keep saying so.
      authRefused: lastCloseWasAuthFailure(),
      ...(() => {
        const refused = currentHelloRefusal();
        return refused === undefined ? {} : { helloRefused: refused.reason };
      })(),
      ...(split === undefined ? {} : { splitBrain: split }),
      listening,
      slowListeners,
      // The url the departed tab was on — the same tombstone the prose diagnosis quotes, so the
      // command and the sentence beside it name the same page.
      ...(() => {
        const known = options.sessions.lastKnown?.();
        if (known === undefined) return {};
        return {
          lastKnownUrl: known.url,
          ...(known.departedTo === undefined ? {} : { departedTo: known.departedTo }),
        };
      })(),
      // Read when asked, like everything else here: a `package.json` can gain a dev script, and a
      // daemon that cached "there is none" at boot would keep saying so for the rest of the day.
      dev: detectDevCommandInProject(directory),
    });
  };

  options.sessions.setNoSessionNextAction(() => nextAction(projectScopeFacts()));

  // ONE call for both registrations below. The prose and the branch code have to come from the
  // same evaluation or they can describe different branches - the facts are read when asked, so two
  // calls a moment apart can genuinely disagree (#615).
  const explain = (): { reason: NoSessionReason; message: string; detail?: string } => {
    const scope = projectScopeFacts();
    return explainNoSession({
      everConnected: options.sessions.everConnected(),
      // Read WHEN ASKED, for the same reason `projectPort` below is: `.reticle.json` is routinely
      // written by `init` after this daemon started — that is the ordinary first-install order — and
      // the boot-time answer is then permanently stale. Reported from the field as `reticle status`
      // saying the project had never been through `init` about a project whose config named its
      // framework and its projectId, and whose real problem was a dev server older than the plugin.
      // The boot value still counts: it is the one the daemon scoped its sessions with.
      ...scope,
      listening,
      slowListeners,
      port: options.port,
      // The directory `initialized` was decided in. Named in the message because "there is no
      // `.reticle.json`" is a claim about ONE directory, and a reader standing somewhere else
      // cannot tell whether it is a claim about their app at all.
      directory,
      // The one fact that outranks every absence below it, and the reason a fresh daemon stopped
      // claiming that an install which has demonstrably worked has never worked.
      previouslyConnected: connectedBefore(),
      // Already read for the NEXT ACTION and, until now, not for the message — so the daemon could
      // suppress an `init` suggestion because it knew a page had been refused, while the sentence
      // beside it still said the tab had been closed. One fact, two answers, and only one of them
      // was right. Read when asked, like the rest: a page can be refused at any moment.
      authRefused: lastCloseWasAuthFailure(),
      ...(() => {
        const refused = currentHelloRefusal();
        return refused === undefined ? {} : { helloRefused: refused };
      })(),
      // Ranks the causes. Read when asked, like the rest: `init` writes this file after the daemon
      // starts on an ordinary first install.
      ...(() => {
        const framework = readProjectFramework(directory);
        return framework === undefined ? {} : { framework };
      })(),
      // A desktop app is opened by its own dev command, never by a browser URL or a lease. Read when
      // asked, like the framework: `init` may wire the app after this daemon started.
      ...(readProjectIsDesktop(directory) ? { desktop: true } : {}),
      // Decided from the session that actually went away, not from a lifetime tally: the lease
      // sentence is only right when the thing that vanished WAS a lease.
      leaseExpired: (() => {
        const departed = options.sessions.lastDeparted();
        return departed === undefined ? false : (options.wasReapedLease?.(departed) ?? false);
      })(),
      // The URL of the session that went away, when the tombstone still holds it. Optional: a
      // stub SessionManager in tests has no lastKnown, and a daemon that never saw a session
      // has none to name.
      ...(() => {
        const known = options.sessions.lastKnown?.();
        if (undefined === known) return {};
        // The status rides only when it was fetched for THIS url. A departure since the fetch
        // means the cached answer is about a route nobody is asking about.
        const status =
          lastKnownStatus !== undefined && lastKnownStatus.url === known.url
            ? { lastKnownStatus: lastKnownStatus.status }
            : {};
        // Where the tab was seen heading, when the SDK reported it fresh. Kept separate from
        // lastKnownUrl: the 5xx probe needs the page the tab was ON.
        const departed =
          known.departedTo === undefined || '' === known.departedTo
            ? {}
            : { departedTo: known.departedTo };
        return { lastKnownUrl: known.url, ...status, ...departed };
      })(),
      // How long this daemon has been waiting with no app. The diagnosis uses it to surface
      // "install never finished" — the same condition telemetry already knows about.
      ...(() => {
        const upMs = stallUptime(Date.now());
        return upMs === undefined ? {} : { daemonUpMs: upMs };
      })(),
      // Read here rather than at boot: `.reticle.json` can be written by `init` after this daemon
      // started, which is the ordinary first-install order, and a port cached from before it existed
      // would make the daemon confidently report no mismatch on the one run where there is one.
      ...(() => {
        const configured = readProjectPort(directory);
        return configured === undefined ? {} : { projectPort: configured };
      })(),
      ...(0 === siblingListeners.length ? {} : { siblingListeners }),
    });
  };

  // The lead, then the literal command, then the differential. Both renderings consume the same
  // scope facts so a discovered workspace config cannot become an `init` recommendation below it,
  // and both come from ONE `explain()` call so they cannot describe different branches.
  const rendered = (): { lead: string; full: string } => {
    const scope = projectScopeFacts();
    const { message, detail } = explain();
    const lead = `${message} ${renderNextAction(nextAction(scope))}${attachFailure ?? ''}`;
    return { lead, full: undefined === detail ? lead : `${lead} ${detail}` };
  };

  options.sessions.setNoSessionHint(() => rendered().full);
  options.sessions.setNoSessionLead(() => rendered().lead);

  options.sessions.setNoSessionReason(() => explain().reason);

  return () => {
    clearInterval(timer);
    options.sessions.setConnectionRecorder(undefined);
    options.sessions.setNoSessionHint(undefined);
    options.sessions.setNoSessionLead(undefined);
    options.sessions.setNoSessionReason(undefined);
    options.sessions.setNoSessionNextAction(undefined);
  };
}

/**
 * The daemon's whole session-scoping decision in one call: scope auto-selection to the active
 * project, and keep the no-session diagnosis fresh. Both derive from the same one fact — whether
 * this directory has been through `reticle init` — so they belong together rather than as two
 * adjacent blocks in the bootstrap.
 */
export function wireSessionScope(
  sessions: SessionManager,
  activeProjectId: string | undefined,
  port: number,
  /** Asks the pool whether a session id was a lease it aged out; omitted when there is no pool. */
  wasReapedLease?: (sessionId: string) => boolean,
  /** Opens a URL in a Reticle-owned browser (the pool). Omitted ⇒ auto-attach is off. */
  attach?: (url: string) => Promise<unknown>,
): () => void {
  if (activeProjectId !== undefined) sessions.setDefaultScope({ projectId: activeProjectId });
  return startNoSessionWatch({
    sessions,
    port,
    initialized: activeProjectId !== undefined,
    ...(wasReapedLease === undefined ? {} : { wasReapedLease }),
    ...(attach === undefined ? {} : { attach }),
  });
}
