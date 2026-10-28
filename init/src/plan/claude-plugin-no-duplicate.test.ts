/**
 * The Reticle Claude Code plugin brings its own `reticle` MCP server. `init` and `reticle setup mcp`
 * still ran `claude mcp add reticle -s user`, so Claude Code got two `reticle` servers: duplicate
 * tools and two proxies. With the plugin installed, no user-scope entry is added, and an old
 * duplicate is reported with the command that removes it.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, MCP_TARGET, type PlanInput } from './plan.js';
import { Framework } from '@/detect/detect.js';
import { claudePluginInstalled, claudeRemoveUserCommand } from '@/register/mcp.js';

const base = (partial: Partial<PlanInput>): PlanInput =>
  ({
    detection: { framework: Framework.VITE, packageManager: 'npm', hasReact: true, deps: {} },
    claudeCli: true,
    mcpExists: false,
    viteConfig: null,
    nextConfigFile: null,
    nextConfigSource: null,
    options: { mcp: true },
    ...partial,
  }) as PlanInput;

const claudeSteps = (input: PlanInput) =>
  buildPlan(input).steps.filter((s) => MCP_TARGET === s.target && /claude/i.test(s.title));

describe('claudePluginInstalled', () => {
  const HOME = '/home/u';
  const io = (files: Record<string, unknown>) => ({
    readFile: (p: string) => {
      const value = files[p.replace(/\\/g, '/')];
      return value === undefined ? null : JSON.stringify(value);
    },
    homeDir: () => HOME,
  });
  const record = { plugins: { 'reticle@reticlehq': [{ scope: 'user' }] } };

  it('finds the plugin in ~/.claude', () => {
    const files = { [`${HOME}/.claude/plugins/installed_plugins.json`]: record };
    expect(claudePluginInstalled(io(files), undefined)).toBe(true);
  });

  it('reads $CLAUDE_CONFIG_DIR when it is set', () => {
    const files = { '/cfg/plugins/installed_plugins.json': record };
    expect(claudePluginInstalled(io(files), '/cfg')).toBe(true);
    expect(claudePluginInstalled(io(files), undefined)).toBe(false);
  });

  it('ignores other plugins and an unreadable record', () => {
    const other = {
      [`${HOME}/.claude/plugins/installed_plugins.json`]: { plugins: { 'x@y': [] } },
    };
    expect(claudePluginInstalled(io(other), undefined)).toBe(false);
    expect(claudePluginInstalled(io({}), undefined)).toBe(false);
  });
});

describe('the Claude Code MCP step with the Reticle plugin', () => {
  it('adds no user-scope entry when the plugin is installed', () => {
    const steps = claudeSteps(base({ claudePlugin: true }));
    expect(steps.map((s) => s.status)).toEqual([StepStatus.ALREADY]);
    expect(steps[0]?.detail).toMatch(/plugin/);
    expect(steps.some((s) => s.exec !== undefined)).toBe(false);
  });

  it('names an old user-scope entry next to the plugin and the command that removes it', () => {
    const steps = claudeSteps(base({ claudePlugin: true, claudeUserEntry: true, mcpExists: true }));
    expect(steps.map((s) => s.status)).toEqual([StepStatus.MANUAL]);
    expect(steps[0]?.detail).toContain(claudeRemoveUserCommand());
    expect(steps.some((s) => s.exec !== undefined)).toBe(false);
  });

  it('writes no project .mcp.json inside Claude Code when the plugin is installed', () => {
    const plan = buildPlan(base({ claudeCli: false, insideClaudeCode: true, claudePlugin: true }));
    expect(plan.steps.some((s) => true === s.write?.path.endsWith('.mcp.json'))).toBe(false);
  });

  it('registers as before without the plugin', () => {
    const steps = claudeSteps(base({}));
    expect(steps.map((s) => s.status)).toEqual([StepStatus.APPLY]);
    expect(steps[0]?.exec?.args).toContain('add');
  });
});
