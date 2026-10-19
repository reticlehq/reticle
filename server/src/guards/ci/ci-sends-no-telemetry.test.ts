/**
 * CI is not a user, so no CI job reports telemetry.
 *
 * Incident: the `early-gates` job runs `reticle init` in temp directories (no package.json, a
 * malformed one, no dev script) on three operating systems, with no opt-out. Each run outside the
 * source checkout reported three failed installs as a real user's. `break-matrix` did the same
 * before its own opt-out. These CI rows mixed with real `init_completed` failures and hid them.
 *
 * Each spec opts out by itself, but a new job forgets. The workflow-level `env` covers every job,
 * now and later. A spec that measures telemetry sets `RETICLE_TELEMETRY=1` for its own children.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ReticleEnv } from '@reticlehq/core';
import { REPO_ROOT } from '@/machine/repo-root.js';

const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const OFF = '0';

describe('the CI workflow sends no telemetry', () => {
  it('turns telemetry off for every job at the workflow level', () => {
    const parsed = parse(readFileSync(WORKFLOW, 'utf8')) as { env?: Record<string, unknown> };
    expect(String(parsed.env?.[ReticleEnv.TELEMETRY])).toBe(OFF);
  });
});
