/**
 * The Harness refusal speaks to two audiences (night 7b).
 *
 * The founder read this in the HUD: "The Reticle Harness runs on the Reticle platform, and a new
 * account gets 10 free credits to try it: run `reticle connect` … drive the journey yourself with
 * reticle_act_and_wait and an `until` …". One sentence served the agent and the person. Its credit
 * number was stale (free credit is now once per person, and the engine cannot know the balance).
 * It did not say that the PERSON runs connect. And error-recovery found it by a regex over that
 * prose.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONNECT_COMMAND,
  HARNESS_NOT_LINKED_HUMAN,
  HumanControlKind,
  NextWho,
  RefusalCode,
  RefusalReason,
  ReticleTool,
  type ImpactSnapshot,
} from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
// The tool table first, as the daemon loads it: the explore module sits on an import cycle with it.
import './tools.js';
import { answerExplore } from './explore-tools.js';
import { hudDrive } from './chat-drives.js';
import { buildErrorPayload, codedRefusalOf, refusalReasonFor } from './error-recovery.js';
import { MSG_NO_HARNESS_KEY } from './harness-gate.js';
import { forgetDrives, withRunningDrive } from '@/features/harness/drive-runs.js';

const SNAPSHOT = { schemaVersion: 1 } as unknown as ImpactSnapshot;
const NEXT = [
  { who: NextWho.HUMAN, run: CONNECT_COMMAND },
  { who: NextWho.AGENT, tool: ReticleTool.ACT_AND_WAIT },
];

/** A daemon with one tab and no linked project. */
function unlinked(said: string[] = []): ToolDeps {
  const tab = {
    id: 's1',
    url: 'http://localhost:5173/',
    channels: ['ui', 'net', 'log', 'state', 'signal'],
    sourceMapping: true,
    pushNarration: (t: string) => said.push(t),
  };
  return {
    now: () => 0,
    linkedCloud: () => Promise.resolve(null),
    sessions: { get: () => tab, resolve: () => tab, list: () => [] },
  } as unknown as ToolDeps;
}

async function refusedExplore(): Promise<unknown> {
  try {
    await answerExplore(unlinked(), {}, undefined, () => Promise.reject(new Error('drove')));
  } catch (error) {
    return error;
  }
  throw new Error('the explore was not refused');
}

afterEach(() => {
  forgetDrives();
});

describe('an unlinked Harness, as the agent reads it', () => {
  it('carries the code, and what to do next as data', async () => {
    const error = await refusedExplore();
    const payload = buildErrorPayload(MSG_NO_HARNESS_KEY, codedRefusalOf(error));
    expect(payload.code).toBe(RefusalCode.HARNESS_NOT_LINKED);
    expect(payload.next).toEqual(NEXT);
    // A deliberate refusal with its next steps: neither a second hint nor a bug-report ask.
    expect(payload.recovery).toBeUndefined();
    expect(payload.feedback).toBeUndefined();
    expect(refusalReasonFor(MSG_NO_HARNESS_KEY, codedRefusalOf(error))).toBe(
      RefusalReason.UNSUPPORTED,
    );
  });

  it('is a short sentence that names no credit number', () => {
    expect(MSG_NO_HARNESS_KEY).not.toMatch(/\d/);
    expect(MSG_NO_HARNESS_KEY.split('. ').length).toBeLessThanOrEqual(3);
    expect(MSG_NO_HARNESS_KEY).toContain(CONNECT_COMMAND);
  });

  it('is recognized by its code, never by its words', () => {
    expect(buildErrorPayload(MSG_NO_HARNESS_KEY).code).toBeUndefined();
  });
});

describe('an unlinked Harness, as the person reads it in the HUD', () => {
  it('is one sentence: connect, with the command, and nothing for the agent', async () => {
    const said: string[] = [];
    await hudDrive(unlinked(said), 's1', { kind: HumanControlKind.HARNESS_RUN }, () => undefined);
    expect(said).toEqual([HARNESS_NOT_LINKED_HUMAN]);
    expect(withRunningDrive(SNAPSHOT, 's1')?.lastDrive?.said).toBe(HARNESS_NOT_LINKED_HUMAN);
    expect(HARNESS_NOT_LINKED_HUMAN).toContain(`\`${CONNECT_COMMAND}\``);
    expect(HARNESS_NOT_LINKED_HUMAN).not.toMatch(/\d|reticle_/);
  });
});
