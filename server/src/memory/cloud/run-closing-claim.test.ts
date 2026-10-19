/**
 * A run leaves with the agent's model and what the agent said when it finished the turn.
 *
 * The platform's Runs screen shows "agent · model" and Asked / Claimed / Reticle found. The model
 * and the closing message were on this machine (the agent hooks' `agent_model` and `agent_stop`
 * records) but never on the run, so the screen had nothing to show.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptContextSchema } from '@reticlehq/core/artifacts';
import { ReticleDir } from '@reticlehq/core';
import { diskSource } from './sync-disk.js';

const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n');

function project(opts: { shareRequests?: boolean; context?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'closing-claim-'));
  writeFileSync(
    join(dir, '.reticle.json'),
    JSON.stringify({
      projectId: 'p',
      ...(opts.shareRequests === undefined ? {} : { shareRequests: opts.shareRequests }),
    }),
  );
  const root = join(dir, ReticleDir.ROOT);
  mkdirSync(join(root, ReticleDir.RUNS_SUBDIR), { recursive: true });
  mkdirSync(join(root, ReticleDir.EPISODES_SUBDIR), { recursive: true });
  // The run's own episode: its last Reticle call ended at 100.
  writeFileSync(
    join(root, ReticleDir.EPISODES_SUBDIR, 'conn-1.jsonl'),
    jsonl([
      { kind: 'start', episodeId: 'conn-1', at: 10 },
      { kind: 'call', n: 1, tool: 'reticle_act', startedAt: 60, endedAt: 100 },
    ]),
  );
  // The agent's own hook records.
  writeFileSync(
    join(root, ReticleDir.EPISODES_SUBDIR, 'agent-s.jsonl'),
    jsonl([
      { kind: 'agent_model', agent: 'claude-code', model: 'claude-x', at: 5 },
      { kind: 'agent_stop', agent: 'claude-code', message: { head: 'an earlier turn' }, at: 90 },
      {
        kind: 'agent_stop',
        agent: 'claude-code',
        message: { head: 'Promo now applies.' },
        at: 150,
      },
      { kind: 'agent_stop', agent: 'claude-code', message: { head: 'a later turn' }, at: 300 },
      { kind: 'agent_stop', agent: 'cursor', message: { head: 'another agent' }, at: 120 },
    ]),
  );
  writeFileSync(
    join(root, ReticleDir.RUNS_SUBDIR, 'r1.json'),
    JSON.stringify({
      runId: 'r1',
      createdAt: 100,
      episodeId: 'conn-1',
      agent: { id: 'claude-code', kind: 'coding-agent' },
      ...(opts.context === undefined ? {} : { context: opts.context }),
    }),
  );
  return root;
}

const sent = (root: string): Record<string, unknown> =>
  diskSource(root).runs()[0]?.payload as Record<string, unknown>;

describe('the run as it is synced', () => {
  it("carries the agent's model and the claim that closed the run's turn", () => {
    const out = sent(
      project({ context: { request: 'make promo work', statements: [], shared: true } }),
    );
    expect(out['agent']).toEqual({ id: 'claude-code', kind: 'coding-agent', model: 'claude-x' });
    expect(out['context']).toMatchObject({
      request: 'make promo work',
      closingClaim: 'Promo now applies.',
      closingClaimAt: 150,
    });
  });

  it('carries the claim when the run had no request, under the same share setting', () => {
    const out = sent(project({ shareRequests: true }));
    expect(out['context']).toMatchObject({ closingClaim: 'Promo now applies.', shared: true });
  });

  it('keeps the claim on this machine when the project does not share requests', () => {
    const out = sent(project({ shareRequests: false }));
    expect(out['context']).toBeUndefined();
    // The model is not the user's words: it still says which agent ran.
    expect((out['agent'] as Record<string, unknown>)['model']).toBe('claude-x');
  });

  it('is kept by the prompt context schema, so a rewrite of the run does not drop it', () => {
    const parsed = PromptContextSchema.parse({
      request: 'x',
      closingClaim: 'Done.',
      closingClaimAt: 150,
    });
    expect(parsed).toMatchObject({ closingClaim: 'Done.', closingClaimAt: 150 });
  });

  /*
   * Two Claude Code sessions in one project used to be told apart by nothing: the claim was the
   * first stop of ANY session of that agent after the run's last call. The run now names the agent
   * session its MCP connection announced, and only that session's records count.
   */
  describe('two sessions of the same agent, interleaved', () => {
    function twoSessions(agentSession?: string): string {
      const root = project();
      const dir = join(root, ReticleDir.EPISODES_SUBDIR);
      writeFileSync(
        join(dir, 'agent-s.jsonl'),
        jsonl([
          { kind: 'agent_model', agent: 'claude-code', model: 'model-a', at: 5 },
          { kind: 'agent_stop', agent: 'claude-code', message: { head: 'A done' }, at: 200 },
        ]),
      );
      writeFileSync(
        join(dir, 'agent-other.jsonl'),
        jsonl([
          { kind: 'agent_model', agent: 'claude-code', model: 'model-b', at: 6 },
          { kind: 'agent_stop', agent: 'claude-code', message: { head: 'B done' }, at: 150 },
        ]),
      );
      writeFileSync(
        join(root, ReticleDir.RUNS_SUBDIR, 'r1.json'),
        JSON.stringify({
          runId: 'r1',
          createdAt: 100,
          episodeId: 'conn-1',
          ...(agentSession === undefined ? {} : { agentSession }),
          agent: { id: 'claude-code', kind: 'coding-agent' },
          context: { request: 'x', statements: [], shared: true },
        }),
      );
      return root;
    }

    it("takes the claim and model from the run's own agent session only", () => {
      const out = sent(twoSessions('s'));
      expect((out['agent'] as Record<string, unknown>)['model']).toBe('model-a');
      expect(out['context']).toMatchObject({ closingClaim: 'A done', closingClaimAt: 200 });
    });

    it('guesses nothing when the run names no session and two sessions match', () => {
      const out = sent(twoSessions());
      expect((out['agent'] as Record<string, unknown>)['model']).toBeUndefined();
      expect((out['context'] as Record<string, unknown>)['closingClaim']).toBeUndefined();
    });
  });
});
