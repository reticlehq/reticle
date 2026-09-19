import { describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import {
  DEFAULT_HARNESS_MODEL,
  harnessDriver,
  harnessOptionsFromEnv,
  type HarnessFetch,
} from './driver.js';
import type { HarnessTool, HistoryEntry } from './harness.js';

const TOOL: HarnessTool = {
  name: 'reticle_snapshot',
  description: 'look at the page',
  inputSchema: { type: 'object', properties: {} },
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function recording(reply: unknown, status = 200): { sent: Sent[]; fetch: HarnessFetch } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: (url, init) => {
      sent.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(reply)),
      });
    },
  };
}

const ANSWER = {
  content: [
    { type: 'text', text: 'looking' },
    { type: 'tool_use', id: 'call_1', name: 'reticle_snapshot', input: { mode: 'interactive' } },
  ],
  usage: {
    input_tokens: 12,
    output_tokens: 4,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 30,
  },
};

const HISTORY: HistoryEntry[] = [{ role: 'user', text: 'begin' }];

function blocksOf(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return body[key] as Record<string, unknown>[];
}

describe('the harness driver', () => {
  it('reads the model turn back out of the wire, calls and usage together', async () => {
    const { fetch } = recording(ANSWER);

    const turn = await harnessDriver({ apiKey: 'k', fetch }).turn({
      system: 'drive it',
      tools: [TOOL],
      history: HISTORY,
    });

    expect(turn.text).toBe('looking');
    expect(turn.calls).toEqual([
      { id: 'call_1', name: 'reticle_snapshot', args: { mode: 'interactive' } },
    ]);
    expect(turn.usage).toEqual({ input: 12, output: 4, cacheRead: 900, cacheWrite: 30 });
  });

  it('caches the standing prefix, because it is byte-identical on every turn of a drive', async () => {
    const { sent, fetch } = recording(ANSWER);

    await harnessDriver({ apiKey: 'k', fetch }).turn({
      system: 'drive it',
      tools: [TOOL],
      history: HISTORY,
    });

    expect(blocksOf(sent[0]?.body ?? {}, 'system')[0]?.['cache_control']).toEqual({
      type: 'ephemeral',
    });
  });

  it('caches the conversation too, so a long drive does not re-pay for its own history', async () => {
    const { sent, fetch } = recording(ANSWER);
    const history: HistoryEntry[] = [
      { role: 'user', text: 'begin' },
      {
        role: 'assistant',
        text: 'looking',
        calls: [{ id: 'c1', name: 'reticle_snapshot', args: {} }],
      },
      {
        role: 'tool',
        outcomes: [
          { id: 'c1', name: 'reticle_snapshot', args: {}, result: { nodes: 3 }, isError: false },
        ],
      },
    ];

    await harnessDriver({ apiKey: 'k', fetch }).turn({ system: 's', tools: [TOOL], history });

    const messages = blocksOf(sent[0]?.body ?? {}, 'messages');
    const last = messages[messages.length - 1];
    const content = last?.['content'] as Record<string, unknown>[];
    expect(content[content.length - 1]?.['cache_control']).toEqual({ type: 'ephemeral' });
    // Only the last one. A second breakpoint buys nothing and there are four per request.
    expect(
      messages.slice(0, -1).flatMap((m) => m['content'] as Record<string, unknown>[]),
    ).toSatisfy((blocks: Record<string, unknown>[]) =>
      blocks.every((block) => block['cache_control'] === undefined),
    );
  });

  it('sends every outcome of one turn in a single message, so parallel calls stay worth making', async () => {
    const { sent, fetch } = recording(ANSWER);
    const history: HistoryEntry[] = [
      { role: 'user', text: 'begin' },
      {
        role: 'tool',
        outcomes: [
          { id: 'a', name: 't', args: {}, result: 1, isError: false },
          { id: 'b', name: 't', args: {}, result: 2, isError: true },
        ],
      },
    ];

    await harnessDriver({ apiKey: 'k', fetch }).turn({ system: 's', tools: [TOOL], history });

    const messages = blocksOf(sent[0]?.body ?? {}, 'messages');
    expect(messages).toHaveLength(2);
    expect((messages[1]?.['content'] as unknown[]).length).toBe(2);
  });

  it('announces a truncated result instead of quietly handing over half a reading', async () => {
    const { sent, fetch } = recording(ANSWER);
    const history: HistoryEntry[] = [
      {
        role: 'tool',
        outcomes: [
          { id: 'a', name: 't', args: {}, result: { tree: 'x'.repeat(20_000) }, isError: false },
        ],
      },
    ];

    await harnessDriver({ apiKey: 'k', fetch }).turn({ system: 's', tools: [TOOL], history });

    const block = (
      blocksOf(sent[0]?.body ?? {}, 'messages')[0]?.['content'] as Record<string, unknown>[]
    )[0];
    expect(String(block?.['content'])).toContain('truncated');
  });

  it('throws on a refused request, because a drive nobody made is not a clean one', async () => {
    const { fetch } = recording({ error: 'overloaded' }, 529);

    await expect(
      harnessDriver({ apiKey: 'k', fetch }).turn({ system: 's', tools: [TOOL], history: HISTORY }),
    ).rejects.toThrow('529');
  });

  it('is unavailable without a key, and configured by the standard one', () => {
    expect(harnessOptionsFromEnv({})).toBeUndefined();
    expect(harnessOptionsFromEnv({ [ReticleEnv.HARNESS_KEY]: '' })).toBeUndefined();
    expect(harnessOptionsFromEnv({ [ReticleEnv.HARNESS_KEY]: 'sk-x' })).toEqual({ apiKey: 'sk-x' });
    expect(
      harnessOptionsFromEnv({
        [ReticleEnv.HARNESS_KEY]: 'sk-x',
        [ReticleEnv.HARNESS_MODEL]: 'claude-haiku-4-5-20251001',
      })?.model,
    ).toBe('claude-haiku-4-5-20251001');
  });

  it('drives a small model by default, so the engine is what finds the defects', () => {
    expect(DEFAULT_HARNESS_MODEL).toBe('claude-sonnet-5');
  });
});

/**
 * One key, both drivers.
 *
 * The platform answers the Messages API at its own `/v1/messages` and forwards with its provider
 * key, so somebody who has run `reticle link` can drive with a frontier model having never held an
 * Anthropic key. The alternative on offer was telling them to set `ANTHROPIC_API_KEY` to a value
 * beginning `rk_live_`, which works and reads like a mistake.
 */
describe('where the anthropic driver gets its key', () => {
  const CLOUD = { RETICLE_API_KEY: 'rk_live_x', RETICLE_CLOUD_URL: 'https://app.reticle.sh' };

  it('is unavailable with nothing configured', () => {
    expect(harnessOptionsFromEnv({})).toBeUndefined();
  });

  it('uses a real Anthropic key against Anthropic', () => {
    expect(harnessOptionsFromEnv({ ANTHROPIC_API_KEY: 'sk-ant' })).toEqual({ apiKey: 'sk-ant' });
  });

  it('falls back to the platform key against the platform', () => {
    expect(harnessOptionsFromEnv(CLOUD)).toEqual({
      apiKey: 'rk_live_x',
      baseUrl: 'https://app.reticle.sh',
    });
  });

  /** A platform key with no host to send it to is not a usable driver; Reticle ships no key. */
  it('is unavailable with a platform key and no host', () => {
    expect(harnessOptionsFromEnv({ RETICLE_API_KEY: 'rk_live_x' })).toBeUndefined();
  });

  it('prefers an explicit Anthropic key, because exporting one is a decision', () => {
    expect(harnessOptionsFromEnv({ ...CLOUD, ANTHROPIC_API_KEY: 'sk-ant' })?.apiKey).toBe('sk-ant');
  });

  it('lets an explicit base URL override the platform, for a proxy or a gateway', () => {
    const options = harnessOptionsFromEnv({
      ...CLOUD,
      RETICLE_HARNESS_BASE_URL: 'http://localhost:9999',
    });
    expect(options?.baseUrl).toBe('http://localhost:9999');
  });
});
