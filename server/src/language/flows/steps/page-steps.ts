/**
 * Steps that reach past the page the journey is on: one opens another page (`navigate`), one sends a
 * request to the app (`request`). Neither acts on an element, and both depend on a caller that owns
 * what the replay cannot reach by itself: the sessions, the origin, the cookies.
 */
import {
  FlowStepTool,
  type Drift,
  type FlowRequest,
  type FlowStep,
  type FlowStepResult,
} from '@reticlehq/core';

/*
 * This folder imports nothing from the rest of the package: the replay passes in what these steps
 * need (the page session, how to open a page, how to judge an expect). Its types live here, and the
 * replay imports them.
 */

/**
 * Opens the page a `navigate` step names and returns the session of the page that loaded, or why no
 * page of the app answered. A full page load ends the session that asked for it, so only the caller
 * that owns the sessions can do this.
 */
export type OpenPage<S> = (url: string) => Promise<{ session: S } | { error: string }>;

/**
 * Sends the request a `request` step names and returns the answer, or why nothing could be sent.
 * Supplied by the caller that knows the app's origin and the page's cookies.
 */
export type SendRequest = (
  request: FlowRequest,
) => Promise<{ status: number; body: string } | { error: string }>;

/** Where the page's cookies come from: the driven browser's storage state. */
interface CookieSource {
  storageState?(sessionUrl: string): Promise<unknown>;
}

/*
 * A step that opens a page in the middle of a journey. The replay goes on with the page that loaded,
 * and the step's `expect` is judged there (see `OpenPage`).
 */
/** The step's result before its `expect` is judged, and the session to go on with. */
export async function openStepPage<S>(
  step: FlowStep,
  index: number,
  open: OpenPage<S> | undefined,
): Promise<{ result: FlowStepResult; session?: S }> {
  const url = step.navigate ?? '';
  const base = { step: index, tool: FlowStepTool.NAVIGATE, anchor: url };
  // Never skipped: a journey that reports green without the page it was meant to check is a false
  // green arriving through the step meant to make the check stronger.
  if (open === undefined) {
    return {
      result: {
        ...base,
        ok: false,
        error: `this replay cannot open a page, so the step that opens ${url} did not run`,
      },
    };
  }
  const opened = await open(url);
  if ('error' in opened) {
    return { result: { ...base, ok: false, error: opened.error } };
  }
  return { result: { ...base, ok: true }, session: opened.session };
}

/** Why an answer does not match the step's `response`, or undefined when it does. */
function responseMismatch(
  response: NonNullable<FlowStep['response']>,
  answer: { status: number; body: string },
): string | undefined {
  const statuses = response.status === undefined ? [] : [response.status].flat();
  if (statuses.length > 0 && !statuses.includes(answer.status)) {
    return `the answer was ${String(answer.status)}, expected ${statuses.join(' or ')}`;
  }
  if (response.contains !== undefined && !answer.body.includes(response.contains)) {
    return `the answer (${String(answer.status)}) does not contain "${response.contains}"`;
  }
  if (response.absent !== undefined && answer.body.includes(response.absent)) {
    return `the answer (${String(answer.status)}) contains "${response.absent}", which it must not`;
  }
  return undefined;
}

/*
 * A step that sends one request and judges the answer. It never skips: a rule the flow says it
 * checks and did not is a false green.
 */
/** Methods that only read. Any other method changes data and needs the run's confirmation. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function runRequestStep(
  step: FlowStep,
  index: number,
  send: SendRequest | undefined,
  judged: boolean,
  /**
   * The run's own yes to steps that change data, never the flow file's: flow files are shared, and a
   * saved `DELETE` would otherwise run with the user's cookies on any app the flow is pointed at.
   */
  confirmDangerous: boolean,
): Promise<FlowStepResult> {
  const request = step.request;
  const label = request === undefined ? '' : `${request.method} ${request.url}`;
  const base = { step: index, tool: FlowStepTool.REQUEST, anchor: label };
  if (request === undefined || send === undefined) {
    return {
      ...base,
      ok: false,
      error: `this replay cannot send a request, so ${label} did not run`,
    };
  }
  if (!READ_METHODS.has(request.method.toUpperCase()) && !confirmDangerous) {
    return {
      ...base,
      ok: false,
      error:
        `potentially destructive request blocked: ${label} changes data, so it was not sent. ` +
        'Confirm it for this run: reticle_verify{action:"flows", confirmDangerous: true}, or ' +
        '`reticle verify <url> --confirm-dangerous`. It cannot be confirmed in the flow file.',
    };
  }
  const answer = await send(request);
  if ('error' in answer) {
    return { ...base, ok: false, error: answer.error };
  }
  const mismatch =
    !judged || step.response === undefined ? undefined : responseMismatch(step.response, answer);
  return mismatch === undefined ? { ...base, ok: true } : { ...base, ok: false, error: mismatch };
}

/** True for a step that reaches past the page: `navigate` or `request`. */
export function isPageStep(step: FlowStep): boolean {
  return step.navigate !== undefined || step.request !== undefined;
}

/**
 * Run a `navigate` or `request` step. `judge` evaluates an `expect` on a page; it comes from the
 * replay so this file does not import the replay back. `checked` is false for a setup step, whose
 * consequence is not checked. A navigate step returns the session to go on with.
 */
export async function runPageStep<S>(
  step: FlowStep,
  index: number,
  ctx: {
    open?: OpenPage<S> | undefined;
    send?: SendRequest | undefined;
    checked: boolean;
    confirmDangerous: boolean;
    judge: (session: S, expect: NonNullable<FlowStep['expect']>) => Promise<Drift | undefined>;
    route: (session: S) => string | undefined;
  },
): Promise<{ result: FlowStepResult; session?: S }> {
  if (step.request !== undefined) {
    return {
      result: await runRequestStep(step, index, ctx.send, ctx.checked, ctx.confirmDangerous),
    };
  }
  const opened = await openStepPage(step, index, ctx.open);
  if (opened.session === undefined) {
    return opened;
  }
  const result = opened.result;
  const page = ctx.route(opened.session);
  if (page !== undefined) {
    result.page = page;
  }
  const drift =
    step.expect === undefined || !ctx.checked
      ? undefined
      : await ctx.judge(opened.session, step.expect);
  if (drift !== undefined) {
    result.ok = false;
    result.drift = drift;
  }
  return { result, session: opened.session };
}

/** How long a `request` step waits for the answer. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The `Cookie` header the page would send to `host`, from the driven browser's storage state. */
function cookieHeader(state: unknown, host: string): string {
  const cookies = (state as { cookies?: unknown } | undefined)?.cookies;
  if (!Array.isArray(cookies)) {
    return '';
  }
  return cookies
    .filter((c): c is { name: string; value: string; domain: string } => {
      const domain = (c as { domain?: unknown }).domain;
      if (typeof domain !== 'string') {
        return false;
      }
      const bare = domain.replace(/^\./, '');
      return host === bare || host.endsWith(`.${bare}`);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * The sender a `request` step uses: same origin as the page only, the page's cookies unless the step
 * is anonymous, no redirects followed (a 302 is the answer to judge). `pageUrl` is read at send time,
 * because a `navigate` step changes the page.
 */
export function requestSender(
  pageUrl: () => string | undefined,
  provider: CookieSource | undefined,
  /** The `Cookie` header of the account a step names in `as`, or undefined when not supplied. */
  accountCookie: (name: string) => string | undefined = () => undefined,
): SendRequest {
  return async (request) => {
    const url = pageUrl();
    if (url === undefined) {
      return { error: 'the page has no known address, so the request has nowhere to go' };
    }
    const origin = new URL(url).origin;
    const target = new URL(request.url, origin);
    if (target.origin !== origin) {
      return {
        error: `${request.url} is not on the app's origin ${origin}; a flow sends requests only to its app`,
      };
    }
    const headers: Record<string, string> = {};
    if (request.body !== undefined) {
      headers['content-type'] = request.contentType ?? 'application/json';
    }
    if (request.as !== undefined) {
      const cookie = accountCookie(request.as);
      if (cookie === undefined || '' === cookie) {
        return {
          error:
            `the session of the account "${request.as}" was not supplied, so the request was not ` +
            'sent. Supply its Cookie header as a secret for this run.',
        };
      }
      headers['cookie'] = cookie;
    } else if (true !== request.anonymous) {
      const state = await provider?.storageState?.(url);
      if (state === undefined) {
        return {
          error:
            'the page cookies cannot be read here (this is not a driven browser), so the request ' +
            'cannot go as the signed-in user. Mark it `anonymous`, or replay with `reticle verify`.',
        };
      }
      const cookie = cookieHeader(state, target.hostname);
      if (cookie !== '') {
        headers['cookie'] = cookie;
      }
    }
    try {
      const answer = await fetch(target, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { status: answer.status, body: await answer.text() };
    } catch (error: unknown) {
      return { error: `the request ${request.method} ${target.pathname} failed: ${String(error)}` };
    }
  };
}
