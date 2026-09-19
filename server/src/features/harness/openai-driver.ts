/**
 * The harness driver for OpenAI's Chat Completions API.
 *
 * Third driver, and the reason it exists is comparison rather than capability: people want to know
 * whether the cheap typed-decision model is good enough for THEIR app, and "cheap versus one
 * frontier model" is a weaker answer than "cheap versus the two they might otherwise reach for".
 *
 * A translation layer, exactly like `driver.ts` — the loop lives in `harness.ts` against
 * `ModelDriver` and knows nothing about any wire. Chat Completions is a genuinely different shape
 * from the Messages API, and translating OpenAI into Anthropic's wire on the platform side was
 * considered and rejected there: it would put a second, undeclared model-shaped transformation
 * inside the thing being measured. So this speaks the native format and the arm measures OpenAI.
 *
 * NOT cache-annotated, and that is a real asymmetry to hold in mind when reading a cost comparison
 * against the Anthropic arm. OpenAI caches long prefixes automatically and reports it back in
 * `usage.prompt_tokens_details.cached_tokens`, so the saving is not something this driver arranges;
 * it is reported below so the number is visible rather than assumed.
 */

import { z } from 'zod';
import { ReticleEnv } from '@reticlehq/core';
import type { HarnessTool, HistoryEntry, ModelDriver, ModelTurn, ToolRequest } from './harness.js';
import type { HarnessFetch } from './driver.js';

/**
 * The default model.
 *
 * Deliberately not the largest available, for the same reason `DEFAULT_HARNESS_MODEL` is not: the
 * driver is choosing what to touch next, and the engine decides the verdict from evidence. A driver
 * that needed a frontier model would be evidence the engine was not doing its job.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

/** The platform's own path, which forwards with Reticle's key rather than the caller's. */
const PLATFORM_PATH = '/v1/model/openai';
const OPENAI_PATH = '/v1/chat/completions';

/** Output cap per turn. A driving turn is a sentence and a tool call, never an essay. */
const MAX_TOKENS = 4096;

/** How much of one tool result the model is allowed to see. Same reasoning as the Anthropic driver. */
const MAX_RESULT_CHARS = 8000;

const ToolCall = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string().default('{}') }),
});
const ChatResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z.array(ToolCall).nullish(),
        }),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number().default(0),
      completion_tokens: z.number().default(0),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
    })
    .default({ prompt_tokens: 0, completion_tokens: 0 }),
});

export interface OpenAiDriverOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Injected for tests. Defaults to the platform `fetch`. */
  fetch?: HarnessFetch;
}

/**
 * Read this driver's configuration out of the environment.
 *
 * A real OpenAI key goes to OpenAI. The platform key goes to the platform, which forwards with its
 * own — so somebody who has run `reticle link` can drive with this model having never held an
 * OpenAI key, which is the entire point of the proxy.
 */
export function openAiOptionsFromEnv(
  env: Record<string, string | undefined>,
): OpenAiDriverOptions | undefined {
  const model = env[ReticleEnv.HARNESS_OPENAI_MODEL];
  const withModel = (rest: Omit<OpenAiDriverOptions, 'model'>): OpenAiDriverOptions => ({
    ...rest,
    ...(model === undefined || 0 === model.length ? {} : { model }),
  });

  const direct = env[ReticleEnv.HARNESS_OPENAI_KEY];
  if (direct !== undefined && 0 < direct.length) return withModel({ apiKey: direct });

  const cloudKey = env[ReticleEnv.CLOUD_KEY];
  const cloudUrl = env[ReticleEnv.CLOUD_URL];
  if (cloudKey === undefined || 0 === cloudKey.length) return undefined;
  if (cloudUrl === undefined || 0 === cloudUrl.length) return undefined;
  return withModel({ apiKey: cloudKey, baseUrl: cloudUrl });
}

/** A message as it goes out. `unknown` values are the model's own arguments, echoed back. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toWireTool(tool: HarnessTool): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function truncate(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated: ${String(text.length - MAX_RESULT_CHARS)} more characters]`;
}

/**
 * The history, in Chat Completions' shape.
 *
 * The one structural difference from the Messages API, and it matters: a tool result is its OWN
 * message carrying `tool_call_id`, where Anthropic puts every result for a turn into one user
 * message. So a turn with three parallel calls becomes one assistant message and three tool
 * messages. That is the format's requirement rather than a choice — an unanswered `tool_call_id`
 * is rejected outright, so every outcome must be emitted, including the failures.
 */
function toWireMessages(history: readonly HistoryEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of history) {
    if ('user' === entry.role) {
      messages.push({ role: 'user', content: entry.text });
      continue;
    }
    if ('assistant' === entry.role) {
      messages.push({
        role: 'assistant',
        content: 0 === entry.text.length ? null : entry.text,
        ...(0 === entry.calls.length
          ? {}
          : {
              tool_calls: entry.calls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            }),
      });
      continue;
    }
    for (const outcome of entry.outcomes) {
      messages.push({
        role: 'tool',
        tool_call_id: outcome.id,
        content: truncate(JSON.stringify(outcome.result)),
      });
    }
  }
  return messages;
}

/** Arguments arrive as a JSON STRING here, not an object — a malformed one is empty, never a throw. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return 'object' === typeof parsed && null !== parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Build a driver backed by Chat Completions. */
export function openAiDriver(options: OpenAiDriverOptions): ModelDriver {
  const model = options.model ?? DEFAULT_OPENAI_MODEL;
  const baseUrl = options.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  // The platform does not expose `/v1/chat/completions`; it exposes its own path and forwards. A
  // base URL that is not OpenAI's is the platform's, which is the only other thing this talks to.
  const path = DEFAULT_OPENAI_BASE_URL === baseUrl ? OPENAI_PATH : PLATFORM_PATH;

  return {
    async turn(input): Promise<ModelTurn> {
      const response = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_completion_tokens: MAX_TOKENS,
          tools: input.tools.map(toWireTool),
          messages: [{ role: 'system', content: input.system }, ...toWireMessages(input.history)],
        }),
      });

      const body = await response.text();
      // Thrown, not returned: a model that will not answer is a BROKEN drive, and a broken drive is
      // never reported as clean. Swallowing it would be a verdict about an app nobody drove.
      if (!response.ok)
        throw new Error(`the model refused the request (HTTP ${String(response.status)}): ${body}`);

      const parsed = ChatResponse.parse(JSON.parse(body) as unknown);
      const message = parsed.choices[0]?.message;
      const calls: ToolRequest[] = (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        args: parseArgs(call.function.arguments),
      }));

      const cached = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0;
      return {
        text: message?.content ?? '',
        calls,
        usage: {
          // `prompt_tokens` INCLUDES the cached ones here, unlike the Messages API where the two are
          // disjoint. Subtracting keeps `input` meaning the same thing in both drivers: what was
          // processed at full price. A cost comparison that summed them would charge the arm that
          // cached well for the tokens it did not pay full price for.
          input: Math.max(parsed.usage.prompt_tokens - cached, 0),
          output: parsed.usage.completion_tokens,
          cacheRead: cached,
          cacheWrite: 0,
        },
      };
    },
  };
}
