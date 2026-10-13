import { describe, expect, it } from 'vitest';
import { ContradictionKind, isAdvisory } from '@reticlehq/core';
import { screenRequestMismatches } from './screen-request.js';

const post = (body: unknown) => ({
  method: 'POST',
  url: 'http://localhost:8787/api/keys?x=1',
  body: JSON.stringify(body),
});

describe('screen/request mismatch', () => {
  it('reports the API-keys case: the screen chose the default, the request named a project', () => {
    const found = screenRequestMismatches(
      [post({ name: 'ci', projectId: 'bench-app' })],
      [{ field: 'projectId', value: '', label: 'Workspace default', ref: 'e12' }],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.SCREEN_REQUEST_MISMATCH);
    expect(found[0]?.claim).toContain('"Workspace default" (value "")');
    expect(found[0]?.counter).toBe('POST /api/keys sent projectId="bench-app"');
  });

  it('is advisory: it can never decide a verdict', () => {
    expect(isAdvisory(ContradictionKind.SCREEN_REQUEST_MISMATCH)).toBe(true);
  });

  it('stays silent when they agree, when the field was not sent, and for unmatched or nested fields', () => {
    expect(
      screenRequestMismatches(
        [post({ projectId: 'bench-app', meta: { plan: 'pro' } })],
        [
          { field: 'projectId', value: 'bench-app', label: 'Bench App' },
          { field: 'plan', value: 'free' },
          { field: 'email', value: 'a@b.c' },
        ],
      ),
    ).toEqual([]);
  });

  it('a body that is not a JSON object compares nothing', () => {
    expect(
      screenRequestMismatches(
        [{ method: 'POST', url: '/x', body: 'projectId=bench-app' }],
        [{ field: 'projectId', value: '' }],
      ),
    ).toEqual([]);
  });
});
