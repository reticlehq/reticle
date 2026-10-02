/**
 * A verification suite with no flows reported that it PASSED.
 *
 * Found by the adversarial MCP sweep — 994 calls against a live app, and this was the only invented
 * answer on the whole surface:
 *
 *   reticle_flow_verify {}
 *   -> { status: "pass", total: 0, passed: 0, failed: 0, summary: "all 0 flows pass" }
 *
 * and the captured telemetry showed it emitting
 *
 *   verification_completed { via: reticle_flow_verify, verified: "yes", passed: true, durationMs: 0 }
 *
 * Both halves are wrong, and they are wrong in the two places that matter most. `flow_verify` is the
 * CI gate: a project with no flows — every project that has not written one yet, and any project
 * where the flows directory failed to resolve — goes GREEN. And `verification_completed` is the
 * number shown to investors, so an empty suite inflates it while verifying nothing.
 *
 * This file already knew the principle: "A green that cannot go red is not a pass", which is why
 * `unverifiable` exists for flows that replay without asserting anything. Zero flows is the purest
 * case of it, and was the one case not covered.
 */

import { describe, expect, it } from 'vitest';
import { buildSuiteVerdict } from './decision.js';

describe('an empty suite has not passed', () => {
  it('reports unverifiable, not pass', () => {
    const v = buildSuiteVerdict([]);
    expect(v.status, 'nothing was verified, so nothing passed').toBe('unverifiable');
    expect(v.total).toBe(0);
    expect(v.passed).toBe(0);
  });

  it('says so in words an agent can act on', () => {
    const v = buildSuiteVerdict([]);
    expect(v.summary).not.toContain('pass');
    expect(v.summary.toLowerCase()).toContain('no flows');
  });
});
