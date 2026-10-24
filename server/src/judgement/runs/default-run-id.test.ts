import { describe, expect, it } from 'vitest';
import { defaultRunId } from './default-run-id.js';

describe('defaultRunId', () => {
  it('is 16 hex characters, not a 36-character uuid', () => {
    // The id goes into each step screenshot path that an agent reads.
    expect(defaultRunId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives a new id each time', () => {
    expect(defaultRunId()).not.toBe(defaultRunId());
  });
});
