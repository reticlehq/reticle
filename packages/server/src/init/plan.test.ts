import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager, type Detection } from './detect.js';

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
    mcpJson: partial.mcpJson ?? null,
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

describe('buildPlan — Vite', () => {
  it('writes .mcp.json and patches the vite config (no entry edit needed)', () => {
    const plan = buildPlan(input({ viteConfig: { path: 'vite.config.ts', source: VITE_SRC } }));
    expect(step(plan, 'MCP config').status).toBe(StepStatus.APPLY);
    expect(step(plan, 'MCP config').write).toBeDefined();
    expect(step(plan, 'Vite plugin').status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Vite plugin').write?.content).toContain('@syrin/iris/vite');
    // The plugin injects connect(), so there is no separate entry-file step.
    expect(plan.steps.some((s) => s.title.includes('entry'))).toBe(false);
  });

  it('bails to manual when there is no vite config file', () => {
    const plan = buildPlan(input({ viteConfig: null }));
    expect(step(plan, 'Vite plugin').status).toBe(StepStatus.MANUAL);
  });

  it('skips MCP under --no-mcp', () => {
    const plan = buildPlan(input({ options: { port: undefined, mcp: false, install: false } }));
    expect(step(plan, 'MCP config').status).toBe(StepStatus.SKIP);
  });

  it('makes install an exec step when install is enabled, manual otherwise', () => {
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
  it('gives an MCP write plus a manual connect snippet', () => {
    const plan = buildPlan(input({ detection: detection(Framework.HTML, 0) }));
    expect(step(plan, 'MCP config').status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Connect snippet').status).toBe(StepStatus.MANUAL);
  });
});
