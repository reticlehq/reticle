import { describe, expect, it } from 'vitest';
import { disabledTargetNote } from './act-observation.js';

/*
 * From a persona drive: the Harness saved an item, the app cleared the field and disabled Save, and
 * the model clicked Save again declaring a POST. Nothing could follow a click on a disabled button,
 * yet the verdict was "no — observed no calls", a finding against an app that did its job.
 */
describe('a declared consequence after clicking a disabled control', () => {
  it('is undecided, naming the disabled control, when the consequence did not follow', () => {
    expect(disabledTargetNote(false, { enabled: false })).toMatch(/disabled/);
  });

  it('changes nothing when the control was enabled, or when the consequence held', () => {
    expect(disabledTargetNote(false, { enabled: true })).toBeUndefined();
    expect(disabledTargetNote(true, { enabled: false })).toBeUndefined();
    expect(disabledTargetNote(false, undefined)).toBeUndefined();
  });
});
