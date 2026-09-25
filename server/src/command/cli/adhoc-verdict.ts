import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { LOOPBACK_HOST, MCP_SSE_PATH } from '@reticlehq/core';
import { TOKEN_QUERY_PARAM } from '@/portal/bridge/token-auth.js';
import { ReticleTool } from '@reticlehq/core';

/**
 * A verdict from the CLI, against the daemon that is already running.
 *
 * THE DEAD END THIS REMOVES. The tools are not loaded in the client, and there is no other supported
 * way to reach a verdict from that state. The shape is always the same: the app is instrumented, the
 * daemon is healthy, `doctor` shows a live connected page, and the client (Codex, Cursor Cloud, Antigravity,
 * Gemini CLI, or a Claude Code session whose MCP link dropped) exposes no `reticle_*` tools, because
 * they load only at client startup. The documented CLI fallback then refused, because the daemon
 * already owned the port — precisely the state a successful install leaves you in. The other CLI
 * verdict paths need saved flows, and a first-install project has none. And our own guidance says
 * never to stop the daemon, because that kills the agent's MCP link.
 *
 * So an agent held a live, correctly-wired app and no path to a verdict short of a human restarting
 * their editor.
 *
 * HOW, AND WHY IT ADDS NO NEW SURFACE. The full tool surface is already drivable over the daemon's
 * HTTP/SSE transport with a hand-written client. That transport is not opt-in — `start()` calls `attachMcp` unconditionally, so every daemon has it. So
 * this asks the running daemon the same questions an agent would, over the same transport, using the
 * MCP client the SDK already ships. Nothing new is exposed and nothing is bound: the daemon keeps
 * the port, the agent keeps its link, and there is nothing to stop.
 *
 * It is deliberately the CLI equivalent of ONE `act_and_wait`: navigate, then assert. A CLI that
 * grew its own scripting language would be a second way to express a journey, competing with flows
 * and drifting from them.
 */

/** What a one-shot verdict reports back to the caller. */
export interface AdhocVerdict {
  /** Process exit code: 0 only when the predicate was PROVED. */
  code: number;
  /** Lines to print, in order. */
  lines: string[];
}

interface AdhocVerdictOptions {
  port: number;
  /** Navigated to first when given; omitted to assert against wherever the session already is. */
  url?: string;
  /** The predicate, already parsed from the caller's JSON. */
  predicate: unknown;
  /**
   * Which connected tab to drive and grade. Omitted means "whatever is connected".
   *
   * It was parsed by `parseVerifySuffix` and never passed on, so with more than one tab open the
   * call failed with "multiple sessions connected — pass sessionId to target one" and there was no
   * way to follow that advice from here. Worse than a dead end: with several tabs it also graded
   * against whichever one the daemon picked.
   */
  sessionId?: string;
  token?: string;
  /** Injected so a test does not need a live daemon. */
  connect?: (endpoint: URL) => Promise<ToolCaller>;
}

/** The narrow slice of an MCP client this needs — one call, then close. */
export interface ToolCaller {
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

/** `verified` is the only field that decides the exit code. Everything else is for the reader. */
const PROVED = 'yes';

export function endpointFor(port: number, token: string | undefined): URL {
  const url = new URL(`http://${LOOPBACK_HOST}:${String(port)}${MCP_SSE_PATH}`);
  if (token !== undefined && token.length > 0) url.searchParams.set(TOKEN_QUERY_PARAM, token);
  return url;
}

export async function connectOverSse(endpoint: URL): Promise<ToolCaller> {
  const client = new Client({ name: 'reticle-cli', version: '1' }, { capabilities: {} });
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
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    const text = (part as { text?: unknown }).text;
    if ('string' !== typeof text) continue;
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
  if (true !== r?.isError || !Array.isArray(r.content)) return undefined;
  const text = r.content
    .map((part) => (part as { text?: unknown }).text)
    .filter((t): t is string => 'string' === typeof t)
    .join('\n');
  if (0 === text.length) return undefined;
  // The tools answer with a JSON envelope whose `error` is the sentence; unwrap when it is one.
  try {
    const parsed: unknown = JSON.parse(text);
    const inner = (parsed as { error?: unknown } | undefined)?.error;
    return 'string' === typeof inner ? inner : text;
  } catch {
    return text;
  }
}

/**
 * Navigate (optionally) and assert, against the daemon already on this port.
 *
 * Exit code 0 ONLY for `verified: "yes"`. `unknown` exits non-zero on purpose: it means Reticle could
 * not tell what happened, and a CI step that treats "could not tell" as success is the false green
 * this whole product exists to prevent.
 */
export async function runAdhocVerdict(options: AdhocVerdictOptions): Promise<AdhocVerdict> {
  const connect = options.connect ?? connectOverSse;
  let caller: ToolCaller;
  try {
    caller = await connect(endpointFor(options.port, options.token));
  } catch (error) {
    return {
      code: 1,
      lines: [
        `could not reach the daemon on port ${String(options.port)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'It answers `reticle status`; if that works and this does not, the daemon is older than this CLI.',
      ],
    };
  }
  try {
    // Spread rather than set: an explicit `sessionId: undefined` is a key the tools reject as an
    // unknown parameter, which would turn "no tab named" into a refusal.
    const pin = options.sessionId === undefined ? {} : { sessionId: options.sessionId };
    if (options.url !== undefined && options.url.length > 0) {
      await caller.call(ReticleTool.NAVIGATE, { url: options.url, ...pin });
    }
    const result = await caller.call(ReticleTool.ASSERT, { predicate: options.predicate, ...pin });
    const refusal = refusalText(result);
    if (refusal !== undefined) {
      return { code: 1, lines: [`verified: unknown`, refusal] };
    }
    const verdict = verdictOf(result);
    // Narrowed rather than stringified: these arrive as `unknown` off a record, and a verdict field
    // that is accidentally an object must not print as `[object Object]` in the one line a reader
    // acts on.
    const asText = (value: unknown): string | undefined =>
      'string' === typeof value ? value : undefined;
    const verified = asText(verdict?.['verified']);
    const reason = asText(verdict?.['verifiedReason']) ?? asText(verdict?.['failureReason']);
    const lines = [
      `verified: ${verified ?? 'unknown'}`,
      ...(reason === undefined ? [] : [`reason: ${reason}`]),
      JSON.stringify(verdict ?? result, null, 2),
    ];
    return { code: PROVED === verified ? 0 : 1, lines };
  } catch (error) {
    return {
      code: 1,
      lines: [
        `the verdict could not be taken: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    await caller.close().catch(() => undefined);
  }
}
