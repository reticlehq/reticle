import { beforeEach, describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { NOTICE_FOLD } from './invoke-tool.js';
import { EnvelopeKey } from './tool-kit.js';
import { forTheAgent } from './agent/for-the-agent.js';
import { resetNotices } from './agent/notices.js';

/**
 * A version-skew warning is decisive: it explains every tool result after it and names the command
 * that fixes it. Folding it into a notice line turned it into a string under another key, and the
 * e2e battery's skewed peer read an empty `reticle_sessions` answer with no `version_skew` at all.
 */
beforeEach(() => resetNotices());

const skew = { pair: 'daemon', action: 'run `npx @reticlehq/server stop`, then retry' };

describe('version_skew is never folded or trimmed', () => {
  it('is not one of the advisories that become notice lines', () => {
    expect(NOTICE_FOLD.advisories).not.toContain(EnvelopeKey.VERSION_SKEW);
  });

  it('reaches the agent intact on an empty session list, which is otherwise cut to one sentence', () => {
    const out = forTheAgent({
      name: ReticleTool.SESSIONS,
      args: {},
      result: { sessions: [], why: 'no browser session connected. More text.', version_skew: skew },
      attach: 'peer',
      root: undefined,
      fold: NOTICE_FOLD,
    }) as Record<string, unknown>;
    expect(out[EnvelopeKey.VERSION_SKEW]).toEqual(skew);
  });

  it('and again on the next call that carries it — it is never deduplicated away', () => {
    const call = () =>
      forTheAgent({
        name: ReticleTool.ACT_AND_WAIT,
        args: {},
        result: { verified: 'unknown', because: 'b', since: 1, version_skew: skew },
        attach: 'peer',
        root: undefined,
        fold: NOTICE_FOLD,
      }) as Record<string, unknown>;
    call();
    expect(call()[EnvelopeKey.VERSION_SKEW]).toEqual(skew);
  });
});
