/**
 * `reticle_record stop` hands the compiled program to the agent with credentials redacted, the
 * same way the saved flow is.
 *
 * A recorded sign-in came back with the password in plain text in `program.steps[].args`, while
 * the flow saved from the same recording held the placeholder: the disk was clean and the secret
 * went into the agent's transcript, which is logged and shared far more often than a repo file.
 */
import { describe, expect, it } from 'vitest';
import { QueryBy, ReticleTool } from '@reticlehq/core';
import { READ_TOOLS } from './read-tools.js';
import type { ToolDeps } from './tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { REDACTED_FILL } from '@/language/flows/flows.js';

const TYPED = 'pw-typed-7';
const EMAIL = 'sam@example.com';

function recordStopTool() {
  const t = READ_TOOLS.find((x) => x.name === ReticleTool.RECORD_STOP);
  if (t === undefined) throw new Error('no reticle_record_stop tool');
  return t;
}

const fill = (field: string, value: string) => ({
  tool: ReticleTool.ACT,
  stable: true,
  args: { by: QueryBy.TESTID, value: field, action: 'fill', args: { value } },
});

describe('reticle_record stop redacts credentials it returns', () => {
  it('returns the placeholder for a password fill and keeps the real value for replay', async () => {
    const recordings = new RecordingStore();
    recordings.start('sign-in', 0, '/login');
    recordings.capture(fill('auth-email', EMAIL));
    recordings.capture(fill('auth-password', TYPED));
    const session = { id: 's1', elapsed: () => 0, eventsSince: () => [] } as unknown as Session;
    const deps = {
      sessions: { resolve: () => session } as unknown as SessionManager,
      recordings,
    } as unknown as ToolDeps;

    const res = await recordStopTool().handler(deps, { recordingName: 'sign-in' });

    const text = JSON.stringify(res);
    expect(text).not.toContain(TYPED);
    expect(text).toContain(REDACTED_FILL);
    // A teammate opening the flow learns what to set, from the file alone.
    expect(text).toContain('RETICLE_SECRET_');
    expect(text, 'a field that is not secret is left alone').toContain(EMAIL);
    // In-session replay still types the real value; only what is RETURNED is redacted.
    expect(JSON.stringify(recordings.getCompiled('sign-in'))).toContain(TYPED);
  });
});
