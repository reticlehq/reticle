import { describe, it, expect } from 'vitest';
import { ReticleCommand } from '@reticlehq/core';
import { READ_TOOLS } from './read-tools.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDeps } from './tools.js';
import type { Session, SessionManager } from '../session/session.js';

function storageDeps(snapshot: unknown): ToolDeps {
  const session = {
    command: (name: string) =>
      Promise.resolve({
        kind: 'command_result',
        id: 'x',
        ok: true,
        result: name === ReticleCommand.STORAGE_READ ? snapshot : {},
      }),
  } as unknown as Session;
  const sessions = { resolve: () => session } as unknown as SessionManager;
  return { sessions } as unknown as ToolDeps;
}

function storageTool() {
  const t = READ_TOOLS.find((x) => x.name === ReticleTool.STORAGE);
  if (t === undefined) throw new Error('no reticle_storage tool');
  return t;
}

describe('reticle_storage', () => {
  it('returns the full snapshot when no key is given', async () => {
    const snap = { local: { cart: '3-items' }, session: {}, cookies: {} };
    expect(await storageTool().handler(storageDeps(snap), {})).toEqual(snap);
  });

  it('extracts a single key across areas with found:true', async () => {
    const snap = { local: {}, session: { view: 'overview' }, cookies: {} };
    const r = (await storageTool().handler(storageDeps(snap), { key: 'view' })) as Record<
      string,
      unknown
    >;
    expect(r['found']).toBe(true);
    expect(r['value']).toBe('overview');
  });

  it('reports found:false for a missing key', async () => {
    const snap = { local: {}, session: {}, cookies: {} };
    const r = (await storageTool().handler(storageDeps(snap), { key: 'nope' })) as Record<
      string,
      unknown
    >;
    expect(r['found']).toBe(false);
  });
});
