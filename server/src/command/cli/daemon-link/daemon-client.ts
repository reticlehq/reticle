/**
 * The CLI's link to a running daemon: an MCP client over the daemon's HTTP/SSE transport, the lease
 * calls that open and close a tab, and the readers of a tool result.
 *
 * Split out of `adhoc-verdict.ts` so a caller that needs only the link (`reticle compare`, and the
 * `reticle_verify { action: "compare" }` tool that runs the same compare) does not reach the
 * browser launcher, and through it the installer.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { LOOPBACK_HOST, MCP_SSE_PATH, ReticleTool, asString as asText } from '@reticlehq/core';
import { CLI_CLIENT_NAME } from '@/judgement/runs/verification-sync.js';
import { TOKEN_QUERY_PARAM } from '@/portal/bridge/token-auth.js';
import { LEASE_KEPT_SENTENCE, LEASE_RELEASED_SENTENCE } from '@/surface/tools/lease-hint.js';

/** The lease tool is reached through `reticle_run`, the route that works on every tool profile. */
const LeaseAction = { ACQUIRE: 'acquire', RELEASE: 'release' } as const;

/**
 * Generous on purpose: on a machine with no Chrome, Edge or Playwright Chromium the FIRST lease
 * downloads Chromium before it can open anything (see launch-chromium), which outlives the MCP
 * client's 60s default and would report a timeout for a lease that was about to succeed.
 */
const LEASE_TIMEOUT_MS = 300_000;

export const leaseFailedLine = (url: string): string =>
  `could not open ${url} in a Reticle browser, so nothing was checked:`;

/**
 * Why a lease's tab is not ready: its `notReadyReason`, then its `hint`, when it gave them. The CLI
 * released the lease, so the hint's kept-lease sentence becomes the released-lease sentence.
 */
function notReadyLine(report: Record<string, unknown> | undefined): string {
  const reason = asText(report?.['notReadyReason']);
  const hint = asText(report?.['hint'])?.replace(LEASE_KEPT_SENTENCE, LEASE_RELEASED_SENTENCE);
  const head =
    reason === undefined ? 'the tab did not connect.' : `the tab did not connect (${reason}).`;
  return hint === undefined ? head : `${head} ${hint}`;
}

/**
 * Open `url` in a Reticle-leased browser unconditionally: `{ leased }` names the lease, which the
 * caller hands to `releaseLease`; `{ failed }` is the lease's own refusal, as lines to print.
 * `init`'s connect proof on a machine with no system browser takes this path directly.
 */
export async function acquireLease(
  caller: ToolCaller,
  url: string,
  /** Open it in a window somebody can watch, whatever the daemon was started as. */
  headed?: boolean,
  /** The `.reticle` the lease's runs belong in: the caller's project, not wherever the page resolves. */
  root?: string,
): Promise<{ leased: string; zeroInstall: boolean } | { failed: string[] }> {
  const ask = (withRoot: boolean): Promise<unknown> =>
    caller.call(
      ReticleTool.RUN,
      {
        tool: ReticleTool.LEASE,
        args: {
          action: LeaseAction.ACQUIRE,
          url,
          ...(true === headed ? { headed } : {}),
          ...(withRoot && root !== undefined ? { root } : {}),
        },
      },
      LEASE_TIMEOUT_MS,
    );
  let acquired = await ask(true);
  // A daemon from an older release does not know `root` and refuses the whole call, so the page
  // was never opened. Ask once more without it: the lease works, only its runs land where that
  // daemon puts them.
  if (root !== undefined && REFUSES_ROOT.test(refusalOf(acquired) ?? '')) {
    acquired = await ask(false);
  }
  const report = verdictOf(acquired, 'sessionId');
  const sessionId = report?.['sessionId'];
  // `ready: false` still carries a sessionId, but no session is registered under it. Driving it
  // answered "names no session" and hid the cause the lease gave. Only an explicit false counts.
  if ('string' === typeof sessionId && false === report?.['ready']) {
    await releaseLease(caller, sessionId);
    return { failed: [leaseFailedLine(url), notReadyLine(report)] };
  }
  // `zeroInstall`: the page never dialled in, so the lease supplied Reticle's own reader.
  if ('string' === typeof sessionId) {
    return { leased: sessionId, zeroInstall: true === report?.['zeroInstall'] };
  }
  return {
    failed: [leaseFailedLine(url), refusalOf(acquired) ?? JSON.stringify(acquired)],
  };
}

/** The lease refusal an older daemon answers when it does not know the `root` argument. */
const REFUSES_ROOT = /unknown parameter[^\n]*\broot\b/i;

/** What the lease said no with: the `error` of its payload, else the refusal text. */
function refusalOf(acquired: unknown): string | undefined {
  const why = verdictOf(acquired, 'error')?.['error'];
  return 'string' === typeof why ? why : refusalText(acquired);
}

/** Hand back a lease `leaseIfNoTab` opened. Best-effort: an expired lease is already gone. */
export async function releaseLease(caller: ToolCaller, sessionId: string): Promise<void> {
  await caller
    .call(ReticleTool.RUN, {
      tool: ReticleTool.LEASE,
      args: { action: LeaseAction.RELEASE, sessionId },
    })
    .catch(() => undefined);
}

/** The narrow slice of an MCP client this needs — one call, then close. */
export interface ToolCaller {
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

export function endpointFor(port: number, token: string | undefined): URL {
  const url = new URL(`http://${LOOPBACK_HOST}:${String(port)}${MCP_SSE_PATH}`);
  if (token !== undefined && token.length > 0) {
    url.searchParams.set(TOKEN_QUERY_PARAM, token);
  }
  return url;
}

export async function connectOverSse(endpoint: URL): Promise<ToolCaller> {
  const client = new Client({ name: CLI_CLIENT_NAME, version: '1' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(endpoint));
  return {
    call: async (name, args, timeoutMs) =>
      await client.callTool(
        { name, arguments: args },
        undefined,
        timeoutMs === undefined ? undefined : { timeout: timeoutMs },
      ),
    close: async () => {
      await client.close();
    },
  };
}

/**
 * The report object an MCP tool result carries, or undefined when the shape is not one.
 *
 * `field` is the key that makes a payload the report this caller wants: `verified` for a one-shot
 * verdict, `status` for a suite. It is a parameter rather than a fixed name because the suite path
 * reproduced this function's own incident the moment it reused it — the headline printed
 * `unverifiable` while the JSON under it said `"status":"fail"` with 74 failing flows, because a
 * suite report has no `verified` key and the text reader would only accept one that did.
 */
export function verdictOf(
  result: unknown,
  field: string = 'verified',
): Record<string, unknown> | undefined {
  const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if ('object' === typeof structured && null !== structured) {
    return structured as Record<string, unknown>;
  }
  // A daemon that answers with the verdict as TEXT left this undefined, so the headline read
  // `verified: unknown` while the JSON printed underneath it said `"verified":"no"` — one response
  // giving two answers to the same question. The text is the same object, so read it.
  return verdictFromText(result, field);
}

/** The report object inside an MCP text part, when the result carried it there instead. */
function verdictFromText(result: unknown, field: string): Record<string, unknown> | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const part of content) {
    const text = (part as { text?: unknown }).text;
    if ('string' !== typeof text) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      // Only a shape that actually carries a verdict — anything else stays `unknown`, which is the
      // honest answer for a result this function could not read.
      if ('object' === typeof parsed && null !== parsed && field in parsed) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* Not JSON; the next part may still be. */
    }
  }
  return undefined;
}

/**
 * The tool's own words when it refused, rather than the envelope carrying them.
 *
 * A refusal from these tools is the most useful text they produce — it names the cause and the next
 * action — and printing the MCP result object around it buries that in JSON escaping. The reader is
 * at a terminal; give them the sentence.
 */
export function refusalText(result: unknown): string | undefined {
  const r = result as { isError?: unknown; content?: unknown } | undefined;
  if (true !== r?.isError || !Array.isArray(r.content)) {
    return undefined;
  }
  const text = r.content
    .map((part) => (part as { text?: unknown }).text)
    .filter((t): t is string => 'string' === typeof t)
    .join('\n');
  if (0 === text.length) {
    return undefined;
  }
  // The tools answer with a JSON envelope whose `error` is the sentence; unwrap when it is one.
  try {
    const parsed: unknown = JSON.parse(text);
    const inner = (parsed as { error?: unknown } | undefined)?.error;
    return 'string' === typeof inner ? inner : text;
  } catch {
    return text;
  }
}

/** The payload of a tool result: its structured content, or the JSON object in its text. */
export function payloadOf(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if ('object' === typeof structured && null !== structured) {
    return structured as Record<string, unknown>;
  }
  const content = (result as { content?: unknown } | undefined)?.content;
  for (const part of Array.isArray(content) ? content : []) {
    const text = (part as { text?: unknown }).text;
    if ('string' !== typeof text) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if ('object' === typeof parsed && null !== parsed) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON; the next part may be.
    }
  }
  return {};
}
