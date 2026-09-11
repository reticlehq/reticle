import { describe, expect, it } from 'vitest';
import type { DevServerEntry } from '@reticlehq/core';
import { urlOfExistingApp } from './existing-app.js';

const entry = (port: number, root: string, projectId: string): DevServerEntry => ({
  port,
  pid: port,
  root,
  url: `http://localhost:${String(port)}/`,
  sdkVersion: '2.13.0',
  startedAt: 1000,
  projectId,
});

/**
 * Setup must attach to THIS project's live server, never a sibling's. Unscoped, `init` for app A
 * started a second Vite because it did not see A's announcement — or worse, treated B's as A's.
 */
describe('urlOfExistingApp', () => {
  const web = entry(5173, '/repo/apps/web', 'web-1');
  const admin = entry(3000, '/repo/apps/admin', 'admin-2');

  it("returns this project's URL", () => {
    expect(urlOfExistingApp([web, admin], { projectId: 'web-1', root: '/repo/apps/web' })).toBe(
      'http://localhost:5173/',
    );
  });

  it("does not hand over a sibling app's server", () => {
    expect(
      urlOfExistingApp([admin], { projectId: 'web-1', root: '/repo/apps/web' }),
    ).toBeUndefined();
  });

  it('is undefined when nothing has announced, so setup still starts one', () => {
    expect(urlOfExistingApp([], { projectId: 'web-1', root: '/repo/apps/web' })).toBeUndefined();
  });
});
