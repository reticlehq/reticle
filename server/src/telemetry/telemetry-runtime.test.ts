/**
 * The realm of a session in telemetry: Reticle's computer is counted beside the browser.
 *
 * The defect: agent feedback from a session of Reticle's computer carried `runtime: "computer"`,
 * and the feedback schema took only `web`, `electron` and `tauri`. The report was refused with an
 * enum error, so no agent could file feedback about the computer. And a verdict carried no
 * runtime at all, so a verdict on a desktop application could not be told from one on a page.
 */
import { describe, expect, it } from 'vitest';
import {
  BugFoundSchema,
  FeedbackSchema,
  TelemetryRuntime,
  VerificationSchema,
  BugSource,
  BugAttribution,
} from '@reticlehq/core';
import { telemetryRuntimeOf } from './telemetry-runtime.js';
import { verificationOf } from './verification-of.js';

describe('the runtime in telemetry', () => {
  it('takes agent feedback from a session of the computer', () => {
    const parsed = FeedbackSchema.safeParse({
      source: 'agent',
      kind: 'bug',
      text: 'the drag on the canvas showed no pixels',
      runtime: telemetryRuntimeOf('computer'),
    });
    expect(parsed.success).toBe(true);
  });

  it('names a realm that a host registered "other", and never its name', () => {
    expect(telemetryRuntimeOf('x-acme-robot')).toBe(TelemetryRuntime.OTHER);
    expect(telemetryRuntimeOf('web')).toBe(TelemetryRuntime.WEB);
    expect(telemetryRuntimeOf(undefined)).toBeUndefined();
  });

  it('puts the runtime on a verdict', () => {
    const verification = verificationOf(
      'reticle_assert',
      { pass: true, verified: 'yes' },
      10,
      undefined,
      false,
      undefined,
      'computer',
    );
    expect(verification?.runtime).toBe(TelemetryRuntime.COMPUTER);
    expect(VerificationSchema.safeParse(verification).success).toBe(true);
  });

  it('takes the runtime on a defect', () => {
    const parsed = BugFoundSchema.safeParse({
      source: BugSource.CONTRADICTION,
      kind: 'signal-contradicted',
      falseGreen: true,
      repeat: false,
      attribution: BugAttribution.APP,
      runtime: TelemetryRuntime.COMPUTER,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.runtime).toBe(TelemetryRuntime.COMPUTER);
  });
});
