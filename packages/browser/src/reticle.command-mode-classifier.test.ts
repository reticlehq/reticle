import { describe, it, expect } from 'vitest';
import { ReticleCommand, PresenterMode } from '@reticle/protocol';
import { modeForCommand } from './reticle-presenter-helpers.js';

describe('command-kind classifier', () => {
  it('classifies reads as READING', () => {
    for (const c of [
      ReticleCommand.SNAPSHOT,
      ReticleCommand.QUERY,
      ReticleCommand.MATCH,
      ReticleCommand.INSPECT,
      ReticleCommand.ANIMATIONS,
      ReticleCommand.STATE_READ,
      ReticleCommand.CAPABILITIES,
    ]) {
      expect(modeForCommand(c)).toBe(PresenterMode.READING);
    }
  });

  it('classifies acts as ACTING', () => {
    expect(modeForCommand(ReticleCommand.ACT)).toBe(PresenterMode.ACTING);
    expect(modeForCommand(ReticleCommand.ACT_SEQUENCE)).toBe(PresenterMode.ACTING);
  });

  it('leaves control commands IDLE', () => {
    expect(modeForCommand(ReticleCommand.CLOCK)).toBe(PresenterMode.IDLE);
    expect(modeForCommand(ReticleCommand.NARRATE)).toBe(PresenterMode.IDLE);
  });
});
