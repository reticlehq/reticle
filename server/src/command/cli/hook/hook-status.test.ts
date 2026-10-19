/**
 * `reticle hook status` names an install that still runs through npx, and how to make it direct.
 *
 * An npx-only install of the current version counted as installed, so it kept paying npx's start
 * (~426 ms per call) with nothing anywhere saying so.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROMPT_HOOK_AGENTS, PromptHookAgent, installPromptHook } from '@reticlehq/init';
import { promptCaptureRows } from './hook-command.js';

const cursor = PROMPT_HOOK_AGENTS.find((a) => PromptHookAgent.CURSOR === a.id);

function projectWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-status-'));
  mkdirSync(join(dir, '.cursor'));
  writeFileSync(join(dir, '.cursor', 'hooks.json'), content);
  return dir;
}

describe('hook status', () => {
  it.skipIf('win32' === process.platform)('names an npx-only install as slow', () => {
    if (cursor === undefined) throw new Error('no Cursor spec');
    const home = mkdtempSync(join(tmpdir(), 'hook-home-'));
    const npxOnly = projectWith(installPromptHook(cursor, null).content);
    const row = promptCaptureRows(npxOnly, home, {}, false).find((r) => r.includes('Cursor'));
    expect(row).toContain('npx');
    expect(row).toContain('reticle hook install');

    const direct = projectWith(installPromptHook(cursor, null, '/opt/reticle/bin.js').content);
    const fast = promptCaptureRows(direct, home, {}, false).find((r) => r.includes('Cursor'));
    expect(fast).toContain('hook installed');
    expect(fast).not.toContain('npx');
  });
});
