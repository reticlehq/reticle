import { describe, expect, it } from 'vitest';
import { RefusalDetail, RefusalReason } from '@reticlehq/core/telemetry';
import { SELF_RECOVERING_MARKER } from '@/portal/session/no-session-diagnosis.js';
import { CHROMIUM_PATH_REFUSAL_PREFIX } from '@/command/cli/doctor/browser/chromium-hint.js';
import { RECOVERY, classifyRefusal, recoveryFor, refusalReasonFor } from './error-recovery.js';

/**
 * `tool_refused` is only worth sending if the reason on it is the same fact the agent was told.
 *
 * These drive the messages the server actually throws — the strings the recovery table already keys
 * on — rather than a paraphrase, because a classifier tested against its own author's idea of the
 * message is a classifier that agrees with itself and nothing else.
 */
describe('why a tool refused', () => {
  it.each([
    ['no browser session connected', RefusalReason.NO_SESSION],
    ['multiple sessions connected', RefusalReason.NO_SESSION],
    ['no connected session with id abc', RefusalReason.NO_SESSION],
    ['session disconnected', RefusalReason.NO_SESSION],
    ["ref 'e12' no longer resolves to an element", RefusalReason.NO_MATCH],
    ['no baseline named checkout', RefusalReason.NO_MATCH],
    ['no <option> with value "gold"', RefusalReason.NO_MATCH],
    ['cannot fill a disabled <input>', RefusalReason.UNSUPPORTED],
    ['cannot type into a contenteditable region', RefusalReason.UNSUPPORTED],
    ['cannot hover without a real pointer', RefusalReason.UNSUPPORTED],
    ['potentially destructive action blocked', RefusalReason.UNSUPPORTED],
    ["unknown action 'clik'", RefusalReason.BAD_ARGS],
    ['invalid flow name: ../escape', RefusalReason.BAD_ARGS],
    ["command 'act' timed out after 5000ms", RefusalReason.NOT_READY],
    ['the target tab is throttled', RefusalReason.NOT_READY],
    ['browser pool unavailable', RefusalReason.NOT_READY],
    ['a pairing token is required', RefusalReason.NOT_READY],
  ])('classifies %s', (message, reason) => {
    expect(refusalReasonFor(message)).toBe(reason);
  });

  /**
   * The single largest refusal there is, and the one that never reaches the recovery table: the
   * no-session diagnosis inspects the machine and names the cause itself, so `recoveryFor` returns
   * nothing for it by design. Missing that would gut the metric while every other case passed.
   */
  it('classifies the self-diagnosing no-session message the recovery table deliberately skips', () => {
    const diagnosed = `nothing is listening on any dev-server port. ${SELF_RECOVERING_MARKER}`;
    expect(recoveryFor(diagnosed)).toBeUndefined();
    expect(refusalReasonFor(diagnosed)).toBe(RefusalReason.NO_SESSION);
  });

  it('renders a zod issue array before classifying it, as the agent-facing payload does', () => {
    const raw = JSON.stringify([{ code: 'unrecognized_keys', message: 'x', keys: ['value'] }]);
    expect(refusalReasonFor(raw)).toBe(RefusalReason.BAD_ARGS);
  });

  /**
   * A classifier that cannot say "I do not know" lies instead. A growing `other` is a finding about
   * the table above, not about anybody's app.
   */
  it('says other rather than guessing at a message nothing recognises', () => {
    expect(refusalReasonFor('the flux capacitor desynchronised')).toBe(RefusalReason.OTHER);
  });

  /**
   * The reason is looked up by hint TEXT, so two recoveries sharing a string would collapse into one
   * entry and hand a matched refusal somebody else's owner. That every recovery HAS a reason is
   * already a compile error to omit (`REASON_OF` is a Record over the keys); this is the half the
   * type system cannot see.
   */
  it('keeps every recovery hint distinct, so the reason lookup cannot collide', () => {
    const hints = Object.values(RECOVERY);
    expect(new Set(hints).size).toBe(hints.length);
  });
});

/*
 * `not_ready` on reticle_lease is one bucket over several causes: no pool, no Chromium, a bad
 * RETICLE_CHROMIUM_PATH, a throttled tab, a timeout, a missing pairing token. Each needs a
 * different fix, and the bucket alone did not say which one stopped the user.
 */
describe('which cause inside the bucket', () => {
  it.each([
    [
      'browser pool unavailable — the lease tools need the daemon-managed pool',
      RefusalDetail.POOL_UNAVAILABLE,
    ],
    ['browser pool is shut down', RefusalDetail.POOL_SHUT_DOWN],
    [
      'Chromium is not installed for Playwright. Run: npx playwright install chromium',
      RefusalDetail.CHROMIUM_MISSING,
    ],
    [`${CHROMIUM_PATH_REFUSAL_PREFIX}/nowhere, which does not exist`, RefusalDetail.CHROMIUM_PATH],
    ['the target tab is throttled', RefusalDetail.THROTTLED],
    ["command 'snapshot' timed out after 8000ms", RefusalDetail.COMMAND_TIMEOUT],
    [
      'a pairing token is required when the Reticle bridge binds beyond localhost',
      RefusalDetail.TOKEN_REQUIRED,
    ],
  ])('names the not_ready cause of %s', (message, detail) => {
    expect(classifyRefusal(message)).toEqual({ reason: RefusalReason.NOT_READY, detail });
  });

  it.each([
    ['multiple sessions connected', RefusalReason.NO_SESSION, RefusalDetail.MULTIPLE_SESSIONS],
    ["ref 'e12' no longer resolves to an element", RefusalReason.NO_MATCH, RefusalDetail.STALE_REF],
    ['cannot fill a disabled <input>', RefusalReason.UNSUPPORTED, RefusalDetail.NOT_EDITABLE],
    ["unknown action 'clik'", RefusalReason.BAD_ARGS, RefusalDetail.BAD_ARGUMENTS],
  ])('names the cause in the other buckets too: %s', (message, reason, detail) => {
    expect(classifyRefusal(message)).toEqual({ reason, detail });
  });

  it('sends no detail for a message nothing recognises', () => {
    expect(classifyRefusal('the flux capacitor desynchronised')).toEqual({
      reason: RefusalReason.OTHER,
    });
  });

  it('sends no detail for a message that diagnosed itself', () => {
    const diagnosed = `nothing is listening on any dev-server port. ${SELF_RECOVERING_MARKER}`;
    expect(classifyRefusal(diagnosed)).toEqual({ reason: RefusalReason.NO_SESSION });
  });
});
