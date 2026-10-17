/**
 * One command, one spelling (night 7b, the HUD's Harness refusal).
 *
 * The refusal told the person to run `reticle connect`; the recovery the agent got with it told it
 * to have the human run `npx @reticlehq/server connect`. The docs call the command `reticle connect`.
 * Two spellings of one command in one answer read as two commands.
 */
import { describe, expect, it } from 'vitest';
import { CONNECT_COMMAND } from '@reticlehq/core';
import { describeSync } from '@/memory/project/sync-status.js';
import { CONNECT } from './platform-moment.js';
import { buildErrorPayload } from './error-recovery.js';
import { MSG_NO_HARNESS_KEY } from './harness-gate.js';

const OTHER_SPELLING = '@reticlehq/server connect';

describe('the connect command', () => {
  it('is spelled as the docs spell it', () => {
    expect(CONNECT_COMMAND).toBe('reticle connect');
  });

  it('has that one spelling wherever the engine names it', () => {
    const unlinked = describeSync(
      { linked: false, runs: 2, onPlatform: 0, pending: 0, refused: [], refusedMore: 0 },
      0,
    );
    const refusal = buildErrorPayload(MSG_NO_HARNESS_KEY);
    for (const said of [CONNECT, unlinked, refusal.error, refusal.recovery ?? '']) {
      expect(said).toContain(CONNECT_COMMAND);
      expect(said).not.toContain(OTHER_SPELLING);
    }
  });
});
