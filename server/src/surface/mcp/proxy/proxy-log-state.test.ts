import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import { proxyLog, proxyLogPath, setProxyLogPort } from './proxy-log.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('writes proxy diagnostics into the configured state directory, alongside the daemon log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-proxy-state-'));
  dirs.push(dir);
  vi.stubEnv(ReticleEnv.STATE_DIR, join(dir, 'state'));
  const expected = join(dir, 'state', 'proxy-15400.log');
  expect(proxyLogPath(15400)).toBe(expected);
  setProxyLogPort(15400);
  proxyLog('reticle_mcp_proxy_reconnecting', { attempt: 1 });
  expect(JSON.parse(readFileSync(expected, 'utf8'))).toMatchObject({
    event: 'reticle_mcp_proxy_reconnecting',
  });
});
