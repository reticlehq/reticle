/**
 * init must say the WebGL gap out loud when react-three-fiber is present (#880).
 *
 * Without this notice, init succeeds, a session connects, and surrounding UI verdicts pass while
 * the canvas, often the product, stays a blank rectangle. The good-first-issue scope is saying
 * so; picking and camera drive are separate work.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager, UiLibrary, type Detection } from './detect.js';
import { WEBGL_CANVAS_LIMIT_NOTE } from './snippets.js';

const VITE_CONFIG = {
  path: 'vite.config.ts',
  source: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()] });
`,
};

function detection(webGlSubtree: boolean): Detection {
  return {
    framework: Framework.VITE,
    uiLibrary: UiLibrary.REACT,
    typescript: true,
    reactMajor: 19,
    needsSourceMapping: true,
    customReconciler: webGlSubtree,
    webGlSubtree,
    packageManager: PackageManager.PNPM,
  };
}

function input(webGlSubtree: boolean): PlanInput {
  return {
    detection: detection(webGlSubtree),
    claudeCli: true,
    mcpExists: false,
    viteConfig: VITE_CONFIG,
    nextConfigFile: null,
    nextReticleDevExists: false,
    options: { port: 4400, mcp: true, install: false },
  };
}

describe('init names the WebGL canvas limit', () => {
  it('raises a NOTICE when react-three-fiber is detected', () => {
    const step = buildPlan(input(true)).steps.find(
      (s) => 'WebGL canvas is not observable' === s.title,
    );
    expect(step?.status).toBe(StepStatus.NOTICE);
    expect(step?.detail).toBe(WEBGL_CANVAS_LIMIT_NOTE);
    expect(step?.detail).toContain('not observable');
    expect(step?.detail).toContain('canvas');
  });

  it('is silent for an ordinary React DOM app', () => {
    expect(
      buildPlan(input(false)).steps.find((s) => 'WebGL canvas is not observable' === s.title),
    ).toBeUndefined();
  });

  it('is a NOTICE, not work left to do: the canvas gap is disclosed, not blocked', () => {
    const step = buildPlan(input(true)).steps.find(
      (s) => 'WebGL canvas is not observable' === s.title,
    );
    expect(step?.status).toBe(StepStatus.NOTICE);
    expect(step?.status).not.toBe(StepStatus.MANUAL);
  });
});
