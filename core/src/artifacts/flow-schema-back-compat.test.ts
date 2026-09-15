import { describe, expect, it } from 'vitest';
import { FlowFileSchema } from './flow-types.js';
import { FLOW_FILE_VERSION } from './flow-constants.js';
import { StepEffect } from './step-effect.js';

/**
 * A flow on somebody's disk keeps working when the schema grows.
 *
 * `id`, `effect`, `requires` and `ensures` all landed after flows were already committed to real
 * repositories. Flow files are not ours: they live in a user's project, under version control, and a
 * schema change that refuses one is not a migration, it is a broken install for anybody who recorded
 * before the release. So every addition is OPTIONAL, the on-disk version stays where it was, and the
 * absence of a field keeps meaning exactly what it meant.
 *
 * The version assertion is the load-bearing one: bumping FLOW_FILE_VERSION for an additive change
 * would make every older file look like a different format to anything that reads the number.
 */
const LEGACY = {
  version: FLOW_FILE_VERSION,
  name: 'recorded-before-any-of-this',
  createdAt: 0,
  steps: [{ tool: 'reticle_act', anchor: { kind: 'testid', value: 'save' }, action: 'click' }],
};

describe('a flow recorded before these fields existed still loads', () => {
  it('parses a file that declares none of them', () => {
    const parsed = FlowFileSchema.safeParse(LEGACY);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues?.[0])).toBe(
      true,
    );
  });

  it('leaves every new field undefined rather than inventing a default', () => {
    // A default would be a claim the recorder never made. `effect` in particular: guessing
    // `idempotent` makes a resume re-drive something that charges a card, and guessing `commits`
    // refuses every resume that works today.
    const parsed = FlowFileSchema.parse(LEGACY);
    expect(parsed.steps[0]?.id).toBeUndefined();
    expect(parsed.steps[0]?.effect).toBeUndefined();
    expect(parsed.requires).toBeUndefined();
    expect(parsed.ensures).toBeUndefined();
  });

  it('did not bump the on-disk version for an additive change', () => {
    expect(FLOW_FILE_VERSION).toBe(1);
  });

  it('accepts a flow that declares all of them', () => {
    const modern = {
      ...LEGACY,
      requires: [{ signal: 'auth:ready' }],
      ensures: [{ signal: 'order:placed' }],
      steps: [{ ...LEGACY.steps[0], id: 'save-it', effect: StepEffect.COMMITS }],
    };
    const parsed = FlowFileSchema.safeParse(modern);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues?.[0])).toBe(
      true,
    );
  });

  it('refuses an effect it does not know, rather than carrying it through', () => {
    // A misspelled effect that parsed would be read as "unknown" and silently re-driven, which is
    // the exact case `commits` exists to prevent.
    const bad = { ...LEGACY, steps: [{ ...LEGACY.steps[0], effect: 'destructive' }] };
    expect(FlowFileSchema.safeParse(bad).success).toBe(false);
  });
});
