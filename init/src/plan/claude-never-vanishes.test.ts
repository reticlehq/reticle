/**
 * Claude Code never disappears from the plan without a word (#1071).
 *
 * Reported on 3.2.0: `init --dry-run` registered the MCP server for Gemini CLI and Codex CLI and
 * "not Claude Code" - from inside a Claude Code VS Code extension session, where the `claude` binary
 * is not on PATH. The user wrote `.mcp.json` by hand to recover.
 *
 * Two separate mistakes meet here. Claude Code is the only client detected by CLI-on-PATH rather
 * than by its config, so an absent binary reads as an absent client while the user is sitting in it.
 * And the manual fallback was reached only when NO agent at all was detected - so with Gemini and
 * Codex present, the Claude step returned null and nothing said so. A step that vanishes from the
 * plan is exactly what the install gate's baseline diff exists to catch, and a plan is the one
 * artifact a person reads to learn what init did.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework } from '@/detect/detect.js';
import { McpClient } from '@/register/mcp-clients.js';

const detection = (framework: Framework) => ({
  framework,
  packageManager: 'npm' as const,
  hasReact: true,
  deps: {},
});

const base = (partial: Partial<PlanInput>): PlanInput =>
  ({
    detection: detection(Framework.VITE),
    claudeCli: true,
    mcpExists: false,
    viteConfig: null,
    nextConfigFile: null,
    nextConfigSource: null,
    options: { mcp: true },
    ...partial,
  }) as PlanInput;

/** Every step whose title or detail names Claude Code at all. */
const mentioningClaude = (plan: { steps: readonly { title: string; detail?: string; status: StepStatus }[] }) =>
  plan.steps.filter((s) => /claude/i.test(`${s.title} ${s.detail ?? ''}`));

describe('the Claude Code MCP step', () => {
  it('is planned when the CLI is there, which was never the broken case', () => {
    const plan = buildPlan(base({ claudeCli: true }));
    expect(mentioningClaude(plan).length).toBeGreaterThan(0);
  });

  /*
   * The reported shape exactly: other clients present, `claude` not on PATH. Before the fix this
   * plan had no line about Claude Code anywhere in it.
   */
  it('still says something when the CLI is missing and other agents were found', () => {
    const plan = buildPlan(
      base({
        claudeCli: false,
        detectedClients: [
          { id: McpClient.GEMINI, configPath: '/home/u/.gemini/settings.json', existing: '{}' },
        ],
      }),
    );
    const named = mentioningClaude(plan);
    expect(
      named.length,
      'Claude Code vanished from the plan with other clients present — the reported defect',
    ).toBeGreaterThan(0);
    // A NOTICE, deliberately: nothing failed, the reader may not use Claude Code, and the install
    // gate asserts zero `⚠`. It still prints its detail in full.
    expect(named.some((s) => StepStatus.NOTICE === s.status)).toBe(true);
  });

  it('carries a remedy somebody can actually act on, not just a name', () => {
    const plan = buildPlan(base({ claudeCli: false }));
    const detail = mentioningClaude(plan)
      .map((s) => s.detail ?? '')
      .join('\n');
    expect(detail).toContain('.mcp.json');
    expect(detail).toContain('@reticlehq/server');
  });
});

/**
 * From #1078 (Christian-Sidak): when `init` runs INSIDE Claude Code with no `claude` on PATH, write
 * the project-scope `.mcp.json` the reporter had to write by hand, instead of only describing it.
 *
 * Only inside Claude Code. A `.mcp.json` written for somebody who does not use it is a file in
 * their repo they did not ask for; the notice stays for everyone else.
 */
describe('inside Claude Code, with no CLI on PATH', () => {
  const inside = (partial: Partial<PlanInput>): PlanInput =>
    base({ claudeCli: false, insideClaudeCode: true, ...partial });
  const claudeWrite = (plan: ReturnType<typeof buildPlan>) =>
    plan.steps.find((s) => StepStatus.APPLY === s.status && true === s.write?.path.endsWith('.mcp.json'));

  it('writes the project .mcp.json, merged into nothing', () => {
    const step = claudeWrite(buildPlan(inside({ claudeProjectConfig: null })));
    expect(step?.write?.content).toContain('"mcpServers"');
    expect(step?.write?.content).toContain('@reticlehq/server');
  });

  it('merges into an existing .mcp.json without dropping the servers already there', () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } });
    const content = claudeWrite(buildPlan(inside({ claudeProjectConfig: existing })))?.write?.content;
    expect(content).toContain('"other"');
    expect(content).toContain('@reticlehq/server');
  });

  it('is ALREADY on a re-run, and writes nothing', () => {
    const first = claudeWrite(buildPlan(inside({ claudeProjectConfig: null })))?.write?.content;
    const again = buildPlan(inside({ claudeProjectConfig: first ?? null }));
    expect(claudeWrite(again)).toBeUndefined();
    expect(mentioningClaude(again).some((s) => StepStatus.ALREADY === s.status)).toBe(true);
  });

  it('outside Claude Code it still only says so, and writes no file', () => {
    const plan = buildPlan(
      base({
        claudeCli: false,
        detectedClients: [
          { id: McpClient.GEMINI, configPath: '/home/u/.gemini/settings.json', existing: '{}' },
        ],
      }),
    );
    expect(claudeWrite(plan)).toBeUndefined();
  });
});
