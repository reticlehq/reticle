import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isToonable, resultToToon } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools/tools.js';
import type { ToolDef } from './tools/tools.js';
import { filterTools, TOOL_PROFILE, type ToolProfile } from './tools/profiles.js';
import { buildDynamicTools } from './tools/dynamic-tools.js';
import { runTool, SESSION_BOUND_TOOLS } from './tools/invoke-tool.js';
import { sessionEnvelopeShape } from './tools/tool-kit.js';
import { buildErrorPayload } from './tools/error-recovery.js';
import { log } from './log.js';
import { SERVER_VERSION } from './server-version.js';
import { MCP_SERVER_NAME } from './init/mcp.js';
import { setMcpClientNameHook } from './telemetry/feedback-context.js';
import { getSessionMetrics } from './telemetry/session-metrics.js';

/**
 * Merge the runtime-spliced envelope (health/lease/age/control) into a session-bound tool's declared
 * outputSchema so structuredContent validation keeps those fields instead of dropping them. The tool's
 * own keys win over the permissive envelope defaults (e.g. ACT keeps its typed `session` shape).
 * Non-session-bound tools (and tools with no outputSchema) are returned unchanged.
 */
export function withSessionEnvelope(
  name: string,
  outputSchema: z.ZodRawShape | undefined,
): z.ZodRawShape | undefined {
  if (outputSchema === undefined || !SESSION_BOUND_TOOLS.has(name)) return outputSchema;
  return { ...sessionEnvelopeShape, ...outputSchema };
}

const SERVER_INFO = { name: MCP_SERVER_NAME, version: SERVER_VERSION };

/**
 * What every agent is told at `initialize`, before it has called a single tool.
 *
 * This is the only channel that reaches an agent with NO dependency on the project: no CLAUDE.md, no
 * AGENTS.md, no pasted skill, no successful `reticle init`. An agent whose setup half-worked has read
 * none of those files and is precisely the agent whose report we need — so the standing instruction
 * to send feedback has to live here, where it arrives with the connection itself.
 *
 * Kept to a handful of lines: it is prepended to every session's context, so each sentence is paid
 * for on every turn, forever.
 */
const SERVER_INSTRUCTIONS = `Reticle verifies a running web app from the inside: look (reticle_snapshot / reticle_query), act (reticle_act), observe (reticle_state / reticle_network / reticle_console), assert (reticle_assert). Verify a user-facing change against the real app before you call it done, and never weaken a check to make it pass.

Feedback is first-class here, not a courtesy. Reticle is built FOR agents, so your experience is the only signal that decides what gets built or fixed — and it disappears when your context does. Send it with \`reticle_feedback\` the moment you notice, then carry on with your task:
- Reticle broke, lied, or could not see something you needed (\`bug\` / \`gap\` / \`ambiguity\`).
- You wished it could do something, or something works but costs too many calls (\`feature_request\` / \`improvement\`).
- The install, the wiring, or the setup itself gave you trouble — including anything you had to work around by hand.

Nothing is too minor, and a report costs one call. If the tools are unreachable (setup unfinished, daemon down), file the same report from the shell instead: \`reticle feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement> "what happened"\`. Report defects in RETICLE — a bug you find in the app under test is Reticle working, and belongs in your answer to the user.`;

/** First sentence of a description (purpose only) for lean profiles — keeps per-turn def cost
 * down. Cuts at the first sentence-ending period or newline; falls back to a 160-char cap. The
 * first clause retains the essentials (enum hints like "role | text | label" live there). */
/**
 * Append the tool's example call to whatever description survived trimming.
 *
 * Costs a handful of tokens per turn and buys back the failed round trips an agent spends guessing
 * how the fields compose — which is a far worse trade in the other direction.
 */
function withExample(description: string, example?: Record<string, unknown>): string {
  return example === undefined ? description : `${description} e.g. ${JSON.stringify(example)}`;
}

/**
 * Abbreviations whose internal period is NOT a sentence end.
 *
 * The splitter looked for the first `". "`, which "e.g. " satisfies — so every lean-profile
 * description containing one was cut off mid-abbreviation. `reticle_act`'s ref parameter reached the
 * agent as "Element ref from reticle_snapshot or reticle_query (e.g." and stopped: the example gone,
 * and any contract stated after it gone too. Silent, and it degraded the DEFAULT profile only, which
 * is the one nobody reads the raw strings for.
 */
const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'vs.', 'cf.'];

export function firstSentence(description: string): string {
  const nl = description.indexOf('\n');
  const base = nl >= 0 ? description.slice(0, nl) : description;
  // Mask abbreviations with an equal-length filler so offsets stay valid in the original string.
  const masked = ABBREVIATIONS.reduce(
    (text, abbr) => text.split(abbr).join('\u0000'.repeat(abbr.length)),
    base,
  );
  const dot = masked.search(/\.\s/);
  const sentence = dot >= 0 ? base.slice(0, dot + 1) : base;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

/**
 * Parameters carrying the recursive predicate grammar. Advertised compactly in lean profiles.
 *
 * `PredicateSchema` is a 12-variant discriminated union whose `allOf`/`anyOf`/`not` members embed the
 * union again. Zod's JSON-Schema emitter inlines that recursion rather than emitting one `$ref`, so a
 * single tool ships the word "kind" 48 times and `reticle_wait_for` alone costs 6,571 characters.
 * Across the three tools that take a predicate that is 72% of the entire advertised input schema — a
 * cost re-sent on every request, forever, to describe a grammar most calls use one variant of.
 */
const PREDICATE_PARAMS = new Set(['predicate', 'until']);

/**
 * What a lean profile advertises in place of the full predicate union.
 *
 * Safe to loosen because it is NOT the validation boundary: every handler taking a predicate calls
 * `PredicateSchema.parse()` itself (observe-tools.ts:203, :279, act-tools.ts:442), so a malformed
 * predicate still fails strictly and structurally — the agent gets a zod error naming the bad field
 * rather than a silently accepted one. What changes is only how many bytes we spend describing the
 * grammar up front versus letting the agent fetch it from `reticle_tools` when it needs a variant it
 * has not used before.
 */
/**
 * The kind list — the part an agent needs to WRITE a predicate. Carried on every predicate parameter.
 *
 * An earlier version put this on one tool and pointed the other five at it ("same grammar as
 * reticle_act_and_wait's"), which saved 790 B/turn. It was the wrong trade: it made writing a
 * predicate require joining two tool descriptions, and accuracy is worth more here than the bytes.
 * Only the "where to get field details" sentence is stated once now — that one IS a pointer, so
 * making it a pointer costs nothing.
 */
const PREDICATE_KINDS =
  'Predicate object: { kind, ...fields }. kind is one of element | text | net | route | console | ' +
  'animation | signal | state | settled | allOf | anyOf | not.';

/**
 * Said once per turn: the bug-catching options, and where to get the rest of the field grammar.
 *
 * `net.count`, `console.absent` and `absent` are the three predicate options that catch a class of
 * bug rather than confirm an expectation — a double-submit, an action that "worked" while logging a
 * caught error, something that should have disappeared and did not. They sat behind a
 * `reticle_tools` round trip, so an agent only found them if it already knew to look, which is the
 * wrong way round for the checks most likely to catch what nobody suspected.
 *
 * Anchored to one tool rather than repeated on all six: these are ADDITIONAL capability, not what
 * makes a basic predicate correct, so one mention per turn is enough to make them reachable without
 * paying for six.
 */
const PREDICATE_FIELD_GRAMMAR_HINT =
  ' Bug-catching options: net.count (exact request count — catches double-submit), ' +
  'console.absent:true (action completed with a CLEAN console), absent:true on element/text ' +
  '(it should be gone). Call reticle_tools for the full field grammar of a kind.';

const COMPACT_PREDICATE_DESCRIPTION = `${PREDICATE_KINDS}${PREDICATE_FIELD_GRAMMAR_HINT}`;

/**
 * Lean copy of a tool's zod input shape for lean profiles: each parameter's description is
 * truncated to its first sentence via zod's own `.describe` (which returns a new schema, so the
 * shared shape is never mutated). The per-parameter prose is the bulk of the re-sent-every-turn
 * schema cost; the first clause keeps each param's purpose and any enum hints. Params without a
 * description pass through unchanged. Predicate params are replaced wholesale — see above.
 */
function leanZodShape(shape: z.ZodRawShape, predicateAnchor?: string): z.ZodRawShape {
  const out: z.ZodRawShape = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (PREDICATE_PARAMS.has(key)) {
      // Every tool keeps the kinds; only the navigation hint is anchored to one.
      const compact = z
        .record(z.unknown())
        .describe(predicateAnchor === undefined ? COMPACT_PREDICATE_DESCRIPTION : PREDICATE_KINDS);
      out[key] = schema.isOptional() ? compact.optional() : compact;
      continue;
    }
    const desc = schema.description;
    out[key] = typeof desc === 'string' ? schema.describe(firstSentence(desc)) : schema;
  }
  return out;
}

const ENCODING_ENV = 'RETICLE_ENCODING';
const TOON_VALUE = 'toon';
const PRETTY_VALUE = 'pretty';

/**
 * Serialize a tool result to the MCP `text` content block. The agent consumes this text — the
 * typed contract travels separately as `structuredContent`, unchanged by encoding — so the text
 * is compact JSON (no indentation) by default: pretty-printing spends a whitespace token on every
 * field of every line, ~40% overhead on the structured payloads that dominate Reticle's cost, for
 * readability only a human re-reading a raw transcript would notice. Opt into the older indented
 * form with `RETICLE_ENCODING=pretty`; `RETICLE_ENCODING=toon` is the even-denser tabular encoding.
 */
export function encodeResult(result: unknown, encoding: string): string {
  if (encoding === TOON_VALUE && isToonable(result)) {
    return resultToToon(result as Record<string, unknown>);
  }
  return encoding === PRETTY_VALUE ? JSON.stringify(result, null, 2) : JSON.stringify(result);
}

/**
 * Bridge type that erases the MCP SDK's complex generic pairing between outputSchema and handler
 * return type. Reticle exposes tool output as text content (for backwards-compatible MCP clients) AND
 * as structuredContent (for schema-aware clients like @reticlehq/cli). The SDK generics are correct at
 * the protocol level; we break the link here intentionally so we can register all tools
 * dynamically from a ToolDef array without a generic per-tool call site.
 */
type ReticleRegisterTool = (
  name: string,
  config: {
    description: string;
    inputSchema: z.ZodRawShape;
    outputSchema?: z.ZodRawShape;
  },
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>,
) => void;

/**
 * The tools a profile advertises directly.
 *
 * Exported so it can be TESTED. A previous guard re-implemented this decision in the test and was
 * therefore insensitive to it — every profile appeared to reach every tool, so reverting the fix here
 * left the suite green. Exercise the real function or the guard is theatre.
 *
 * Every TRIMMED profile keeps the meta-tools, so a tool that is not advertised is still reachable via
 * reticle_run. Without them a trim is not a trim but a hard removal: under `standard`, 11 tools were
 * uncallable — including reticle_annotate, which reticle_flow_save's own description tells the agent to
 * call. `full` advertises everything and needs no hatch.
 */
export function advertisedTools(profile: ToolProfile): ToolDef[] {
  if (profile === TOOL_PROFILE.DYNAMIC) return buildDynamicTools(TOOLS);
  if (profile === TOOL_PROFILE.FULL) return TOOLS;
  const base = filterTools(TOOLS, profile === TOOL_PROFILE.HYBRID ? TOOL_PROFILE.CORE : profile);
  return [...base, ...buildDynamicTools(TOOLS)];
}

/**
 * Exactly what gets advertised for one tool under a profile: trimmed description, lean input shape,
 * and (non-lean only) the output schema.
 *
 * Exported so tests assert on the REAL advertised text rather than on the tool definitions, which
 * are trimmed later and would make a guard that cannot fail — a mistake already made once here, with
 * an abbreviation test that read raw defs and would have passed with the bug fully present.
 */
export function advertisedConfig(
  tool: ToolDef,
  advertised: readonly ToolDef[],
  profile: ToolProfile,
): { description: string; inputSchema: z.ZodRawShape; outputSchema?: z.ZodRawShape } {
  const terse =
    profile === TOOL_PROFILE.CORE ||
    profile === TOOL_PROFILE.STANDARD ||
    profile === TOOL_PROFILE.HYBRID;
  // The first advertised tool carrying a predicate spells the grammar out; the rest point at it.
  const anchor = advertised.find((t) =>
    Object.keys(t.inputSchema).some((k) => PREDICATE_PARAMS.has(k)),
  )?.name;
  const outputSchema = terse ? undefined : withSessionEnvelope(tool.name, tool.outputSchema);
  return {
    description: withExample(
      terse ? firstSentence(tool.description) : tool.description,
      tool.example,
    ),
    inputSchema: terse
      ? leanZodShape(tool.inputSchema, tool.name === anchor ? undefined : anchor)
      : tool.inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  };
}

/**
 * Replace the SDK's arg-validation error with one an agent can act on.
 *
 * A wrong argument SHAPE is the most common failure an agent has here, and it is the one this
 * package's otherwise-good error handling never sees: the SDK validates and throws before the
 * handler runs, so what comes back is the validator's internal state — `{"code":"invalid_type",
 * "expected":"string","received":...}` — naming no field and showing no correct call. Observed live:
 * two failed round trips guessing `reticle_act`'s shape, which costs more than the lean snapshot
 * saves. Advertised examples reduced the guessing; this removes the dead end that remains.
 *
 * The zod detail is KEPT — it names the offending field — and the tool's own example is appended, so
 * the reply says both what was wrong and exactly what a correct call looks like.
 *
 * This wraps an SDK-internal method, so a rename upstream would silently restore the raw dump. That
 * is why `mcp.test.ts` drives a real client over an in-memory transport and asserts on the message
 * an agent actually receives, rather than testing this function directly.
 */
type InputValidator = (tool: unknown, args: unknown, toolName: string) => Promise<unknown>;

/** Argument keys the tool never declared. Empty when the tool's shape is unknown to us. */
function unknownKeys(args: unknown, allowed?: ReadonlySet<string>): string[] {
  if (allowed === undefined || typeof args !== 'object' || args === null) return [];
  return Object.keys(args as Record<string, unknown>).filter((key) => !allowed.has(key));
}

export function installFriendlyArgErrors(
  server: McpServer,
  examples: Map<string, string>,
  allowedKeys: Map<string, ReadonlySet<string>> = new Map(),
): void {
  const target = server as unknown as { validateToolInput?: InputValidator };
  const original = target.validateToolInput;
  if (typeof original !== 'function') return;
  target.validateToolInput = async (tool, args, toolName) => {
    // An UNKNOWN key is the failure zod cannot catch, because object schemas are non-strict: the key
    // is silently dropped and the tool answers as if it had not been asked. Measured live —
    // `reticle_clock { action: "freeze" }` returned `{"frozen":false}`, which reads as a fact about
    // the app ("the clock is not frozen") when it means "you named the parameter wrong". That is a
    // false NEGATIVE the caller cannot detect from the reply, in every tool at once.
    const unknown = unknownKeys(args, allowedKeys.get(toolName));
    if (unknown.length > 0) {
      const example = examples.get(toolName);
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown ${unknown.length === 1 ? 'parameter' : 'parameters'} for ${toolName}: ${unknown.join(', ')}. ` +
          `They were NOT applied — a result computed without them would look like an answer. ` +
          (example === undefined
            ? `Call reticle_tools { names: ["${toolName}"] } for its parameters.`
            : `A valid call looks like: ${toolName} ${example}`),
      );
    }
    try {
      return await original.call(server, tool, args, toolName);
    } catch (error) {
      // McpError.message already carries "MCP error -32602: "; re-wrapping would print it twice.
      const raw = error instanceof Error ? error.message : String(error);
      const detail = raw.replace(/^MCP error -?\d+:\s*/, '');
      const example = examples.get(toolName);
      const help =
        example === undefined
          ? ` Call reticle_tools { names: ["${toolName}"] } for its parameters.`
          : ` A valid call looks like: ${toolName} ${example}`;
      throw new McpError(ErrorCode.InvalidParams, `${detail}${help}`);
    }
  };
}

export function createMcpServer(
  deps: ToolDeps,
  profile: ToolProfile = TOOL_PROFILE.HYBRID,
): McpServer {
  const encoding = (process.env[ENCODING_ENV] ?? '').toLowerCase();
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  // Which agent is on the other end, taken from its own `initialize` handshake. Registered as a lazy
  // hook rather than read here: the handshake has not happened yet at construction time, and a
  // feedback report filed twenty tool calls later is exactly when we want the answer.
  setMcpClientNameHook(() => {
    const info = server.server.getClientVersion();
    // Record it as a side effect of the first read so the session summary can report WHICH agents
    // drove this daemon — the multi-agent story, visible without a second plumbing path.
    if (info?.name !== undefined) getSessionMetrics().recordClient(info.name);
    return info === undefined ? undefined : { name: info.name, version: info.version };
  });
  // Cast once to our bridge type so every per-tool call site is typed without `any`.
  const registerTool = server.registerTool.bind(server) as unknown as ReticleRegisterTool;

  // `dynamic` advertises only the 2 meta-tools (reticle_tools + reticle_run); real tools load on demand.
  // core/standard advertise the filtered set with terse descriptions (first sentence + trimmed
  // param prose) — the full prose is re-sent every turn, and the first clause carries the purpose.
  // Every TRIMMED profile keeps the meta-tools, so a tool that is not advertised is still reachable
  // through reticle_run. Without them a trim is not a trim, it is a hard removal: under `standard`,
  // 11 tools were unreachable with no escape hatch — including reticle_annotate, which
  // reticle_flow_save's own description instructs the agent to call. `full` advertises everything
  // directly and needs no hatch.
  const advertised = advertisedTools(profile);
  installFriendlyArgErrors(
    server,
    new Map(
      advertised
        .filter((tool) => tool.example !== undefined)
        .map((tool) => [tool.name, JSON.stringify(tool.example)]),
    ),
    // Every tool in TOOLS, not just the advertised ones: reticle_run dispatches to the full table,
    // so an unadvertised tool reached through the hatch must be just as strict.
    new Map(TOOLS.map((tool) => [tool.name, new Set(Object.keys(tool.inputSchema))])),
  );
  for (const tool of advertised) {
    // Output schemas are now the largest slice of the per-request tax (55.6% of the hybrid payload
    // after the predicate fix) and we are the only one of the three MCP servers that sends them.
    //
    // Trimming their prose was tried and MEASURED ZERO: the field descriptions were already written
    // as single sentences, so first-sentence truncation had nothing to remove. Recorded here so the
    // next person does not spend the same hour. The remaining cost is structural — the shapes
    // themselves — and dropping them is NOT the answer: the type contract is what makes
    // `structuredContent` verifiable, and it has already caught a real defect (a broad reticle_query
    // failing output validation outright instead of returning a degraded result).
    //
    // Lean profiles therefore DROP the advertised outputSchema entirely, and that is safe — verified
    // against the SDK, not assumed. A tool registered with NO outputSchema still returns its
    // `structuredContent` unchanged (the SDK does not require a declared schema to carry it), so a
    // client that wants the typed object still gets it; only client-side VALIDATION of that object is
    // lost, which the MCP spec makes optional and which the agent, reading the text block, never did.
    // If anything the object is MORE complete without a schema — with one, the SDK drops fields the
    // schema does not list, which is the very reason the session envelope had to be spliced in. The
    // handler below is unchanged, so `full`/`dynamic` (non-terse) keep the schema for validating
    // clients. This removes the single largest remaining slice of the per-request tax (~36% of the
    // hybrid payload) with no loss the agent can observe.
    const config = advertisedConfig(tool, advertised, profile);
    registerTool(tool.name, config, async (args: Record<string, unknown>) => {
      try {
        const result = await runTool(tool, deps, args);
        const text = encodeResult(result, encoding);
        if (tool.outputSchema !== undefined) {
          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: result as Record<string, unknown>,
          };
        }
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('tool_error', { tool: tool.name, error: message });
        // Counted by FINGERPRINT, never by message — see error-fingerprint.ts. This is the single
        // boundary every agent-visible tool failure crosses, so it is the one place "which error is
        // hurting people most" can be answered without instrumenting every handler.
        getSessionMetrics().recordToolError(message, tool.name);
        // Every error the agent hits should answer "what next?", not just "what broke".
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: JSON.stringify(buildErrorPayload(message)) }],
        };
      }
    });
  }
  return server;
}
