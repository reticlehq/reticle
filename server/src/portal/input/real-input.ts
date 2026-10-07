/**
 * Optional CDP/Playwright real-input mode.
 *
 * Synthetic `dispatchEvent` cannot drive native hover/pointer state (an onMouseEnter never
 * fires, hit-testing never runs). When a CDP endpoint is configured, this module connects a
 * Playwright `Browser` over CDP and drives REAL pointer/keyboard input against the element box
 * the SDK resolves (viewport CSS px from getBoundingClientRect).
 *
 * Node-only. Playwright is loaded via DYNAMIC `import('playwright')` so non-CDP users never
 * pay for it; the type-only import is elided by `tsc`, so the build stays green without it.
 */
import { takeJsCoverage, type ScriptCoverage } from './js-coverage.js';
import type { Browser, Page } from 'playwright';
import { stampedDriveUrl } from './drive-url-stamp.js';
import { launchChromium } from '@/launch-chromium.js';
import { chromiumLaunchHint, gotoOptions } from '@/portal/pool/playwright-launcher.js';
import { BrowserLaunchKind } from '@reticlehq/core/telemetry';
import { getSessionMetrics } from '@/telemetry/session-metrics.js';
import { classifyConnectFailure } from '@/telemetry/connect-failure.js';
import {
  ActionType,
  clampHoldMs,
  DriveErrorCode,
  DRIVE_PLAYWRIGHT_MISSING_MSG,
  explicitCodeFromArgs,
  InputMode,
  InputModeReason,
  pressKeyFromArgs,
  pressKeysFromArgs,
  pressModifiersFromArgs,
} from '@reticlehq/core';
import { installNetworkMocks, type MockRule } from './network-mock.js';
import { attachNetworkDetail, type NetworkDetail } from './network-detail.js';
import { injectedConnectArgs } from '@/portal/pool/zero-install.js';

/** Viewport CSS-px box as returned by the INSPECT command (getBoundingClientRect). */
export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Args forwarded from reticle_act (fill value, type text, press key, drag drop-target box).
 *
 * A `type`, not an `interface`: only the alias form gets an implicit index signature, so the core
 * arg readers take it as a plain record without a cast at every call site.
 */
export type RealInputArgs = {
  value?: string;
  text?: string;
  /** For press: the key name, e.g. Escape or Tab. `text` also carries it; `key` is the fallback. */
  key?: string;
  /** For press: modifier names (Meta/Control/Shift/Alt; aliases like `cmd` accepted). */
  modifiers?: string[];
  /**
   * For press: several keys held down TOGETHER, pressed in order and released in reverse. Read but
   * never forwarded — a chord with a non-modifier key has no `page.keyboard.press` spelling, so the
   * caller routes such a press to the synthetic dispatcher before it reaches here.
   */
  keys?: string[];
  /**
   * For press: how long to keep the key down between keydown and keyup. The same argument the
   * synthetic path has always honoured, so a hold-to-confirm key driven through the driver holds
   * for exactly as long as one driven in the page.
   */
  holdMs?: number;
  /** For drag: the resolved box of the drop-target ref (toRef). */
  toBox?: ElementBox;
  steps?: number;
};

/** What a provider reports for one driven gesture. Exported so a fake can build it by name. */
export interface RealInputResult {
  /** True if a native gesture was actually driven. */
  performed: boolean;
  /** Center used, for diagnostics/tests. ABSENT for a key press: see `undriven`. */
  center?: { cx: number; cy: number };
  /**
   * Which path this result came from. `real` whenever a gesture was actually driven, so a caller
   * reading it on a `performed: true` result learns nothing it did not already know — it is here
   * for the `performed: false` case, where the caller is about to take the synthetic path and
   * saying `real` would describe a gesture that never ran.
   */
  inputMode: InputMode;
  /**
   * How long the key was ACTUALLY held, for a real press that was asked to hold. Absent for every
   * other gesture, and for a press with no `holdMs` — the same rule the synthetic path uses, where
   * an absent `heldMs` means "this action does not hold" rather than "it held for no time".
   *
   * Measured rather than echoed back: `holdMs: 1200` against a 1200ms animation is a race by
   * construction, and a throttled tab stretches the wait. A caller needs to tell "held 1200" from
   * "held 1204", and can only do that with the achieved number.
   */
  heldMs?: number;
}

/** Options for a page screenshot — full-page scroll capture and/or a clip box. */
export interface ScreenshotOpts {
  fullPage?: boolean;
  /** Restrict the capture to one element/region (viewport CSS px). */
  clip?: ElementBox;
}

/** The capability surface reticle_act depends on. A FAKE implementing this is injected in tests. */
export interface RealInputProvider {
  /** Whether a Playwright Page currently matches this SDK session URL. */
  isAvailableFor(sessionUrl: string): Promise<boolean>;
  /** Drive a native gesture for `action` at the element `box`. */
  perform(
    sessionUrl: string,
    action: ActionType,
    box: ElementBox,
    args: RealInputArgs,
  ): Promise<RealInputResult>;
  /**
   * Capture a PNG of the correlated page, or undefined if no page matches. Optional
   * so the visual layer stays opt-in — a provider that cannot screenshot simply omits it.
   */
  screenshot?(sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined>;
  /**
   * Read and restore the browser CONTEXT's state — cookies and per-origin storage — so a suite can
   * start from a known place instead of logging in fifty times.
   *
   * Optional, and on the web this is where the capability actually lives. A page cannot write an
   * httpOnly cookie from inside itself, so the SDK can never do this however much is added to it;
   * only something holding the context can. A provider with no owned browser omits both, and every
   * flow then runs from cold, which is correct and merely slower.
   *
   * The state is opaque to everything but the browser that produced it. `applyStorageState` returns
   * false when no driven page matched, which the caller must treat as a failure rather than a
   * no-op — a suite that believes it is signed in and is not fails fifty times for a reason none of
   * them names.
   */
  storageState?(sessionUrl: string): Promise<unknown>;
  applyStorageState?(sessionUrl: string, state: unknown): Promise<boolean>;
  /**
   * Install (or replace, or with [] clear) network-mock rules on the correlated page — stub a 500,
   * force offline, delay a response — for deterministic error/edge-state testing. Returns true when
   * a page matched and the rules were applied, false when no driven page matches this session.
   * Optional: a provider with no owned browser simply omits it.
   */
  setMocks?(sessionUrl: string, rules: MockRule[]): Promise<boolean>;
  /**
   * What of the app's own code ran since the last take (V8 coverage, Chromium only), or undefined
   * when no driven page matches or collection had not started. The first call starts collecting,
   * because collection slows every script on the page and a slower page can let a console error land
   * after a clean-console check passed. Optional: a provider with no owned browser cannot see the
   * engine's counters.
   */
  takeCodeCoverage?(sessionUrl: string): Promise<ScriptCoverage[] | undefined>;
  /**
   * Pin the correlated page's viewport to fixed pixel dimensions so a screenshot baseline is
   * reproducible across machines (the missing piece of CI-stable visual regression, alongside masks
   * and the frozen clock). Returns true when a page matched, false otherwise. Optional.
   */
  setViewport?(sessionUrl: string, size: { width: number; height: number }): Promise<boolean>;
}

/**
 * Optional lifecycle a provider that OWNS a browser implements (`reticle drive`). The
 * reticle_act routing still depends only on `RealInputProvider`; the server uses these to boot/tear-down.
 */
export interface OwnedRealInputProvider extends RealInputProvider {
  /** Launch + navigate the owned browser. Must reject (never hang) on failure. */
  navigate(): Promise<void>;
  /** Close the owned browser. Idempotent. */
  dispose(): Promise<void>;
}

/** Structured, code-tagged failure so callers branch on cause, not message text. */
export class DriveError extends Error {
  readonly code: DriveErrorCode;
  constructor(code: DriveErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'DriveError';
  }
}

/** Center of a viewport box in CSS px. Pure — unit-tested directly. */
export function boxCenter(box: ElementBox): { cx: number; cy: number } {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

/**
 * Which actions are driven by a native pointer. `press` is excluded on purpose — a key has no
 * pointer, and widening this would change what every existing caller of it means.
 */
export function isPointerAction(action: ActionType): boolean {
  return (
    action === ActionType.HOVER ||
    action === ActionType.CLICK ||
    action === ActionType.DBLCLICK ||
    action === ActionType.DRAG
  );
}

/**
 * The routing question `tryRealInput` asks: does this action have a real-input path at all? Wider
 * than `isPointerAction` by `press`, which needs no coordinates.
 */
export function isRealInputAction(action: ActionType): boolean {
  return isPointerAction(action) || action === ActionType.PRESS;
}

/**
 * A gesture that was NOT driven. No center for a key press — a zero would read as a real point.
 *
 * `inputMode` is SYNTHETIC: no real gesture ran, so this is the path the caller is about to take.
 */
function undriven(action: ActionType, box: ElementBox): RealInputResult {
  const base: RealInputResult = { performed: false, inputMode: InputMode.SYNTHETIC };
  return action === ActionType.PRESS ? base : { ...base, center: boxCenter(box) };
}

/** Settle delay after a native gesture so the reaction can begin to flush (named, not free). */
const REAL_INPUT_SETTLE_MS = 16;
/** Default number of interpolation steps for a native drag. */
const DEFAULT_DRAG_STEPS = 8;

type SleepFn = (ms: number) => Promise<void>;
type ConnectFn = (url: string) => Promise<Browser>;

/**
 * Drive a `press` with a real keyboard — coordinate-free; the key goes to whatever holds focus.
 * Key and modifiers come from the same core helpers the synthetic dispatcher uses, so the two paths
 * cannot read the same args differently.
 *
 * A `holdMs` splits the chord into down / wait / up, the same shape the page uses for a held key.
 * `keyboard.press` would send it instantly instead, reporting a hold-to-confirm that never held.
 * The one thing this cannot reproduce is the auto-repeat a held key emits: the driver sends a single
 * keydown, where the in-page path sends the repeats a browser would. Named rather than papered over
 * — an app that counts repeats needs the synthetic path, and a caller that sees a held key do
 * nothing now has a reason to try it.
 */
async function pressViaKeyboard(
  page: Page,
  args: RealInputArgs,
  sleep: SleepFn,
  now: () => number,
): Promise<number> {
  const key = pressKeyFromArgs(args);
  const modifiers = pressModifiersFromArgs(args);
  const chord = 0 < modifiers.length ? `${modifiers.join('+')}+${key}` : key;
  const holdMs = clampHoldMs(args.holdMs);
  if (0 === holdMs) {
    // `press` DOES take a chord string ("Control+k"), so the tap path needs no splitting.
    await page.keyboard.press(chord);
    return 0;
  }
  /*
   * `down`/`up` take ONE key each, unlike `press`: `down('Control+k')` throws
   * `Unknown key: "Control+k"` — measured on a real Chromium, not assumed. The chord string the
   * tap path uses therefore cannot express a hold, so the chord is split here: modifiers down in
   * chord order, the key last, and released in reverse (key first, modifiers reversed), which is
   * what a hand does and what an app's keyup bookkeeping expects.
   *
   * Without the split a held shortcut threw before a single key moved, the caller fell back to
   * the synthetic path, and a real hold was impossible for any press with modifiers — the exact
   * gesture `holdMs` exists for.
   *
   * ## Why every key that went down is tracked, and every exit path cleans up
   *
   * The down calls are the ones that MOVE the keyboard, and they can fail partway: `Control` goes
   * down, the key after it rejects, and the driver's copy of `Control` is still held. That path
   * used to fall straight to the caller's synthetic replay — which presses the same chord again on
   * a keyboard that is already holding a modifier. Tracking what actually went down is what makes
   * the cleanup below able to release the right keys, and only those: releasing a key that never
   * went down is its own lie, and it would turn a clean failure into an unnecessary refusal.
   */
  const pressed: string[] = [];
  const pressDown = async (k: string): Promise<void> => {
    await page.keyboard.down(k);
    pressed.push(k);
  };
  try {
    for (const modifier of modifiers) await pressDown(modifier);
    await pressDown(key);
  } catch (error) {
    // The chord is PARTIALLY down. Release what is held before reporting the failure; if that
    // cannot be proved, `releaseKeys` throws RELEASE_FAILED and the caller refuses the replay —
    // the same rule as a failed release on the ordinary path, for the same reason. Only when the
    // cleanup DOES succeed is the original error safe to hand back.
    await releaseKeys(page, pressed);
    throw error;
  }
  const startedAt = now();
  try {
    await sleep(holdMs);
  } catch (error) {
    // The wait failed, and the caller is about to run the synthetic path — which presses this SAME
    // key a second time. If the driver's copy stays down, a held modifier then colours every later
    // action for the rest of the run. Best-effort on purpose: whatever went wrong with the wait is
    // the error worth reporting. A cleanup that cannot be proved is the exception — that one is a
    // stuck key, and it must reach the caller as a refusal rather than be swallowed.
    try {
      await releaseKeys(page, pressed);
    } catch {
      throw new DriveError(
        DriveErrorCode.RELEASE_FAILED,
        'the wait failed and the keys it pressed could not be released, so they may still be held',
      );
    }
    throw error;
  }
  // NOT best-effort: on the ordinary path a failed release is a real failure the caller must hear
  // about, and swallowing it would report a press whose key is still down.
  await releaseKeys(page, pressed);
  return now() - startedAt;
}

/**
 * Release the given keys, in reverse press order, and report a failure as one that leaves the
 * keyboard UNKNOWN rather than as an ordinary provider error.
 *
 * Every release is attempted even after one fails: a stuck `Control` is worse than a stuck letter,
 * so a failure on one key must not skip the rest. The first failure is what is thrown, since it is
 * the one that happened first, and it is wrapped in `DriveError` so the caller can tell "this
 * gesture failed" from "this gesture may have left a key down" — the difference between a safe
 * synthetic replay and an unsafe one.
 */
async function releaseKeys(page: Page, pressed: readonly string[]): Promise<void> {
  let failure: unknown;
  for (const k of [...pressed].reverse()) {
    try {
      await page.keyboard.up(k);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    throw new DriveError(
      DriveErrorCode.RELEASE_FAILED,
      `the key was pressed but could not be released, so it may still be held: ${describeFailure(failure)}`,
    );
  }
}

/**
 * A thrown value as a line a reader can act on.
 *
 * Not `String(error)`: a non-Error thrown value (a rejected plain object, an SDK that throws a
 * record) stringifies to `[object Object]`, which names nothing and hides the one fact the message
 * exists to carry. Anything that is neither an Error nor a string says so rather than pretending.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'string' === typeof error ? error : 'an unknown error';
}

/**
 * The `press`es this module will NOT drive: a chord that only the in-page dispatcher can express.
 *
 * `args.keys` asks for several keys held down TOGETHER, pressed in order and released in reverse.
 * That is not a `page.keyboard.press` chord — a non-modifier key cannot appear before the last `+`
 * — and a real keyboard cannot aim a key at a named element. `args.code` is the third: the driver
 * presses by KEY name and offers no way to send a physical `code` that disagrees with it, so
 * `{ text: 'z', code: 'KeyY' }` would strike a different key than the one asked for. All three are
 * routed to the synthetic path by the caller, which reports the reason rather than pretending a
 * different gesture happened.
 *
 * Ordered by how specifically the caller asked: `keys` then `code` name the KEY, `ref` names only
 * the target. Two can apply at once, and the earlier one is the more unusual request — the reason
 * should name that, not the generic "you passed a ref".
 */
export function unspellablePressReason(
  ref: string,
  args: Record<string, unknown>,
): InputModeReason | undefined {
  if (0 < pressKeysFromArgs(args).length) {
    return InputModeReason.SYNTHETIC_MULTI_KEY_PRESS_PREFERRED;
  }
  if (explicitCodeFromArgs(args) !== undefined) {
    return InputModeReason.SYNTHETIC_KEY_CODE_PRESS_PREFERRED;
  }
  if (0 < ref.length) return InputModeReason.SYNTHETIC_ELEMENT_PRESS_PREFERRED;
  return undefined;
}

/**
 * Shared gesture executor: drive a native gesture on an already-resolved Page. Used by both the
 * CDP-attached and the launched (drive) providers so the pointer logic lives in one place.
 */
export async function performGesture(
  page: Page,
  action: ActionType,
  box: ElementBox,
  args: RealInputArgs,
  sleep: SleepFn,
  /** Injected so a test can assert the achieved hold deterministically; defaults to the real clock. */
  now: () => number = Date.now,
): Promise<RealInputResult> {
  // Ahead of the box, not after it: a press addresses focus rather than a point, and the
  // placeholder box its caller passes would otherwise be turned into a (0,0) that reads like a real
  // location. The result reports NO `center` for the same reason.
  if (action === ActionType.PRESS) {
    const heldMs = await pressViaKeyboard(page, args, sleep, now);
    return {
      performed: true,
      inputMode: InputMode.REAL,
      // Omitted rather than 0 when there was no hold — see `RealInputResult.heldMs`.
      ...(heldMs > 0 ? { heldMs } : {}),
    };
  }

  const center = boxCenter(box);
  const { cx, cy } = center;
  const real = (performed: boolean): RealInputResult => ({
    performed,
    center,
    inputMode: InputMode.REAL,
  });

  if (action === ActionType.HOVER) {
    await page.mouse.move(cx, cy);
    await page.mouse.move(cx + 1, cy);
    await page.mouse.move(cx, cy);
    await sleep(REAL_INPUT_SETTLE_MS);
    return real(true);
  }
  if (action === ActionType.CLICK) {
    await page.mouse.move(cx, cy);
    await page.mouse.click(cx, cy);
    return real(true);
  }
  if (action === ActionType.DBLCLICK) {
    await page.mouse.move(cx, cy);
    await page.mouse.dblclick(cx, cy);
    return real(true);
  }
  if (action === ActionType.DRAG) {
    if (args.toBox === undefined) return real(false);
    const dst = boxCenter(args.toBox);
    const steps = args.steps ?? DEFAULT_DRAG_STEPS;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= steps; i += 1) {
      const px = cx + ((dst.cx - cx) * i) / steps;
      const py = cy + ((dst.cy - cy) * i) / steps;
      await page.mouse.move(px, py, { steps: 1 });
    }
    await page.mouse.up();
    return real(true);
  }
  if (action === ActionType.FILL || action === ActionType.TYPE) {
    await page.mouse.click(cx, cy);
    await page.keyboard.type(args.value ?? args.text ?? '');
    return real(true);
  }
  return real(false);
}

/**
 * Reticle paints its own dev overlay (presenter HUD + border glow) into the page. That chrome is
 * time-varying — the activity log and border state change with every command — so capturing it
 * makes a fresh screenshot of an unchanged page differ from its baseline. Hide it during capture
 * (Playwright applies this stylesheet only for the shot, then reverts) so visual baselines reflect
 * the app, not Reticle. Disabling animations settles any remaining transitions for determinism.
 */
const HIDE_RETICLE_CHROME_CSS = '[data-reticle-overlay]{display:none !important}';
const SCREENSHOT_DETERMINISM = { style: HIDE_RETICLE_CHROME_CSS, animations: 'disabled' } as const;

/**
 * Capture a PNG from a Playwright page. Shared by the CDP + launched providers so the
 * screenshot path lives in one place (mirrors performGesture). Returns the raw PNG bytes.
 */
export async function capturePage(page: Page, opts: ScreenshotOpts): Promise<Uint8Array> {
  const buf = await page.screenshot(
    opts.clip !== undefined
      ? { ...SCREENSHOT_DETERMINISM, clip: opts.clip }
      : true === opts.fullPage
        ? { ...SCREENSHOT_DETERMINISM, fullPage: true }
        : { ...SCREENSHOT_DETERMINISM },
  );
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

interface CdpProviderOptions {
  cdpUrl: string;
  /** Injected so the settle delay is deterministic in tests; defaults to a real Node timer. */
  sleep?: SleepFn;
  /** Injected so a measured hold is deterministic in tests; defaults to the real clock. */
  now?: () => number;
  /** Injected connector so unit tests can stub Playwright without import. */
  connect?: ConnectFn;
  /**
   * Sink for CDP-authoritative network detail. Optional, so the capture stays opt-in.
   *
   * This used to exist only on the LAUNCHED provider, which gated wire-level network visibility on
   * whether Reticle happened to open the browser. That is the wrong axis: owning the browser says
   * nothing about being able to see its network, and both providers speak CDP. The authoritative
   * request body is the one thing an in-page fetch wrapper structurally cannot get.
   */
  onNetworkDetail?: (detail: NetworkDetail) => void;
}

const nodeSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const cdpConnect: ConnectFn = async (url) => {
  const { chromium } = await import('playwright');
  // Attaching to someone's already-running browser is the fragile path — a stale CDP url, a browser
  // that was closed — so its FAILURE rate is the number worth watching. Settled with the outcome
  // rather than counted up front, which is what the first version got wrong: it incremented before
  // the await, so it silently reported attempts while the other paths reported successes.
  const settle = getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.ATTACHED);
  try {
    const browser = await chromium.connectOverCDP(url);
    settle();
    return browser;
  } catch (error) {
    settle(classifyConnectFailure(error));
    throw error;
  }
};

/** CDP-backed real-input provider. Lazily connects on first availability check / perform. */
export class CdpRealInputProvider implements RealInputProvider {
  readonly #cdpUrl: string;
  readonly #sleep: SleepFn;
  readonly #now: () => number;
  readonly #connect: ConnectFn;
  readonly #onNetworkDetail: ((detail: NetworkDetail) => void) | undefined;
  /** Pages already listening. #pageFor resolves on EVERY call, so without this each action would add
   *  another listener and every response would be emitted once per action taken so far. */
  readonly #listening = new WeakSet<object>();
  /** Pages collecting V8 coverage — see js-coverage.ts. */
  readonly #covering = new WeakSet<Page>();
  #browser: Browser | undefined;

  constructor(options: CdpProviderOptions) {
    this.#cdpUrl = options.cdpUrl;
    this.#sleep = options.sleep ?? nodeSleep;
    this.#now = options.now ?? Date.now;
    this.#connect = options.connect ?? cdpConnect;
    this.#onNetworkDetail = options.onNetworkDetail;
  }

  /** Attach the response listener the first time we see a page; a no-op afterwards. */
  #listen(page: Page): void {
    const sink = this.#onNetworkDetail;
    if (sink === undefined || this.#listening.has(page)) return;
    this.#listening.add(page);
    attachNetworkDetail(page, sink);
  }

  async #ensureBrowser(): Promise<Browser | undefined> {
    if (this.#browser !== undefined) {
      // A cached browser can be DEAD: CDP dropped (the page was closed, the debugged Chrome exited,
      // the network blipped). The old code cached it forever, so every later call handed back a
      // corpse and the whole drive path went silently unavailable until the daemon restarted.
      // Playwright's Browser exposes isConnected(); a test fake may not, so only an EXPLICIT false
      // drops the cache — a fake without the method is assumed live.
      const alive = this.#browser.isConnected?.() ?? true;
      if (alive) return this.#browser;
      this.#browser = undefined; // fall through and reconnect
    }
    try {
      this.#browser = await this.#connect(this.#cdpUrl);
      return this.#browser;
    } catch {
      this.#browser = undefined; // a failed reconnect must not leave a stale handle behind
      return undefined;
    }
  }

  async #pageFor(sessionUrl: string): Promise<Page | undefined> {
    const browser = await this.#ensureBrowser();
    if (browser === undefined) return undefined;
    const page = selectPage(
      browser.contexts().flatMap((c) => c.pages()),
      sessionUrl,
    );
    if (page !== undefined) this.#listen(page);
    return page;
  }

  async takeCodeCoverage(sessionUrl: string): Promise<ScriptCoverage[] | undefined> {
    const page = await this.#pageFor(sessionUrl);
    return page === undefined ? undefined : takeJsCoverage(page, this.#covering);
  }

  async isAvailableFor(sessionUrl: string): Promise<boolean> {
    try {
      return (await this.#pageFor(sessionUrl)) !== undefined;
    } catch {
      return false;
    }
  }

  async perform(
    sessionUrl: string,
    action: ActionType,
    box: ElementBox,
    args: RealInputArgs,
  ): Promise<RealInputResult> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return undriven(action, box);
    return performGesture(page, action, box, args, this.#sleep, this.#now);
  }

  /** PNG of the correlated page, or undefined if none matches. */
  async screenshot(sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return undefined;
    return capturePage(page, opts);
  }

  /** The context's cookies and per-origin storage; undefined when no driven page matches. */
  async storageState(sessionUrl: string): Promise<unknown> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return undefined;
    return page.context().storageState();
  }

  /**
   * Put a captured context state back: cookies through the context, per-origin storage through the
   * page, because only the context owns a cookie jar and only a document owns its localStorage.
   *
   * False when no driven page matches. The caller throws on that — see `fixturePortFor`.
   */
  async applyStorageState(sessionUrl: string, state: unknown): Promise<boolean> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return false;
    const saved = state as {
      cookies?: Parameters<ReturnType<Page['context']>['addCookies']>[0];
      origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
    };
    if (saved.cookies !== undefined) await page.context().addCookies(saved.cookies);
    for (const origin of saved.origins ?? []) {
      // Only the document for an origin can write that origin's localStorage, so this is applied in
      // the page rather than through the context. A page sitting on a different origin cannot be
      // given another origin's storage, and silently succeeding there would be the quiet half-restore
      // this whole path exists to avoid.
      if (!page.url().startsWith(origin.origin)) continue;
      await page.evaluate((entries: { name: string; value: string }[]) => {
        // Reached through `globalThis` rather than `window`: this body is serialised and runs in the
        // PAGE, but it is typechecked here, and this package never pulls in the DOM lib — a server
        // that can name `window` is one step from a server that uses it.
        const store = (
          globalThis as { localStorage?: { setItem(key: string, value: string): void } }
        ).localStorage;
        if (store === undefined) return;
        for (const entry of entries) store.setItem(entry.name, entry.value);
      }, origin.localStorage ?? []);
    }
    return true;
  }

  /** Apply network-mock rules to the correlated page; false when no driven page matches. */
  async setMocks(sessionUrl: string, rules: MockRule[]): Promise<boolean> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return false;
    await installNetworkMocks(page, rules);
    return true;
  }

  /** Pin the correlated page's viewport to fixed dimensions; false when no driven page matches. */
  async setViewport(sessionUrl: string, size: { width: number; height: number }): Promise<boolean> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return false;
    await page.setViewportSize({ width: size.width, height: size.height });
    return true;
  }

  /** Best-effort cleanup; idempotent. */
  async dispose(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser !== undefined) await browser.close();
  }
}

/** Injected launcher so unit tests stub Playwright without import. */
export type LaunchFn = (headless: boolean) => Promise<Browser>;

/**
 * Force a driven page's already-loaded SDK to connect to our loopback bridge with a pairing token,
 * overriding the app's own (often localhost-only) reticle.connect — so a hosted preview verifies with
 * no app redeploy. connect is a no-op once connected, so re-invoking it is safe.
 */
export interface InjectConnectOptions {
  token: string;
  url: string;
}

export interface LaunchedProviderOptions {
  driveUrl: string;
  headless: boolean;
  /** Injected so the settle delay is deterministic in tests; defaults to a real Node timer. */
  sleep?: SleepFn;
  /** Injected so a measured hold is deterministic in tests; defaults to the real clock. */
  now?: () => number;
  /** Injected launcher so unit tests can stub Playwright; defaults to dynamic import('playwright'). */
  launch?: LaunchFn;
  /** When set, re-invoke the page's reticle.connect with these after load (drive-a-hosted-preview). */
  injectConnect?: InjectConnectOptions;
  /** Path to a Playwright storageState JSON (cookies/localStorage) — starts the page authenticated. */
  storageState?: string;
  /**
   * Sink for CDP-authoritative network detail. When set, every driven-page response is captured
   * as a NET_DETAIL and handed here — the daemon routes it onto the driven session's journal so the
   * inside-app view never loses fidelity to the outside-in view. Omitted → no network detail captured.
   */
  onNetworkDetail?: (detail: NetworkDetail) => void;
}

const INJECT_CONNECT_WAIT_MS = 8_000;

/** The only place the dynamic value import of Playwright lives for the launched (drive) path. */
export const launchedChromium: LaunchFn = async (headless) => {
  let mod: typeof import('playwright');
  try {
    mod = await import('playwright');
  } catch {
    throw new DriveError(DriveErrorCode.PLAYWRIGHT_MISSING, DRIVE_PLAYWRIGHT_MISSING_MSG);
  }
  const settle = getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.LAUNCHED);
  try {
    const browser = await launchChromium(mod.chromium, headless);
    settle();
    return browser;
  } catch (e) {
    settle(classifyConnectFailure(e));
    const msg = e instanceof Error ? e.message : String(e);
    throw new DriveError(DriveErrorCode.LAUNCH_FAILED, chromiumLaunchHint(msg) ?? msg);
  }
};

/**
 * Launches and OWNS a Playwright Chromium, navigates it to `driveUrl`, then drives native
 * input on that page. Headless-capable so @reticlehq/test / CI can run hover/drag unattended.
 */
export class LaunchedRealInputProvider implements OwnedRealInputProvider {
  readonly #driveUrl: string;
  readonly #headless: boolean;
  readonly #sleep: SleepFn;
  readonly #now: () => number;
  readonly #launch: LaunchFn;
  readonly #injectConnect: InjectConnectOptions | undefined;
  readonly #storageState: string | undefined;
  readonly #onNetworkDetail: ((detail: NetworkDetail) => void) | undefined;
  #browser: Browser | undefined;
  #page: Page | undefined;
  /** Pages collecting V8 coverage — see js-coverage.ts. */
  readonly #covering = new WeakSet<Page>();

  constructor(options: LaunchedProviderOptions) {
    this.#driveUrl = options.driveUrl;
    this.#headless = options.headless;
    this.#sleep = options.sleep ?? nodeSleep;
    this.#now = options.now ?? Date.now;
    this.#launch = options.launch ?? launchedChromium;
    this.#injectConnect = options.injectConnect;
    this.#storageState = options.storageState;
    this.#onNetworkDetail = options.onNetworkDetail;
  }

  async navigate(): Promise<void> {
    this.#browser = await this.#launch(this.#headless);
    const page = await this.#browser.newPage(
      this.#storageState !== undefined ? { storageState: this.#storageState } : undefined,
    );
    this.#page = page;
    // Capture CDP-authoritative response detail into the driven session's journal (best-effort).
    if (this.#onNetworkDetail !== undefined) attachNetworkDetail(page, this.#onNetworkDetail);
    try {
      // Same navigation rule as the pool, and for the same measured reason: Playwright's default
      // waits for `load`, which an app with one never-finishing subresource never fires — 30s of
      // nothing and then a failure that blames the app. The SDK connect is a module script, so it
      // has already run by DOMContentLoaded. See gotoOptions.
      // Stamped, so the page can tell Reticle opened it — see drive-url-stamp.ts. Without it the
      // first-run tour mounts over a driven page and its scrim swallows every native gesture.
      await page.goto(stampedDriveUrl(this.#driveUrl), gotoOptions(undefined));
    } catch (e) {
      throw new DriveError(
        DriveErrorCode.NAVIGATE_FAILED,
        e instanceof Error ? e.message : String(e),
      );
    }
    await this.#tryInjectConnect(page);
  }

  /**
   * Wait for the page's Reticle singleton to exist, then re-invoke connect with our token + loopback
   * URL so a hosted (non-localhost) preview pairs to our bridge without the app being reconfigured.
   * Best-effort: a page with no SDK simply never exposes the global, and we move on.
   */
  async #tryInjectConnect(page: Page): Promise<void> {
    const opts = this.#injectConnect;
    if (opts === undefined) return;
    try {
      await page.waitForFunction('!!globalThis.__reticleInstance', {
        timeout: INJECT_CONNECT_WAIT_MS,
      });
      const arg = JSON.stringify(injectedConnectArgs(opts));
      await page.evaluate(`globalThis.__reticleInstance.connect(${arg})`);
    } catch {
      // No SDK on the page (or it connected already) — the no-session guard in verify reports it.
    }
  }

  /**
   * The page we own, or undefined once it is gone.
   *
   * The handle is cached for the life of the provider and Playwright keeps answering `url()` after
   * the page has closed, so a closed window read as AVAILABLE and every method below threw
   * "Target page, context or browser has been closed" — the raw Playwright message, surfaced to the
   * agent as a tool error, on every call for the rest of the run. A dead page is the same fact as no
   * page, and every caller already handles that. Only an EXPLICIT `true` drops it, matching
   * `CdpRealInputProvider`'s `isConnected` check: a test fake without the method is assumed live.
   */
  #livePage(): Page | undefined {
    const page = this.#page;
    if (page === undefined) return undefined;
    if (true === page.isClosed?.()) {
      this.#page = undefined; // never ask a corpse twice
      return undefined;
    }
    return page;
  }

  isAvailableFor(sessionUrl: string): Promise<boolean> {
    const page = this.#livePage();
    if (page === undefined) return Promise.resolve(false);
    if (page.url() === sessionUrl) return Promise.resolve(true);
    return Promise.resolve(stripVolatile(page.url()) === stripVolatile(sessionUrl));
  }

  /**
   * The context's cookies and per-origin storage, or undefined when no page is live.
   *
   * Present here and not only on the CDP provider because THIS is the provider `reticle drive`
   * builds, and `fixturePortFor` refuses outright when either half is missing — so without these a
   * driven session had no fixture port at all, and every suite seeded nothing while reading as if it
   * seeded everything. Same two methods, same contract, one page instead of a page lookup.
   */
  async storageState(_sessionUrl: string): Promise<unknown> {
    const page = this.#livePage();
    if (page === undefined) return undefined;
    return page.context().storageState();
  }

  /**
   * Put a captured state back: cookies through the context, per-origin storage through the page.
   * Only the context owns a cookie jar and only a document owns its localStorage.
   */
  async applyStorageState(_sessionUrl: string, state: unknown): Promise<boolean> {
    const page = this.#livePage();
    if (page === undefined) return false;
    const saved = state as {
      cookies?: Parameters<ReturnType<Page['context']>['addCookies']>[0];
      origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
    };
    if (saved.cookies !== undefined) await page.context().addCookies(saved.cookies);
    for (const origin of saved.origins ?? []) {
      // A page sitting on a different origin cannot be given another origin's storage, and silently
      // succeeding there is the quiet half-restore this whole path exists to avoid.
      if (!page.url().startsWith(origin.origin)) continue;
      await page.evaluate((entries: { name: string; value: string }[]) => {
        const store = (
          globalThis as { localStorage?: { setItem(key: string, value: string): void } }
        ).localStorage;
        if (store === undefined) return;
        for (const entry of entries) store.setItem(entry.name, entry.value);
      }, origin.localStorage ?? []);
    }
    return true;
  }

  perform(
    _sessionUrl: string,
    action: ActionType,
    box: ElementBox,
    args: RealInputArgs,
  ): Promise<RealInputResult> {
    const page = this.#livePage();
    if (page === undefined) return Promise.resolve(undriven(action, box));
    return performGesture(page, action, box, args, this.#sleep, this.#now);
  }

  /**
   * PNG of the owned page, or undefined before navigate / after dispose, or when `sessionUrl` is not
   * the page this provider owns. It owns ONE page, and photographing it for whatever url was asked
   * saved a different tab's pixels under the caller's session (#1407). Same rule as `isAvailableFor`.
   */
  async screenshot(sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined> {
    const page = this.#livePage();
    if (page === undefined || !(await this.isAvailableFor(sessionUrl))) return undefined;
    return capturePage(page, opts);
  }

  /**
   * Pin the owned page's viewport; false before navigate / after dispose.
   *
   * `CdpRealInputProvider` has had this since it shipped and THIS provider did not, so
   * `reticle_viewport` refused with `no-cdp-provider` under `reticle drive` — while recommending
   * `reticle drive` as the fix. Same for `setMocks` below. A driven browser was attached and taking
   * screenshots the whole time; only these two methods were missing.
   */
  async setViewport(
    _sessionUrl: string,
    size: { width: number; height: number },
  ): Promise<boolean> {
    const page = this.#livePage();
    if (page === undefined) return false;
    await page.setViewportSize({ width: size.width, height: size.height });
    return true;
  }

  takeCodeCoverage(_sessionUrl: string): Promise<ScriptCoverage[] | undefined> {
    const page = this.#livePage();
    return page === undefined ? Promise.resolve(undefined) : takeJsCoverage(page, this.#covering);
  }

  /** Apply network-mock rules to the owned page; false before navigate / after dispose. */
  async setMocks(_sessionUrl: string, rules: MockRule[]): Promise<boolean> {
    const page = this.#livePage();
    if (page === undefined) return false;
    await installNetworkMocks(page, rules);
    return true;
  }

  /** Close the owned browser once. Idempotent and safe before navigate. */
  async dispose(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    this.#page = undefined;
    if (browser !== undefined) await browser.close();
  }
}

/** Drop hash/query so a page whose URL drifted by fragment still correlates to the session. */
/**
 * Correlate a session URL to one driven page, or refuse.
 *
 * Exact match first, query string included — that is the only fully reliable signal. The stripped
 * fallback exists for a real case (an app pushState's to /overview, so the page's URL no longer
 * equals the session's) but it is only sound when UNAMBIGUOUS.
 *
 * Returning the first loose match was a false-green generator: the benchmark fixture selects a bug
 * purely by query string, so two pages differing only there stripped to the same key, and a visual
 * diff happily compared the wrong page to itself and reported "0.00% changed, matched" for pixels
 * that demonstrably differed. Ambiguity now yields undefined, which callers already surface as
 * "no driven page" rather than as a passing comparison.
 */
export function selectPage<T extends { url(): string }>(
  pages: readonly T[],
  sessionUrl: string,
): T | undefined {
  const exact = pages.find((p) => p.url() === sessionUrl);
  if (exact !== undefined) return exact;
  const target = stripVolatile(sessionUrl);
  const loose = pages.filter((p) => stripVolatile(p.url()) === target);
  return 1 === loose.length ? loose[0] : undefined;
}

function stripVolatile(url: string): string {
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const query = base.indexOf('?');
  return query >= 0 ? base.slice(0, query) : base;
}
