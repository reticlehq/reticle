import { describe, it, expect } from 'vitest';
import { IrisCommand, PresenterMode } from '@syrin/protocol';
import { modeForCommand } from './iris.js';

describe('H2 command-kind classifier', () => {
  it('classifies reads as READING', () => {
    for (const c of [
      IrisCommand.SNAPSHOT,
      IrisCommand.QUERY,
      IrisCommand.MATCH,
      IrisCommand.INSPECT,
      IrisCommand.ANIMATIONS,
      IrisCommand.STATE_READ,
      IrisCommand.CAPABILITIES,
    ]) {
      expect(modeForCommand(c)).toBe(PresenterMode.READING);
    }
  });

  it('classifies acts as ACTING', () => {
    expect(modeForCommand(IrisCommand.ACT)).toBe(PresenterMode.ACTING);
    expect(modeForCommand(IrisCommand.ACT_SEQUENCE)).toBe(PresenterMode.ACTING);
  });

  it('leaves control commands IDLE', () => {
    expect(modeForCommand(IrisCommand.CLOCK)).toBe(PresenterMode.IDLE);
    expect(modeForCommand(IrisCommand.NARRATE)).toBe(PresenterMode.IDLE);
  });
});
