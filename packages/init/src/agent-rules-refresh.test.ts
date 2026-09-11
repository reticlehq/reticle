/**
 * A managed block that can never be updated is not managed.
 *
 * `mergeMarkedInstruction` returned ALREADY the moment it saw the begin-marker, so a project that
 * ran `reticle init` once kept that release's rule text forever. Two consequences, and the second is
 * the one that bites:
 *
 *   - every rule improvement reaches only NEW projects;
 *   - and a rule describing a field that did not exist yet can never be added, so this release ships
 *     `version_skew` on every tool result while the agent's instruction file — the only place it
 *     learns what to do with such a field — does not mention it.
 *
 * The markers say "managed by `reticle init` — edit outside these markers", which is a promise that
 * the inside is ours to replace. Idempotence is preserved by comparing CONTENT: identical block, no
 * write; different block, replace it and leave everything outside untouched.
 */

import { describe, expect, it } from 'vitest';
import {
  AgentRuleStatus,
  markedBlock,
  mergeMarkedInstruction,
  reticleMdFile,
  RETICLE_MD_PATH,
} from './agent-rules.js';

const STALE = `<!-- reticle:begin (managed by \`reticle init\` — edit outside these markers) -->
## Verifying with Reticle

- an old rule from a previous release
<!-- reticle:end -->
`;

describe('the managed block refreshes', () => {
  it('replaces a stale block with the current one', () => {
    const result = mergeMarkedInstruction(STALE);
    expect(result.status).toBe(AgentRuleStatus.APPLY);
    expect(result.content).toContain('Never weaken a check');
    expect(result.content).not.toContain('an old rule from a previous release');
  });

  it('is still a no-op when the block is already current', () => {
    const current = markedBlock();
    expect(mergeMarkedInstruction(current).status).toBe(AgentRuleStatus.ALREADY);
  });

  it('never touches what the human wrote outside the markers', () => {
    const withUserContent = `# My project\n\nSome house rules.\n\n${STALE}\n## After\n\nMore of mine.\n`;
    const result = mergeMarkedInstruction(withUserContent);
    expect(result.content).toContain('# My project');
    expect(result.content).toContain('Some house rules.');
    expect(result.content).toContain('## After');
    expect(result.content).toContain('More of mine.');
    expect(result.content).not.toContain('an old rule from a previous release');
  });

  it('leaves a file with no marker alone except for appending', () => {
    const result = mergeMarkedInstruction('# Existing\n');
    expect(result.status).toBe(AgentRuleStatus.APPLY);
    expect(result.content.startsWith('# Existing')).toBe(true);
  });
});

/**
 * The recovery envelopes moved to RETICLE.md when the rule was split, and they must still be findable.
 *
 * They are the definition of reference material: an agent needs them on the turn a result carries the
 * field and never before. Carrying them in the always-loaded block taxed every session for text
 * almost no session read. Dropping them instead would have been silent, because nothing else in the
 * suite mentions them, so the assertion moves with the text rather than disappearing with it.
 */
describe('the full rules tell the agent what to do with a skew envelope', () => {
  it('names version_skew and what to do about it', () => {
    const full = reticleMdFile();
    expect(full).toContain('version_skew');
    // The two fixes differ by which piece is stale, so the rule must not collapse them into one.
    expect(full).toContain('npx @reticlehq/server update');
    expect(full).toContain('npx @reticlehq/server stop');
  });

  it('is reachable: the always-loaded block names the file that holds it', () => {
    expect(markedBlock()).toContain(RETICLE_MD_PATH);
  });
});
