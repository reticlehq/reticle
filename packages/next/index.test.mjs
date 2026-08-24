import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { withReticle, readPairingToken } = require('./index.cjs');

const TOKEN_ENV = 'RETICLE_PAIRING_TOKEN_DIR';

describe('readPairingToken', () => {
  const previous = process.env[TOKEN_ENV];
  /** @type {string | undefined} */
  let dir;

  afterEach(() => {
    if (previous === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = previous;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads the token from RETICLE_PAIRING_TOKEN_DIR when the daemon has written one', () => {
    dir = mkdtempSync(join(tmpdir(), 'reticle-next-token-'));
    writeFileSync(join(dir, 'pairing-token'), 'tok-from-daemon\n');
    process.env[TOKEN_ENV] = dir;
    expect(readPairingToken()).toBe('tok-from-daemon');
  });

  it('mints a token when the file is missing, so Next started before the daemon still pairs', () => {
    dir = mkdtempSync(join(tmpdir(), 'reticle-next-token-'));
    process.env[TOKEN_ENV] = dir;
    const token = readPairingToken();
    expect(token).toBeTruthy();
    expect(readPairingToken()).toBe(token);
  });
});

describe('withReticle', () => {
  const previousEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
  });

  it('is a no-op in production, so a production Next config is byte-identical', () => {
    process.env.NODE_ENV = 'production';
    const input = { reactStrictMode: true };
    expect(withReticle(input)).toBe(input);
  });

  it('installs the stamping loader as a webpack pre-loader in development', () => {
    process.env.NODE_ENV = 'development';
    const config = withReticle({});
    expect(typeof config.webpack).toBe('function');
    const webpackConfig = { module: { rules: [] } };
    const out = config.webpack(webpackConfig, { dev: true });
    const rule = out.module.rules.find(
      (entry) =>
        entry.enforce === 'pre' && String(entry.use?.[0]?.loader ?? '').endsWith('loader.cjs'),
    );
    expect(rule).toBeDefined();
    expect(rule.test.test('src/Foo.tsx')).toBe(true);
    expect(rule.test.test('src/Foo.jsx')).toBe(true);
    expect(rule.test.test('src/util.ts')).toBe(false);
  });
});
