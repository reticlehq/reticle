import { beforeEach, describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { ReteachLine, reteachFor, resetReteach } from './reteach.js';

beforeEach(() => resetReteach());

describe('re-teach the rule a call broke', () => {
  it('act_and_wait with no until that came back no-fault', () => {
    expect(
      reteachFor(
        'a',
        ReticleTool.ACT_AND_WAIT,
        { ref: 'e1', action: 'click' },
        { verified: 'no-fault' },
      ),
    ).toEqual([ReteachLine.NO_UNTIL]);
  });

  it('an alias and a case-only miss', () => {
    expect(
      reteachFor(
        'a',
        ReticleTool.ASSERT,
        {},
        {
          verified: 'no',
          normalized: ['route.pathContains → contains'],
          caseOnlyMiss: true,
        },
      ),
    ).toEqual([ReteachLine.ALIAS, ReteachLine.CASE]);
  });

  it('a third session listing in one session points back at what it already has', () => {
    const list = { sessions: [{ sessionId: 's1' }] };
    expect(reteachFor('a', ReticleTool.SESSION, {}, list)).toEqual([]);
    expect(reteachFor('a', ReticleTool.SESSION, {}, list)).toEqual([]);
    expect(reteachFor('a', ReticleTool.SESSION, {}, list)).toEqual([
      ReteachLine.RELIST,
      ReteachLine.COMPACTED,
    ]);
  });

  it('says nothing when the agent behaves', () => {
    expect(
      reteachFor(
        'a',
        ReticleTool.ACT_AND_WAIT,
        { until: { kind: 'signal', name: 'x' } },
        { verified: 'yes' },
      ),
    ).toEqual([]);
  });
});
