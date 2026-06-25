/**
 * URL-param identity overrides: a pooled/headless launcher stamps session + project via namespaced
 * query params so the app SDK adopts them with no app-code changes. Pure parsing, no DOM needed.
 */

import { describe, expect, it } from 'vitest';
import { SESSION_AUTO } from '@syrin/iris-protocol';
import { IRIS_URL_PARAM, irisParamsFromSearch, resolveConnectIdentity } from './iris.js';

describe('irisParamsFromSearch', () => {
  it('extracts session and projectId from namespaced params', () => {
    const search = `?${IRIS_URL_PARAM.SESSION}=lease-7&${IRIS_URL_PARAM.PROJECT}=acme-9f3c`;
    expect(irisParamsFromSearch(search)).toEqual({ session: 'lease-7', projectId: 'acme-9f3c' });
  });

  it('returns an empty object when the params are absent', () => {
    expect(irisParamsFromSearch('?foo=bar&page=2')).toEqual({});
    expect(irisParamsFromSearch('')).toEqual({});
  });

  it('ignores empty values', () => {
    expect(irisParamsFromSearch(`?${IRIS_URL_PARAM.SESSION}=`)).toEqual({});
  });

  it('does not clash with the app’s own session param', () => {
    // A plain ?session= belongs to the app, not Iris — only the namespaced one is read.
    expect(irisParamsFromSearch('?session=app-thing')).toEqual({});
  });

  it('reads one without the other', () => {
    expect(irisParamsFromSearch(`?${IRIS_URL_PARAM.PROJECT}=just-project`)).toEqual({
      projectId: 'just-project',
    });
  });
});

describe('resolveConnectIdentity', () => {
  const search = `?${IRIS_URL_PARAM.SESSION}=lease-7&${IRIS_URL_PARAM.PROJECT}=acme`;

  it('an explicit non-auto session option wins over the URL param', () => {
    expect(resolveConnectIdentity({ session: 'my-tab' }, search).session).toBe('my-tab');
  });

  it('the auto sentinel defers to the URL param (so leases correlate)', () => {
    expect(resolveConnectIdentity({ session: SESSION_AUTO }, search).session).toBe('lease-7');
  });

  it('an absent session option uses the URL param', () => {
    expect(resolveConnectIdentity({}, search).session).toBe('lease-7');
  });

  it('no option and no param → undefined (caller generates a per-tab id)', () => {
    expect(resolveConnectIdentity({ session: SESSION_AUTO }, '').session).toBeUndefined();
  });

  it('projectId: explicit option wins, else URL param', () => {
    expect(resolveConnectIdentity({ projectId: 'mine' }, search).projectId).toBe('mine');
    expect(resolveConnectIdentity({}, search).projectId).toBe('acme');
    expect(resolveConnectIdentity({}, '').projectId).toBeUndefined();
  });
});
