/**
 * Re-drive (persona 02): `connect` gave the app `nina-app-ef9029ee` in `.reticle.json` and created
 * the platform project `nina-app` — one project, two ids. The rule: a project `connect` creates for a
 * folder `init` already named asks the platform for the folder's own id, and a project already
 * holding that id is the one linked. An older platform that ignores the field still answers with the
 * id it chose, which is what is linked, so nothing that exists changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { method: string; url: string; body?: unknown }[] = [];
let projects: { projectId: string; name: string }[] = [];
vi.mock('./cloud-kit.js', async (load) => ({
  ...(await load<typeof import('./cloud-kit.js')>()),
  hint: () => undefined,
  api: (method: string, url: string, _token: string, body?: Record<string, unknown>) => {
    calls.push({ method, url, ...(body === undefined ? {} : { body }) });
    if ('GET' === method) return Promise.resolve({ projects });
    const wanted = body?.['projectId'];
    return Promise.resolve({
      projectId: 'string' === typeof wanted ? wanted : 'nina-app',
      name: body?.['name'],
    });
  },
}));
const { resolveProjectId } = await import('./project-name.js');

beforeEach(() => {
  calls.length = 0;
  projects = [];
});

describe('one id for a project connect creates', () => {
  it("asks the platform for the folder's own id, beside the name people look for", async () => {
    const id = await resolveProjectId(
      'https://p.test',
      't',
      'nina-app',
      undefined,
      undefined,
      'nina-app-ef9029ee',
    );
    expect(calls.find((c) => 'POST' === c.method)?.body).toMatchObject({
      name: 'nina-app',
      projectId: 'nina-app-ef9029ee',
    });
    expect(id).toBe('nina-app-ef9029ee');
  });

  it('links the project that already holds the folder’s id', async () => {
    projects = [{ projectId: 'nina-app-ef9029ee', name: 'Nina' }];
    const id = await resolveProjectId(
      'https://p.test',
      't',
      'nina-app',
      undefined,
      undefined,
      'nina-app-ef9029ee',
    );
    expect(id).toBe('nina-app-ef9029ee');
    expect(calls.some((c) => 'POST' === c.method)).toBe(false);
  });
});
