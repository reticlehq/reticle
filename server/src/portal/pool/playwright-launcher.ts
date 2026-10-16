/**
 * The real Playwright adapter behind BrowserPool: wraps `chromium.launch` into the pool's small
 * PooledBrowser/Context/Page interfaces. Kept thin and separate so the pool's lifecycle logic stays
 * unit-tested with a fake while this glue is exercised only by the e2e battery (it needs Chromium).
 *
 * Headless by default — the pool exists for fault-tolerant headless multi-agent testing.
 */

import type { Browser } from 'playwright';
import { BrowserLaunchKind } from '@reticlehq/core/telemetry';
import { HIDE_RETICLE_CHROME_CSS, RETICLE_OVERLAY_SELECTOR } from '@reticlehq/core';
import { launchChromium } from '@/launch-chromium.js';
import { getSessionMetrics } from '@/telemetry/session-metrics.js';
import { classifyConnectFailure } from '@/telemetry/connect-failure.js';
import {
  chromiumInstallCommand,
  chromiumInstallDepsCommand,
  bundledPlaywrightVersion,
} from '@/command/cli/doctor/browser/chromium-hint.js';
import type { Launcher, PooledBrowser, PooledContext, PooledPage } from './browser-pool.js';
import type { ScreenshotOptions } from './pool-contract.js';
import { installNetworkMocks } from '@/portal/input/network-mock.js';

/**
 * Reticle paints its own UI (presenter HUD, glow, annotator marks, tour) into the page. It is
 * time-varying, since the activity log and border state change with every command, so capturing it
 * makes a fresh screenshot of an unchanged page differ from its baseline. Playwright applies `style`
 * for the shot only and then reverts it, so the page under test is never changed. Disabling animations
 * settles any remaining transitions. Shared by every capture path, driven and leased, so both hide
 * the same set: core's `RETICLE_OVERLAY_SELECTOR`.
 */
export const SCREENSHOT_DETERMINISM = {
  style: HIDE_RETICLE_CHROME_CSS,
  animations: 'disabled',
} as const;

/**
 * How Playwright captures a leased tab: a PNG by default, a JPEG for a live picture. Every capture
 * hides Reticle's own UI with `SCREENSHOT_DETERMINISM`, the same as the driven path, so a lease
 * baseline shows the app and not the HUD.
 */
export function screenshotOptions(opts: ScreenshotOptions): {
  fullPage: boolean;
  style?: string;
  animations?: 'disabled';
  type?: 'jpeg';
  quality?: number;
  scale?: 'css';
} {
  // A step screenshot is evidence about the page, so it must not change it: `animations: disabled`
  // fast-forwards running animations to their end and fires their events in the app under test.
  if (true === opts.cssScale && opts.jpegQuality !== undefined) {
    return { fullPage: false, type: 'jpeg', quality: opts.jpegQuality, scale: 'css' };
  }
  const base = { ...SCREENSHOT_DETERMINISM, fullPage: true === opts.fullPage };
  return opts.jpegQuality === undefined
    ? base
    : { ...base, type: 'jpeg', quality: opts.jpegQuality };
}

/** Where the hidden hosts' own visibility waits to be put back, on the page's window. */
const SHOT_HIDDEN_KEY = '__reticleShotHidden';
/** A string literal safe to splice into a script: JSON plus the characters that end one early. */
const scriptLiteral = (value: string): string =>
  JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
const HIDE_CHROME_SCRIPT = `(() => { const held = []; for (const el of document.querySelectorAll(${scriptLiteral(RETICLE_OVERLAY_SELECTOR)})) { held.push([el, el.style.visibility]); el.style.visibility = 'hidden'; } window.${SHOT_HIDDEN_KEY} = held; })()`;
const RESTORE_CHROME_SCRIPT = `(() => { for (const [el, was] of window.${SHOT_HIDDEN_KEY} ?? []) el.style.visibility = was; delete window.${SHOT_HIDDEN_KEY}; })()`;

/**
 * A step screenshot with Reticle's own UI out of it. The step path injects nothing into the page
 * (no stylesheet, no fast-forwarded animation), so the HUD covered a third of every picture. Only
 * our own hosts change, by their own inline `visibility`, for this one capture, and are put back
 * whatever the capture did: the app's DOM, styles and events are not touched.
 */
export async function captureWithChromeHidden(
  page: { evaluate: (script: string) => Promise<unknown> },
  capture: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  await page.evaluate(HIDE_CHROME_SCRIPT);
  try {
    return await capture();
  } finally {
    await page.evaluate(RESTORE_CHROME_SCRIPT).catch(() => undefined);
  }
}

/**
 * How a leased tab navigates. Pure, and exported, because the decision in it is worth a test while
 * the rest of this file needs a real Chromium.
 *
 * `waitUntil: 'domcontentloaded'` — NOT Playwright's default of `load`. `load` waits for every
 * subresource, so an app with one that never finishes burns the whole nav budget and the lease then
 * reports "is the app running?" about an app that is running. Measured on the sveltekit fixture:
 * 30,501ms and a false diagnosis. The SDK connect is a module script and runs before
 * DOMContentLoaded, and the pool separately waits for the session to register, so the load event was
 * never what proved the page was usable.
 */
export function gotoOptions(timeoutMs: number | undefined): {
  waitUntil: 'domcontentloaded';
  timeout?: number;
} {
  return {
    waitUntil: 'domcontentloaded',
    // Absent, not zero: zero means "no timeout" to Playwright, which would turn a slow page into a
    // lease that never returns.
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  };
}

function wrapBrowser(browser: Browser): PooledBrowser {
  return {
    isConnected: () => browser.isConnected(),
    newContext: async (opts): Promise<PooledContext> => {
      const context = await browser.newContext(
        true === opts?.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : undefined,
      );
      return {
        newPage: async (): Promise<PooledPage> => {
          const page = await context.newPage();
          return {
            goto: (url, opts) => page.goto(url, gotoOptions(opts?.timeoutMs)),
            close: () => page.close(),
            evaluate: (script) => page.evaluate(script),
            // Playwright returns a Buffer; Uint8Array is what the visual store and differ take.
            // Same determinism as the driven path's capturePage: without it a lease baseline caught
            // the HUD, its activity log and the toolbar, and a HUD change read as a regression (#1355).
            screenshot: async (opts) => {
              const shoot = async (): Promise<Uint8Array> =>
                new Uint8Array(await page.screenshot(screenshotOptions(opts ?? {})));
              // A step capture injects no stylesheet, so our own hosts are hidden another way.
              return true === opts?.cssScale
                ? captureWithChromeHidden({ evaluate: (script) => page.evaluate(script) }, shoot)
                : shoot();
            },
            // Three moves, same as performGesture: a single move to the center can be a no-op if
            // the pointer was already there, and CSS :hover needs a native hit-test to apply.
            hover: async (x, y) => {
              await page.mouse.move(x, y);
              await page.mouse.move(x + 1, y);
              await page.mouse.move(x, y);
            },
            installMocks: (rules) => installNetworkMocks(page, [...rules]),
            setViewport: (size) => page.setViewportSize(size),
            bringToFront: () => page.bringToFront(),
            onCrash: (handler) => page.on('crash', handler),
            onConsole: (handler) => page.on('console', (msg) => handler(msg.text())),
            onDialog: (handler) =>
              page.on('dialog', (dialog) =>
                handler({ message: dialog.message(), dismiss: () => dialog.dismiss() }),
              ),
            addInitScript: async (script, arg) => {
              const handle = (await page.addInitScript(script as never, arg)) as
                { dispose?: () => Promise<void> } | undefined;
              const dispose = handle?.dispose;
              if ('function' !== typeof dispose) {
                throw new Error(
                  'Storage seeding failed: Playwright page.addInitScript did not return a disposable handle',
                );
              }
              return { dispose: () => dispose() };
            },
          };
        },
        addCookies: (cookies) => context.addCookies(cookies),
        grantPermissions: (permissions, opts) => context.grantPermissions(permissions, opts),
        clearPermissions: () => context.clearPermissions(),
        close: () => context.close(),
      };
    },
    close: () => browser.close(),
    onDisconnected: (handler) => browser.on('disconnected', handler),
  };
}

/**
 * The fix for the most common first-run failure: Chromium isn't installed for Playwright.
 *
 * Pinned to the playwright this process bundles. Unpinned, `npx` fetches the latest playwright and
 * installs ITS browser revision — a build this launcher will never look at — so the user follows the
 * advice, it succeeds, and the next launch fails identically. Shares one builder with `doctor` so
 * the two cannot suggest different commands for the same missing browser.
 *
 * With a path, the message names it, the way the preflight refusal and the doctor line already do.
 * Without it the launch translation was the one surface that hid the evidence: a daemon whose HOME
 * or PLAYWRIGHT_BROWSERS_PATH differs from the shell that ran the install keeps refusing after a
 * successful install, and a bare command gives the reader no way to see that the lookup is aimed at
 * a root nothing was installed into (#691).
 */
function chromiumMissingHint(executablePath?: string): string {
  const command = chromiumInstallCommand(bundledPlaywrightVersion());
  return executablePath === undefined
    ? `Chromium is not installed for Playwright. Run: ${command}`
    : `Chromium is not installed for Playwright — looked for ${executablePath}. Run: ${command}`;
}

/**
 * The executable path this process's Playwright resolved, or undefined when it cannot say.
 *
 * Asking can itself fail: a playwright whose registry is broken throws here, and a test double may
 * not implement it at all. Either way the launch error that brought the caller here is the real
 * evidence, and a failed lookup must not replace it.
 */
export function resolvedChromiumPath(chromium: {
  executablePath?: (() => string) | undefined;
}): string | undefined {
  if (chromium.executablePath === undefined) return undefined;
  try {
    const path = chromium.executablePath();
    return 0 < path.length ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A DIFFERENT first-run failure from the one above: the browser binary is already there, but the
 * host is missing the OS-level shared libraries (e.g. `libnspr4.so`) Playwright's own
 * host-requirement check refuses to launch without. `npx playwright install chromium` does nothing
 * for this — it re-downloads a binary that was never the problem — so this needs its own hint
 * pointing at `install-deps`, pinned the same way and for the same reason as the one above.
 */
const CHROMIUM_MISSING_DEPS_HINT = `Chromium is installed, but the host system is missing shared-library dependencies it needs. Run: ${chromiumInstallDepsCommand(bundledPlaywrightVersion())}`;

/** A Launcher that boots a real headless Chromium and adapts it to the pool's interface. */
export function playwrightLauncher(opts: { headless?: boolean } = {}): Launcher {
  const headless = opts.headless ?? true;
  // `playwright` is an OPTIONAL dependency. A static value-import here would be pulled in by the
  // server's main entry (index.ts re-exports this module) and crash the whole process with
  // ERR_MODULE_NOT_FOUND on any install without Chromium — the CLI, the MCP server, everything.
  // Import it lazily, only when a browser is actually launched, so absence fails at drive-time
  // (where it's meaningful) instead of at import-time (where it kills unrelated features).
  return async () => {
    const { chromium } = await import('playwright');
    // A pooled launch serves N parallel leases, so this counts BROWSERS, not contexts — which is the
    // number that actually costs memory and the one that explains a slow machine.
    const settle = getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.POOLED);
    try {
      const browser = wrapBrowser(await launchChromium(chromium, headless));
      settle();
      return browser;
    } catch (err) {
      settle(classifyConnectFailure(err));
      const msg = err instanceof Error ? err.message : String(err);
      const hint = chromiumLaunchHint(msg, resolvedChromiumPath(chromium));
      throw hint !== undefined ? new Error(hint) : err;
    }
  };
}

/**
 * Turn Playwright's raw launch error into the one command that fixes it, or undefined when it is
 * not a missing-browser failure. Shared by the pooled and the drive launch, so `reticle verify` on
 * a fresh machine gets the same advice as a lease.
 */
export function chromiumLaunchHint(msg: string, executablePath?: string): string | undefined {
  // Checked FIRST: Playwright's host-requirement validation error also contains
  // "browserType.launch", so the generic check below would otherwise misdiagnose it as a
  // missing binary and send the user through a fix that changes nothing.
  if (/host system is missing dependencies/i.test(msg)) return CHROMIUM_MISSING_DEPS_HINT;
  if (/executable doesn.?t exist|playwright install|browsertype\.launch/i.test(msg)) {
    return chromiumMissingHint(executablePath);
  }
  return undefined;
}

const MAX_CONTEXTS_CEILING = 8;
const MAX_CONTEXTS_FLOOR = 1;
/**
 * Hard backstop for an EXPLICIT RETICLE_MAX_CONTEXTS. The operator override still wins for any
 * realistic value (well above the CPU-derived ceiling), but a typo/abuse like 5000 can't spawn 5000
 * browser contexts and exhaust memory/FDs — the fork-bomb the function's own comment warns about.
 */
const MAX_CONTEXTS_HARD_CEILING = 128;

/**
 * Resolve the pool's concurrency cap. An explicit RETICLE_MAX_CONTEXTS wins (clamped to
 * [1, hard ceiling]); otherwise scale with the machine but never above the CPU-derived ceiling.
 * Pure (env value + cpu count passed in) so it's testable.
 */
export function resolveMaxContexts(envValue: string | undefined, cpuCount: number): number {
  if (envValue !== undefined) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed >= MAX_CONTEXTS_FLOOR) {
      return Math.min(MAX_CONTEXTS_HARD_CEILING, parsed);
    }
  }
  const byCpu = Math.max(MAX_CONTEXTS_FLOOR, cpuCount - 1);
  return Math.min(MAX_CONTEXTS_CEILING, byCpu);
}
