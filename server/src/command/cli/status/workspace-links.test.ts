/**
 * Re-drive (persona 11): `reticle status` at a monorepo root said "this repo is not linked: run
 * `reticle connect`" with both apps linked, and named neither — connect there would have linked the
 * root under one app's id. At a root that is no app of its own, status names each app and its link.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { statusLines } from './status-lines.js';
import { workspaceAppLinks } from './workspace-links.js';

function monorepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'reticle-mono-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['apps/*'] }),
  );
  for (const app of ['web', 'admin']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(
      join(root, 'apps', app, 'package.json'),
      JSON.stringify({ name: `@acme/${app}`, devDependencies: { vite: '^5' } }),
    );
    writeFileSync(join(root, 'apps', app, 'vite.config.ts'), 'export default {};\n');
  }
  return root;
}

describe('status at a workspace root', () => {
  it('finds each app and the project it is linked to', async () => {
    const root = monorepo();
    const links = await workspaceAppLinks(root, (dir) =>
      Promise.resolve(dir.endsWith(join('apps', 'web')) ? 'acme-web' : null),
    );
    expect(links).toEqual([
      { app: 'apps/admin', project: null },
      { app: 'apps/web', project: 'acme-web' },
    ]);
  });

  it('names each app and its link instead of "this repo is not linked"', () => {
    const out = statusLines({
      port: 4400,
      running: false,
      signedInAs: 'Acme Mono',
      linkedProject: null,
      workspaceApps: [
        { app: 'apps/admin', project: null },
        { app: 'apps/web', project: 'acme-web' },
      ],
    }).join('\n');
    expect(out).toContain('apps/web is linked to acme-web');
    expect(out).toContain('apps/admin is not linked: run `reticle connect` in apps/admin');
    expect(out).not.toContain('this repo is not linked');
  });
});
