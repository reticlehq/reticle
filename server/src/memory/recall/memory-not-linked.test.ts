/**
 * An unlinked project asking for memory is told the one command that links it.
 *
 * A headless agent on an unlinked project called `reticle_memory { action: "add" }` and got "this
 * project is not linked to the platform", with no next step, so it wrote its notes somewhere else.
 * The read refusal named `login`, which is not the command that links a project.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECT_COMMAND, ReticleDir, ReticleTool } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { MEMORY_TOOLS } from './memory-tools.js';

function unlinked(): ToolDeps {
  const root = join(mkdtempSync(join(tmpdir(), 'memory-unlinked-')), ReticleDir.ROOT);
  mkdirSync(root, { recursive: true });
  return { fs: createNodeFileSystem(), reticleRoot: root } as unknown as ToolDeps;
}

const memory = MEMORY_TOOLS.find((t) => ReticleTool.MEMORY === t.name);

describe('reticle_memory on a project that is not linked', () => {
  it.each([{}, { action: 'add', subject: 'seats', statement: 'an invite sends the new count' }])(
    'names the command that links it, and what memory adds (%o)',
    async (args) => {
      const answer = (await memory?.handler(unlinked(), args)) as Record<string, unknown>;
      expect(answer['reason']).toBe('not-linked');
      const advice = String(answer['advice']);
      expect(advice).toContain(`\`${CONNECT_COMMAND}\``);
      expect(advice).toContain('--url');
      expect(advice).not.toContain('login');
    },
  );
});
