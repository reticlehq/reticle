import { afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_ATTR } from '@reticlehq/babel-plugin';
import { RETICLE_DEFAULT_PORT, ReticleDir, ReticleEnv } from '@reticlehq/core';
import { reticle, RETICLE_VITE_PLUGIN_NAME, RETICLE_CONNECT_MODULE } from './index.js';

// Point the token lookup at an empty temp dir so tests never pick up a real ~/.reticle/pairing-token.
const emptyTokenDir = mkdtempSync(join(tmpdir(), 'reticle-vite-token-'));
const savedTokenDir = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
process.env[ReticleEnv.PAIRING_TOKEN_DIR] = emptyTokenDir;
afterAll(() => {
  if (savedTokenDir === undefined) delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  else process.env[ReticleEnv.PAIRING_TOKEN_DIR] = savedTokenDir;
});

describe('reticle vite plugin', () => {
  it('only applies during serve (never ships to production builds)', () => {
    const plugin = reticle();
    expect(plugin.name).toBe(RETICLE_VITE_PLUGIN_NAME);
    expect(plugin.apply).toBe('serve');
    expect(plugin.enforce).toBe('pre');
  });

  it('stamps data-reticle-source on host elements in .tsx files', () => {
    const plugin = reticle();
    const result = plugin.transform?.('const x = <button>Hi</button>;', '/app/src/Foo.tsx');
    expect(result).not.toBeNull();
    expect(result?.code).toContain(SOURCE_ATTR);
  });

  it('skips non-jsx and node_modules and virtual ids', () => {
    const plugin = reticle();
    expect(plugin.transform?.('const x = 1;', '/app/src/util.ts')).toBeNull();
    expect(plugin.transform?.('const x = <a/>;', '/app/node_modules/pkg/Foo.tsx')).toBeNull();
    expect(plugin.transform?.('const x = <a/>;', '\0virtual:foo.tsx')).toBeNull();
  });

  it('disables stamping when sourceMapping is false', () => {
    const plugin = reticle({ sourceMapping: false });
    expect(plugin.transform?.('const x = <button>Hi</button>;', '/app/src/Foo.tsx')).toBeNull();
  });

  it('injects a script that references the connect module by src (not an inline import)', () => {
    // Regression: an inline injected <script> with a bare import is NOT run through Vite import
    // resolution, so it must be served as a real module via src.
    const plugin = reticle();
    const tags = plugin.transformIndexHtml?.('<html></html>');
    expect(tags).toHaveLength(1);
    const tag = tags?.[0];
    expect(tag?.tag).toBe('script');
    expect(tag?.attrs?.['type']).toBe('module');
    expect(tag?.attrs?.['src']).toBe(RETICLE_CONNECT_MODULE);
  });

  it('serves the connect module via resolveId + load with a real @reticlehq/core import', () => {
    const plugin = reticle();
    expect(plugin.resolveId?.(RETICLE_CONNECT_MODULE)).toBe(RETICLE_CONNECT_MODULE);
    expect(plugin.resolveId?.('some/other/id')).toBeNull();
    const code = plugin.load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain("from '@reticlehq/core'");
    expect(code).toContain('install()');
    expect(code).toContain('reticle.connect(');
  });

  it('does not inject or serve the module when inject is false', () => {
    const plugin = reticle({ inject: false });
    expect(plugin.transformIndexHtml?.('<html></html>')).toEqual([]);
    expect(plugin.resolveId?.(RETICLE_CONNECT_MODULE)).toBeNull();
    expect(plugin.load?.(RETICLE_CONNECT_MODULE)).toBeNull();
  });

  it('bakes a non-default port into the connect module url', () => {
    const customPort = RETICLE_DEFAULT_PORT + 1;
    const code = reticle({ port: customPort }).load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain(String(customPort));
    expect(code).toContain('ws://localhost:');
  });

  it('omits the url for the default port (SDK default applies)', () => {
    const code = reticle().load?.(RETICLE_CONNECT_MODULE);
    expect(code).not.toContain('ws://localhost:');
  });

  it('forwards session and token when provided', () => {
    const code = reticle({ session: 'my-app', token: 'secret' }).load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain('my-app');
    expect(code).toContain('secret');
  });

  it('auto-injects the daemon pairing token from the token dir when no explicit token is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-vite-hastoken-'));
    writeFileSync(join(dir, ReticleDir.PAIRING_TOKEN_FILE), 'daemon-secret-123\n');
    const prev = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
    process.env[ReticleEnv.PAIRING_TOKEN_DIR] = dir;
    try {
      const code = reticle().load?.(RETICLE_CONNECT_MODULE);
      expect(code).toContain('daemon-secret-123');
      expect(code).toContain('token');
    } finally {
      process.env[ReticleEnv.PAIRING_TOKEN_DIR] = prev;
    }
  });

  it('omits the token when the daemon has not provisioned one yet (no file)', () => {
    // Env points at the empty dir from the top of the file — no token file present.
    const code = reticle().load?.(RETICLE_CONNECT_MODULE);
    expect(code).not.toContain('"token"');
  });

  it('auto-stamps a derived projectId with zero config', () => {
    const code = reticle().load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain('projectId');
    // The id this monorepo derives for the vite-plugin package starts with a slug of its name.
    expect(code).toMatch(/projectId":"[a-z0-9-]+-[0-9a-f]{8}"/);
  });

  it('an explicit projectId option overrides the derived one', () => {
    const code = reticle({ projectId: 'my-fixed-id' }).load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain('my-fixed-id');
  });
});
