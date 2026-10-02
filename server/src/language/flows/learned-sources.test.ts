/**
 * A flow recorded before its app was stamped can learn which files it covers by replaying.
 *
 * `reticle_verify change` re-runs a flow whose steps name no source file, and since this release it
 * answers UNKNOWN for a green that rests only on such flows: the honest answer, and a useless one for
 * a suite recorded before stamping reached the app. Each of those flows resolves its anchors to real
 * elements every time it replays, and those elements carry `data-reticle-source` now, so one clean
 * replay is enough to know.
 */
import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  QueryBy,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { recordingSources, withLearnedSources, parseCompactSource } from './learned-sources.js';
import type { FlowReplaySession } from './flow-replay-types.js';

const found = (source?: string): CommandResult => ({
  kind: 'command_result',
  id: 'q',
  ok: true,
  result: { elements: [{ ref: 'e1', ...(source === undefined ? {} : { source }) }] },
});

function session(answer: CommandResult): FlowReplaySession {
  return {
    command: () => Promise.resolve(answer),
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

const flow = (source?: FlowFile['steps'][number]['source']): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'checkout',
  createdAt: 0,
  steps: [
    {
      tool: 'reticle_act',
      anchor: { kind: AnchorKind.TESTID, value: 'pay' },
      action: 'click',
      ...(source === undefined ? {} : { source }),
    },
  ],
});

describe('learning a flow step source from the element it resolved to', () => {
  it('reads a compact file:line:column source', () => {
    expect(parseCompactSource('src/Pay.tsx:12:4')).toEqual({ file: 'src/Pay.tsx', line: 12 });
    expect(parseCompactSource('src/Pay.tsx:12')).toEqual({ file: 'src/Pay.tsx', line: 12 });
    expect(parseCompactSource('nonsense')).toBeUndefined();
  });

  it('gives a step with no source the file its anchor resolved to', async () => {
    const rec = recordingSources(session(found('src/Pay.tsx:12:4')));
    await rec.session.command(ReticleCommand.QUERY, { by: QueryBy.TESTID, value: 'pay' });
    const learned = withLearnedSources(flow(), rec.sources);
    expect(learned?.steps[0]?.source).toEqual({ file: 'src/Pay.tsx', line: 12 });
  });

  it('never overwrites a source the recorder already stamped', async () => {
    const rec = recordingSources(session(found('src/Other.tsx:3:1')));
    await rec.session.command(ReticleCommand.QUERY, { by: QueryBy.TESTID, value: 'pay' });
    expect(
      withLearnedSources(flow({ file: 'src/Pay.tsx', line: 12 }), rec.sources),
    ).toBeUndefined();
  });

  it('learns nothing from an element with no stamp, or from an ambiguous match', async () => {
    const rec = recordingSources(session(found()));
    await rec.session.command(ReticleCommand.QUERY, { by: QueryBy.TESTID, value: 'pay' });
    expect(withLearnedSources(flow(), rec.sources)).toBeUndefined();

    const two: CommandResult = {
      kind: 'command_result',
      id: 'q',
      ok: true,
      result: {
        elements: [
          { ref: 'e1', source: 'src/A.tsx:1:1' },
          { ref: 'e2', source: 'src/B.tsx:1:1' },
        ],
      },
    };
    const amb = recordingSources(session(two));
    await amb.session.command(ReticleCommand.QUERY, { by: QueryBy.TESTID, value: 'pay' });
    expect(withLearnedSources(flow(), amb.sources)).toBeUndefined();
  });

  it('keeps a session with private state working through the wrapper', async () => {
    class Real {
      #answer = found('src/Pay.tsx:12:4');
      command(): Promise<CommandResult> {
        return Promise.resolve(this.#answer);
      }
      elapsed(): number {
        return this.#answer.ok ? 1 : 0;
      }
    }
    const rec = recordingSources(new Real() as unknown as FlowReplaySession);
    expect(rec.session.elapsed()).toBe(1);
    await rec.session.command(ReticleCommand.QUERY, { by: QueryBy.TESTID, value: 'pay' });
    expect(rec.sources.size).toBe(1);
  });
});
