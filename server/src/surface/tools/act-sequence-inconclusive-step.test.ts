/**
 * An inconclusive `reticle_act { steps }` plan names the step and the missing evidence (#2204).
 *
 * The plan answered `verified: "unknown"` with "a step could not be judged" and the raw error. It
 * did not say which step, and it left out the diagnosis that `reticle_act_and_wait` gives for the
 * same read. The agent could not tell whether to wait longer, read again or declare an `expect`.
 */
import { describe, expect, it } from 'vitest';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { ReticleCommand, ReticleTool, Verified, VerifiedReason } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';
import { createFakeSession } from '@/portal/session/fake-session.js';

const SAVED = { kind: 'element', role: 'button', name: 'Save' };
const SAVE_BUTTON = { ref: 'b1', role: 'button', name: 'Save', states: [], visible: true };

/** A page that answers every read until the action numbered `silentFrom` runs, then answers none. */
function pageSilentFrom(silentFrom: number, overrides: Partial<Session> = {}): Session {
  let acts = 0;
  return createFakeSession({
    command(name: string, _args?: Record<string, unknown>, t?: number) {
      if (ReticleCommand.ACT === name) {
        acts += 1;
      }
      if (ReticleCommand.MATCH === name && silentFrom <= acts) {
        return Promise.reject(new Error(`command 'match' timed out after ${String(t)}ms`));
      }
      const result =
        ReticleCommand.MATCH === name
          ? { matched: true, count: 1, elements: [SAVE_BUTTON] }
          : { dispatched: true, settled: true };
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    ...overrides,
  });
}

const tool = (name: string): ToolDef => TOOLS.find((t) => t.name === name) as ToolDef;

const deps = (session: Session): ToolDeps =>
  ({
    sessions: { resolve: () => session } as unknown as SessionManager,
    recordings: new RecordingStore(),
    now: () => 0,
  }) as unknown as ToolDeps;

const plan = (session: Session): Promise<Record<string, unknown>> =>
  tool(ReticleTool.ACT_SEQUENCE).handler(deps(session), {
    steps: [
      { ref: 'e1', action: 'fill', value: 'a@b.com', expect: SAVED },
      { ref: 'e2', action: 'click', expect: SAVED },
    ],
    timeout_ms: 30,
  }) as Promise<Record<string, unknown>>;

const single = (session: Session): Promise<Record<string, unknown>> =>
  tool(ReticleTool.ACT_AND_WAIT).handler(deps(session), {
    ref: 'e2',
    action: 'click',
    until: SAVED,
    timeout_ms: 30,
  }) as Promise<Record<string, unknown>>;

describe('a plan with a step whose expect could not be read', () => {
  it('is unknown and inconclusive, and names the step by number and action', async () => {
    const result = await plan(pageSilentFrom(2));
    expect(result['verified']).toBe(Verified.UNKNOWN);
    expect(result['verifiedReason']).toBe(VerifiedReason.INCONCLUSIVE);
    expect(String(result['because'])).toContain('step 2 (click)');
    // The index is also a field, counted from 0 as `steps` is.
    expect(result['stopped_at']).toBe(1);
  });

  it('names the missing evidence in the words reticle_act_and_wait uses', async () => {
    const fromPlan = String((await plan(pageSilentFrom(2)))['because']);
    const fromSingle = String((await single(pageSilentFrom(1)))['because']);
    expect(fromSingle).toContain('the assertion could not be evaluated:');
    // The single action's whole sentence is inside the plan's sentence, after the step's name.
    expect(fromPlan).toContain(fromSingle);
    expect(fromPlan).toContain('timeout_ms');
  });

  it('names an old page SDK as the cause, as the single action does', async () => {
    const result = await plan(pageSilentFrom(2, { sdkVersion: '3.6.2' }));
    expect(String(result['because'])).toContain('step 2 (click)');
    expect(String(result['because'])).toContain('3.6.2');
    expect(String(result['because'])).toContain('reticle update');
  });
});
