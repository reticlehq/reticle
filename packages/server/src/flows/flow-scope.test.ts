import { describe, expect, it } from 'vitest';
import { AnchorKind, FLOW_FILE_VERSION, type FlowFile } from '@reticlehq/core';
import { buildFlowChips, flowInProjectScope } from './flow-scope.js';

const flow = (name: string, projectId?: string, startTestid?: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name,
  createdAt: 1,
  ...(projectId === undefined ? {} : { projectId }),
  steps: [
    {
      tool: 'reticle_act',
      anchor:
        startTestid === undefined
          ? { kind: AnchorKind.SIGNAL, name: 'x:done' }
          : { kind: AnchorKind.TESTID, value: startTestid },
    },
  ],
});

describe('flowInProjectScope', () => {
  it('shows a flow with no projectId everywhere (legacy/global back-compat)', () => {
    expect(flowInProjectScope(undefined, 'app-a')).toBe(true);
    expect(flowInProjectScope(undefined, undefined)).toBe(true);
  });

  it('shows a project-stamped flow only on its own project', () => {
    expect(flowInProjectScope('app-a', 'app-a')).toBe(true);
    expect(flowInProjectScope('app-a', 'app-b')).toBe(false);
    expect(flowInProjectScope('app-a', undefined)).toBe(false);
  });
});

describe('buildFlowChips', () => {
  it('drops other projects flows and keeps this project + global ones', () => {
    const flows = [
      flow('cloud-login', 'cloud', 'email'),
      flow('demo-add-task', 'demo', 'task-input'),
      flow('legacy-global', undefined, 'root'),
    ];
    const chips = buildFlowChips(flows, 'cloud');
    expect(chips.map((c) => c.name)).toEqual(['cloud-login', 'legacy-global']);
  });

  it('derives start from a first testid anchor and omits it for non-testid starts', () => {
    const chips = buildFlowChips(
      [flow('has-start', 'app', 'task-input'), flow('no-start', 'app')],
      'app',
    );
    expect(chips).toEqual([{ name: 'has-start', start: 'task-input' }, { name: 'no-start' }]);
  });
});
