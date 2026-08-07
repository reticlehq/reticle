import { describe, it, expect } from 'vitest';
import {
  mergeMarkedInstruction,
  cursorRuleFile,
  markedBlock,
  AgentRuleStatus,
} from './agent-rules.js';

describe('agent verification rule — content', () => {
  it('states WHEN to verify, HOW, and the never-weaken guard', () => {
    const block = markedBlock();
    // The rule must make the trigger unambiguous and the anti-reward-hacking guard explicit.
    expect(block).toContain('after you build or change any user-facing feature');
    expect(block).toContain('before');
    expect(block).toMatch(/reticle_act/);
    expect(block).toMatch(/reticle_assert/);
    expect(block).toContain('reticle gate');
    expect(block).toContain('Never weaken a check');
    // Wrapped in idempotency markers.
    expect(block).toContain('reticle:begin');
    expect(block).toContain('<!-- reticle:end -->');
  });

  // The rule `init` writes is the FIRST thing an agent reads about Reticle, and it lands before any
  // framework wiring — so it is the only chance to say "report your experience" while the setup is
  // still being lived through. A rule that only asks for feedback about verifications collects
  // nothing about the phase that most often breaks.
  it('asks for feedback as a standing instruction, not only when a verification fails', () => {
    const block = markedBlock();
    expect(block).toContain('reticle_feedback');
    expect(block).toMatch(/feature_request/);
    expect(block).toMatch(/improvement/);
    // Setup and install problems, named — they happen before any tool surface exists.
    expect(block).toMatch(/installing, wiring, or starting Reticle/);
    // The escape hatch for when there is no daemon and no tools to call.
    expect(block).toContain('reticle feedback --agent --kind');
  });

  it('cursor .mdc carries alwaysApply so it stays in every turn context', () => {
    const mdc = cursorRuleFile();
    expect(mdc.startsWith('---\n')).toBe(true);
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).toContain('Verifying with Reticle');
  });
});

describe('mergeMarkedInstruction — idempotent append into CLAUDE.md/AGENTS.md', () => {
  it('creates the block alone when the file is absent or empty', () => {
    for (const existing of [null, undefined, '', '   \n']) {
      const r = mergeMarkedInstruction(existing);
      expect(r.status).toBe(AgentRuleStatus.APPLY);
      expect(r.content).toBe(markedBlock());
    }
  });

  it('appends the block below existing content, preserving it', () => {
    const existing = '# My project rules\n\nDo the thing.\n';
    const r = mergeMarkedInstruction(existing);
    expect(r.status).toBe(AgentRuleStatus.APPLY);
    expect(r.content.startsWith(existing)).toBe(true); // existing content untouched
    expect(r.content).toContain('Verifying with Reticle'); // block appended
  });

  it('is a NO-OP when the managed block is already present (re-run idempotency)', () => {
    const first = mergeMarkedInstruction('# rules\n').content;
    const second = mergeMarkedInstruction(first);
    expect(second.status).toBe(AgentRuleStatus.ALREADY);
    expect(second.content).toBe(first); // byte-identical — no duplicate block
    // And a third pass over the second is still a no-op.
    expect(mergeMarkedInstruction(second.content).content).toBe(first);
  });
});
