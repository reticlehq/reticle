/**
 * Codex's web search is a hosted tool: no hook ever sees it. Codex writes it to its own session
 * transcript, so the next Codex hook imports it from there into the same `agent-<session>.jsonl`.
 *
 * The lines below are SYNTHETIC, in the two shapes read from real transcripts on this machine
 * (2026-10-19): Codex 0.160.0's `item_completed` with an `Extension` item of kind `web.search`
 * (query, action, results, start and end in ms), and older builds' `response_item`
 * `web_search_call` (action only, time from the line's timestamp).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import { captureToolCall } from './tool-hook.js';
import { codexTranscriptPath } from './codex-transcript.js';

const SESSION = '01a1516f-27f2-7042-8152-eecfb3cb44c6';

const newSearch = {
  timestamp: '2026-10-19T05:24:10.000Z',
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: SESSION,
    item: {
      type: 'Extension',
      kind: 'web.search',
      id: 'ws_1',
      query: 'vitest toBeCloseTo token=sk-live-abcdefghijklmnop1234',
      action: { type: 'search', query: 'vitest toBeCloseTo', queries: null },
      results: [{ type: 'text_result', title: 'Expect', url: 'https://vitest.dev/api/expect' }],
    },
    started_at_ms: 1_000,
    completed_at_ms: 2_500,
  },
};
const oldOpen = {
  timestamp: '2026-06-20T07:15:26.000Z',
  type: 'response_item',
  payload: {
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'open_page', url: 'https://example.org/a' },
  },
};
const unrelated = { timestamp: '2026-10-19T05:24:00.000Z', type: 'event_msg', payload: {} };

function setup(): { dir: string; transcript: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-codex-')));
  writeFileSync(join(dir, '.reticle.json'), JSON.stringify({ projectId: 'shop-1' }));
  const transcript = join(dir, 'rollout.jsonl');
  writeFileSync(
    transcript,
    [unrelated, newSearch, oldOpen, 'not json'].map((l) => JSON.stringify(l)).join('\n'),
  );
  return { dir, transcript };
}

const stop = (dir: string, transcript: string | null) =>
  captureToolCall(
    'codex',
    JSON.stringify({
      session_id: SESSION,
      transcript_path: transcript,
      cwd: dir,
      hook_event_name: 'Stop',
      model: 'gpt-5.5',
      last_assistant_message: 'done',
    }),
    { cwd: '/nowhere', env: {}, now: () => 10_000 },
  );

const lines = (dir: string): Record<string, unknown>[] =>
  readFileSync(
    join(dir, ReticleDir.ROOT, ReticleDir.EPISODES_SUBDIR, `agent-${SESSION}.jsonl`),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("Codex's web search, from its own transcript", () => {
  it('lands as agent_tool records in the same session file, once', () => {
    const { dir, transcript } = setup();
    stop(dir, transcript);
    const searches = lines(dir).filter((r) => 'web_search' === r['tool']);
    expect(searches).toHaveLength(2);
    expect(searches[0]).toMatchObject({
      kind: 'agent_tool',
      agent: 'codex',
      agentSession: SESSION,
      source: 'codex-transcript',
      toolUseId: 'ws_1',
      args: { type: 'search', query: 'vitest toBeCloseTo' },
      ok: true,
      startedAt: 1_000,
      endedAt: 2_500,
      durationMs: 1_500,
    });
    const result = searches[0]?.['result'] as Record<string, unknown>;
    // The same redaction as every hook record: a URL keeps its scheme only.
    expect(result['head']).toContain('"title":"Expect"');
    expect(result['chars']).toBeGreaterThan(0);
    expect(JSON.stringify(searches[0])).not.toContain('sk-live-abcdefghijklmnop1234');
    expect(searches[1]).toMatchObject({
      args: { type: 'open_page', url: 'https://[redacted]' },
      endedAt: Date.parse(oldOpen.timestamp),
    });
    expect(searches[1]?.['result']).toBeUndefined();

    // The next hook fire imports nothing twice; a search added since is imported.
    stop(dir, transcript);
    writeFileSync(
      transcript,
      `${readFileSync(transcript, 'utf8')}\n${JSON.stringify({
        ...newSearch,
        payload: { ...newSearch.payload, item: { ...newSearch.payload.item, id: 'ws_2' } },
      })}`,
    );
    stop(dir, transcript);
    const after = lines(dir).filter((r) => 'web_search' === r['tool']);
    expect(after.map((r) => r['toolUseId'])).toEqual([
      'ws_1',
      expect.stringContaining('L3') as unknown,
      'ws_2',
    ]);
  });

  it('finds the transcript by session id when the payload names none', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'codex-home-')));
    const day = join(home, 'sessions', '2026', '10', '19');
    mkdirSync(day, { recursive: true });
    const file = join(day, `rollout-2026-10-19T05-23-25-${SESSION}.jsonl`);
    writeFileSync(file, '');
    expect(codexTranscriptPath({ session_id: SESSION }, home)).toBe(file);
    expect(codexTranscriptPath({ session_id: 'other' }, home)).toBeUndefined();
  });
});
