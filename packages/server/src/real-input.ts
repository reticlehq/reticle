/**
 * R1: optional CDP/Playwright real-input mode.
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
import { ActionType } from '@iris/protocol';

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
}

/** Center of a viewport box in CSS px. Pure — unit-tested directly. */
export function boxCenter(box: ElementBox): { cx: number; cy: number } {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

/**
 * R1: which actions are driven by native pointer input. fill/type stay synthetic unless a
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
    const center = boxCenter(box);
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return { performed: false, center };
    const { cx, cy } = center;

    if (action === ActionType.HOVER) {
      await page.mouse.move(cx, cy);
      await page.mouse.move(cx + 1, cy);
      await page.mouse.move(cx, cy);
      await this.#sleep(REAL_INPUT_SETTLE_MS);
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

  /** Best-effort cleanup; idempotent. */
  async dispose(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
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
