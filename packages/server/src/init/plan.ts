/**
 * Pure assembly of the `reticle init` action plan. Given the detection result and the relevant file
 * contents, produce an ordered list of steps — each marked apply / manual / already / skip. The
 * runner performs the `write` side-effects; this module decides *what* should happen.
 */

import { Framework, installCommand, installCommandParts, type Detection } from './detect.js';
import { claudeAddCommand, mcpManual } from './mcp.js';
import { mergeCursorConfig, CursorMergeStatus, cursorServerEntry } from './cursor.js';
import { patchViteConfig, VitePatchKind } from './vite-config.js';
import {
  viteManual,
  htmlManual,
  NEXT_LAYOUT_MANUAL,
  nextReticleDevFile,
  NEXT_RETICLE_DEV_PATH,
  nextConfigManual,
  reticleConfigContent,
  svelteKitHooksFile,
  SVELTEKIT_HOOKS_PATH,
} from './snippets.js';

const RETICLE_PACKAGE = '@reticle/core';
const MCP_TARGET = 'global (claude user scope)';
const RETICLE_CONFIG_FILE = '.reticle.json';

export const StepStatus = {
  APPLY: 'apply',
  MANUAL: 'manual',
  ALREADY: 'already',
  SKIP: 'skip',
} as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

interface Step {
  title: string;
  target: string;
  status: StepStatus;
  detail: string;
  /** Present only when status is APPLY and a file must be written. */
  write?: { path: string; content: string };
  /** Present only when status is APPLY and a subprocess must run (the dependency install). */
  exec?: { command: string; args: string[]; fallback: string };
}

export interface Plan {
  framework: Framework;
  steps: Step[];
}

export interface PlanInput {
  detection: Detection;
  /** Whether the `claude` CLI is installed (so we can register the MCP server globally). */
  claudeCli: boolean;
  /** Whether an `reticle` MCP server is already registered with Claude (any scope) — idempotency. */
  mcpExists: boolean;
  /** Whether Cursor is installed for this user (its global config dir exists). */
  cursorPresent: boolean;
  /** Current ~/.cursor/mcp.json content, or null if absent. */
  cursorConfig: string | null;
  /** Absolute path of ~/.cursor/mcp.json (the write target). */
  cursorConfigPath: string;
  /** Discovered Vite config: its path + source, or null if none found. */
  viteConfig: { path: string; source: string } | null;
  /** Discovered Next config filename (e.g. 'next.config.mjs'), or null. */
  nextConfigFile: string | null;
  /** Whether app/reticle-dev.tsx already exists. */
  nextReticleDevExists: boolean;
  /** Whether src/hooks.client.ts already exists (SvelteKit idempotency). */
  svelteKitHooksExists?: boolean;
  /** Whether .reticle.json already exists in the project root (idempotency). */
  reticleConfigExists?: boolean;
  options: {
    port: number | undefined;
    mcp: boolean;
    install: boolean;
    /** Stable project identity derived at init (package.json name + root). Baked into snippets/.reticle.json. */
    projectId?: string;
  };
}

const CLAUDE_MCP_TITLE = 'MCP server (Claude, global)';
const CURSOR_MCP_TITLE = 'MCP server (Cursor, global)';

function claudeMcpStep(input: PlanInput): Step | null {
  if (!input.claudeCli) return null;
  if (input.mcpExists) {
    return {
      title: CLAUDE_MCP_TITLE,
      target: MCP_TARGET,
      status: StepStatus.ALREADY,
      detail: 'reticle already registered (install once, used by every project)',
    };
  }
  const cmd = claudeAddCommand();
  return {
    title: CLAUDE_MCP_TITLE,
    target: MCP_TARGET,
    status: StepStatus.APPLY,
    detail: 'register reticle globally for all projects',
    exec: { command: cmd.command, args: cmd.args, fallback: cmd.display },
  };
}

function cursorMcpStep(input: PlanInput): Step | null {
  if (!input.cursorPresent) return null;
  const r = mergeCursorConfig(input.cursorConfig);
  if (r.status === CursorMergeStatus.ALREADY) {
    return {
      title: CURSOR_MCP_TITLE,
      target: input.cursorConfigPath,
      status: StepStatus.ALREADY,
      detail: 'reticle already in Cursor global config',
    };
  }
  if (r.status === CursorMergeStatus.MANUAL) {
    return {
      title: CURSOR_MCP_TITLE,
      target: input.cursorConfigPath,
      status: StepStatus.MANUAL,
      detail: `couldn't parse ${input.cursorConfigPath} — add this server by hand:\n  "reticle": ${JSON.stringify(cursorServerEntry())}`,
    };
  }
  return {
    title: CURSOR_MCP_TITLE,
    target: input.cursorConfigPath,
    status: StepStatus.APPLY,
    detail: 'register reticle in Cursor global config',
    write: { path: input.cursorConfigPath, content: r.content },
  };
}

/** One global registration per detected agent (Claude + Cursor). Falls back to a manual note. */
function mcpSteps(input: PlanInput): Step[] {
  if (!input.options.mcp) {
    return [
      {
        title: 'MCP server (global)',
        target: MCP_TARGET,
        status: StepStatus.SKIP,
        detail: '--no-mcp',
      },
    ];
  }
  const steps = [claudeMcpStep(input), cursorMcpStep(input)].filter((s): s is Step => s !== null);
  if (steps.length > 0) return steps;
  // No supported agent detected — print the one-time global instructions.
  return [
    {
      title: 'MCP server (global)',
      target: MCP_TARGET,
      status: StepStatus.MANUAL,
      detail: mcpManual(),
    },
  ];
}

function installStep(input: PlanInput): Step {
  const pm = input.detection.packageManager;
  const command = installCommand(pm, RETICLE_PACKAGE);
  if (!input.options.install) {
    return {
      title: 'Install dependency',
      target: 'package.json',
      status: StepStatus.MANUAL,
      detail: command,
    };
  }
  const parts = installCommandParts(pm, RETICLE_PACKAGE);
  return {
    title: 'Install dependency',
    target: 'package.json',
    status: StepStatus.APPLY,
    detail: command,
    exec: { command: parts.command, args: parts.args, fallback: command },
  };
}

function viteSteps(input: PlanInput): Step[] {
  const cfg = input.viteConfig;
  const port = input.options.port;
  if (cfg === null) {
    return [
      {
        title: 'Vite plugin',
        target: 'vite.config',
        status: StepStatus.MANUAL,
        detail: viteManual(port),
      },
    ];
  }
  const patch = patchViteConfig(cfg.source, port);
  if (patch.kind === VitePatchKind.ALREADY) {
    return [
      {
        title: 'Vite plugin',
        target: cfg.path,
        status: StepStatus.ALREADY,
        detail: 'reticle() already in plugins',
      },
    ];
  }
  if (patch.kind === VitePatchKind.MANUAL) {
    return [
      {
        title: 'Vite plugin',
        target: cfg.path,
        status: StepStatus.MANUAL,
        detail: `${patch.reason}\n\n${viteManual(port)}`,
      },
    ];
  }
  return [
    {
      title: 'Vite plugin',
      target: cfg.path,
      status: StepStatus.APPLY,
      detail: 'add reticle() to plugins (also injects connect())',
      write: { path: cfg.path, content: patch.code },
    },
  ];
}

function nextSteps(input: PlanInput): Step[] {
  const configFile = input.nextConfigFile ?? 'next.config.mjs';
  const devFile: Step = input.nextReticleDevExists
    ? {
        title: 'ReticleDev component',
        target: NEXT_RETICLE_DEV_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists',
      }
    : {
        title: 'ReticleDev component',
        target: NEXT_RETICLE_DEV_PATH,
        status: StepStatus.APPLY,
        detail: 'create dev-only connect component',
        write: {
          path: NEXT_RETICLE_DEV_PATH,
          content: nextReticleDevFile(input.options.port, input.options.projectId),
        },
      };
  return [
    devFile,
    {
      title: 'Next config (withReticle)',
      target: configFile,
      status: StepStatus.MANUAL,
      detail: nextConfigManual(configFile),
    },
    {
      title: 'Mount ReticleDev',
      target: 'app/layout.tsx',
      status: StepStatus.MANUAL,
      detail: NEXT_LAYOUT_MANUAL,
    },
  ];
}

function svelteKitSteps(input: PlanInput): Step[] {
  // SvelteKit can't use the Vite-plugin injection (renders via app.html) — wire a client hook that
  // SvelteKit runs on startup. This is verified to register a session where the plugin does not.
  if (input.svelteKitHooksExists === true) {
    return [
      {
        title: 'Reticle client hook',
        target: SVELTEKIT_HOOKS_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists',
      },
    ];
  }
  return [
    {
      title: 'Reticle client hook',
      target: SVELTEKIT_HOOKS_PATH,
      status: StepStatus.APPLY,
      detail: 'create dev-only client connect (SvelteKit renders via app.html)',
      write: {
        path: SVELTEKIT_HOOKS_PATH,
        content: svelteKitHooksFile(input.options.port, input.options.projectId),
      },
    },
  ];
}

function reticleConfigStep(input: PlanInput): Step {
  if (input.reticleConfigExists === true) {
    return {
      title: 'Reticle config',
      target: RETICLE_CONFIG_FILE,
      status: StepStatus.ALREADY,
      detail: '.reticle.json already exists',
    };
  }
  const content = reticleConfigContent(
    input.detection.framework,
    input.options.port,
    input.options.projectId,
  );
  return {
    title: 'Reticle config',
    target: RETICLE_CONFIG_FILE,
    status: StepStatus.APPLY,
    detail: 'write project config (framework + port)',
    write: { path: RETICLE_CONFIG_FILE, content },
  };
}

export function buildPlan(input: PlanInput): Plan {
  const steps: Step[] = [...mcpSteps(input), installStep(input), reticleConfigStep(input)];
  if (input.detection.framework === Framework.VITE) {
    steps.push(...viteSteps(input));
  } else if (input.detection.framework === Framework.NEXT) {
    steps.push(...nextSteps(input));
  } else if (input.detection.framework === Framework.SVELTEKIT) {
    steps.push(...svelteKitSteps(input));
  } else {
    steps.push({
      title: 'Connect snippet',
      target: 'index.html',
      status: StepStatus.MANUAL,
      detail: htmlManual(input.options.port, input.options.projectId),
    });
  }
  return { framework: input.detection.framework, steps };
}
