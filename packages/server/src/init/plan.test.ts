import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager, type Detection } from './detect.js';

const CLAUDE_STEP = 'MCP server (Claude, global)';
const CURSOR_STEP = 'MCP server (Cursor, global)';
const MCP_STEP = 'MCP server (global)';
const CONFIG_STEP = 'Reticle config';

function detection(framework: Framework, reactMajor = 19): Detection {
  return {
    framework,
    reactMajor,
    needsSourceMapping: reactMajor >= 19,
    packageManager: PackageManager.PNPM,
  };
}

function input(partial: Partial<PlanInput>): PlanInput {
  return {
    detection: partial.detection ?? detection(Framework.VITE),
    claudeCli: partial.claudeCli ?? true,
    mcpExists: partial.mcpExists ?? false,
    cursorPresent: partial.cursorPresent ?? false,
    cursorConfig: partial.cursorConfig ?? null,
    cursorConfigPath: partial.cursorConfigPath ?? '/home/u/.cursor/mcp.json',
    viteConfig: partial.viteConfig ?? null,
    nextConfigFile: partial.nextConfigFile ?? null,
    nextReticleDevExists: partial.nextReticleDevExists ?? false,
    options: partial.options ?? { port: undefined, mcp: true, install: false },
  };
}

function maybeStep(plan: ReturnType<typeof buildPlan>, title: string) {
  return plan.steps.find((x) => x.title === title);
}

const VITE_SRC = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()] });
`;

function step(plan: ReturnType<typeof buildPlan>, title: string) {
  const s = plan.steps.find((x) => x.title === title);
  if (s === undefined) throw new Error(`no step ${title}`);
  return s;
}

describe('buildPlan — MCP (global, per detected agent)', () => {
  it('registers with Claude via an exec step when the claude CLI is present', () => {
    const s = step(buildPlan(input({ claudeCli: true, mcpExists: false })), CLAUDE_STEP);
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.exec?.command).toBe('claude');
    expect(s.exec?.args).toEqual([
      'mcp',
      'add',
      'reticle',
      '-s',
      'user',
      '--',
      'npx',
      '@reticlehq/server',
      'mcp',
    ]);
  });

  it('Claude step is ALREADY (idempotent) when reticle is already registered', () => {
    const s = step(buildPlan(input({ claudeCli: true, mcpExists: true })), CLAUDE_STEP);
    expect(s.status).toBe(StepStatus.ALREADY);
  });

  it('registers with Cursor by writing its global config when Cursor is present', () => {
    const plan = buildPlan(input({ claudeCli: false, cursorPresent: true, cursorConfig: null }));
    const s = step(plan, CURSOR_STEP);
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.write?.path).toBe('/home/u/.cursor/mcp.json');
    expect(s.write?.content).toContain('@reticlehq/server');
  });

  it('registers with BOTH agents when both are present', () => {
    const plan = buildPlan(input({ claudeCli: true, cursorPresent: true, cursorConfig: null }));
    expect(maybeStep(plan, CLAUDE_STEP)).toBeDefined();
    expect(maybeStep(plan, CURSOR_STEP)).toBeDefined();
  });

  it('Cursor step is ALREADY when reticle is already in its config', () => {
    const existing = JSON.stringify({ mcpServers: { reticle: { command: 'x' } } });
    const plan = buildPlan(
      input({ claudeCli: false, cursorPresent: true, cursorConfig: existing }),
    );
    expect(step(plan, CURSOR_STEP).status).toBe(StepStatus.ALREADY);
  });

  it('falls back to a single manual step when no agent is detected', () => {
    const plan = buildPlan(input({ claudeCli: false, cursorPresent: false }));
    const s = step(plan, MCP_STEP);
    expect(s.status).toBe(StepStatus.MANUAL);
    expect(s.detail).toContain('-s user');
  });

  it('skips under --no-mcp', () => {
    const s = step(
      buildPlan(input({ options: { port: undefined, mcp: false, install: false } })),
      MCP_STEP,
    );
    expect(s.status).toBe(StepStatus.SKIP);
  });

  it('keeps both agents’ registration portless — the port lives in .reticle.json, not the global config', () => {
    const plan = buildPlan(
      input({
        claudeCli: true,
        cursorPresent: true,
        cursorConfig: null,
        options: { port: 5000, mcp: true, install: false },
      }),
    );
    // The global MCP registration must NOT pin a port — one entry serves every project.
    expect(step(plan, CLAUDE_STEP).exec?.args).not.toContain('5000');
    expect(step(plan, CLAUDE_STEP).exec?.args).not.toContain('--port');
    expect(step(plan, CURSOR_STEP).write?.content).not.toContain('5000');
    expect(step(plan, CURSOR_STEP).write?.content).not.toContain('--port');
    // Instead the port is written to the per-project .reticle.json.
    expect(step(plan, CONFIG_STEP).write?.content).toContain('5000');
  });
});

describe('buildPlan — Vite', () => {
  it('patches the vite config; no separate entry-file step (plugin injects connect)', () => {
    const plan = buildPlan(input({ viteConfig: { path: 'vite.config.ts', source: VITE_SRC } }));
    expect(step(plan, 'Vite plugin').status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Vite plugin').write?.content).toContain('@reticlehq/vite-plugin');
    expect(plan.steps.some((s) => s.title.includes('entry'))).toBe(false);
  });

  it('bails to manual when there is no vite config file', () => {
    const plan = buildPlan(input({ viteConfig: null }));
    expect(step(plan, 'Vite plugin').status).toBe(StepStatus.MANUAL);
  });

  it('bakes --port into the patched reticle() call (bridge/SDK port agree)', () => {
    const plan = buildPlan(
      input({
        viteConfig: { path: 'vite.config.ts', source: VITE_SRC },
        options: { port: 5000, mcp: true, install: false },
      }),
    );
    expect(step(plan, 'Vite plugin').write?.content).toContain('reticle({ port: 5000 })');
  });
});

describe('buildPlan — install', () => {
  it('makes install an exec step when enabled, manual otherwise', () => {
    const off = buildPlan(input({ options: { port: undefined, mcp: true, install: false } }));
    expect(step(off, 'Install dependencies').status).toBe(StepStatus.MANUAL);
    expect(step(off, 'Install dependencies').exec).toBeUndefined();

    const on = buildPlan(input({ options: { port: undefined, mcp: true, install: true } }));
    const s = step(on, 'Install dependencies');
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.exec?.command).toBe('pnpm');
    // Vite (the default): the React kit + the Vite build plugin — never the retired core umbrella.
    expect(s.exec?.args).toEqual(['add', '-D', '@reticlehq/react', '@reticlehq/vite-plugin']);
  });

  it('installs the kit + the framework build plugin, never the core umbrella', () => {
    const vite = buildPlan(
      input({
        detection: detection(Framework.VITE),
        options: { port: undefined, mcp: true, install: true },
      }),
    );
    const next = buildPlan(
      input({
        detection: detection(Framework.NEXT),
        options: { port: undefined, mcp: true, install: true },
      }),
    );
    expect(step(vite, 'Install dependencies').exec?.args).toEqual([
      'add',
      '-D',
      '@reticlehq/react',
      '@reticlehq/vite-plugin',
    ]);
    expect(step(next, 'Install dependencies').exec?.args).toEqual([
      'add',
      '-D',
      '@reticlehq/react',
      '@reticlehq/next',
    ]);
    // The retired umbrella must appear nowhere in either install plan.
    for (const plan of [vite, next]) {
      for (const s of plan.steps) {
        expect(s.exec?.args ?? []).not.toContain('@reticlehq/core');
        expect(s.write?.content ?? '').not.toContain('@reticlehq/core');
      }
    }
  });
});

describe('buildPlan — Next', () => {
  it('creates reticle-dev.tsx and bails config + mount to manual', () => {
    const plan = buildPlan(
      input({ detection: detection(Framework.NEXT), nextConfigFile: 'next.config.mjs' }),
    );
    expect(step(plan, 'ReticleDev component').status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Next config (withReticle)').status).toBe(StepStatus.MANUAL);
    expect(step(plan, 'Mount ReticleDev').status).toBe(StepStatus.MANUAL);
  });

  it('marks reticle-dev.tsx already when it exists', () => {
    const plan = buildPlan(
      input({ detection: detection(Framework.NEXT), nextReticleDevExists: true }),
    );
    expect(step(plan, 'ReticleDev component').status).toBe(StepStatus.ALREADY);
  });
});

describe('buildPlan — HTML', () => {
  it('registers MCP globally plus a manual connect snippet', () => {
    const plan = buildPlan(input({ detection: detection(Framework.HTML, 0) }));
    expect(step(plan, CLAUDE_STEP).status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Connect snippet').status).toBe(StepStatus.MANUAL);
  });
});
