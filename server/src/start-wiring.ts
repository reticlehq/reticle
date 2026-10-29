/**
 * The wiring `start` and `startDaemon` share, built in one place so the two entry points cannot drift.
 *
 * Split from `index.ts`: that file is the package's front door and the two entry points; these are
 * the pieces both of them assemble — the browser pool, the drive/real-input provider, the CDP network
 * router, and the per-project lookups the daemon closes over. `daemon-parity.test.ts` checks both
 * entry points still call them.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { worktreeTwins } from './command/cli/config/checkout.js';
import { cpus, homedir } from 'node:os';
import { bridgeWsUrl, EventType, ReticleDir, ReticleEnv } from '@reticlehq/core';
import { fetchPlatformConfig } from '@/features/harness/platform-config.js';
import { platformEnvPort } from './memory/cloud/cloud-config.js';
import {
  knownProjectCandidates,
  projectDirectoryFor,
} from './memory/project/artifact-root-resolver.js';
import { createNodeFileSystem } from './memory/project/fs/fs-port.js';
import { claimedArtifactRoots } from './memory/project/root-claims.js';
import { originOf } from './portal/session/session-manager.js';
import { setBrowserMode, BrowserMode } from './telemetry/browser-mode.js';
import type { NetworkDetail } from './portal/input/network-detail.js';
import type { StartOptions } from './start-options.js';
import type { Bridge } from './portal/bridge/bridge.js';
import { sdkFixForDirectory } from './command/version/sdk-fix.js';
import { SERVER_VERSION } from './command/version/identity/server-version.js';
import { CdpRealInputProvider, LaunchedRealInputProvider } from './portal/input/real-input.js';
import type { RealInputProvider } from './portal/input/real-input.js';
import { BrowserPool } from './portal/pool/browser-pool.js';
import { playwrightLauncher, resolveMaxContexts } from './portal/pool/playwright-launcher.js';
import { makePageErrorJournal, type PageErrorJournal } from './portal/pool/page-error-journal.js';
import type { PooledPageError } from './portal/pool/pool-contract.js';
import { resolveLeasedSessionId } from './surface/tools/lease-tools.js';
import {
  readReaderBundle,
  zeroInstallScript as zeroInstallScriptFor,
  type InjectedConnect,
} from './portal/pool/zero-install.js';
import { offLoopbackOrigin } from './portal/pool/context-permissions.js';
import type { NonceMinter } from './portal/production/production-activation.js';

/**
 * Build the shared browser pool (one headless Chromium, N capped isolated leased contexts). Lazy —
 * no Chromium launches until the first lease — so creating it is free even when never used.
 */
/** Where the zero-install reader connects: this daemon's own bridge, with its pairing token. */
export function readerConnect(port: number, token: string | undefined): InjectedConnect {
  return { url: bridgeWsUrl(port), ...(token === undefined ? {} : { token }) };
}

/**
 * The zero-install script for pages that connect to `reader`, built on first use and kept: the
 * page that needs it is one whose app never connected. Undefined when this install has no reader.
 *
 * A page that is not on loopback gets a nonce minted for its origin in place of the pairing token.
 * The bridge admits a WebSocket from an origin only while a nonce names it, so the reader on a
 * deployed page was refused with a 403 (#2016). The nonce also keeps the machine's pairing token
 * out of a page that somebody else serves.
 *
 * ponytail: the nonce lives for one drive (SESSION_NONCE_TTL_MS). A lease reloaded after that
 * dials with a dead nonce; mint per navigation if that is ever seen.
 */
export function zeroInstallLoader(
  reader: InjectedConnect,
  nonces?: Pick<NonceMinter, 'mint'>,
): (url?: string) => string | undefined {
  let script: string | null | undefined;
  return (url) => {
    const origin = offLoopbackOrigin(url);
    if (origin !== undefined && nonces !== undefined) {
      const bundle = readReaderBundle();
      if (bundle === undefined) {
        return undefined;
      }
      return zeroInstallScriptFor(bundle, {
        url: reader.url,
        token: nonces.mint({ origin }).nonce,
      });
    }
    if (script === undefined) {
      const bundle = readReaderBundle();
      script = bundle === undefined ? null : zeroInstallScriptFor(bundle, reader);
    }
    return script ?? undefined;
  };
}

export function createBrowserPool(
  headless: boolean,
  reader: InjectedConnect,
  onPageError?: (leaseId: string, error: PooledPageError) => void,
  onLeaseClosed?: (leaseId: string) => void,
  nonces?: Pick<NonceMinter, 'mint'>,
): BrowserPool {
  const maxContexts = resolveMaxContexts(process.env[ReticleEnv.MAX_CONTEXTS], cpus().length);
  const genSessionId = (): string =>
    `lease-${
      'function' === typeof globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : String(Date.now())
    }`;
  return new BrowserPool(playwrightLauncher({ headless }), {
    maxContexts,
    genSessionId,
    zeroInstallScript: zeroInstallLoader(reader, nonces),
    launchHeaded: playwrightLauncher({ headless: false }),
    ...(onPageError === undefined ? {} : { onPageError }),
    ...(onLeaseClosed === undefined ? {} : { onLeaseClosed }),
  });
}

/**
 * Journal the uncaught page errors the pool hears into the session that connects for that lease.
 *
 * The pool sees every throw its pages make from before the first navigation; the SDK only exists
 * afterwards. Without this wiring an import-time crash — a blank page with no error text anywhere
 * (#1966) — was invisible to the agent driving it. Returns the journal so the pool's sink can be
 * handed over; the bridge hook is registered here.
 */
export function attachPageErrorJournal(bridge: Bridge): PageErrorJournal {
  const journal = makePageErrorJournal({
    resolveSession: (leaseId) => {
      // Same resolution the lease tool uses: the lease id, or the id of a session whose URL
      // carries the lease marker — an app that registered under its own name still reaches its lease.
      const id = resolveLeasedSessionId(bridge.sessions, leaseId);
      if (id === undefined) {
        return undefined;
      }
      const session = bridge.sessions.get(id);
      return session === undefined ? undefined : session;
    },
  });
  bridge.attachSessionCreate((session) => journal.onSessionCreate(session));
  // The daemon runs for days; both of the journal's maps are keyed by things that end, so both
  // endings are hooked. The bridge's end hook is additive — the durable journal's teardown runs too.
  bridge.attachSessionEnd((session) => {
    journal.onSessionEnd(session.id);
    return Promise.resolve();
  });
  return journal;
}

/**
 * Route CDP-authoritative network detail onto the driven session's journal.
 *
 * The page and the SDK session share an origin, so a NET_DETAIL is pushed to the matching connected
 * session. Shared by both entry points: `startDaemon` previously omitted it entirely, so on the path
 * users actually take, CDP network detail was collected and then dropped on the floor.
 */
export function makeNetworkDetailRouter(bridge: Bridge, driveUrl: string | undefined) {
  const driveOrigin = originOf(driveUrl ?? '');
  return (detail: NetworkDetail): void => {
    // Route by the DOCUMENT that issued the request, not by the request's own origin.
    //
    // Matching the request's origin only works for same-origin calls. An app on one origin calling an
    // API on another — most API calls — produced a detail matching no session, and it was dropped
    // without a trace. The drive-URL fallback papered over it on the launched path and did nothing on
    // the CDP-attach path, where driveUrl is undefined and the fallback compares against ''.
    const pageOrigin = originOf(detail.pageUrl ?? '');
    const requestOrigin = originOf(detail.url);
    for (const session of bridge.sessions.all()) {
      const origin = originOf(session.url);
      // originOf returns `string | undefined`, NEVER '' — so the old `!== ''` guards were dead, and a
      // bare `origin === requestOrigin` matched `undefined === undefined` when BOTH the session URL and
      // the detail URL were unparseable. That routed a NET_DETAIL (with its response headers, incl.
      // set-cookie) onto an unrelated session. Require a DEFINED origin; undefined operands then simply
      // fail to match any of the three candidates.
      const matches =
        origin !== undefined &&
        (origin === pageOrigin || origin === requestOrigin || origin === driveOrigin);
      if (matches) {
        session.pushEvent({
          t: 0,
          type: EventType.NET_DETAIL,
          sessionId: session.id,
          data: { ...detail },
        });
      }
    }
  };
}

/**
 * Resolve the drive/real-input provider from options — shared by start and startDaemon so the
 * precedence (driveUrl launch+own → CDP attach → none) and the storageState/injectConnect plumbing
 * live in ONE place. `onNavigateError` is the entrypoint's own cleanup (close the bridge/shared server)
 * so a failed launch never leaks a WS port. A past divergence between the two paths let daemon mode
 * run with a different setup — this removes that risk.
 */
export async function resolveRealInput(
  options: StartOptions,
  onNavigateError: () => Promise<void>,
  onNetworkDetail?: (detail: NetworkDetail) => void,
  /** Where a driven page with no SDK connects the zero-install reader. Absent: it gets none. */
  reader?: InjectedConnect,
): Promise<{ realInput?: RealInputProvider; owned?: { dispose: () => Promise<void> } }> {
  const driveUrl = options.driveUrl;
  if (driveUrl !== undefined && driveUrl.length > 0) {
    const headless = options.headless ?? true;
    // The one place that knows. Everything downstream reads it rather than re-deriving it, and a
    // daemon that launches nothing keeps the default (ATTACHED) rather than guessing.
    setBrowserMode(headless ? BrowserMode.HEADLESS : BrowserMode.HEADED);
    const injectConnect = options.injectConnect;
    const storageState = options.storageState;
    const factory =
      options.realInputFactory ??
      ((opts) =>
        new LaunchedRealInputProvider({
          driveUrl: opts.driveUrl,
          headless: opts.headless,
          ...(injectConnect !== undefined ? { injectConnect } : {}),
          ...(storageState !== undefined ? { storageState } : {}),
          ...(onNetworkDetail !== undefined ? { onNetworkDetail } : {}),
          ...(reader !== undefined ? { zeroInstallScript: zeroInstallLoader(reader) } : {}),
        }));
    const launched = factory({ driveUrl, headless });
    try {
      await launched.navigate();
    } catch (error) {
      await onNavigateError(); // no leaked WS port on a failed start
      throw error;
    }
    return { realInput: launched, owned: launched };
  }
  const cdpUrl = options.cdpUrl ?? process.env[ReticleEnv.CDP_URL];
  if (cdpUrl !== undefined && cdpUrl.length > 0) {
    // Same network sink as the launched path. Whether Reticle opened the browser or attached to one
    // someone else opened has no bearing on whether it can read that browser's network.
    const cdp = new CdpRealInputProvider({
      cdpUrl,
      ...(onNetworkDetail !== undefined ? { onNetworkDetail } : {}),
    });
    return { realInput: cdp, owned: cdp };
  }
  return {};
}

/**
 * The SDK-upgrade sentence for the package.json of the project the page announced, evaluated at
 * each HELLO so a just-edited manifest is what we name. The daemon's cwd only when that project's
 * directory is unknown, and the framework-neutral sensor when that is not an app either (#1135).
 */
export function sdkFixForProject(projectId?: string): string {
  return sdkFixForDirectory(SERVER_VERSION, projectDirectoryFor(projectId) ?? process.cwd());
}

/**
 * Resolve a session's artifact root, from everything this machine knows about where projects live.
 *
 * Built once per daemon and closed over by every tool call. The two sources are read lazily and
 * cheaply on each call rather than snapshotted at startup: `init` can run in another terminal while
 * this daemon is up, and a resolution that used a startup snapshot would keep answering with a map
 * from before the project the agent is now driving existed.
 */
/**
 * Every `.reticle` root on this machine that sync should consider: the sources the artifact resolver
 * uses, plus every root a lease claimed in this process.
 *
 * Read on every call rather than snapshotted, for the same reason: `reticle link` can run in
 * another terminal while this daemon is up, and a startup snapshot would keep that repo silent
 * until somebody restarted a process they have no reason to suspect.
 *
 * Returns directories that MIGHT be linked; the caller resolves each and skips the ones that are
 * not. Deciding that here would mean reading every cloud.json on every tick.
 */
export function knownProjectRoots(): string[] {
  const directories = knownProjectCandidates().map((c) => c.directory);
  // A page served from a git worktree writes its runs into that worktree's copy of the project.
  const twins = directories
    .flatMap(worktreeTwins)
    .filter((d) => existsSync(join(d, ReticleDir.ROOT)));
  return [
    ...new Set([
      ...[...directories, ...twins].map((d) => join(d, ReticleDir.ROOT)),
      // A lease opened with `root` writes there; without this, that work is never sent.
      ...claimedArtifactRoots(),
    ]),
  ];
}

/** This project's platform credential (stored, else the env key), as the env the platform readers take. */
export const platformEnvFor = (root: string | undefined) =>
  platformEnvPort(
    createNodeFileSystem(),
    root ?? join(process.cwd(), ReticleDir.ROOT),
    homedir(),
    process.env,
  );
export const loadHarnessConfig = async (root: string) =>
  fetchPlatformConfig(await platformEnvFor(root)());
