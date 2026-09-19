import { describe, expect, it } from 'vitest';
import { openAiDriver, openAiOptionsFromEnv } from './openai-driver.js';
import type { HarnessFetch } from './driver.js';
import type { HistoryEntry, ToolOutcome } from './harness.js';

/**
 * Chat Completions differs from the Messages API in exactly one way that can break a drive: a tool
 * result is its own message carrying `tool_call_id`, and an unanswered id is rejected outright. So
 * most of these are about the translation, not about the model.
 */

interface SentBody {
  model: string;
  messages: {
    role: string;
    content?: string | null;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }[];
  tools: { type: string; function: { name: string } }[];
}

function fake(body: unknown, ok = true, status = 200) {
  const seen: { urls: string[]; bodies: SentBody[] } = { urls: [], bodies: [] };
  const doFetch: HarnessFetch = (url, init) => {
    seen.urls.push(url);
    seen.bodies.push(JSON.parse(init.body) as SentBody);
    return Promise.resolve({ ok, status, text: () => Promise.resolve(JSON.stringify(body)) });
  };
  return { doFetch, seen };
}

const answered = (content: string | null, toolCalls: unknown[] = [], usage = {}) => ({
  choices: [{ message: { content, tool_calls: toolCalls } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, ...usage },
});

const outcome = (id: string, result: unknown): ToolOutcome => ({
  id,
  name: 'reticle_snapshot',
  args: {},
  result,
  isError: false,
});

describe('driving over Chat Completions', () => {
  it('sends the system prompt as a system message and the tools as functions', async () => {
    const { doFetch, seen } = fake(answered('ok'));
    await openAiDriver({ apiKey: 'sk', fetch: doFetch }).turn({
      system: 'drive it',
      tools: [{ name: 'reticle_snapshot', description: 'look', inputSchema: { type: 'object' } }],
      history: [{ role: 'user', text: 'begin' }],
    });
    const body = seen.bodies[0];
    expect(body?.messages[0]).toEqual({ role: 'system', content: 'drive it' });
    expect(body?.messages[1]).toEqual({ role: 'user', content: 'begin' });
    expect(body?.tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'reticle_snapshot' },
    });
  });

  it('reads the tool calls the model asked for, parsing their JSON string arguments', async () => {
    const { doFetch } = fake(
      answered(null, [
        {
          id: 'call_1',
          function: { name: 'reticle_act', arguments: '{"ref":"e5","action":"click"}' },
        },
      ]),
    );
    const result = await openAiDriver({ apiKey: 'sk', fetch: doFetch }).turn({
      system: 's',
      tools: [],
      history: [],
    });
    expect(result.calls).toEqual([
      { id: 'call_1', name: 'reticle_act', args: { ref: 'e5', action: 'click' } },
    ]);
  });

  /** A malformed argument string is the model's mistake; it must not take the whole drive down. */
  it('survives arguments that are not valid JSON', async () => {
    const { doFetch } = fake(
      answered(null, [{ id: 'c', function: { name: 'reticle_act', arguments: '{oops' } }]),
    );
    const result = await openAiDriver({ apiKey: 'sk', fetch: doFetch }).turn({
      system: 's',
      tools: [],
      history: [],
    });
    expect(result.calls[0]?.args).toEqual({});
  });

  /**
   * The structural difference. Anthropic takes every result for a turn in ONE user message; Chat
   * Completions needs one `tool` message per call, each naming the id it answers. An id left
   * unanswered is rejected by the API outright, so all of them have to be emitted.
   */
  it('answers every tool call with its own message, naming the id', async () => {
    const { doFetch, seen } = fake(answered('ok'));
    const history: HistoryEntry[] = [
      { role: 'user', text: 'go' },
      {
        role: 'assistant',
        text: 'looking',
        calls: [
          { id: 'call_1', name: 'reticle_snapshot', args: {} },
          { id: 'call_2', name: 'reticle_observe', args: {} },
        ],
      },
      {
        role: 'tool',
        outcomes: [outcome('call_1', { tree: 'a' }), outcome('call_2', { events: [] })],
      },
    ];
    await openAiDriver({ apiKey: 'sk', fetch: doFetch }).turn({ system: 's', tools: [], history });

    const messages = seen.bodies[0]?.messages ?? [];
    const toolMessages = messages.filter((m) => 'tool' === m.role);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['call_1', 'call_2']);
    const assistant = messages.find((m) => 'assistant' === m.role);
    expect(assistant?.tool_calls).toHaveLength(2);
  });

  it('refuses to turn a model that will not answer into a clean drive', async () => {
    const { doFetch } = fake({ error: 'nope' }, false, 500);
    await expect(
      openAiDriver({ apiKey: 'sk', fetch: doFetch }).turn({ system: 's', tools: [], history: [] }),
    ).rejects.toThrow('HTTP 500');
  });

  /**
   * `prompt_tokens` INCLUDES cached tokens here; on the Messages API the two are disjoint. Reporting
   * them raw would charge the arm that cached well for tokens it did not pay full price for, which
   * is the one way this driver could quietly lose a cost comparison it actually won.
   */
  it('reports cached tokens separately from what was processed at full price', async () => {
    const { doFetch } = fake(
      answered('ok', [], { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } }),
    );
    const result = await openAiDriver({ apiKey: 'sk', fetch: doFetch }).turn({
      system: 's',
      tools: [],
      history: [],
    });
    expect(result.usage).toEqual({ input: 200, output: 20, cacheRead: 800, cacheWrite: 0 });
  });
});

describe('where the openai driver gets its key', () => {
  const CLOUD = { RETICLE_API_KEY: 'rk_live_x', RETICLE_CLOUD_URL: 'https://app.reticle.sh' };

  it('is unavailable with nothing configured', () => {
    expect(openAiOptionsFromEnv({})).toBeUndefined();
  });

  it('uses a real OpenAI key against OpenAI', () => {
    expect(openAiOptionsFromEnv({ OPENAI_API_KEY: 'sk-proj' })).toEqual({ apiKey: 'sk-proj' });
  });

  it('falls back to the platform key against the platform', () => {
    expect(openAiOptionsFromEnv(CLOUD)).toEqual({
      apiKey: 'rk_live_x',
      baseUrl: 'https://app.reticle.sh',
    });
  });

  /** The platform does not serve `/v1/chat/completions`; it serves its own path and forwards. */
  it('posts to the platform path when driving through the platform', async () => {
    const { doFetch, seen } = fake(answered('ok'));
    await openAiDriver({ apiKey: 'rk', baseUrl: 'https://app.reticle.sh', fetch: doFetch }).turn({
      system: 's',
      tools: [],
      history: [],
    });
    expect(seen.urls[0]).toBe('https://app.reticle.sh/v1/model/openai');
  });

  it('posts to chat completions when driving OpenAI directly', async () => {
    const { doFetch, seen } = fake(answered('ok'));
    await openAiDriver({ apiKey: 'sk', fetch: doFetch }).turn({
      system: 's',
      tools: [],
      history: [],
    });
    expect(seen.urls[0]).toBe('https://api.openai.com/v1/chat/completions');
  });
});
