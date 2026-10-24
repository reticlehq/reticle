/**
 * The Claude Code plugin's SessionStart hook, in a web app that is not wired.
 *
 * It told the agent to offer `init` first, and `init` changes the user's files. The lease checks the
 * app now and changes nothing, so the hook leads with the lease, and asks for consent to wire with
 * the same wording as the MCP instructions.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '@/machine/repo-root.js';
import { wiringConsent } from '@/surface/tools/empty-session-list.js';

const HOOK = join(REPO_ROOT, 'plugins', 'reticle', 'hooks', 'init-nudge.mjs');

function runHook(cwd: string, stateDir: string): string {
  const out = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd }),
    env: { ...process.env, RETICLE_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
  expect(out.status).toBe(0);
  return out.stdout;
}

function context(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { additionalContext: string };
  };
  return parsed.hookSpecificOutput.additionalContext;
}

describe('the plugin SessionStart hook in an unwired web app', () => {
  const app = mkdtempSync(join(tmpdir(), 'reticle-nudge-app-'));
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }),
  );

  it('leads with the lease, and asks for consent to wire in the shared wording', () => {
    const text = context(runHook(app, mkdtempSync(join(tmpdir(), 'reticle-nudge-state-'))));
    expect(text).toMatch(/^This web app can be checked now with no install: /);
    expect(text).toContain('reticle_lease');
    const init = /run `([^`]+)` in the app's folder/.exec(text)?.[1] ?? '';
    expect(init).toMatch(/@reticlehq\/server.* init$/);
    expect(text).toContain(wiringConsent(init));
    expect(text.indexOf('reticle_lease')).toBeLessThan(text.indexOf('`init`'));
    expect(text).not.toContain('\n');
  });

  it('says it once per project', () => {
    const state = mkdtempSync(join(tmpdir(), 'reticle-nudge-state-'));
    expect(runHook(app, state)).not.toBe('');
    expect(runHook(app, state)).toBe('');
  });

  it('never fails the session, and stays silent where there is no web app', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reticle-nudge-bare-'));
    expect(runHook(bare, mkdtempSync(join(tmpdir(), 'reticle-nudge-state-')))).toBe('');
    const broken = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    expect(broken.status).toBe(0);
  });
});
