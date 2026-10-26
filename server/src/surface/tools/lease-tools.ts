/**
 * Lease tools — the agent-facing surface of the BrowserPool.
 *
 * `reticle_lease_acquire` opens an isolated headless context navigated to the app URL and returns
 * the sessionId the app's SDK will register. A second acquire on the same origin reuses the live
 * lease rather than minting another tab — that second tab used to poison default session resolution
 * for the rest of the run. The parallel suite still mints via `acquireLeasedSession`, because ten
 * flows on one origin need isolation on purpose.
 *
 * Attach-only: the pool drives a browser against an already-running dev server — it never starts one.
 */

import * as production from '@/portal/production/production-activation.js';
import { z } from 'zod';
import {
  leaseNotConnectedHint,
  leaseReaderFailedHint,
  leaseStillLoadingHint,
  type LeaseEvidence,
} from './lease-hint.js';
import {
  connectOrInject,
  moveReusedLease,
  notReadyReason,
  probeLeaseAlive,
} from './lease-readiness.js';
import { probeSdkMarker } from './gaps/sdk-marker-probe.js';
import { observeWebDocument } from '@/portal/session/dev-server/served-document.js';
import { diagnoseObservedWebCsp } from '@reticlehq/init';
import { readProjectFramework, readProjectId } from '@/command/cli/ports/resolve/cli-port.js';
import { hasAnyAppConnectedBefore } from '@/memory/recall/prior/connection-memory.js';
import {
  AGENT_DRIVING_ELSEWHERE,
  AGENT_DRIVING_HERE_AGAIN,
  watchersToNotify,
} from '@/portal/session/lease-visibility.js';
import { reticleStateHome } from '@/command/daemon/daemon.js';
import { claimArtifactRoot, dropArtifactRootClaim } from '@/memory/project/root-claims.js';
import {
  LeaseNotReadyReason,
  RETICLE_URL_PARAM,
  RETICLE_DEFAULT_PORT,
  SeedStorageSchema,
  originOf,
  type SeedStorage,
} from '@reticlehq/core';
import { HudVisibility, ReticleTool, SESSION_HEALTH } from '@reticlehq/core';
import { HOST_STUB_NOTE, type ToolDef, type ToolDeps } from './tool-kit.js';
import { type BrowserPool, PoolAtCapacityError } from '@/portal/pool/browser-pool.js';
import { asString } from '@reticlehq/core';
import { chromiumPreflightRefusal } from '@/command/cli/doctor/browser/chromium-hint.js';
import {
  LEASE_PERMISSIONS_ARG,
  hintOf,
  notificationReadBack,
  parseLeasePermissions,
  permissionRefusal,
  refuseRegrant,
} from './lease-permissions.js';
import { LEASE_EMULATE_ARG, leaseEmulationOf } from '@/portal/input/viewport-tools.js';
export {
  sessionMutationPort,
  sessionPerturbationPort,
  suiteFixturePort,
  suiteFixtureSeed,
} from './session-ports.js';

/**
 * Everything the daemon already knows about why a leased tab might not have dialled in.
 *
 * Gathered here rather than guessed in the hint, because the daemon HAD this evidence all along and
 * printed a static differential over the top of it — telling one agent in `reticle_sessions` that
 * the wiring was proven correct and telling it seconds later that the port was probably wrong.
 */
/**
 * Async only for the marker probe, which is the piece that decides whether this app ships an SDK at
 * all — the difference between the diagnosis a new user needs and four causes that all assume the
 * install already happened. It is one localhost GET on a path that has already failed and is about
 * to print a paragraph, and it can only ever add a sentence: the probe returns `undefined` on any
 * doubt and the hint then says nothing about markers.
 */
/**
 * Whether the served page's own CSP refuses the bridge's SOCKET, read by the same code `doctor` uses.
 *
 * Only `connect-src` counts here. A lease injects the SDK itself, so the inline-snippet problem a
 * `script-src` finding describes does not apply; what stops a leased page is the socket. Said in the
 * lease's own words, because doctor's advice is about wiring a project, not about a tab.
 */
async function observedCspBlock(
  url: string,
  port: number,
): Promise<{ problem: string; fix: string } | undefined> {
  const document = await observeWebDocument(url);
  if (document === undefined) {
    return undefined;
  }
  const refusesSocket = diagnoseObservedWebCsp(document, port).some((finding) =>
    `${finding.problem} ${finding.fix}`.includes(CONNECT_SRC),
  );
  if (!refusesSocket) {
    return undefined;
  }
  const allow = `ws://localhost:${String(port)} ws://127.0.0.1:${String(port)}`;
  return {
    problem: `its ${CONNECT_SRC} does not allow ws://localhost:${String(port)}`,
    fix: `add ${allow} to ${CONNECT_SRC}, behind a development-only check`,
  };
}

/** The CSP directive that governs the socket the SDK dials. */
const CONNECT_SRC = 'connect-src';

async function leaseEvidence(deps: ToolDeps, port: number, url: string): Promise<LeaseEvidence> {
  const cwd = process.cwd();
  const projectId = readProjectId(cwd);
  const refusal = deps.sessions.lastClosure()?.reason;
  const framework = readProjectFramework(cwd);
  const sdkMarker = await probeSdkMarker(url);
  const cspBlock = await observedCspBlock(url, port);
  return {
    ...(refusal === undefined ? {} : { refusal }),
    ...(cspBlock === undefined ? {} : { cspBlock }),
    ...(framework === undefined ? {} : { framework }),
    ...(sdkMarker === undefined ? {} : { sdkMarker }),
    previouslyConnected: hasAnyAppConnectedBefore(reticleStateHome(), port, projectId),
    initialized: projectId !== undefined,
  };
}

const POOL_UNAVAILABLE =
  'browser pool unavailable — the lease tools need the daemon-managed pool (start Reticle via `reticle mcp`).';

const ALREADY_HELD_LEASE = 'you already hold a lease on this origin';

function alreadyHeldHint(sessionId: string, origin: string): string {
  return (
    `${ALREADY_HELD_LEASE} (${origin}): ${sessionId} — reused it rather than opening a second ` +
    'tab, which would make every later call require sessionId. It is still signed in as whoever ' +
    'used it last (cookies and storage come with it): release it first for a fresh context or ' +
    'another identity.'
  );
}

/**
 * Append Reticle identity params (__reticle_session, optional __reticle_project) to a URL so the app's own SDK
 * adopts them on connect. Pure; falls back to plain concatenation if the URL can't be parsed.
 */
export function appendReticleParams(
  url: string,
  session: string,
  projectId?: string,
  hud?: HudVisibility,
): string {
  try {
    const u = new URL(url);
    u.searchParams.set(RETICLE_URL_PARAM.SESSION, session);
    if (projectId !== undefined && projectId.length > 0) {
      u.searchParams.set(RETICLE_URL_PARAM.PROJECT, projectId);
    }
    if (hud !== undefined) {
      u.searchParams.set(RETICLE_URL_PARAM.HUD, hud);
    }
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    const proj =
      projectId !== undefined && projectId.length > 0
        ? `&${RETICLE_URL_PARAM.PROJECT}=${encodeURIComponent(projectId)}`
        : '';
    return `${url}${sep}${RETICLE_URL_PARAM.SESSION}=${encodeURIComponent(session)}${proj}`;
  }
}

export { cleanNavError, evaluateSeedPrecondition, scrubSeedFromError } from './lease-seed.js';
import {
  evaluateSeedPrecondition,
  looksLikeStorageStateExport,
  navFailureMessage,
  scrubSeedFromError,
} from './lease-seed.js';

/** A fresh, collision-resistant lease id. Uses crypto at the I/O boundary (not pure logic). */
function newLeaseId(): string {
  const uuid =
    'function' === typeof globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${String(Date.now())}-${String(performance.now())}`;
  return `lease-${uuid}`;
}

/**
 * The session a lease's tab actually registered as, or undefined while nothing has.
 *
 * Normally that is the lease id: `appendReticleParams` stamps `__reticle_session` on the URL and the
 * SDK adopts it. An app that passes an explicit `session` to `connect()` keeps its own name instead,
 * which is legitimate — a single-app fixture does it deliberately so a battery can address it by a
 * known id. Matching on the lease id alone could never see those tabs, so the lease reported
 * `ready: false` and a hint blaming a port mismatch while the session was connected and driveable.
 *
 * The URL marker is the evidence, and it is what makes this safe: two concurrent leases on one origin
 * carry different markers, so neither can adopt the other's tab. Parsed rather than substring-matched,
 * so `lease-abc` cannot claim `lease-abcdef`.
 */
export function resolveLeasedSessionId(
  sessions: { get: (id: string) => unknown; all: () => { id: string; url?: string }[] },
  leaseId: string,
): string | undefined {
  if (sessions.get(leaseId) !== undefined) {
    return leaseId;
  }
  return sessions.all().find((s) => sessionParamOf(s.url) === leaseId)?.id;
}

/**
 * Carry a claimed identity across a navigation.
 *
 * A LEASED tab is addressed by `__reticle_session` in its URL: that param is how the pool finds the
 * context it opened, and — since succession was tightened — it is also the ONLY thing that lets the
 * reconnecting document inherit the lease. `reticle_navigate` sent the caller's raw URL, so the very
 * first navigation stripped the marker, the tab re-announced as an ordinary anonymous session, and
 * the lease was orphaned: "no sessions are connected at all", with a browser window still open on
 * screen. A leased browser that cannot survive being navigated is not a usable one.
 *
 * A tab that claims nothing is left exactly as it was — this must never bolt Reticle's params onto
 * a human's own URL.
 */
export function carryReticleIdentity(fromUrl: string | undefined, toUrl: string): string {
  const session = sessionParamOf(fromUrl);
  if (session === undefined) {
    return toUrl;
  }
  // Already addressed (a caller passing the stamped URL back) — appending would be a no-op at best.
  if (sessionParamOf(toUrl) !== undefined) {
    return toUrl;
  }
  const projectId = projectParamOf(fromUrl);
  return appendReticleParams(toUrl, session, projectId);
}

function projectParamOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).searchParams.get(RETICLE_URL_PARAM.PROJECT) ?? undefined;
  } catch {
    return undefined;
  }
}

function sessionParamOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).searchParams.get(RETICLE_URL_PARAM.SESSION) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Acquire a leased, SDK-connected context for a caller that is not the lease TOOL (the parallel suite).
 * Returns the session id plus its release; the caller must release in a finally so a crashed flow never
 * leaks a pool slot and starves the rest of the suite.
 */
export async function acquireLeasedSession(
  pool: {
    acquire: (
      url: string,
      opts: { sessionId: string; seedStorage?: SeedStorage },
    ) => Promise<{
      sessionId: string;
      release: () => Promise<void>;
      navStatus?: number;
      injectReader?: () => Promise<boolean>;
      isLoading?: () => Promise<boolean>;
    }>;
    /**
     * The address this lease's page said it could not reach. Optional so a test double need not
     * implement it; the real pool always does.
     */
    dialFailureUrl?: (sessionId: string) => string | undefined;
    /** Optional so a test double need not implement it; the real pool always does. */
    alias?: (registeredId: string, leaseId: string) => void;
  },
  sessions: { get: (id: string) => unknown; all: () => { id: string; url?: string }[] },
  url: string,
  projectId?: string,
  seedStorage?: SeedStorage,
): Promise<{ sessionId: string; release: () => Promise<void> }> {
  const sessionId = newLeaseId();
  let lease;
  try {
    lease = await pool.acquire(appendReticleParams(url, sessionId, projectId), {
      sessionId,
      ...(seedStorage !== undefined ? { seedStorage } : {}),
    });
  } catch (err) {
    throw new Error(
      scrubSeedFromError(err instanceof Error ? err.message : String(err), seedStorage),
    );
  }
  // Resolved, not assumed — see resolveLeasedSessionId. The parallel suite replays against whatever
  // id comes back, so handing it the lease id for an app that named its own session sent every flow
  // in the run at a session that does not exist.
  let registeredId: string | undefined;
  await connectOrInject(lease, () => {
    registeredId = resolveLeasedSessionId(sessions, lease.sessionId);
    return registeredId !== undefined;
  });
  if (registeredId !== undefined) {
    pool.alias?.(registeredId, lease.sessionId);
  }
  const effectiveId = registeredId ?? lease.sessionId;
  if (seedStorage !== undefined) {
    const session = sessions.get(effectiveId) as
      | {
          url?: string;
          setPreconditionFailure?(reason: string): void;
        }
      | undefined;
    if (session?.setPreconditionFailure !== undefined) {
      const failureReason = evaluateSeedPrecondition(
        url,
        session.url,
        seedStorage,
        lease.navStatus,
      );
      if (failureReason !== undefined) {
        session.setPreconditionFailure(failureReason);
      }
    }
  }
  return { sessionId: effectiveId, release: () => lease.release() };
}

/**
 * Named on its own because `reticle drive <url>` runs it too.
 *
 * When a daemon already owns the bridge port, `drive` asks that daemon for a browser instead of
 * competing for the port (see cli/drive/drive-attach.ts), and the browser it should get is exactly the one
 * an agent gets: same pool, same isolation, same reporting. Sharing the ToolDef rather than the
 * handler keeps that literal — the drive route dispatches through `runTool`, so it is counted like
 * any other call instead of being a second, invisible dispatch path.
 */
// Serializes lease acquisitions on the same origin so concurrent callers (e.g. seeded replacements)
// do not race and establish multiple overlapping contexts on that origin.
const originAcquireLocks = new Map<string, Promise<unknown>>();

export function hasOriginLock(origin: string): boolean {
  return originAcquireLocks.has(origin);
}

export const LEASE_ACQUIRE_TOOL: ToolDef = {
  name: ReticleTool.LEASE_ACQUIRE,
  description:
    'Lease a fresh isolated browser context from the shared pool (shown or hidden as the daemon was started; `headed: true` forces a window) and navigate it to the app URL (the app must already be running; one with no Reticle SDK gets one supplied, reported as zeroInstall). If this origin is already leased and still connected, this returns THAT session rather than minting a second tab — a second acquire on the same origin poisons default session resolution. Returns the sessionId the leased tab registers — pass it to other tools. The pool keeps all leases in ONE browser and caps concurrency; if every slot is taken this is refused at once, naming the cap, rather than queued. Release with reticle_lease{action:"release"} when the flow is done. PREFER AN ALREADY-OPEN TAB: if reticle_sessions lists a non-leased session for this app, drive THAT instead — a lease is invisible to the person watching the app, whose HUD lives in their own tab, and a tab flagged hidden/throttled is often still driveable. Lease for isolation you actually need (a second identity, a clean context, parallel flows) or when driving the open tab has failed — this call answers with `preferExisting` when a live tab was available.',
  inputSchema: {
    url: z
      .string()
      .optional()
      .describe(
        'URL of the already-running app to drive (e.g. http://localhost:3000/dashboard). Omit it to lease the one dev server that runs in this project folder.',
      ),
    projectId: z
      .string()
      .optional()
      .describe('Stable project id to stamp on the leased tab so the agent can scope to it.'),
    seedStorage: SeedStorageSchema.optional().describe(
      'Initial storage state (local, session and cookies) to seed before the first navigation (e.g. `seedStorage: { local: { token: "..." } }` to start already authenticated).',
    ),
    initScript: z
      .string()
      .optional()
      .describe(
        "JavaScript installed in the tab BEFORE any of the page's own scripts run. Use it for TEST DOUBLES of the host bindings a desktop shell injects — Wails `window.go.*`, Tauri `window.runtime`/`__TAURI_INTERNALS__`, an Electron preload object — so a view that calls them on mount is driven against the stub instead of throwing. It stays on for this lease only, and it is disposed with the lease. Every verdict on this lease carries a note that a stub was installed, so a green is never read as one against the real shell.",
      ),
    headed: z
      .boolean()
      .optional()
      .describe('Open it in a browser window somebody can watch, instead of headless.'),
    ignoreHTTPSErrors: z
      .boolean()
      .optional()
      .describe(
        'Accept a self-signed or mkcert certificate on an https dev server, for this lease only. Off by default.',
      ),
    hud: z
      .enum([HudVisibility.SHOWN, HudVisibility.HIDDEN, HudVisibility.REMOVED])
      .optional()
      .describe('How the HUD starts on the page: shown (default), hidden, or removed.'),
    permissions: LEASE_PERMISSIONS_ARG,
    emulate: LEASE_EMULATE_ARG,
    production: production.PRODUCTION_LEASE_ARG,
    root: z
      .string()
      .optional()
      .describe(
        "Absolute path of the .reticle folder this lease's runs belong in — the caller's project. The project folder itself is accepted when it contains a .reticle. Without it, the page's project id decides, and a page with none lands in ~/.reticle/unmatched, which nothing syncs.",
      ),
  },
  outputSchema: {
    sessionId: z.string(),
    url: z.string(),
    ready: z
      .boolean()
      .describe(
        'Whether the leased tab is connected AND answering. It is NOT a claim that the app has hydrated, so an act can miss: make the first act reticle_act_and_wait with an `until`, or reticle_assert { action: "wait" }. Empty reads may mean not hydrated. False ⇒ read notReadyReason.',
      ),
    zeroInstall: z
      .boolean()
      .optional()
      .describe(
        'Present when this app ships no Reticle SDK and the lease supplied one. Verdicts work on the DOM, network, console and routes; there is no framework adapter, so no component state and no source file:line. Install with `npx @reticlehq/server init` for those.',
      ),
    hostStub: z
      .string()
      .optional()
      .describe(
        'Present when this leased tab runs an init script stubbing the bindings a desktop shell injects. Verdicts on this lease are about the app with that stub, not about the real shell.',
      ),
    notReadyReason: z
      .enum([
        LeaseNotReadyReason.SDK_NEVER_DIALLED,
        LeaseNotReadyReason.SDK_STOPPED_ANSWERING,
        LeaseNotReadyReason.TAB_HIDDEN,
        LeaseNotReadyReason.NOT_HTML_DOCUMENT,
        LeaseNotReadyReason.READER_FAILED,
      ])
      .optional()
      .describe(
        'Present only when ready is false. sdk_never_dialled ⇒ nothing connected within the wait, so check the install (the app may not embed @reticlehq/core), unless the hint says the page was still loading, in which case it is a slow first compile and checking reticle_session { action: "list" } shortly is the next step. sdk_stopped_answering ⇒ an SDK did connect and has stopped replying, so the tab is wedged and needs recovering, not reinstalling. tab_hidden ⇒ the SDK answers but its tab is hidden, so timers and animations are throttled and nothing on it verifies; bring the tab to the front, or release and re-acquire. not_html_document ⇒ the URL is not an HTML page (an `.svg`, for example), so acquire an HTML page of the app instead. reader_failed ⇒ the zero-install reader failed, for example because the tab closed during setup; the hint gives the cause. For both, the lease is already released.',
      ),
    expiresInMs: z
      .number()
      .describe(
        'Milliseconds until this lease expires if untouched. Each tool call that targets this session resets the clock. Plan your work to finish or re-acquire before this runs out.',
      ),
    leased: z.number().describe('How many contexts are currently leased from the pool.'),
    queued: z.number().describe('How many acquires are waiting for a free slot.'),
    preferExisting: z
      .object({ sessionId: z.string(), note: z.string() })
      .optional()
      .describe(
        'Present when a live NON-leased tab for this app was already connected. That tab is the one a human can see; this lease is not. Release this lease and drive that sessionId unless you specifically need an isolated context.',
      ),
    reused: z
      .boolean()
      .optional()
      .describe(
        'True when this acquire returned an existing live lease on the same origin rather than minting a second context.',
      ),
    navigated: z
      .boolean()
      .optional()
      .describe(
        'Present when a reused lease was on another page. True: its tab was moved to url. False: it could not be moved, and url is the page it is on.',
      ),
    hint: z.string().optional(),
    production: production.PRODUCTION_LEASE_OUTPUT,
    versionSkew: z
      .string()
      .optional()
      .describe(
        "Present when the leased tab's SDK disagrees with this daemon. ready is still true — the " +
          'page dialled in — but CDP-backed tools (screenshot, viewport, real input, network_mock) ' +
          'will fail until the versions match. Same sentence as reticle_sessions.versionSkew.',
      ),
  },
  handler: async (deps: ToolDeps, args) => {
    const pool = deps.pool;
    if (pool === undefined) {
      throw new Error(POOL_UNAVAILABLE);
    }
    const given = asString(args['url']);
    const url = given === undefined || 0 === given.length ? await deps.projectAppUrl?.() : given;
    if (url === undefined) {
      throw new Error(
        'reticle_lease{action:"acquire"} requires a url: no single dev server runs in this project folder. Start the app, or pass the url it serves.',
      );
    }
    // Preflight the browser before spending the round trip. Without it a missing Playwright Chromium
    // only surfaces inside pool.acquire, where the launch failure is caught and reported as
    // "could not open <url> — is the app running?" — sending the caller to debug an app that is
    // fine. Say the real thing at the first refusal instead. The phrasing carries "Chromium is not
    // installed" so error-recovery routes it to the NO_POOL fix (install + drive a human tab).
    if (deps.browserProbe !== undefined) {
      const refusal = chromiumPreflightRefusal(await deps.browserProbe());
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
    }
    const projectId = asString(args['projectId']);
    const root = asString(args['root']);
    const headed = true === args['headed'];
    const hud = Object.values(HudVisibility).find((v) => v === args['hud']);
    const permissions = production.leasePermissions(
      parseLeasePermissions(args['permissions']),
      args['production'],
    );
    const emulate = leaseEmulationOf(args['emulate']);
    // The stub of the shell bindings, when the caller supplied one. Installed by the pool before
    // the first navigation, so it is already defined when the app's first module runs.
    const initScript = asString(args['initScript']);
    const seedStorageArg = args['seedStorage'];
    let validatedSeed: SeedStorage | undefined;
    if (seedStorageArg !== undefined) {
      const parsed = SeedStorageSchema.safeParse(seedStorageArg);
      if (!parsed.success) {
        const msg = scrubSeedFromError(
          parsed.error.issues
            .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
            .join(', '),
          seedStorageArg,
        );
        const hint = looksLikeStorageStateExport(seedStorageArg)
          ? 'This looks like a Playwright storageState() export ({ origins, cookies }); seedStorage takes { local?, session?, cookies? } (map origins[].localStorage into `local`).'
          : 'Expected { local?, session?, cookies? }.';
        throw new Error(`reticle_lease{action:"acquire"} seedStorage is invalid: ${msg}. ${hint}`);
      }
      validatedSeed = parsed.data;
    }
    // Awaited only when asked: an extra tick here reorders concurrent acquires on the origin lock.
    const activated =
      args['production'] === undefined
        ? undefined
        : await production.activationFor(deps, args['production'], url, root);
    // Sampled BEFORE acquiring: afterwards this lease is itself a session, and the point is to name
    // a tab that already existed. A human's open tab is the one they can watch, so if one is here
    // the agent should be told at the moment it is choosing — not after it has gone dark on them.
    const alreadyOpen = liveTabFor(deps, projectId, url);
    const origin = originOf(url);
    const priorLock = origin !== undefined ? originAcquireLocks.get(origin) : undefined;
    let releaseLock: (() => void) | undefined;
    let lockPromise: Promise<void> | undefined;
    if (origin !== undefined) {
      lockPromise = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      originAcquireLocks.set(origin, lockPromise);
    }
    if (priorLock !== undefined) {
      await priorLock.catch(() => undefined);
    }
    try {
      // Only a lease THIS caller took: another agent's tab is never reused or released (#1226).
      // A window asked for is never answered with the headless tab on that origin, nor the reverse.
      // A held lease that already runs the SAME stub is exactly what the caller asked for, so it is
      // left alone and reused below — releasing it would throw away the tab, and everything loaded
      // in it, for nothing. A lease with no stub, or with a different one, is released FIRST instead:
      // an init script has to exist before the page's own scripts run, which a loaded page cannot
      // do, and the resolve below then finds nothing and mints a fresh context with the stub. A
      // lease of the other kind is left alone, exactly as it is when a window was asked for.
      const heldForStub =
        origin === undefined ? undefined : pool.leaseIdOnOrigin(origin, deps.attachId);
      if (
        initScript !== undefined &&
        heldForStub !== undefined &&
        pool.isHeaded(heldForStub) === headed &&
        pool.hostStubScript?.(heldForStub) !== initScript
      ) {
        await pool.release(heldForStub);
      }
      const held = origin === undefined ? undefined : pool.leaseIdOnOrigin(origin, deps.attachId);
      const existing = held !== undefined && pool.isHeaded(held) === headed ? held : undefined;
      // A context's certificate setting is fixed when it is made, so an explicit request for the
      // other one cannot be answered by the held lease: handing it back would keep checks off after
      // `false`, or keep a local certificate refused after `true` (#1255). Omitted keeps the lease.
      const certAsked = args['ignoreHTTPSErrors'];
      const certMismatch =
        existing !== undefined &&
        'boolean' === typeof certAsked &&
        pool.ignoresHTTPSErrors(existing) !== certAsked;
      // Emulation is set before the first paint, so a held lease is replaced like a seeded one.
      if (
        (validatedSeed !== undefined ||
          certMismatch ||
          emulate !== undefined ||
          activated !== undefined) &&
        existing !== undefined
      ) {
        // Seeding or a different certificate setting asked for: release its own context so the new
        // lease starts with what was asked.
        await pool.release(existing);
      } else if (existing !== undefined && origin !== undefined) {
        // Resolved, not looked up — the same resolver the mint path below uses, for the same reason
        // it states: an app that names its own session registers under that name, so the id the pool
        // holds is not always an id the other tools accept. A direct `sessions.get` missed exactly
        // those apps and fell through to the release, which frees a LIVE lease and mints a second
        // context — the tab-poisoning this branch exists to prevent, reached through the branch
        // itself. It bites when the first acquire returned `ready: false`, since the mint path only
        // aliases once its wait has resolved, so nothing recorded the app's own name (#692).
        const resolved = resolveLeasedSessionId(deps.sessions, existing);
        if (resolved !== undefined) {
          // The other name this lease answers to, told to the pool exactly as the mint path tells it.
          // A no-op when the id resolved to itself; load-bearing when it did not, because every later
          // touch and release arrives under the id being handed back here.
          pool.alias(resolved, existing);
          refuseRegrant(pool, existing, permissions);
          pool.touch(existing);
          // Probed only HERE, never on the mint path below. There, the readiness wait resolved
          // moments ago and IS the liveness evidence; on reuse the last evidence may be minutes
          // old, or there may be none at all — `unresponsive` is set by past commands failing, and
          // its own contract says absence means "answering, OR NOT ASKED YET". So the happy path of
          // a first acquire pays nothing for this.
          const tabUrl = (): string | undefined => deps.sessions.get(resolved)?.url;
          const moved = await moveReusedLease(
            tabUrl,
            url,
            () => pool.gotoLease(existing, carryReticleIdentity(tabUrl(), url)),
            deps.now,
          );
          const reusedSession = deps.sessions.get(resolved);
          const reuseReason =
            false === moved?.arrived
              ? LeaseNotReadyReason.SDK_NEVER_DIALLED
              : notReadyReason(await probeLeaseAlive(reusedSession), reusedSession);
          return {
            sessionId: resolved,
            url: moved?.url ?? url,
            ...(moved === undefined ? {} : { navigated: moved.navigated }),
            ready: reuseReason === undefined,
            ...(reuseReason === undefined ? {} : { notReadyReason: reuseReason }),
            reused: true,
            expiresInMs: pool.leaseTtlMs(),
            leased: pool.activeCount(),
            queued: pool.queuedCount(),
            hint: alreadyHeldHint(resolved, origin),
            // Asked of the pool, not remembered here: the stub was installed when THIS lease was
            // minted, and the caller reusing it now may be seeing it for the first time.
            ...(true === pool.stubInstalled?.(existing) ? { hostStub: HOST_STUB_NOTE } : {}),
            ...(alreadyOpen === undefined
              ? {}
              : { preferExisting: { sessionId: alreadyOpen, note: PREFER_EXISTING_NOTE } }),
          };
        }
        // The lease is still held but the tab has gone — a reload dropped the session, and no session
        // anywhere is driving it. Free the slot and mint, rather than handing back a dead id or
        // leaving both contexts occupied.
        await pool.release(existing);
      }
      const sessionId = newLeaseId();
      // Before the page can dial in: the session is stamped with its root the moment it registers.
      if (root !== undefined) {
        claimArtifactRoot(sessionId, root);
      }
      const navUrl = appendReticleParams(activated?.url ?? url, sessionId, projectId, hud);
      let lease;
      try {
        lease = await pool.acquire(navUrl, {
          sessionId,
          // An agent, or `reticle drive` behind it, is waiting on this answer and cannot see a queue:
          // a full pool is said at once, not discovered as a 60 s silence (#1535).
          whenFull: 'refuse',
          ...(headed ? { headed } : {}),
          ...(deps.attachId === undefined ? {} : { owner: deps.attachId }),
          ...(validatedSeed !== undefined ? { seedStorage: validatedSeed } : {}),
          ...(initScript !== undefined ? { initScript } : {}),
          ...(permissions !== undefined ? { permissions } : {}),
          ...(true === args['ignoreHTTPSErrors'] ? { ignoreHTTPSErrors: true } : {}),
          ...(emulate === undefined ? {} : { emulate }),
        });
      } catch (err) {
        if (err instanceof PoolAtCapacityError) {
          throw err;
        }
        const refusal = permissionRefusal(err);
        if (refusal !== undefined) {
          throw refusal;
        }
        if (err instanceof Error && err.message.startsWith('Storage seeding failed')) {
          throw new Error(scrubSeedFromError(err.message, validatedSeed));
        }
        // A raw page.goto failure is noisy and leaks the internal URL params — surface a clean,
        // actionable message instead, one that tells a slow first compile from a missing app.
        throw new Error(navFailureMessage(url, err, validatedSeed));
      }
      // Wait for the leased tab's SDK to connect so the returned sessionId is usable right away.
      // Resolved rather than assumed: an app that names its own session registers under that name,
      // and the id we hand back has to be the one the agent can actually drive.
      let registeredId: string | undefined;
      const waitStartedAt = Date.now();
      const waited = await production.guardedForProduction(pool, lease, activated);
      const { ready, zeroInstall, stillLoading, readerFailure } = await connectOrInject(
        waited,
        () => {
          registeredId = resolveLeasedSessionId(deps.sessions, lease.sessionId);
          return registeredId !== undefined;
        },
      );
      // Tell the pool the other name this lease answers to. Every later touch and release arrives
      // under the id we are about to hand back, and the pool is keyed by the id it navigated with;
      // without this the touches miss, the lease ages out despite continuous activity, and the
      // reaper closes the context mid-flow. See BrowserPool.alias and #157.
      if (registeredId !== undefined) {
        pool.alias(registeredId, lease.sessionId);
      }
      const effectiveSessionId = registeredId ?? lease.sessionId;
      const session = deps.sessions.get(effectiveSessionId);
      if (validatedSeed !== undefined && session !== undefined) {
        const failureReason = evaluateSeedPrecondition(
          url,
          session.url,
          validatedSeed,
          lease.navStatus,
        );
        if (failureReason !== undefined) {
          session.setPreconditionFailure?.(failureReason);
        }
      }
      // The lease now exists, so any HUD a human is watching has just gone dark. Say so. A lease whose
      // reader failed is already released, so there is nothing to say.
      if (readerFailure === undefined) {
        tellWatchers(deps, projectId, AGENT_DRIVING_ELSEWHERE);
      }
      // ready means the SDK dialled in — not that contracts match. Carry the skew warning on acquire
      // so the agent does not learn it only after a CDP tool invents a closed page (#688).
      const mintReason =
        readerFailure?.reason ??
        notReadyReason(ready, session, LeaseNotReadyReason.SDK_NEVER_DIALLED);
      const versionSkew =
        registeredId === undefined ? undefined : deps.sessions.get(registeredId)?.versionSkew;
      let notReadyHint: string | undefined;
      if (!ready) {
        if (readerFailure !== undefined) {
          notReadyHint = leaseReaderFailedHint(url, readerFailure);
        } else if (true === stillLoading) {
          notReadyHint = leaseStillLoadingHint(url, Date.now() - waitStartedAt);
        } else if (activated !== undefined) {
          notReadyHint = production.notActivatedHint(url);
        } else {
          notReadyHint = await notConnectedHint(deps, url, pool.dialFailureUrl?.(lease.sessionId));
        }
      }
      return {
        sessionId: registeredId ?? lease.sessionId,
        url,
        ready: mintReason === undefined,
        // The other half of the pair. `ready: false` carried two opposite situations under one
        // word: no SDK ever dialled in (look at the install) versus one dialled in and stopped
        // answering (recover the tab). They want different next actions, so they get names — and so
        // does a third: dialled in and answering, but hidden, so nothing on it verifies (#1351).
        ...(mintReason === undefined ? {} : { notReadyReason: mintReason }),
        ...(zeroInstall ? { zeroInstall: true } : {}),
        expiresInMs: pool.leaseTtlMs(),
        leased: pool.activeCount(),
        queued: pool.queuedCount(),
        ...(alreadyOpen === undefined
          ? {}
          : {
              preferExisting: {
                sessionId: alreadyOpen,
                note: PREFER_EXISTING_NOTE,
              },
            }),
        ...(versionSkew === undefined ? {} : { versionSkew }),
        ...production.summary(activated),
        ...(initScript === undefined ? {} : { hostStub: HOST_STUB_NOTE }),
        ...hintOf(
          notReadyHint,
          ready ? await notificationReadBack(pool, lease.sessionId, permissions) : undefined,
        ),
      };
    } finally {
      releaseLock?.();
      if (origin !== undefined && originAcquireLocks.get(origin) === lockPromise) {
        originAcquireLocks.delete(origin);
      }
    }
  },
};

/** The whole not-connected diagnosis, gathered and worded. Split out so the acquire path stays flat. */
async function notConnectedHint(
  deps: ToolDeps,
  url: string,
  dialledUrl: string | undefined,
): Promise<string> {
  const bridgePort = deps.bridgePort ?? RETICLE_DEFAULT_PORT;
  const evidence = await leaseEvidence(deps, bridgePort, url);
  return leaseNotConnectedHint(url, bridgePort, {
    ...evidence,
    ...(dialledUrl === undefined ? {} : { dialledUrl }),
  });
}

const LEASE_RELEASE_TOOL: ToolDef = {
  name: ReticleTool.LEASE_RELEASE,
  description:
    'Release a leased browser context by sessionId, closing it and freeing the pool slot for a queued acquire. Call this when a flow finishes so the pool stays within its concurrency cap.',
  inputSchema: {
    sessionId: z
      .string()
      .describe('The leased sessionId returned by reticle_lease{action:"acquire"}.'),
  },
  outputSchema: {
    released: z.boolean(),
    leased: z.number(),
  },
  handler: async (deps: ToolDeps, args) => {
    const pool = deps.pool;
    if (pool === undefined) {
      throw new Error(POOL_UNAVAILABLE);
    }
    const sessionId = asString(args['sessionId']);
    if (sessionId === undefined || 0 === sessionId.length) {
      throw new Error('reticle_lease{action:"release"} requires a sessionId');
    }
    // An id that holds no lease (a typo, or one that expired) answered `released: true`.
    if (pool.leaseUrl(sessionId) === undefined) {
      const held = pool.leasedSessionIds();
      throw new Error(
        `reticle_lease{action:"release"}: no lease '${sessionId}' is held, so nothing was released. ` +
          (0 === held.length ? 'No lease is held now.' : `Leases held now: ${held.join(', ')}.`),
      );
    }
    return { released: true, leased: await releaseLease(deps, pool, sessionId) };
  },
};

/**
 * Release one lease and everything that hangs off it. Returns how many leases are still held.
 *
 * Shared with `reticle_session { action: "end" }`: an ended session that kept its lease stayed
 * connected until the reaper took it, and every id-less call from the next agent was refused as
 * ambiguous in the meantime.
 */
export async function releaseLease(
  deps: ToolDeps,
  pool: BrowserPool,
  sessionId: string,
): Promise<number> {
  // Read the project BEFORE releasing: afterwards the session is gone and there is nothing to
  // ask which project it belonged to.
  const projectId = deps.sessions.get(sessionId)?.projectId;
  await pool.release(sessionId);
  dropArtifactRootClaim(sessionId);
  // Only once the LAST lease is gone. Announcing "live again" while another lease still drives
  // would be a lie, and a HUD that says the wrong thing is worse than one that says nothing.
  if (0 === pool.activeCount()) {
    tellWatchers(deps, projectId, AGENT_DRIVING_HERE_AGAIN);
  }
  return pool.activeCount();
}

/**
 * What to say when a lease was taken while a real tab was already open.
 *
 * Not a refusal. Leases are the highest-value path for autonomous work and an agent that genuinely
 * needs isolation must still get one — but a human watching their own tab cannot see a lease, so
 * when both exist the visible one is the better default and the agent should hear that here, where
 * it is choosing, rather than discover it when somebody asks why nothing is happening.
 */
const PREFER_EXISTING_NOTE =
  'a non-leased tab for this app was already connected — that is the one a human can see, and this lease is not. Unless you need an isolated context (a second identity, a clean profile, parallel flows), release this lease and drive that sessionId instead.';

/**
 * The first live non-leased session that is THIS app, if any.
 *
 * The watcher selector decides who to NARRATE to, and it is deliberately permissive: an unknown
 * project still gets told, because a dark HUD is worse than a note that did not concern you. That
 * is the right trade for a broadcast and the wrong one here, where a single `[0]` is handed back as
 * "drive this instead". With `projectId` undefined — and it is an OPTIONAL argument that an
 * acquiring agent has no reason to pass — every non-leased session qualified and the answer was
 * whichever the map yielded first: leasing `localhost:4312` recommended a tab on `:5173`, another app.
 *
 * So this narrows by the one thing a lease always knows: the ORIGIN it is being taken against.
 * `projectId` still narrows further when given. Nothing is recommended when nothing matches, which
 * is the honest answer — a lease is simply correct then.
 */
function liveTabFor(
  deps: ToolDeps,
  projectId: string | undefined,
  url: string,
): string | undefined {
  const pool = deps.pool;
  if (pool === undefined) {
    return undefined;
  }
  const wanted = originOf(url);
  if (wanted === undefined) {
    return undefined;
  }
  try {
    const candidates = deps.sessions
      .all()
      .filter((session) => session.url !== undefined && originOf(session.url) === wanted)
      // Nor a tab gone silent: one last heard from 105s earlier was named here and answered nothing.
      .filter((session) => (session.lastSeenMs?.() ?? 0) <= SESSION_HEALTH.STALE_THRESHOLD_MS)
      .map((session) => ({ id: session.id, projectId: session.projectId }));
    return watchersToNotify(candidates, pool.leasedSessionIds(), projectId)[0];
  } catch {
    return undefined;
  }
}

/**
 * Tell the tabs a human is watching that the agent has gone somewhere they cannot see.
 *
 * Fire-and-forget, and deliberately never able to fail the tool: this is a courtesy to a person, and
 * a lease that succeeded must not be reported as failed because a narration could not be posted to
 * some unrelated tab. `pushNarration` is already fire-and-forget; the try/catch covers a session
 * that disconnects between listing it and posting to it.
 */
function tellWatchers(deps: ToolDeps, projectId: string | undefined, text: string): void {
  const pool = deps.pool;
  if (pool === undefined) {
    return;
  }
  try {
    const candidates = deps.sessions
      .all()
      .map((session) => ({ id: session.id, projectId: session.projectId }));
    for (const id of watchersToNotify(candidates, pool.leasedSessionIds(), projectId)) {
      deps.sessions.get(id)?.pushNarration(text);
    }
  } catch {
    // A HUD that missed one line is a smaller problem than a lease reported as broken.
  }
}

export const LEASE_TOOLS: ToolDef[] = [LEASE_ACQUIRE_TOOL, LEASE_RELEASE_TOOL];
