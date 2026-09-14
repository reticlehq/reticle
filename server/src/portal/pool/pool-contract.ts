/**
 * What the pool drives, stated as interfaces and nothing else.
 *
 * A leaf: `storage-seed.ts` needs four of these shapes and had to import them back out of
 * `browser-pool.ts`, which imports IT. Real Playwright `Page`/`BrowserContext`/`Browser` satisfy
 * these structurally, which is how the pool stays testable without a real Chromium.
 */

/** The minimal page surface the pool drives. Real Playwright `Page` satisfies this. */
export interface PooledPage {
  goto(url: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  close(): Promise<void>;
  /** Fires when THIS page's renderer crashes — lets the pool reclaim just this lease, not the fleet. */
  onCrash(handler: () => void): void;
  /**
   * Fires for each console message the page logs. OPTIONAL: a fake that does not implement it makes
   * the pool record nothing, which is the correct degradation — an absent dial address must read as
   * "the page said nothing", never as "the page dialled correctly".
   */
  onConsole?(handler: (text: string) => void): void;
  /**
   * Capture the page as a PNG. OPTIONAL, like `onConsole`: a fake that does not implement it makes
   * the pool report "no provider", which is the correct degradation — an absent screenshotter must
   * read as "this context cannot be captured", never as a blank image that a visual diff would then
   * compare against and pass.
   */
  screenshot?(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  /**
   * Move the real pointer to (x, y) so CSS `:hover` applies. OPTIONAL, like `screenshot`: a fake
   * that does not implement it makes hover refuse rather than dispatch a synthetic mouseover that
   * reports dispatched/settled while the styles never ran.
   */
  hover?(x: number, y: number): Promise<void>;
  /** Add an init script to run after document creation but before any page scripts run. */
  addInitScript?<Arg>(
    script: ((arg: Arg) => void) | string,
    arg?: Arg,
  ): Promise<InitScriptHandle | void>;
  /**
   * Install (or clear) network mocks on this page. OPTIONAL: a fake that does not implement it
   * makes `reticle_network_mock` refuse rather than claiming it stubbed a request it cannot intercept.
   */
  installMocks?(rules: readonly PooledMockRule[]): Promise<void>;
  /**
   * Resize this page's viewport. OPTIONAL, like `installMocks`: a fake that does not implement it
   * makes `reticle_viewport` refuse rather than claim a resize the page never took.
   *
   * A lease IS a real browser page, so the resize was always possible — the tool simply had no route
   * to it and consulted only the driven-provider path. On an SDK-only install there is no such
   * provider, so mobile-only UI (a `lg:hidden` hamburger, a drawer that only mounts under a
   * breakpoint) could not be driven at all without installing Playwright separately.
   */
  setViewport?(size: { width: number; height: number }): Promise<void>;
  /**
   * Fires when the page opens a native `window.confirm`/`alert`/`prompt`. OPTIONAL, like `onConsole`:
   * a fake that does not implement it means the pool cannot see or arbitrate the dialog, and the
   * page is left to whatever the underlying engine does with no listener attached.
   *
   * The pool always dismisses on this handler (see `acquire`) — a page blocked on a native dialog
   * previously wedged the whole session (every subsequent tool call timed out and no recovery
   * existed short of restarting the daemon), because nothing in the stack ever answered it.
   */
  onDialog?(handler: (dialog: PooledDialog) => void): void;
}

/** A native dialog the page opened, handed to the pool so it can be dismissed instead of left blocking. */
export interface PooledDialog {
  /** The dialog's message text — kept for diagnostics (`BrowserPool#lastDialogMessage`). */
  readonly message: string;
  dismiss(): Promise<void>;
}

export interface InitScriptHandle {
  dispose(): Promise<void>;
}

export interface PooledCookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * One interception rule the pool can install. Same fields as the drive-path mock rule, kept here so
 * the pool does not import Playwright.
 */
export interface PooledMockRule {
  urlContains: string;
  method?: string;
  status?: number;
  body?: string;
  contentType?: string;
  delayMs?: number;
  abort?: boolean;
}

/** An isolated browsing context (cookies/storage). Real Playwright `BrowserContext` satisfies this. */
export interface PooledContext {
  newPage(): Promise<PooledPage>;
  close(): Promise<void>;
  addCookies?(cookies: PooledCookie[]): Promise<void>;
}

/** The launched browser. Real Playwright `Browser` satisfies this. */
export interface PooledBrowser {
  isConnected(): boolean;
  newContext(): Promise<PooledContext>;
  close(): Promise<void>;
  /** Fires when the browser process dies/crashes so the pool can relaunch on the next acquire. */
  onDisconnected(handler: () => void): void;
}

/** Produces a freshly launched browser. Injected so tests can supply a fake. */
export type Launcher = () => Promise<PooledBrowser>;
