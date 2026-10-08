import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  firstRunWiring,
  projectDirectoryOf,
  readInitOutput,
  type RunCli,
} from './first-run-wiring.js';

const PLAN = [
  '  [✓] Install @reticlehq/vite-plugin → package.json',
  '  [✓] Vite plugin → vite.config.ts',
  '  [·] Reticle config → .reticle.json',
  '{',
  '  "ok": true,',
  '  "url": "http://localhost:5173/"',
  '}',
  '',
].join('\n');

describe('wiring the app on first use', () => {
  it('runs init in the project against this daemon, once, and reports what it changed', async () => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const run: RunCli = (args, cwd) => {
      calls.push({ args, cwd });
      // As init really does it under --json: the plan on stderr, the one object on stdout.
      const at = PLAN.indexOf('{');
      return Promise.resolve({ code: 0, stdout: PLAN.slice(at), stderr: PLAN.slice(0, at) });
    };
    const wiring = firstRunWiring({ port: 4410, cliPath: '/x/cli.js', run });
    const first = await wiring.wire('/work/shop');
    expect(calls).toEqual([
      { args: ['init', '--no-mcp', '--json', '--port', '4410'], cwd: '/work/shop' },
    ]);
    expect(first.ok).toBe(true);
    expect(first.url).toBe('http://localhost:5173/');
    expect(first.steps.map((s) => s.target)).toEqual([
      'package.json',
      'vite.config.ts',
      '.reticle.json',
    ]);
    // Never twice on the same files: a second ask gets the first answer.
    expect(await wiring.wire('/work/shop')).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('says why it stopped when init fails', async () => {
    const run: RunCli = () =>
      Promise.resolve({
        code: 1,
        stdout: 'no framework detected\n',
        stderr: 'init: no dev script\n',
      });
    const out = await firstRunWiring({ port: 4400, cliPath: 'c', run }).wire('/w');
    expect(out).toMatchObject({ ok: false, error: 'init: no dev script', steps: [] });
  });

  it('does not guess a project for a daemon in the home directory or outside any package', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const app = mkdtempSync(join(tmpdir(), 'app-'));
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }),
    );
    expect(projectDirectoryOf(home, home, () => false)).toBeUndefined();
    expect(
      projectDirectoryOf(mkdtempSync(join(tmpdir(), 'bare-')), home, () => false),
    ).toBeUndefined();
    expect(projectDirectoryOf(app, home, () => false)).toBe(app);
    // A package that is not an app (a library, an API) is never wired unasked.
    const lib = mkdtempSync(join(tmpdir(), 'lib-'));
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ scripts: { dev: 'tsx watch' } }));
    expect(projectDirectoryOf(lib, home, () => false)).toBeUndefined();
    // A project that is already wired has nothing for a first run to do.
    expect(projectDirectoryOf(app, home, () => true)).toBeUndefined();
  });

  it('reads no result from an init that printed none', () => {
    expect(readInitOutput('plain text').result).toBeUndefined();
  });
});
