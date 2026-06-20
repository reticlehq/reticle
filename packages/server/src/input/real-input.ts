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
import type { Browser, Page } from 'playwright';
import { ActionType, DriveErrorCode, DRIVE_PLAYWRIGHT_MISSING_MSG } from '@syrin/iris-protocol';
import { installNetworkMocks, type MockRule } from './network-mock.js';

/** Viewport CSS-px box as returned by the INSPECT command (getBoundingClientRect). */
export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Args forwarded from iris_act (fill value, type text, drag drop-target box). */
export interface RealInputArgs {
  value?: string;
  text?: string;
  /** For drag: the resolved box of the drop-target ref (toRef). */
  toBox?: ElementBox;
  steps?: number;
}

export interface RealInputResult {
  /** True if a native gesture was actually driven. */
  performed: boolean;
  /** Center used, for diagnostics/tests. */
  center: { cx: number; cy: number };
}

/** Options for a page screenshot — full-page scroll capture and/or a clip box. */
export interface ScreenshotOpts {
  fullPage?: boolean;
  /** Restrict the capture to one element/region (viewport CSS px). */
  clip?: ElementBox;
}

/** The capability surface iris_act depends on. A FAKE implementing this is injected in tests. */
export interface RealInputProvider {
  /** Whether a Playwright Page currently matches this SDK session URL. */
  isAvailableFor(sessionUrl: string): Promise<boolean>;
  /** Drive a native gesture for `action` at the element `box`. */
  perform(
    sessionUrl: string,
    action: string,
    box: ElementBox,
    args: RealInputArgs,
  ): Promise<RealInputResult>;
  /**
   * Capture a PNG of the correlated page, or undefined if no page matches. Optional
   * so the visual layer stays opt-in — a provider that cannot screenshot simply omits it.
   */
  screenshot?(sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined>;
  /**
   * Install (or replace, or with [] clear) network-mock rules on the correlated page — stub a 500,
   * force offline, delay a response — for deterministic error/edge-state testing. Returns true when
   * a page matched and the rules were applied, false when no driven page matches this session.
   * Optional: a provider with no owned browser simply omits it.
   */
  setMocks?(sessionUrl: string, rules: MockRule[]): Promise<boolean>;
  /**
   * Pin the correlated page's viewport to fixed pixel dimensions so a screenshot baseline is
   * reproducible across machines (the missing piece of CI-stable visual regression, alongside masks
   * and the frozen clock). Returns true when a page matched, false otherwise. Optional.
   */
  setViewport?(sessionUrl: string, size: { width: number; height: number }): Promise<boolean>;
}

/**
 * Optional lifecycle a provider that OWNS a browser implements (`iris drive`). The
 * iris_act routing still depends only on `RealInputProvider`; the server uses these to boot/tear-down.
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
 * Which actions are driven by native pointer input. fill/type stay synthetic unless a
 * provider explicitly runs them.
 */
export function isPointerAction(action: string): boolean {
  return (
    action === ActionType.HOVER ||
    action === ActionType.CLICK ||
    action === ActionType.DBLCLICK ||
    action === ActionType.DRAG
  );
}

/** Settle delay after a native gesture so the reaction can begin to flush (named, not free). */
const REAL_INPUT_SETTLE_MS = 16;
/** Default number of interpolation steps for a native drag. */
const DEFAULT_DRAG_STEPS = 8;

type SleepFn = (ms: number) => Promise<void>;
type ConnectFn = (url: string) => Promise<Browser>;

/**
 * Shared gesture executor: drive a native gesture on an already-resolved Page. Used by both the
 * CDP-attached and the launched (drive) providers so the pointer logic lives in one place.
 */
export async function performGesture(
  page: Page,
  action: string,
  box: ElementBox,
  args: RealInputArgs,
  sleep: SleepFn,
): Promise<RealInputResult> {
  const center = boxCenter(box);
  const { cx, cy } = center;

  if (action === ActionType.HOVER) {
    await page.mouse.move(cx, cy);
    await page.mouse.move(cx + 1, cy);
    await page.mouse.move(cx, cy);
    await sleep(REAL_INPUT_SETTLE_MS);
    return { performed: true, center };
  }
  if (action === ActionType.CLICK) {
    await page.mouse.move(cx, cy);
    await page.mouse.click(cx, cy);
    return { performed: true, center };
  }
  if (action === ActionType.DBLCLICK) {
    await page.mouse.move(cx, cy);
    await page.mouse.dblclick(cx, cy);
    return { performed: true, center };
  }
  if (action === ActionType.DRAG) {
    if (args.toBox === undefined) return { performed: false, center };
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
    return { performed: true, center };
  }
  if (action === ActionType.FILL || action === ActionType.TYPE) {
    await page.mouse.click(cx, cy);
    await page.keyboard.type(args.value ?? args.text ?? '');
    return { performed: true, center };
  }
  return { performed: false, center };
}

/**
 * Iris paints its own dev overlay (presenter HUD + border glow) into the page. That chrome is
 * time-varying — the activity log and border state change with every command — so capturing it
 * makes a fresh screenshot of an unchanged page differ from its baseline. Hide it during capture
 * (Playwright applies this stylesheet only for the shot, then reverts) so visual baselines reflect
 * the app, not Iris. Disabling animations settles any remaining transitions for determinism.
 */
const HIDE_IRIS_CHROME_CSS = '[data-iris-overlay]{display:none !important}';
const SCREENSHOT_DETERMINISM = { style: HIDE_IRIS_CHROME_CSS, animations: 'disabled' } as const;

/**
 * Capture a PNG from a Playwright page. Shared by the CDP + launched providers so the
 * screenshot path lives in one place (mirrors performGesture). Returns the raw PNG bytes.
 */
export async function capturePage(page: Page, opts: ScreenshotOpts): Promise<Uint8Array> {
  const buf = await page.screenshot(
    opts.clip !== undefined
      ? { ...SCREENSHOT_DETERMINISM, clip: opts.clip }
      : opts.fullPage === true
        ? { ...SCREENSHOT_DETERMINISM, fullPage: true }
        : { ...SCREENSHOT_DETERMINISM },
  );
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export interface CdpProviderOptions {
  cdpUrl: string;
  /** Injected so the settle delay is deterministic in tests; defaults to a real Node timer. */
  sleep?: SleepFn;
  /** Injected connector so unit tests can stub Playwright without import(). */
  connect?: ConnectFn;
}

const nodeSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const cdpConnect: ConnectFn = async (url) => {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(url);
};

/** CDP-backed real-input provider. Lazily connects on first availability check / perform. */
export class CdpRealInputProvider implements RealInputProvider {
  readonly #cdpUrl: string;
  readonly #sleep: SleepFn;
  readonly #connect: ConnectFn;
  #browser: Browser | undefined;

  constructor(options: CdpProviderOptions) {
    this.#cdpUrl = options.cdpUrl;
    this.#sleep = options.sleep ?? nodeSleep;
    this.#connect = options.connect ?? cdpConnect;
  }

  async #ensureBrowser(): Promise<Browser | undefined> {
    if (this.#browser !== undefined) return this.#browser;
    try {
      this.#browser = await this.#connect(this.#cdpUrl);
      return this.#browser;
    } catch {
      return undefined;
    }
  }

  async #pageFor(sessionUrl: string): Promise<Page | undefined> {
    const browser = await this.#ensureBrowser();
    if (browser === undefined) return undefined;
    const pages = browser.contexts().flatMap((c) => c.pages());
    const exact = pages.find((p) => p.url() === sessionUrl);
    if (exact !== undefined) return exact;
    const target = stripVolatile(sessionUrl);
    return pages.find((p) => stripVolatile(p.url()) === target);
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
    action: string,
    box: ElementBox,
    args: RealInputArgs,
  ): Promise<RealInputResult> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return { performed: false, center: boxCenter(box) };
    return performGesture(page, action, box, args, this.#sleep);
  }

  /** PNG of the correlated page, or undefined if none matches. */
  async screenshot(sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return undefined;
    return capturePage(page, opts);
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

/** Injected launcher so unit tests stub Playwright without import(). */
export type LaunchFn = (headless: boolean) => Promise<Browser>;

export interface LaunchedProviderOptions {
  driveUrl: string;
  headless: boolean;
  /** Injected so the settle delay is deterministic in tests; defaults to a real Node timer. */
  sleep?: SleepFn;
  /** Injected launcher so unit tests can stub Playwright; defaults to dynamic import('playwright'). */
  launch?: LaunchFn;
}

/** The only place the dynamic value import of Playwright lives for the launched (drive) path. */
const launchedChromium: LaunchFn = async (headless) => {
  let mod: typeof import('playwright');
  try {
    mod = await import('playwright');
  } catch {
    throw new DriveError(DriveErrorCode.PLAYWRIGHT_MISSING, DRIVE_PLAYWRIGHT_MISSING_MSG);
  }
  try {
    return await mod.chromium.launch({ headless });
  } catch (e) {
    throw new DriveError(DriveErrorCode.LAUNCH_FAILED, e instanceof Error ? e.message : String(e));
  }
};

/**
 * Launches and OWNS a Playwright Chromium, navigates it to `driveUrl`, then drives native
 * input on that page. Headless-capable so @syrin/iris-test / CI can run hover/drag unattended.
 */
export class LaunchedRealInputProvider implements OwnedRealInputProvider {
  readonly #driveUrl: string;
  readonly #headless: boolean;
  readonly #sleep: SleepFn;
  readonly #launch: LaunchFn;
  #browser: Browser | undefined;
  #page: Page | undefined;

  constructor(options: LaunchedProviderOptions) {
    this.#driveUrl = options.driveUrl;
    this.#headless = options.headless;
    this.#sleep = options.sleep ?? nodeSleep;
    this.#launch = options.launch ?? launchedChromium;
  }

  async navigate(): Promise<void> {
    this.#browser = await this.#launch(this.#headless);
    const page = await this.#browser.newPage();
    this.#page = page;
    try {
      await page.goto(this.#driveUrl);
    } catch (e) {
      throw new DriveError(
        DriveErrorCode.NAVIGATE_FAILED,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  isAvailableFor(sessionUrl: string): Promise<boolean> {
    const page = this.#page;
    if (page === undefined) return Promise.resolve(false);
    if (page.url() === sessionUrl) return Promise.resolve(true);
    return Promise.resolve(stripVolatile(page.url()) === stripVolatile(sessionUrl));
  }

  perform(
    _sessionUrl: string,
    action: string,
    box: ElementBox,
    args: RealInputArgs,
  ): Promise<RealInputResult> {
    const page = this.#page;
    if (page === undefined) return Promise.resolve({ performed: false, center: boxCenter(box) });
    return performGesture(page, action, box, args, this.#sleep);
  }

  /** PNG of the owned page, or undefined before navigate / after dispose. */
  screenshot(_sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined> {
    const page = this.#page;
    if (page === undefined) return Promise.resolve(undefined);
    return capturePage(page, opts);
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
function stripVolatile(url: string): string {
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const query = base.indexOf('?');
  return query >= 0 ? base.slice(0, query) : base;
}
