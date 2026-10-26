/**
 * The pool's lease handle and lease record, its options, and its limits: the types and constants
 * `BrowserPool` is built from.
 */

import type {
  InitScriptHandle,
  Launcher,
  PooledBrowser,
  PooledContext,
  PooledPage,
} from './pool-contract.js';

/** A leased context+page for one flow. `release` frees the slot and closes the context. */
export interface Lease {
  readonly sessionId: string;
  readonly url: string;
  readonly navStatus?: number;
  release(): Promise<void>;
  /**
   * Hand the page the zero-install reader: evaluated in the live document, and added ahead of every
   * document this lease loads next. False when there is no reader, or the page cannot run one.
   * Rejects with `NotHtmlDocumentError` when the page is not an HTML document.
   */
  injectReader?(): Promise<boolean>;
  /** Whether the page's document has not reached `complete` yet. False when it cannot be read. */
  isLoading?(): Promise<boolean>;
}

/** Default lease time-to-live: a lease untouched for this long is presumed orphaned and reclaimed. */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
/**
 * How long a lease outlives the MCP connection that took it. Long enough for an agent whose
 * connection only blipped to touch it again; short enough that a gone agent's window closes soon.
 */
export const ORPHANED_LEASE_GRACE_MS = 30_000;

/** Default cap on how long a lease's initial navigation may take before it fails (frees the slot). */
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;

/**
 * How many reaped lease ids to remember. Only the most recent departure is ever asked about, so
 * this is slack for a burst sweep, not a history.
 */
export const MAX_REMEMBERED_REAPED_LEASES = 64;

export interface BrowserPoolOptions {
  /** Max simultaneous leased contexts. Over-cap acquires queue. */
  maxContexts: number;
  /** Stable id generator for lease sessionIds (injected to stay clock-/random-free in logic). */
  genSessionId: () => string;
  /** Injected clock (ms). Defaults to Date.now; tests pass a controllable one. */
  now?: () => number;
  /** A lease untouched for longer than this is reclaimed by sweepExpired. */
  leaseTtlMs?: number;
  /** Per-lease navigation timeout — a page that won't load fails its own lease, never blocks a slot. */
  navTimeoutMs?: number;
  /**
   * The zero-install reader, built where the daemon knows its own port and pairing token. A thunk so
   * the ~450KB build is only read if some page ever needs it; undefined when there is none to give.
   */
  zeroInstallScript?: () => string | undefined;
  /**
   * Launches a browser with a window, for a lease somebody wants to watch. Launched only when the
   * first headed lease is asked for. Absent: a headed lease is refused.
   */
  launchHeaded?: Launcher;
}

/** One browser the pool may hold, and the launch in flight for it. */
export interface BrowserSlot {
  readonly launch: Launcher | undefined;
  readonly headed: boolean;
  browser?: PooledBrowser | undefined;
  launching?: Promise<PooledBrowser> | undefined;
}

/** What a headed lease is refused with where no window can be opened. */
export const NO_HEADED_BROWSER = 'no headed browser can be opened here';

/**
 * An acquire that asked to be refused rather than queued found every slot taken (#1535). Queued,
 * it waited behind the cap with no deadline and no status, and `reticle drive` reported the 60 s
 * timeout as a daemon shutting down. The message names the cap and the one override for it.
 */
export class PoolAtCapacityError extends Error {
  constructor(readonly max: number) {
    super(
      `all ${String(max)} lease slots are in use. Release one (reticle_lease{action:"release"}, or ` +
        'stop a `reticle drive`), or raise RETICLE_MAX_CONTEXTS.',
    );
    this.name = 'PoolAtCapacityError';
  }
}

/**
 * What an acquire that asked for an init script is refused with when the page cannot run one.
 *
 * A refusal rather than a lease: the caller asked for a stub of the bindings a desktop shell
 * injects, and a tab opened without it would throw in the app's view and read as a broken app.
 */
export const INIT_SCRIPT_UNSUPPORTED =
  'Init script failed: this page does not support init scripts, so the requested stub would not be there';

export interface ActiveLease {
  /** Whether it lives in the headed browser: that browser's death is this lease's death. */
  headed: boolean;
  context: PooledContext;
  page: PooledPage;
  url: string;
  /** Who took it (one id per MCP attach). Only that caller is handed it again. */
  owner?: string;
  /** Last time an agent touched this lease (acquire or any tool call); drives orphan reclaim. */
  touchedAt: number;
  /** When the connection that took it closed, until it is touched again. */
  detachedAt?: number;
  /**
   * The websocket address the page's SDK reported it could not reach, if it said so.
   *
   * One string, overwritten — not a buffer. The SDK retries and logs each failure, so accumulating
   * them would grow without bound for exactly the app that is already misconfigured, and every entry
   * after the first says the same thing.
   */
  dialFailureUrl?: string;
  /**
   * The message of the most recent native dialog dismissed on this lease, if any.
   *
   * One string, overwritten — not a buffer, same reasoning as `dialFailureUrl`: this is diagnostic
   * context for "why did the page look frozen for a moment", not a log an agent needs to replay.
   */
  lastDialogMessage?: string;
  /**
   * The disposable handle of the caller's init script, when the lease was opened with one — a stub
   * of the bindings a desktop shell injects. Disposed with the lease, so a reload or a later
   * navigation inside the lease keeps the stub.
   */
  hostStub?: InitScriptHandle;
  /** The production guard on this page's requests, re-asserted after mocks so it is asked first. */
  guard?: (method: string, url: string) => string | undefined;
  /**
   * The text of that init script, kept so a lease that asks for the SAME stub again is recognised and
   * reused instead of being torn down and remade — see `hostStubScript` and the lease tool's reuse.
   */
  hostStubScript?: string;
  /** What this lease was granted when it opened. It never changes on an open lease. */
  permissions: readonly string[];
  /** Whether its context accepts any TLS certificate (#1255). Fixed when the context is made. */
  ignoresHTTPSErrors: boolean;
}

/** Whether the page's document has not finished loading. A page that cannot be asked counts as loaded. */
export async function pageLoading(page: PooledPage): Promise<boolean> {
  if (page.evaluate === undefined) {
    return false;
  }
  const state = await page.evaluate('document.readyState');
  return 'string' === typeof state && state !== 'complete';
}
