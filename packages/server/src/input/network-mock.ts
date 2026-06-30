import type { Page, Route } from 'playwright';

/**
 * CDP network mock/intercept for `reticle drive`. Lets an agent or dev deterministically test error and
 * edge states — a 500 on checkout, an offline payment, a slow API — without touching the backend.
 * "Verify the app handles a failed payment" becomes one declared rule.
 *
 * Two layers, split for testability:
 *   - matchMock(): PURE. Given the active rules and a request's url/method, decide the outcome
 *     (fulfill | abort | continue). Unit-tested directly.
 *   - installNetworkMocks(): the Playwright wiring. Registers a single catch-all page.route handler
 *     that consults matchMock and fulfills/aborts/continues. Driven in tests with a fake Page + Route.
 */

/** One interception rule. First matching rule (in order) wins for a request. */
export interface MockRule {
  /** Substring the request URL must contain to match (e.g. "/api/pay"). */
  urlContains: string;
  /** Optional method filter (GET/POST/…); case-insensitive. Omit to match any method. */
  method?: string;
  /** Fulfill the request with this HTTP status (default 200). Ignored when `abort` is set. */
  status?: number;
  /** Response body to fulfill with. */
  body?: string;
  /** Response content type (default application/json). */
  contentType?: string;
  /** Delay (ms) before fulfilling — simulate a slow endpoint. */
  delayMs?: number;
  /** Simulate a network failure (offline / connection refused) instead of a response. */
  abort?: boolean;
}

/** What to do with a request after matching: fulfill a canned response, abort it, or let it through. */
interface MockOutcome {
  kind: 'fulfill' | 'abort' | 'continue';
  status?: number;
  body?: string;
  contentType?: string;
  delayMs?: number;
}

const DEFAULT_STATUS = 200;
const DEFAULT_CONTENT_TYPE = 'application/json';

/**
 * Decide the outcome for a request from the active rules. Pure: no IO, no clock. The first rule
 * whose url-substring (and optional method) matches wins; no match → continue (let it hit the network).
 */
export function matchMock(rules: MockRule[], req: { url: string; method: string }): MockOutcome {
  for (const rule of rules) {
    if (!req.url.includes(rule.urlContains)) continue;
    if (rule.method !== undefined && rule.method.toUpperCase() !== req.method.toUpperCase())
      continue;
    if (rule.abort === true) return { kind: 'abort' };
    const outcome: MockOutcome = {
      kind: 'fulfill',
      status: rule.status ?? DEFAULT_STATUS,
      contentType: rule.contentType ?? DEFAULT_CONTENT_TYPE,
    };
    if (rule.body !== undefined) outcome.body = rule.body;
    if (rule.delayMs !== undefined) outcome.delayMs = rule.delayMs;
    return outcome;
  }
  return { kind: 'continue' };
}

/** Apply a matched outcome to a Playwright Route. Exported so the route handler is testable in isolation. */
export async function applyOutcome(
  route: Route,
  outcome: MockOutcome,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (outcome.kind === 'continue') {
    await route.continue();
    return;
  }
  if (outcome.kind === 'abort') {
    await route.abort('failed');
    return;
  }
  if (outcome.delayMs !== undefined && outcome.delayMs > 0) await sleep(outcome.delayMs);
  await route.fulfill({
    status: outcome.status ?? DEFAULT_STATUS,
    contentType: outcome.contentType ?? DEFAULT_CONTENT_TYPE,
    body: outcome.body ?? '',
  });
}

const realSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Install (or replace) the network-mock handler on a driven page. Clears any prior Reticle route first,
 * so calling with a new rule set is idempotent and calling with [] turns mocking off. The handler
 * consults matchMock per request and fulfills/aborts/continues accordingly.
 */
export async function installNetworkMocks(
  page: Page,
  rules: MockRule[],
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<void> {
  await page.unroute('**/*').catch(() => undefined);
  if (rules.length === 0) return;
  await page.route('**/*', (route) => {
    const req = route.request();
    const outcome = matchMock(rules, { url: req.url(), method: req.method() });
    void applyOutcome(route, outcome, sleep);
  });
}
