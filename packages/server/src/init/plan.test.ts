import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager, type Detection } from './detect.js';

const MCP_STEP = 'MCP server (global)';

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
    viteConfig: partial.viteConfig ?? null,
    nextConfigFile: partial.nextConfigFile ?? null,
    nextIrisDevExists: partial.nextIrisDevExists ?? false,
    options: partial.options ?? { port: undefined, mcp: true, install: false },
  };
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

describe('buildPlan — MCP (global, claude user scope)', () => {
  it('registers iris globally via an exec step when the claude CLI is present', () => {
    const s = step(buildPlan(input({ claudeCli: true, mcpExists: false })), MCP_STEP);
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.exec?.command).toBe('claude');
    expect(s.exec?.args).toEqual([
      'mcp',
      'add',
      'iris',
      '-s',
      'user',
      '--',
      'npx',
      '@syrin/iris',
      'mcp',
    ]);
  });

  it('is ALREADY (idempotent) when an iris server is already registered', () => {
    const s = step(buildPlan(input({ claudeCli: true, mcpExists: true })), MCP_STEP);
    expect(s.status).toBe(StepStatus.ALREADY);
  });

  it('bails to manual global instructions when the claude CLI is missing', () => {
    const s = step(buildPlan(input({ claudeCli: false, mcpExists: false })), MCP_STEP);
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

  it('bakes --port into the global registration', () => {
    const s = step(
      buildPlan(input({ options: { port: 5000, mcp: true, install: false } })),
      MCP_STEP,
    );
    expect(s.exec?.args).toContain('--port');
    expect(s.exec?.args).toContain('5000');
  });
});

describe('buildPlan — Vite', () => {
  it('patches the vite config; no separate entry-file step (plugin injects connect)', () => {
    const plan = buildPlan(input({ viteConfig: { path: 'vite.config.ts', source: VITE_SRC } }));
    expect(step(plan, 'Vite plugin').status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Vite plugin').write?.content).toContain('@syrin/iris/vite');
    expect(plan.steps.some((s) => s.title.includes('entry'))).toBe(false);
  });

  it('bails to manual when there is no vite config file', () => {
    const plan = buildPlan(input({ viteConfig: null }));
    expect(step(plan, 'Vite plugin').status).toBe(StepStatus.MANUAL);
  });

  it('bakes --port into the patched iris() call (bridge/SDK port agree)', () => {
    const plan = buildPlan(
      input({
        viteConfig: { path: 'vite.config.ts', source: VITE_SRC },
        options: { port: 5000, mcp: true, install: false },
      }),
    );
    expect(step(plan, 'Vite plugin').write?.content).toContain('iris({ port: 5000 })');
  });
});

describe('buildPlan — install', () => {
  it('makes install an exec step when enabled, manual otherwise', () => {
    const off = buildPlan(input({ options: { port: undefined, mcp: true, install: false } }));
    expect(step(off, 'Install dependency').status).toBe(StepStatus.MANUAL);
    expect(step(off, 'Install dependency').exec).toBeUndefined();

    const on = buildPlan(input({ options: { port: undefined, mcp: true, install: true } }));
    const s = step(on, 'Install dependency');
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.exec?.command).toBe('pnpm');
    expect(s.exec?.args).toEqual(['add', '-D', '@syrin/iris']);
  });
});

describe('buildPlan — Next', () => {
  it('creates iris-dev.tsx and bails config + mount to manual', () => {
    const plan = buildPlan(
      input({ detection: detection(Framework.NEXT), nextConfigFile: 'next.config.mjs' }),
    );
    expect(step(plan, 'IrisDev component').status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Next config (withIris)').status).toBe(StepStatus.MANUAL);
    expect(step(plan, 'Mount IrisDev').status).toBe(StepStatus.MANUAL);
  });

  it('marks iris-dev.tsx already when it exists', () => {
    const plan = buildPlan(
      input({ detection: detection(Framework.NEXT), nextIrisDevExists: true }),
    );
    expect(step(plan, 'IrisDev component').status).toBe(StepStatus.ALREADY);
  });
});

describe('buildPlan — HTML', () => {
  it('registers MCP globally plus a manual connect snippet', () => {
    const plan = buildPlan(input({ detection: detection(Framework.HTML, 0) }));
    expect(step(plan, MCP_STEP).status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Connect snippet').status).toBe(StepStatus.MANUAL);
  });
});
