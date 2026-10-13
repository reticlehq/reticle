/**
 * Every agent that writes text Reticle keeps is told to write it in Simplified Technical English.
 *
 * Founder decision 2026-10-13: flows, notes, feedback and reports follow ASD-STE100 about 80% of the
 * way. The harness model and every MCP agent must get the rule, or the rule does not exist.
 */
import { describe, expect, it } from 'vitest';
import { WRITING_RULE, WRITING_RULE_SHORT } from '@reticlehq/core';
import { systemPrompt } from './harness.js';
import { buildServerInstructions } from '@/surface/mcp/server-instructions.js';

describe('the writing rule reaches every agent', () => {
  it('is in the harness system prompt, with or without a focus', () => {
    expect(systemPrompt()).toContain(WRITING_RULE);
    expect(systemPrompt('the checkout')).toContain(WRITING_RULE);
  });

  it('is in the MCP briefing before and after an app has connected', () => {
    for (const previouslyConnected of [true, false]) {
      expect(buildServerInstructions({ previouslyConnected })).toContain(WRITING_RULE_SHORT);
    }
  });

  it('names the standard, so an agent can look it up', () => {
    expect(WRITING_RULE).toContain('ASD-STE100');
    expect(WRITING_RULE_SHORT).toContain('ASD-STE100');
  });
});
