/**
 * The model binding: the one file in the harness that knows there is a network.
 *
 * Everything about the loop lives in harness.ts against the `ModelDriver` interface, so this file is
 * a translation layer and nothing else. That split is not tidiness — it is what lets the loop be
 * tested against a scripted model with no API key, on every run of the unit gate.
 *
 * It speaks the Messages API over `fetch` rather than through a vendor SDK. The loop is ours (the
 * harness owns the step budget and has to record every call even when a run is cut short), so an SDK
 * would contribute one HTTP POST and a dependency — and this package's dependency list is short on
 * purpose.
 */

import { z } from 'zod';
import { ReticleEnv } from '@reticlehq/core';
import type { HarnessTool, HistoryEntry, ModelDriver, ModelTurn, ToolRequest } from './harness.js';

/**
 * The default driver model.
 *
 * Deliberately not the largest model available. The harness is not reasoning about business logic; it
 * is exploring an interface and stating consequences, and the verdict is produced by the engine
 * reading what it drove. If finding defects required a frontier model HERE, the engine would not be
 * doing its job — so the model tier is also a standing test of the design.
 */
export const DEFAULT_HARNESS_MODEL = 'claude-sonnet-5';

export const DEFAULT_HARNESS_BASE_URL = 'https://api.anthropic.com';

/** Output cap per turn. A driving turn is a sentence and a tool call, never an essay. */
const MAX_TOKENS = 4096;

const ANTHROPIC_VERSION = '2023-06-01';
const MESSAGES_PATH = '/v1/messages';

/**
 * How much of one tool result the model is allowed to see.
 *
 * A snapshot of a dense page or a network window on a busy app is far larger than anything the model
 * needs to choose its next click, and a handful of them will fill a context window that then has to
 * be paid for on every subsequent turn. Truncation is announced in the payload rather than silent,
 * because a model that cannot tell it was given a partial reading will reason about it as a complete
 * one — and the tools already have cheaper lenses (`count_only`, `interactive`, `diff`) for exactly
 * this. The full result is in the journal either way; nothing is lost from the record.
 */
const MAX_RESULT_CHARS = 8000;

/** The cache breakpoint marker. One object, because it is the same fact in three places. */
const CACHE_BREAKPOINT = { type: 'ephemeral' } as const;

/** What one turn of the wire looks like, narrowed at the boundary rather than trusted. */
const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const OtherBlock = z.object({ type: z.string() }).passthrough();
const MessageResponse = z.object({
  content: z.array(z.union([TextBlock, ToolUseBlock, OtherBlock])).default([]),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().nullish(),
      cache_creation_input_tokens: z.number().nullish(),
    })
    .default({ input_tokens: 0, output_tokens: 0 }),
});

/** A content block as it goes out. `unknown` values are the model's own arguments, echoed back. */
interface WireBlock {
  type: string;
  [field: string]: unknown;
}
interface WireMessage {
  role: 'user' | 'assistant';
  content: WireBlock[];
}

/** The one call this file makes. Injected so a test can drive the translation with no network. */
export type HarnessFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface HarnessDriverOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Injected for tests. Defaults to the platform `fetch`. */
  fetch?: HarnessFetch;
}

/**
 * Read the harness's configuration out of the environment.
 *
 * Returns `undefined` when there is no key, which is the ONLY thing that decides whether the harness
 * is available. Stated as a read rather than a throw because "you have not configured this" is a
 * routine answer a caller offers a way out of, not a failure.
 */
export function harnessOptionsFromEnv(
  env: Record<string, string | undefined>,
): HarnessDriverOptions | undefined {
  const apiKey = env[ReticleEnv.HARNESS_KEY];
  if (apiKey === undefined || 0 === apiKey.length) return undefined;
  const model = env[ReticleEnv.HARNESS_MODEL];
  const baseUrl = env[ReticleEnv.HARNESS_BASE_URL];
  return {
    apiKey,
    ...(model === undefined || 0 === model.length ? {} : { model }),
    ...(baseUrl === undefined || 0 === baseUrl.length ? {} : { baseUrl }),
  };
}

/** Build a driver backed by the Messages API. */
export function harnessDriver(options: HarnessDriverOptions): ModelDriver {
  const model = options.model ?? DEFAULT_HARNESS_MODEL;
  const baseUrl = options.baseUrl ?? DEFAULT_HARNESS_BASE_URL;
  const call: HarnessFetch = options.fetch ?? ((url, init) => fetch(url, init));

  return {
    async turn({ system, tools, history }): Promise<ModelTurn> {
      const response = await call(`${baseUrl}${MESSAGES_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: system,
              // The system prompt and the tool list are byte-identical on every turn of a drive, and
              // a drive is dozens of turns. Caching the prefix is most of the cost of driving an app.
              cache_control: CACHE_BREAKPOINT,
            },
          ],
          tools: tools.map(toWireTool),
          messages: withConversationCache(history.map(toWireMessage)),
        }),
      });

      const body = await response.text();
      if (!response.ok) {
        // Thrown, not returned: the loop calls a model that will not answer a BROKEN drive, and a
        // broken drive is never reported as clean. Swallowing this would be a verdict about an app
        // nobody drove.
        throw new Error(`the model refused the request (HTTP ${String(response.status)}): ${body}`);
      }
      const parsed = MessageResponse.parse(JSON.parse(body) as unknown);

      const text = parsed.content
        .filter((block): block is z.infer<typeof TextBlock> => 'text' === block.type)
        .map((block) => block.text)
        .join('\n');
      const calls: ToolRequest[] = parsed.content
        .filter((block): block is z.infer<typeof ToolUseBlock> => 'tool_use' === block.type)
        .map((block) => ({
          id: block.id,
          name: block.name,
          args: isRecord(block.input) ? block.input : {},
        }));

      return {
        text,
        calls,
        usage: {
          input: parsed.usage.input_tokens,
          output: parsed.usage.output_tokens,
          // Reported so a missed cache is VISIBLE. A breakpoint that silently stops matching costs
          // full price and looks exactly like one that is working from every other angle.
          cacheRead: parsed.usage.cache_read_input_tokens ?? 0,
          cacheWrite: parsed.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}

/**
 * Cache the conversation so far, so the next turn does not pay to re-read it.
 *
 * The API is stateless: every turn re-sends the whole conversation, and a drive is dozens of turns.
 * The system prompt and the tool list are already cached from the first turn — but those are the half
 * that does not grow. The messages are the half that does, and without a breakpoint every byte of
 * them is processed again at full price on every single turn.
 *
 * ONE breakpoint, on the last content block of the most-recently-appended turn. Next turn, this
 * entire conversation is the request's prefix, so it is read at roughly a tenth of the input price
 * rather than processed again. Earlier entries stay valid read points, so the saving accrues as the
 * conversation grows — which is exactly the shape of the cost.
 *
 * Not several breakpoints: four is the hard limit per request and the system block already spends
 * one. More here would buy nothing, because the lookup from a later breakpoint already finds the
 * earlier turn's entry as its prefix.
 *
 * The one thing that would break it is a single turn adding more than twenty content blocks — the
 * lookback window is twenty, and a breakpoint that cannot see the previous entry silently misses. A
 * turn here is one text block, N tool_use blocks and N tool_result blocks, so it would take ten
 * parallel calls in one turn to reach that. Worth knowing; not worth a second breakpoint until it
 * happens, and the cache-read count in `usage` is where it would show up.
 */
function withConversationCache(messages: readonly WireMessage[]): WireMessage[] {
  const last = messages[messages.length - 1];
  if (last === undefined) return [...messages];
  const content = last.content.map((block, index) =>
    index === last.content.length - 1 ? { ...block, cache_control: CACHE_BREAKPOINT } : block,
  );
  return [...messages.slice(0, -1), { ...last, content }];
}

function toWireTool(tool: HarnessTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toWireMessage(entry: HistoryEntry): WireMessage {
  if ('user' === entry.role) {
    // A text BLOCK rather than a bare string: only a block can carry a cache breakpoint, and the
    // opening message is the one that would otherwise be a string. It changes the billing and
    // nothing the model reads.
    return { role: 'user', content: [{ type: 'text', text: entry.text }] };
  }
  if ('assistant' === entry.role) {
    const blocks: WireBlock[] = [];
    if (entry.text.length > 0) blocks.push({ type: 'text', text: entry.text });
    for (const call of entry.calls) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
    }
    return { role: 'assistant', content: blocks };
  }
  // Every outcome goes back in ONE user message. Splitting tool results across messages teaches the
  // model to stop asking for calls in parallel, which is most of what makes a drive fast.
  return {
    role: 'user',
    content: entry.outcomes.map((outcome) => ({
      type: 'tool_result',
      tool_use_id: outcome.id,
      content: truncate(JSON.stringify(outcome.result ?? null)),
      is_error: outcome.isError,
    })),
  };
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const dropped = String(text.length - MAX_RESULT_CHARS);
  return `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${dropped} characters — ask for a narrower lens (count_only, interactive, diff, or a path) if you need the rest]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && null !== value && !Array.isArray(value);
}
