import { COMPUTER_USE_RUNTIME, ReticleTool } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import {
  CapabilityRealm,
  REALMS_FIELD,
  REALMS_RULE,
  capabilitiesOf,
  realmsOf,
  samePage,
} from './session-realms.js';
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

// A plan of many steps routes each one to a session. It needs, for every session, what it is and
// what it acts on: the list said that only as a rule in words, and only when both kinds were up.
describe('capabilitiesOf', () => {
  it('says for each session its realm and what it acts on, with one kind connected too', () => {
    const sheet = { sessionId: 'tab-2', url: 'https://docs.google.com/spreadsheets/d/1/edit' };
    const slack = {
      sessionId: 'cu-Slack-9',
      url: 'app://Google%20Chrome/',
      runtime: COMPUTER_USE_RUNTIME,
    };
    expect(capabilitiesOf([sheet, slack], 'darwin')).toEqual([
      { sessionId: 'tab-2', realm: CapabilityRealm.BROWSER, url: sheet.url },
      {
        sessionId: 'cu-Slack-9',
        realm: CapabilityRealm.DESKTOP,
        app: 'Google Chrome',
        platform: 'darwin',
      },
    ]);
    expect(capabilitiesOf([desktop], 'win32')[0]).toMatchObject({
      app: 'Finder',
      platform: 'win32',
    });
  });
});

describe('samePage', () => {
  const feed = { sessionId: 'tab-1', title: 'Feed reader' };
  const windows = new Map([['cu-Chrome-7', ['Feed reader - Google Chrome', 'Downloads']]]);

  it('names the window of a desktop session that shows the page of an SDK session', () => {
    expect(samePage([feed], windows)).toEqual([
      { desktop: 'cu-Chrome-7', insideTheApp: 'tab-1', window: 'Feed reader - Google Chrome' },
    ]);
  });

  // A title of a few letters is in many window names, and a wrong pair sends work to the wrong page.
  it('makes no pair from a title that is short or absent', () => {
    expect(
      samePage([{ sessionId: 'tab-2', title: 'Fee' }, { sessionId: 'tab-3' }], windows),
    ).toEqual([]);
  });
});

describe('the session list', () => {
  it('asks a desktop session for its windows, and names the page that is in one of them', async () => {
    const tool = TOOLS.find((t) => ReticleTool.SESSIONS === t.name);
    const asked: string[] = [];
    const deps = {
      sessions: {
        list: () => [{ ...page, title: 'Feed reader' }, desktop],
        noSessionHint: () => undefined,
        noSessionNextAction: () => undefined,
        resolve: (id: string) => ({
          command: (name: string) => {
            asked.push(`${id}:${name}`);
            return Promise.resolve({
              ok: true,
              result: { elements: [{ role: 'window', name: 'Feed reader — Safari' }] },
            });
          },
        }),
      },
    } as unknown as ToolDeps;
    const answer = (await tool?.handler(deps, {})) as Record<string, { samePage?: unknown }>;
    expect(asked).toEqual(['cu-Finder-7:query']);
    expect(answer[REALMS_FIELD]?.samePage).toEqual([
      { desktop: 'cu-Finder-7', insideTheApp: 'tab-1', window: 'Feed reader — Safari' },
    ]);
  });

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
