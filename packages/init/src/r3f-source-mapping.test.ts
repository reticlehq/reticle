/**
 * A react-three-fiber app must come out of `init` with the source-map stamp OFF.
 *
 * This is the whole remedy, and it lives in the PLAN rather than in the babel plugin, because the
 * plugin cannot see what the manifest can. `<line>` is SVG's `<line>` and it is `THREE.Line`; the
 * allowlist has to let it through, and R3F then walks the dashed attribute as a pierced property
 * path and throws from the commit phase, unmounting the app to a white screen.
 *
 * It is asserted on the plan's OUTPUT — the config text a user actually gets — because that is the
 * only thing that reaches them. A correct detection that nothing writes down is the state this
 * repo was already in: the babel plugin documented this behaviour for a release in which no code
 * read the manifest at all.
 */

import { describe, expect, it } from 'vitest';
import { buildPlan, type PlanInput } from './plan.js';
import { Framework, PackageManager, UiLibrary, type Detection } from './detect.js';

const NEXT_CONFIG_SOURCE = `const nextConfig = {};
export default nextConfig;
`;

const VITE_CONFIG = {
  path: 'vite.config.ts',
  source: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
};

function input(customReconciler: boolean): PlanInput {
  const detection: Detection = {
    framework: Framework.VITE,
    uiLibrary: UiLibrary.REACT,
    typescript: true,
    reactMajor: 19,
    needsSourceMapping: true,
    customReconciler,
    packageManager: PackageManager.PNPM,
  };
  return {
    detection,
    claudeCli: true,
    mcpExists: false,
    viteConfig: VITE_CONFIG,
    nextConfigFile: null,
    nextReticleDevExists: false,
    options: { port: 4400, mcp: true, install: false },
  };
}

function viteStepText(plan: ReturnType<typeof buildPlan>): string {
  return stepText(plan, 'Vite plugin');
}

function stepText(plan: ReturnType<typeof buildPlan>, title: string): string {
  const step = plan.steps.find((s) => title === s.title);
  if (step === undefined) throw new Error(`no ${title} step in the plan`);
  return `${step.write?.content ?? ''}\n${step.detail ?? ''}`;
}

/**
 * The same app on Next.js. It has no plugin call to carry the flag, so the ONLY place `init` can
 * say it is the `withReticle` wrap it writes into next.config — and the wrap is auto-applied, so a
 * detection that stopped at the Vite path would leave every Next R3F app crashing exactly as before.
 */
function nextInput(customReconciler: boolean): PlanInput {
  return {
    ...input(customReconciler),
    detection: { ...input(customReconciler).detection, framework: Framework.NEXT },
    viteConfig: null,
    nextConfigFile: 'next.config.mjs',
    nextConfigSource: NEXT_CONFIG_SOURCE,
  };
}

describe('init and a non-DOM React renderer', () => {
  it('turns the stamp off in the config it writes', () => {
    expect(viteStepText(buildPlan(input(true)))).toContain('sourceMapping: false');
  });

  it('leaves the stamp alone for an ordinary React DOM app', () => {
    expect(viteStepText(buildPlan(input(false)))).not.toContain('sourceMapping');
  });

  it('turns the stamp off in the next.config wrap it writes', () => {
    const text = stepText(buildPlan(nextInput(true)), 'Next config (withReticle)');
    expect(text).toContain('withReticle(nextConfig, { sourceMapping: false })');
  });

  it('leaves the next.config wrap bare for an ordinary React DOM app', () => {
    const text = stepText(buildPlan(nextInput(false)), 'Next config (withReticle)');
    expect(text).toContain('withReticle(nextConfig)');
    expect(text).not.toContain('sourceMapping');
  });
});
