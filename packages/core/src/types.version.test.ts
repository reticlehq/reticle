import { describe, it, expect } from 'vitest';
import { ContractFileSchema, ProjectFileSchema } from './types.js';

// A versioned on-disk envelope exists so an old reader can REJECT a newer file instead of silently
// parsing it and stripping unknown fields. z.number() rejected nothing; the version must be pinned.
describe('on-disk file version is pinned (rejects future versions)', () => {
  it('ContractFile accepts v1 and rejects v2', () => {
    expect(ContractFileSchema.shape.version.safeParse(1).success).toBe(true);
    expect(ContractFileSchema.shape.version.safeParse(2).success).toBe(false);
  });

  it('ProjectFile accepts v1 and rejects v2', () => {
    expect(ProjectFileSchema.shape.version.safeParse(1).success).toBe(true);
    expect(ProjectFileSchema.shape.version.safeParse(2).success).toBe(false);
  });
});
