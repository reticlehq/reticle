import { describe, it, expect } from 'vitest';
import { SESSION_AUTO } from '@syrin/iris-protocol';
import { resolveSessionLabel } from './iris.js';

describe('resolveSessionLabel', () => {
  const gen = (): string => 'unique-123';

  it('generates a unique per-tab id when no label is given', () => {
    expect(resolveSessionLabel(undefined, gen)).toBe('unique-123');
  });

  it('generates a unique per-tab id for the "auto" sentinel', () => {
    expect(resolveSessionLabel(SESSION_AUTO, gen)).toBe('unique-123');
  });

  it('uses an explicit label verbatim so tabs can intentionally share', () => {
    expect(resolveSessionLabel('alianpost', gen)).toBe('alianpost');
  });
});
