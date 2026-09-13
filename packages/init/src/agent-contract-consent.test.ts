/**
 * Creating an instruction file and APPENDING to one somebody else owns are different acts.
 *
 * Reported from the field on a monorepo audit: `init` appended 68 lines to `CLAUDE.md` — the repo's
 * binding agent contract, the file every agent there reads first — described in the plan only as
 * "teach the agent to verify features with Reticle after building them". The reporter reverted the
 * entire install.
 *
 * `--dry-run` already existed, so the consent MECHANISM was never missing. What was missing was the
 * plan telling the truth loudly enough to act on: the size of the edit, and the fact that the file
 * was already theirs. Both were known at the moment the step was built, and both were withheld.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, type PlanInput } from './plan.js';
import { markedBlock } from './agent-rules.js';
import { Framework, PackageManager } from './detect.js';

const EXISTING_CONTRACT = '# CLAUDE.md\n\nThe rules of this repository.\n';

/**
 * The smallest input that reaches the agent-rule steps. Deliberately local rather than shared with
 * `plan.test.ts`: that file is already past the 1000-line cap, and this asks one narrow question.
 */
function planInput(over: Partial<PlanInput>): PlanInput {
  return {
    detection: { framework: Framework.VITE, packageManager: PackageManager.PNPM },
    claudeCli: true,
    mcpExists: false,
    viteConfig: null,
    nextConfigFile: null,
    nextReticleDevExists: false,
    options: { port: undefined, mcp: true, install: false },
    ...over,
  } as PlanInput;
}

/** The agent-rule steps that actually WRITE, with the detail a reader would act on. */
function ruleSteps(over: Partial<PlanInput>): { detail?: string; target: string }[] {
  return buildPlan(planInput(over))
    .steps.filter((s) => 'Agent verification rule' === s.title && s.write !== undefined)
    .map((s) => ({ detail: s.detail, target: s.target }));
}

const forFile = (steps: { detail?: string; target: string }[], file: string): string | undefined =>
  steps.find((s) => s.target.includes(file))?.detail;

describe('the plan says what it will do to an agent contract', () => {
  it('says CREATES when there is no such file yet', () => {
    const detail = forFile(ruleSteps({ claudeMdContent: undefined }), 'CLAUDE.md');
    expect(detail).toContain('creates');
    expect(detail, 'nothing is being appended to').not.toContain('APPENDS');
  });

  it('says APPENDS, and how many lines, when the file is already the user own', () => {
    const detail = forFile(ruleSteps({ claudeMdContent: EXISTING_CONTRACT }), 'CLAUDE.md');
    expect(detail).toContain('APPENDS');
    expect(detail).toContain('existing CLAUDE.md');
    const lines = markedBlock().split('\n').length - 1;
    expect(detail, 'the size is the whole point — 68 lines is not a detail').toContain(
      String(lines),
    );
  });

  it('names the markers, because a reversible edit is different from an irreversible one', () => {
    const detail = forFile(ruleSteps({ claudeMdContent: EXISTING_CONTRACT }), 'CLAUDE.md');
    expect(detail).toContain('reticle:begin');
    expect(detail).toContain('undo');
  });

  it('applies the same honesty to AGENTS.md, which is written for every repo', () => {
    const detail = forFile(ruleSteps({ agentsMdContent: '# AGENTS.md\n\nRules.\n' }), 'AGENTS.md');
    expect(detail).toContain('APPENDS');
    expect(detail).toContain('existing AGENTS.md');
  });

  it('treats a whitespace-only file as empty rather than as somebody content', () => {
    const detail = forFile(ruleSteps({ claudeMdContent: '   \n\n  ' }), 'CLAUDE.md');
    expect(detail).toContain('creates');
  });
});
