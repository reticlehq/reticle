import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager, UiLibrary, type Detection } from './detect.js';
import { cursorRuleFile } from './agent-rules.js';

const CLAUDE_STEP = 'MCP server (Claude, global)';
const CURSOR_STEP = 'MCP server (Cursor, global)';
const MCP_STEP = 'MCP server (global)';
const CONFIG_STEP = 'Reticle config';

function detection(
  framework: Framework,
  reactMajor = 19,
  uiLibrary: UiLibrary = UiLibrary.REACT,
): Detection {
  return {
    framework,
    uiLibrary,
    typescript: true,
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
    cursorProjectPresent: partial.cursorProjectPresent,
    cursorConfig: partial.cursorConfig ?? null,
    cursorConfigPath: partial.cursorConfigPath ?? '/home/u/.cursor/mcp.json',
    viteConfig: partial.viteConfig ?? null,
    astroConfig: partial.astroConfig,
    astroLayout: partial.astroLayout,
    nextConfigFile: partial.nextConfigFile ?? null,
    nextConfigSource: partial.nextConfigSource,
    nextLayout: partial.nextLayout,
    nextReticleDevPath: partial.nextReticleDevPath,
    nextReticleDevImport: partial.nextReticleDevImport,
    testids: partial.testids,
    storeHints: partial.storeHints,
    viteDevModuleExists: partial.viteDevModuleExists,
    nextReticleDevExists: partial.nextReticleDevExists ?? false,
    claudeMdContent: partial.claudeMdContent,
    agentsMdContent: partial.agentsMdContent,
    cursorRuleContent: partial.cursorRuleContent,
    ...(partial.craEntry === undefined ? {} : { craEntry: partial.craEntry }),
    ...(partial.craEnv === undefined ? {} : { craEnv: partial.craEnv }),
    ...(partial.pairingToken === undefined ? {} : { pairingToken: partial.pairingToken }),
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

const AGENT_RULE_STEP = 'Agent verification rule';

describe('buildPlan — agent verification rule (makes the agent USE Reticle)', () => {
  it('writes the rule into CLAUDE.md when the Claude CLI is present', () => {
    const s = step(buildPlan(input({ claudeCli: true, claudeMdContent: null })), AGENT_RULE_STEP);
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.write?.path).toBe('CLAUDE.md');
    expect(s.write?.content).toContain('Verifying with Reticle');
    expect(s.write?.content).toContain('npx @reticlehq/server gate');
  });

  it('appends to an existing CLAUDE.md, preserving it', () => {
    const s = step(
      buildPlan(input({ claudeCli: true, claudeMdContent: '# House rules\n\nBe terse.\n' })),
      AGENT_RULE_STEP,
    );
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.write?.content.startsWith('# House rules')).toBe(true);
  });

  it('is ALREADY (idempotent) when CLAUDE.md already carries the managed block', () => {
    // Seed a CLAUDE.md that already contains the block by round-tripping one apply.
    const first = step(
      buildPlan(input({ claudeCli: true, claudeMdContent: null })),
      AGENT_RULE_STEP,
    ).write?.content;
    const s = step(
      buildPlan(input({ claudeCli: true, claudeMdContent: first ?? '' })),
      AGENT_RULE_STEP,
    );
    expect(s.status).toBe(StepStatus.ALREADY);
  });

  it('writes a Cursor .mdc rule when Cursor is present', () => {
    const s = step(
      buildPlan(input({ claudeCli: false, cursorPresent: true, cursorRuleContent: null })),
      AGENT_RULE_STEP,
    );
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.write?.path).toBe('.cursor/rules/reticle.mdc');
    expect(s.write?.content).toContain('alwaysApply: true');
  });

  it('Cursor rule step is ALREADY only when the .mdc holds the CURRENT rule', () => {
    const current = cursorRuleFile();
    const s = step(
      buildPlan(input({ claudeCli: false, cursorPresent: true, cursorRuleContent: current })),
      AGENT_RULE_STEP,
    );
    expect(s.status).toBe(StepStatus.ALREADY);
  });

  /**
   * The Cursor rule was gated on the file EXISTING, while CLAUDE.md compares content and refreshes.
   * So a Cursor project that ran init once kept that release's rule text forever — a rule about a
   * field introduced later (`version_skew`) could never reach it, on the only agent surface those
   * projects have.
   */
  it('refreshes a STALE Cursor rule instead of calling it done', () => {
    const s = step(
      buildPlan(
        input({
          claudeCli: false,
          cursorPresent: true,
          cursorRuleContent: '---\nalwaysApply: true\n---\n\n## Verifying with Reticle\n\nold text',
        }),
      ),
      AGENT_RULE_STEP,
    );
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.write?.content).toContain('version_skew');
  });

  it('falls back to AGENTS.md when neither Claude nor Cursor is detected', () => {
    const s = step(
      buildPlan(input({ claudeCli: false, cursorPresent: false, agentsMdContent: null })),
      AGENT_RULE_STEP,
    );
    expect(s.status).toBe(StepStatus.APPLY);
    expect(s.write?.path).toBe('AGENTS.md');
  });

  it('is skipped entirely under --no-mcp (rule rides with the tool wiring)', () => {
    const plan = buildPlan(
      input({ options: { port: undefined, mcp: false, install: false }, claudeCli: false }),
    );
    expect(maybeStep(plan, AGENT_RULE_STEP)).toBeUndefined();
  });
});

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

describe('buildPlan — CRA pairing token', () => {
  const TOKEN_STEP = 'Pairing token';
  const craPlan = (partial: Partial<PlanInput> = {}): ReturnType<typeof buildPlan> =>
    buildPlan(
      input({
        detection: detection(Framework.CRA),
        craEntry: { path: 'src/index.tsx', source: "import React from 'react';\n" },
        ...partial,
      }),
    );

  it('warns that the env file is gitignored, so a teammate cloning must run init too', () => {
    const written = maybeStep(craPlan({ pairingToken: 'tok-1' }), TOKEN_STEP);
    expect(StepStatus.APPLY).toBe(written?.status);
    expect(written?.detail).toContain('gitignored');
  });

  it('says the token is missing rather than reporting a clean install with no token step at all', () => {
    // No daemon has ever run, so ~/.reticle/pairing-token does not exist. The plan used to simply
    // omit the step: init read all-green and the app could never pair.
    const missing = maybeStep(craPlan({ pairingToken: '' }), TOKEN_STEP);
    expect(StepStatus.MANUAL).toBe(missing?.status);
    expect(missing?.detail).toContain('reticle start');
  });

  it('stays quiet when the correct token is already in the env file', () => {
    const plan = craPlan({ pairingToken: 'tok-1', craEnv: 'REACT_APP_RETICLE_TOKEN=tok-1\n' });
    expect(undefined).toBe(maybeStep(plan, TOKEN_STEP));
  });

  /**
   * The caveat was already written — and attached to a line the reader is told to skip.
   *
   * `SKILL.md` instructs whoever reads the report: *"If every line is `✓`, `·` or `–`, skip to Step 4
   * and validate. The manual sections below exist for the `⚠` lines only."* The gitignore warning
   * lives in the `detail` of an APPLY step, which renders `[✓]`. So the install is documented as
   * conditional in a place the documented reading protocol says to ignore.
   *
   * That is why the report reached us as "4 OK marks and no warning": the words were on screen and
   * the reader was following instructions.
   *
   * The step itself must STAY `APPLY` — `run.ts:603` is `if (s.status !== StepStatus.APPLY) continue`,
   * so a NOTICE step never writes, and demoting it would silently stop writing the token and break
   * the install outright. The fix is a SEPARATE notice beside it, the same shape
   * `unverifiedUiLibraryNote` already uses.
   */
  it('raises a NOTICE beside the write, because a caveat on a ✓ line is one the reader is told to skip', () => {
    const plan = craPlan({ pairingToken: 'tok-1' });
    const written = maybeStep(plan, TOKEN_STEP);
    expect(StepStatus.APPLY, 'the step must still WRITE — only APPLY steps do').toBe(
      written?.status,
    );

    const notice = plan.steps.find((s) => s.status === StepStatus.NOTICE);
    expect(
      notice,
      'nothing tells a reader who skips ✓ lines that this install is per-machine',
    ).toBeDefined();
    expect(notice?.detail).toContain('gitignore');
    expect(notice?.detail, 'name the consequence: a fresh clone cannot pair').toMatch(
      /clone|teammate|CI/i,
    );
  });

  it('the notice does not appear when there is no token to write', () => {
    const plan = craPlan({ pairingToken: '', craEnv: null });
    const notice = plan.steps.find(
      (s) => s.status === StepStatus.NOTICE && s.detail.includes('gitignore'),
    );
    expect(
      notice,
      'nothing was written, so there is nothing per-machine to warn about',
    ).toBeUndefined();
  });
});

describe('buildPlan — Next', () => {
  const NEXT_CONFIG_SRC = 'const nextConfig = {};\nexport default nextConfig;\n';
  const LAYOUT_SRC =
    'export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n';

  const nextPlan = (partial: Partial<PlanInput> = {}): ReturnType<typeof buildPlan> =>
    buildPlan(
      input({
        detection: detection(Framework.NEXT),
        nextConfigFile: 'next.config.ts',
        nextConfigSource: NEXT_CONFIG_SRC,
        nextLayout: { path: 'app/layout.tsx', source: LAYOUT_SRC },
        ...partial,
      }),
    );

  it('wires all three Next files with no hand edits left', () => {
    const plan = nextPlan();
    expect(step(plan, 'ReticleDev component').status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Next config (withReticle)').status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Mount ReticleDev').status).toBe(StepStatus.APPLY);
  });

  it('the generated connect presents the pairing token — without it the bridge refuses', () => {
    const content = step(nextPlan(), 'ReticleDev component').write?.content ?? '';
    expect(content).toContain('NEXT_PUBLIC_RETICLE_TOKEN');
    expect(content).toContain('token');
  });

  it('puts the component next to the layout, so a --src-dir app imports something that exists', () => {
    const plan = nextPlan({
      nextLayout: { path: 'src/app/layout.tsx', source: LAYOUT_SRC },
      nextReticleDevPath: 'src/app/reticle-dev.tsx',
    });
    expect(step(plan, 'ReticleDev component').write?.path).toBe('src/app/reticle-dev.tsx');
    expect(step(plan, 'Mount ReticleDev').write?.path).toBe('src/app/layout.tsx');
  });

  it('falls back to the hand-edit instructions when a file is missing or unrecognised', () => {
    const plan = nextPlan({ nextConfigSource: null, nextLayout: null });
    expect(step(plan, 'Next config (withReticle)').status).toBe(StepStatus.MANUAL);
    expect(step(plan, 'Mount ReticleDev').status).toBe(StepStatus.MANUAL);
  });

  it('marks reticle-dev.tsx already when it exists', () => {
    expect(step(nextPlan({ nextReticleDevExists: true }), 'ReticleDev component').status).toBe(
      StepStatus.ALREADY,
    );
  });
});

describe('buildPlan — HTML', () => {
  it('registers MCP globally plus a manual connect snippet', () => {
    const plan = buildPlan(input({ detection: detection(Framework.HTML, 0) }));
    expect(step(plan, CLAUDE_STEP).status).toBe(StepStatus.APPLY);
    expect(step(plan, 'Connect snippet').status).toBe(StepStatus.MANUAL);
  });
});

describe('SvelteKit gets the Vite plugin, not only the client hook', () => {
  const svelteKit = (viteConfig: PlanInput['viteConfig']): ReturnType<typeof buildPlan> =>
    buildPlan(input({ detection: detection(Framework.SVELTEKIT, 0), viteConfig }));

  it('patches vite.config so .svelte components are actually stamped', () => {
    // `init` already installed @reticlehq/vite-plugin for SvelteKit and then never wired it in, so
    // it sat in package.json doing nothing — which is why a SvelteKit app connected fine and every
    // verdict came back with no file:line.
    const plan = svelteKit({ path: 'vite.config.ts', source: VITE_SRC });
    const step = maybeStep(plan, 'Vite plugin');
    expect(step?.status).toBe(StepStatus.APPLY);
    expect(step?.write?.content).toContain('reticle()');
    expect(step?.detail).toContain('data-reticle-source');
  });

  it('still wires the client hook, which is what registers the session', () => {
    const plan = svelteKit(null);
    expect(maybeStep(plan, 'Reticle client hook')).toBeDefined();
  });

  it('falls back to manual instructions when there is no vite config to patch', () => {
    expect(maybeStep(svelteKit(null), 'Vite plugin')?.status).toBe(StepStatus.MANUAL);
  });
});

/**
 * A Vue or Preact app used to get `@reticlehq/react` installed and an all-green report — the report
 * claimed support the project does not have. It now says so in the plan itself.
 */
describe('buildPlan — non-React apps are marked unverified', () => {
  const libStep = (lib: UiLibrary) =>
    maybeStep(
      buildPlan(input({ detection: detection(Framework.VITE, 0, lib) })),
      `${lib} is UNVERIFIED`,
    );

  it('flags Vue and Preact apps as a NOTICE — worth reading, but not work to do', () => {
    for (const lib of [UiLibrary.VUE, UiLibrary.PREACT] as const) {
      const s = libStep(lib);
      // Not MANUAL: the app is wired and working, it is just not covered by a gate. Counting this as
      // an outstanding step made "steps remaining" a number that could never reach zero.
      expect(s?.status).toBe(StepStatus.NOTICE);
      expect(s?.detail).toContain('data-reticle-source');
    }
  });

  it('an UNVERIFIED stack still reports zero manual steps when everything applied', () => {
    const plan = buildPlan(
      input({
        detection: detection(Framework.VITE, 0, UiLibrary.PREACT),
        viteConfig: { path: 'vite.config.ts', source: VITE_SRC },
        options: { port: undefined, mcp: true, install: true },
      }),
    );
    expect(plan.steps.filter((s) => s.status === StepStatus.MANUAL)).toEqual([]);
  });

  it('says nothing for React, and does not double up on SvelteKit (which has its own note)', () => {
    expect(libStep(UiLibrary.REACT)).toBeUndefined();
    expect(
      maybeStep(
        buildPlan(input({ detection: detection(Framework.SVELTEKIT, 0, UiLibrary.SVELTE) })),
        'svelte is UNVERIFIED',
      ),
    ).toBeUndefined();
  });
});

describe('buildPlan — the Cursor rule is a project file, not a machine-wide one', () => {
  const rule = (partial: Partial<PlanInput>) =>
    maybeStep(buildPlan(input({ cursorPresent: true, ...partial })), AGENT_RULE_STEP);

  it('is not written into a Claude Code project just because ~/.cursor exists', () => {
    expect(rule({ claudeCli: true, cursorProjectPresent: false })?.write?.path).toBe('CLAUDE.md');
    const steps = buildPlan(
      input({ cursorPresent: true, claudeCli: true, cursorProjectPresent: false }),
    ).steps;
    expect(steps.some((s) => '.cursor/rules/reticle.mdc' === s.write?.path)).toBe(false);
  });

  it('is written when the repo itself has a .cursor dir', () => {
    const steps = buildPlan(
      input({ cursorPresent: true, claudeCli: true, cursorProjectPresent: true }),
    ).steps;
    expect(steps.some((s) => '.cursor/rules/reticle.mdc' === s.write?.path)).toBe(true);
  });

  it('is written when Cursor is the only agent found', () => {
    expect(rule({ claudeCli: false, cursorProjectPresent: false })?.write?.path).toBe(
      '.cursor/rules/reticle.mdc',
    );
  });
});

describe('buildPlan — Astro', () => {
  /**
   * Astro was the last gated stack whose wiring `init` printed and did not apply — the only ⚠ left
   * on a supported framework. With a config and exactly one layout in hand, both halves are written.
   */
  it('APPLIES both halves when there is a config and exactly one layout', () => {
    const plan = buildPlan(
      input({
        detection: detection(Framework.ASTRO, 19),
        astroConfig: {
          path: 'astro.config.mjs',
          source:
            "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
        },
        astroLayout: {
          path: 'src/layouts/Layout.astro',
          source: '<html><body><slot /></body></html>\n',
        },
      }),
    );
    const config = step(plan, 'Astro config (token + build target)');
    expect(config.status).toBe(StepStatus.APPLY);
    expect(config.write?.content).toContain('__RETICLE_TOKEN__');
    const layout = step(plan, 'Connect snippet (Astro)');
    expect(layout.status).toBe(StepStatus.APPLY);
    expect(layout.write?.path).toBe('src/layouts/Layout.astro');
    expect(layout.write?.content).toContain('reticle.connect');
  });

  it('falls back to the printed recipe when the layout is ambiguous', () => {
    const plan = buildPlan(
      input({
        detection: detection(Framework.ASTRO, 19),
        astroConfig: { path: 'astro.config.mjs', source: 'export default defineConfig({});\n' },
        astroLayout: null, // zero or several candidates — not init's decision to make
      }),
    );
    expect(step(plan, 'Connect snippet (Astro)').status).toBe(StepStatus.MANUAL);
  });

  it('gets Astro-specific instructions, not the generic HTML connect snippet', () => {
    const plan = buildPlan(input({ detection: detection(Framework.ASTRO, 19) }));
    expect(maybeStep(plan, 'Connect snippet')).toBeUndefined();
    const s = step(plan, 'Connect snippet (Astro)');
    expect(s.status).toBe(StepStatus.MANUAL);
    // The three things that are Astro-specific and wrong in the generic advice.
    expect(s.detail).toContain('__RETICLE_TOKEN__');
    expect(s.detail).toContain('es2022');
    expect(s.detail).toContain('<script>');
  });

  it('installs the kit but no bundler plugin — Astro owns its own Vite', () => {
    const s = step(
      buildPlan(input({ detection: detection(Framework.ASTRO, 19) })),
      'Install dependencies',
    );
    expect(s.detail).toContain('@reticlehq/react');
    expect(s.detail).not.toContain('@reticlehq/vite-plugin');
  });
});

/**
 * `pnpm add -D @reticlehq/react` installed 2.2.1 in one project while npm and yarn took 2.3.0 in the
 * next — a stale registry metadata cache, invisible to everyone. A version-skewed SDK against a newer
 * daemon is the -32000 path: the app connects, the protocol disagrees, and nothing names a version.
 */
describe('buildPlan — the SDK is pinned to the CLI version', () => {
  const installStepOf = (sdkVersion?: string) =>
    step(
      buildPlan(
        input({
          detection: detection(Framework.VITE),
          options: {
            port: undefined,
            mcp: true,
            install: true,
            ...(sdkVersion !== undefined ? { sdkVersion } : {}),
          },
        }),
      ),
      'Install dependencies',
    );

  it('asks for the exact version, so a stale cache cannot pick a different one', () => {
    const s = installStepOf('2.3.1');
    expect(s.detail).toContain('@reticlehq/react@2.3.1');
    expect(s.detail).toContain('@reticlehq/vite-plugin@2.3.1');
    expect(s.exec?.args).toContain('@reticlehq/react@2.3.1');
  });

  it('falls back to unpinned when no version is known, rather than installing garbage', () => {
    expect(installStepOf(undefined).detail).toContain('@reticlehq/react');
    expect(installStepOf(undefined).detail).not.toContain('@undefined');
  });
});

/**
 * The generated connect component ships into a JavaScript project as `.jsx`, where SWC parses it as
 * plain JS. A TypeScript cast in the body — `(globalThis as Record<string, unknown>)` — therefore
 * failed to compile and every route served 500: installing Reticle stopped the app booting, for the
 * second time, in the same file. The extension was fixed; the BODY was not. So assert on the body.
 */
describe('the generated Next component is valid JavaScript', () => {
  const body = (): string => {
    const plan = buildPlan(
      input({
        detection: detection(Framework.NEXT),
        nextConfigFile: 'next.config.js',
        nextConfigSource: 'module.exports = {};\n',
        nextLayout: {
          path: 'pages/_app.js',
          source:
            'export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n',
        },
        nextReticleDevPath: 'components/reticle-dev.jsx',
      }),
    );
    return step(plan, 'ReticleDev component').write?.content ?? '';
  };

  it('contains no TypeScript-only syntax', () => {
    const src = body();
    expect(src, 'an `as` cast does not parse as JavaScript').not.toMatch(
      /\bas\s+(Record|any|unknown|string)\b/,
    );
    expect(src, 'a type annotation does not parse as JavaScript').not.toMatch(
      /:\s*Record<|:\s*string\b|<[A-Z]\w*>/,
    );
  });

  it('carries the capabilities scaffold too — only the Vite path used to get one', () => {
    const plan = buildPlan(
      input({
        detection: detection(Framework.NEXT),
        nextConfigFile: 'next.config.ts',
        nextConfigSource: 'export default {};\n',
        nextLayout: { path: 'app/layout.tsx', source: '<html><body>{children}</body></html>' },
        testids: ['pay', 'nav-home'],
        storeHints: ["registerStore('app', store)"],
      }),
    );
    const src = step(plan, 'ReticleDev component').write?.content ?? '';
    expect(src).toContain('registerCapabilities');
    expect(src).toContain("'pay'");
    // Commented, for the same reason as everywhere else: we cannot know which module exports it.
    for (const line of src.split('\n')) {
      if (line.includes('registerStore')) expect(line.trimStart().startsWith('//')).toBe(true);
    }
  });

  it('still passes the root through, just as a connect option instead of a global assignment', () => {
    const src = body();
    expect(src).toContain('NEXT_PUBLIC_RETICLE_ROOT');
    expect(src).toContain('root');
    expect(src).not.toContain('globalThis');
  });
});
