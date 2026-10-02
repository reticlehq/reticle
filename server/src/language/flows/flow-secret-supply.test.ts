import { afterEach, describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  ReticleCommand,
  FlowStepTool,
  type CommandResult,
  type FlowStep,
} from '@reticlehq/core';
import { REDACTED_FILL, anchorFieldName } from './flows.js';
import { replayActionArgs } from './replay.js';
import { runRoleStep, runSequenceStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay.js';

/**
 * Supplying at replay the secret that was redacted at save.
 *
 * Redacting the password out of a git-checked flow is only half a fix. The other half is that
 * sign-in still has to REPLAY — a flow that drifts at step two forever because its own credential
 * was removed is a flow nobody keeps, and a team that cannot replay sign-in cannot replay anything
 * behind it.
 *
 * So the value comes from the environment at replay time: the one place a secret can live that is
 * neither the repository nor our database.
 */

const KEY = 'RETICLE_SECRET_AUTH_PASSWORD';

afterEach(() => {
  delete process.env[KEY];
});

describe('a redacted fill at replay time', () => {
  it('is filled from the environment variable named after its field', () => {
    process.env[KEY] = 'the-real-password';
    const args = replayActionArgs({ value: REDACTED_FILL }, false, 'auth-password');
    expect(args['value']).toBe('the-real-password');
  });

  /**
   * Left as the placeholder rather than blanked. The replay then fails at the login form with the
   * placeholder visible on screen, which names its own fix — an empty field fails identically and
   * tells the reader nothing.
   */
  it('stays the placeholder when nothing supplies it', () => {
    const args = replayActionArgs({ value: REDACTED_FILL }, false, 'auth-password');
    expect(args['value']).toBe(REDACTED_FILL);
  });

  /** An ordinary recorded value is never touched, whatever the environment holds. */
  it('leaves a non-redacted value exactly as recorded', () => {
    process.env[KEY] = 'the-real-password';
    const args = replayActionArgs({ value: 'checkout total' }, false, 'auth-password');
    expect(args['value']).toBe('checkout total');
  });

  /** Field names become env keys predictably, or nobody can guess what to set. */
  it('maps a dashed field name onto a SCREAMING_SNAKE variable', () => {
    process.env['RETICLE_SECRET_API_KEY'] = 'rk_live_x';
    const args = replayActionArgs({ value: REDACTED_FILL }, false, 'api-key');
    expect(args['value']).toBe('rk_live_x');
  });
});

/**
 * The unit above was always correct. The BUG was every caller but one.
 *
 * `replayActionArgs` substitutes only when its `field` argument is passed, and the testid path was
 * the only one passing it — so a role-anchored login, and the same fill inside an `act_sequence`,
 * typed the literal `<redacted: supply at replay>` into the form. Three of four replay paths were
 * broken while every test above passed, because every test above calls the unit directly with a
 * field already in hand.
 *
 * These drive the RUNNERS instead. That is the difference that would have caught it: an optional
 * parameter is not checkable from the function's own tests, only from the call sites.
 */
describe('a redacted fill is supplied however the step is anchored', () => {
  const ROLE_KEY = 'RETICLE_SECRET_PASSWORD';
  afterEach(() => {
    delete process.env[ROLE_KEY];
  });

  /** Records the args of the ACT command so the test can assert what actually reached the page. */
  function spySession(): {
    session: FlowReplaySession;
    actArgs: () => Record<string, unknown> | undefined;
  } {
    let seen: Record<string, unknown> | undefined;
    const session: FlowReplaySession = {
      command: (name, args = {}) => {
        if (ReticleCommand.QUERY === name) {
          return Promise.resolve({
            kind: 'command_result',
            id: 'q',
            ok: true,
            result: { elements: [{ ref: 'e1' }] },
          } as unknown as CommandResult);
        }
        if (ReticleCommand.ACT === name) seen = args['args'] as Record<string, unknown>;
        return Promise.resolve({ kind: 'command_result', id: 'a', ok: true } as CommandResult);
      },
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    return { session, actArgs: () => seen };
  }

  it('supplies the secret on a ROLE-anchored fill', async () => {
    process.env[ROLE_KEY] = 'the-real-password';
    const { session, actArgs } = spySession();
    await runRoleStep(
      session,
      {
        tool: FlowStepTool.ACT,
        action: ActionType.FILL,
        args: { value: REDACTED_FILL },
      } as unknown as FlowStep,
      0,
      { kind: AnchorKind.ROLE, role: 'textbox', name: 'Password' },
      false,
      () => Promise.resolve(),
    );
    expect(
      actArgs()?.['value'],
      'a role-anchored login must replay, or sign-in cannot be replayed at all',
    ).toBe('the-real-password');
  });

  it('names the field from the anchor’s NAME, not its whole label', () => {
    // `textbox "Password"` would key on RETICLE_SECRET_TEXTBOX_PASSWORD — different from the testid
    // path's key for the same field, and not something a user can guess. The env name has to be
    // predictable or the flow can say a value is missing without saying what to set.
    // `anchorFieldName` is the function REDACTION already uses to decide what to hide. Replay must
    // ask the same one, or a secret is hidden under one name and looked up under another.
    expect(anchorFieldName({ kind: AnchorKind.ROLE, role: 'textbox', name: 'Password' })).toBe(
      'Password',
    );
  });
});

/**
 * The sequence path, which is where a recorded login usually lands: fill, fill, click, in one step.
 *
 * Each sub-step carries its own anchor, so each needs its own field name — a single field threaded
 * for the whole sequence would supply the password to the username box.
 */
describe('a redacted fill inside an act_sequence is supplied per sub-step', () => {
  const KEY_PW = 'RETICLE_SECRET_PASSWORD';
  afterEach(() => {
    delete process.env[KEY_PW];
  });

  it('substitutes on the sub-step that carries the redacted fill', async () => {
    process.env[KEY_PW] = 'the-real-password';
    let sent: { args: Record<string, unknown> }[] | undefined;
    const session: FlowReplaySession = {
      command: (name, args = {}) => {
        if (ReticleCommand.QUERY === name) {
          return Promise.resolve({
            kind: 'command_result',
            id: 'q',
            ok: true,
            result: { elements: [{ ref: 'e1' }] },
          } as unknown as CommandResult);
        }
        if (ReticleCommand.ACT_SEQUENCE === name) {
          sent = args['steps'] as { args: Record<string, unknown> }[];
        }
        return Promise.resolve({ kind: 'command_result', id: 'a', ok: true } as CommandResult);
      },
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    await runSequenceStep(
      session,
      {
        tool: FlowStepTool.ACT_SEQUENCE,
        anchor: { kind: AnchorKind.ROLE, role: 'form', name: 'Sign in' },
        args: {},
      },
      0,
      [
        {
          tool: FlowStepTool.ACT,
          anchor: { kind: AnchorKind.ROLE, role: 'textbox', name: 'Email' },
          action: ActionType.FILL,
          args: { value: 'a@b.test' },
        },
        {
          tool: FlowStepTool.ACT,
          anchor: { kind: AnchorKind.ROLE, role: 'textbox', name: 'Password' },
          action: ActionType.FILL,
          args: { value: REDACTED_FILL },
        },
      ],
      false,
      () => Promise.resolve(),
    );
    expect(sent?.[1]?.args['value'], 'the password sub-step gets the secret').toBe(
      'the-real-password',
    );
    expect(sent?.[0]?.args['value'], 'and the email sub-step is untouched').toBe('a@b.test');
  });
});
