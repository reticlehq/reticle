/**
 * Pure assembly of the `iris init` action plan. Given the detection result and the relevant file
 * contents, produce an ordered list of steps — each marked apply / manual / already / skip. The
 * runner performs the `write` side-effects; this module decides *what* should happen.
 */

import { Framework, installCommand, installCommandParts, type Detection } from './detect.js';
import { mergeMcpConfig, McpMergeStatus, irisServerEntry } from './mcp-config.js';
import { patchViteConfig, VitePatchKind } from './vite-config.js';
import {
  viteManual,
  htmlManual,
  NEXT_LAYOUT_MANUAL,
  nextIrisDevFile,
  NEXT_IRIS_DEV_PATH,
  nextConfigManual,
  mcpManual,
} from './snippets.js';

const IRIS_PACKAGE = '@syrin/iris';
const MCP_FILE = '.mcp.json';

export const StepStatus = {
  APPLY: 'apply',
  MANUAL: 'manual',
  ALREADY: 'already',
  SKIP: 'skip',
} as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export interface Step {
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
  /** Current `.mcp.json` content, or null if absent. */
  mcpJson: string | null;
  /** Discovered Vite config: its path + source, or null if none found. */
  viteConfig: { path: string; source: string } | null;
  /** Discovered Next config filename (e.g. 'next.config.mjs'), or null. */
  nextConfigFile: string | null;
  /** Whether app/iris-dev.tsx already exists. */
  nextIrisDevExists: boolean;
  options: { port: number | undefined; mcp: boolean; install: boolean };
}

function mcpStep(input: PlanInput): Step {
  if (!input.options.mcp) {
    return { title: 'MCP config', target: MCP_FILE, status: StepStatus.SKIP, detail: '--no-mcp' };
  }
  const r = mergeMcpConfig(input.mcpJson, input.options.port);
  if (r.status === McpMergeStatus.ALREADY) {
    return {
      title: 'MCP config',
      target: MCP_FILE,
      status: StepStatus.ALREADY,
      detail: 'iris server already configured',
    };
  }
  if (r.status === McpMergeStatus.MANUAL) {
    return {
      title: 'MCP config',
      target: MCP_FILE,
      status: StepStatus.MANUAL,
      detail: mcpManual(irisServerEntry(input.options.port)),
    };
  }
  return {
    title: 'MCP config',
    target: MCP_FILE,
    status: StepStatus.APPLY,
    detail: 'add iris MCP server',
    write: { path: MCP_FILE, content: r.content },
  };
}

function installStep(input: PlanInput): Step {
  const pm = input.detection.packageManager;
  const command = installCommand(pm, IRIS_PACKAGE);
  if (!input.options.install) {
    return {
      title: 'Install dependency',
      target: 'package.json',
      status: StepStatus.MANUAL,
      detail: command,
    };
  }
  const parts = installCommandParts(pm, IRIS_PACKAGE);
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
        detail: 'iris() already in plugins',
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
      detail: 'add iris() to plugins (also injects connect())',
      write: { path: cfg.path, content: patch.code },
    },
  ];
}

function nextSteps(input: PlanInput): Step[] {
  const configFile = input.nextConfigFile ?? 'next.config.mjs';
  const devFile: Step = input.nextIrisDevExists
    ? {
        title: 'IrisDev component',
        target: NEXT_IRIS_DEV_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists',
      }
    : {
        title: 'IrisDev component',
        target: NEXT_IRIS_DEV_PATH,
        status: StepStatus.APPLY,
        detail: 'create dev-only connect component',
        write: { path: NEXT_IRIS_DEV_PATH, content: nextIrisDevFile(input.options.port) },
      };
  return [
    devFile,
    {
      title: 'Next config (withIris)',
      target: configFile,
      status: StepStatus.MANUAL,
      detail: nextConfigManual(configFile),
    },
    {
      title: 'Mount IrisDev',
      target: 'app/layout.tsx',
      status: StepStatus.MANUAL,
      detail: NEXT_LAYOUT_MANUAL,
    },
  ];
}

export function buildPlan(input: PlanInput): Plan {
  const steps: Step[] = [mcpStep(input), installStep(input)];
  if (input.detection.framework === Framework.VITE) {
    steps.push(...viteSteps(input));
  } else if (input.detection.framework === Framework.NEXT) {
    steps.push(...nextSteps(input));
  } else {
    steps.push({
      title: 'Connect snippet',
      target: 'index.html',
      status: StepStatus.MANUAL,
      detail: htmlManual(input.options.port),
    });
  }
  return { framework: input.detection.framework, steps };
}
