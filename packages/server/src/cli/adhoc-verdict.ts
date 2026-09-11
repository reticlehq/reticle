import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { LOOPBACK_HOST, MCP_SSE_PATH } from '@reticlehq/core';
import { TOKEN_QUERY_PARAM } from '../bridge/token-auth.js';
import { ReticleTool } from '../tools/tool-names.js';

/**
 * A verdict from the CLI, against the daemon that is already running.
 *
 * THE DEAD END THIS REMOVES. The largest single cluster in the field feedback is not a defect in any
 * tool — it is that the tools were not loaded in the client, and there was no supported way to reach
 * a verdict from that state. The shape was always the same: the app is instrumented, the daemon is
 * healthy, `doctor` shows a live connected page, and the client (Codex, Cursor Cloud, Antigravity,
 * Gemini CLI, or a Claude Code session whose MCP link dropped) exposes no `reticle_*` tools, because
 * they load only at client startup. The documented CLI fallback then refused, because the daemon
 * already owned the port — precisely the state a successful install leaves you in. The other CLI
 * verdict paths need saved flows, and a first-install project has none. And our own guidance says
 * never to stop the daemon, because that kills the agent's MCP link.
 *
 * So an agent held a live, correctly-wired app and no path to a verdict short of a human restarting
 * their editor. Several reporters fell back to Playwright or to their own client and said honestly
 * that Reticle could not produce a verdict.
 *
 * HOW, AND WHY IT ADDS NO NEW SURFACE. One reporter found the answer themselves: they drove the full
 * tool surface over the daemon's HTTP/SSE transport with a hand-written client, and it worked. That
 * transport is not opt-in — `start()` calls `attachMcp` unconditionally, so every daemon has it. So
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

export interface AdhocVerdictOptions {
  port: number;
  /** Navigated to first when given; omitted to assert against wherever the session already is. */
  url?: string;
  /** The predicate, already parsed from the caller's JSON. */
  predicate: unknown;
  token?: string;
  /** Injected so a test does not need a live daemon. */
  connect?: (endpoint: URL) => Promise<ToolCaller>;
}

/** The narrow slice of an MCP client this needs — one call, then close. */
export interface ToolCaller {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** `verified` is the only field that decides the exit code. Everything else is for the reader. */
const PROVED = 'yes';

function endpointFor(port: number, token: string | undefined): URL {
  const url = new URL(`http://${LOOPBACK_HOST}:${String(port)}${MCP_SSE_PATH}`);
  if (token !== undefined && token.length > 0) url.searchParams.set(TOKEN_QUERY_PARAM, token);
  return url;
}

async function connectOverSse(endpoint: URL): Promise<ToolCaller> {
  const client = new Client({ name: 'reticle-cli', version: '1' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(endpoint));
  return {
    call: async (name, args) => await client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
    },
  };
}

/** The verdict object an MCP tool result carries, or undefined when the shape is not one. */
function verdictOf(result: unknown): Record<string, unknown> | undefined {
  const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if ('object' === typeof structured && null !== structured) {
    return structured as Record<string, unknown>;
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
function refusalText(result: unknown): string | undefined {
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
    if (options.url !== undefined && options.url.length > 0) {
      await caller.call(ReticleTool.NAVIGATE, { url: options.url });
    }
    const result = await caller.call(ReticleTool.ASSERT, { predicate: options.predicate });
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
