import { describe, expect, it } from 'vitest';
import { AGENT_NOTE_MAX, AgentLinkSchema } from './impact.js';

describe('the HUD agent link on the wire', () => {
  it('carries the attached agents and each note with whether an agent took it', () => {
    const link = {
      agents: ['Claude Code'],
      notes: [
        { text: 'check the empty cart', seen: true, by: 'Claude Code' },
        { text: 'and the coupon', seen: false },
      ],
    };
    expect(AgentLinkSchema.parse(link)).toEqual(link);
  });

  it('refuses a note longer than the HUD lets anybody type', () => {
    const text = 'x'.repeat(AGENT_NOTE_MAX + 1);
    expect(AgentLinkSchema.safeParse({ agents: [], notes: [{ text, seen: false }] }).success).toBe(
      false,
    );
  });
});
