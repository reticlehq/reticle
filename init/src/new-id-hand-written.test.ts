/**
 * A copied checkout whose app names its project id by hand, `connect({ projectId: '…' })`, kept
 * sending its evidence into the ORIGINAL after `init --new-id`: the config took the new id and the
 * literal in the app did not.
 */
import { describe, expect, it } from 'vitest';
import { runInit, type InitOptions } from './run.js';
import { memoryIo } from './memory-io.test-helpers.js';

const OPTS: InitOptions = {
  cwd: '/code/shop-copy',
  port: undefined,
  mcp: false,
  install: false,
  dryRun: false,
  newId: true,
};

const OLD_ID = 'shop-79cb7120';

describe('init --new-id with an id the app names by hand', () => {
  it('moves the literal in connect() along with the config', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ name: 'shop', devDependencies: { vite: '^6.0.0' } }),
      'vite.config.ts': 'export default {}',
      '.reticle.json': JSON.stringify({ framework: 'vite', projectId: OLD_ID }),
      'src/main.ts': `import { connect } from '@reticlehq/browser';\nconnect({ projectId: "${OLD_ID}" });\n`,
    });
    runInit(OPTS, io);
    const config = JSON.parse(io.written['.reticle.json'] ?? '{}') as { projectId?: string };
    expect(config.projectId).toBeDefined();
    expect(config.projectId).not.toBe(OLD_ID);
    expect(io.written['src/main.ts']).toContain(
      `connect({ projectId: "${String(config.projectId)}" })`,
    );
  });
});
