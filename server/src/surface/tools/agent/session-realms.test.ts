import { COMPUTER_USE_RUNTIME, ReticleTool } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { REALMS_FIELD, REALMS_RULE, realmsOf } from './session-realms.js';
import type { ToolDeps } from '../tool-kit.js';
import { TOOLS } from '../tools.js';

const page = { sessionId: 'tab-1', url: 'http://localhost:3000/' };
const desktop = { sessionId: 'cu-Finder-7', url: 'app://Finder/', runtime: COMPUTER_USE_RUNTIME };

describe('realmsOf', () => {
  it('says nothing when only one kind of session is connected', () => {
    expect(realmsOf([page])).toBeUndefined();
    expect(realmsOf([desktop])).toBeUndefined();
    expect(realmsOf([])).toBeUndefined();
  });

  it('names each kind and gives the rule when a page and a desktop application are both there', () => {
    expect(realmsOf([page, desktop])).toEqual({
      desktop: ['cu-Finder-7'],
      insideTheApp: ['tab-1'],
      rule: REALMS_RULE,
    });
  });
});

describe('the session list', () => {
  it('carries the rule beside the sessions', async () => {
    const tool = TOOLS.find((t) => ReticleTool.SESSIONS === t.name);
    const deps = {
      sessions: {
        list: () => [page, desktop],
        noSessionHint: () => undefined,
        noSessionNextAction: () => undefined,
      },
    } as unknown as ToolDeps;
    const answer = (await tool?.handler(deps, {})) as Record<string, unknown>;
    expect(answer[REALMS_FIELD]).toMatchObject({ desktop: ['cu-Finder-7'] });
  });
});
