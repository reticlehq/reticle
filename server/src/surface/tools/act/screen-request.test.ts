import { afterEach, describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';
import {
  SCREEN_REQUEST_CHECK_ENV,
  screenRequestFindings,
  withAdvisories,
} from './screen-request.js';

const write = {
  t: 1,
  type: EventType.NET_REQUEST,
  data: { method: 'POST', url: 'http://x/api/keys', requestBody: '{"projectId":"bench-app"}' },
} as unknown as ReticleEvent;

function page(asked: string[]): Session {
  return {
    command: (_name: string, args: { query: { role: string } }) => {
      asked.push(args.query.role);
      const elements =
        'combobox' === args.query.role
          ? [
              {
                ref: 'e3',
                role: 'combobox',
                name: 'Project',
                value: 'workspace',
                attrs: { name: 'projectId' },
              },
            ]
          : [];
      return Promise.resolve({
        ok: true,
        result: { matched: elements.length > 0, count: elements.length, elements },
      });
    },
  } as unknown as Session;
}

afterEach(() => {
  delete process.env[SCREEN_REQUEST_CHECK_ENV];
});

describe('the screen/request check is opt-in and advisory', () => {
  it('off by default: costs nothing, asks the page nothing', async () => {
    const asked: string[] = [];
    expect(await screenRequestFindings(page(asked), [write])).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('on: reports a control whose value differs from what the request carried', async () => {
    process.env[SCREEN_REQUEST_CHECK_ENV] = '1';
    const found = await screenRequestFindings(page([]), [write]);
    expect(found).toHaveLength(1);
    expect(found[0]?.counter).toBe('POST /api/keys sent projectId="bench-app"');
  });

  it('appends after the verdict’s own findings and omits the field when both are empty', () => {
    expect(withAdvisories([], [])).toEqual({});
    const own = { kind: 'a', claim: 'c', counter: 'k', detail: 'd' };
    const adv = { kind: 'screen-request-mismatch', claim: 'c', counter: 'k', detail: 'd' };
    expect(withAdvisories([own], [adv])).toEqual({ contradictions: [own, adv] });
  });
});
