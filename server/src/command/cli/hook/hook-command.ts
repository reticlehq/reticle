/**
 * `reticle hook install|uninstall|status|prompt`: the prompt-capture hook, outside `init`.
 *
 * `init` installs the hook for the agents it finds. These are the same steps on their own: add it
 * to a project wired before the hook existed, remove exactly what was added, or say per agent
 * whether prompts are captured. `prompt` is what the agent hook itself runs.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MCP_FALLBACK_AGENTS,
  PROMPT_CAPTURE_NOTICE,
  PROMPT_HOOK_AGENTS,
  PromptHookStatus,
  claudeAvailableProbe,
  installPromptHook,
  promptHookInstalled,
  promptHookNpxOnly,
  promptHookTargets,
  uninstallPromptHook,
} from '@reticlehq/init';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { discoverProjectConfigs } from '@/command/cli/config/config-discovery.js';
import { projectSetting } from '@/memory/intent/record-request.js';
import { capturePrompt, hookAck } from './prompt-hook.js';
import { captureToolCall, toolHookAck } from './tool-hook.js';
import { AT_FLAG, PROMPT_WRITE_ACTION, TOOL_WRITE_ACTION, hookBinFor } from './hook-fast.js';
import { exportStructure } from './episode-structure.js';

const HookAction = {
  PROMPT: 'prompt',
  /** What the agent's post-tool hook runs: one of the agent's own tool calls. */
  TOOL: 'tool',
  /** The episodes, for a dataset: `--structure` is the text-free page structure per step. */
  EXPORT: 'export',
  INSTALL: 'install',
  UNINSTALL: 'uninstall',
  STATUS: 'status',
} as const;
const AGENT_FLAG = '--agent';
const STRUCTURE_FLAG = '--structure';
/** An agent hook that names none is Claude Code's: the stand-in this command replaces was. */
const DEFAULT_AGENT = 'claude-code';
/** The payload is a few kilobytes. More than this is not a prompt payload, and is not read. */
const MAX_STDIN_BYTES = 1024 * 1024;
/** A hook whose agent never closes stdin must still end, and let the prompt through. */
const STDIN_WAIT_MS = 3_000;
const OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
const fileIo = { exists: existsSync, readFile: readText };

/** The project folder `cwd` belongs to: the nearest `.reticle.json` above it, else `cwd`. */
export function projectDirOf(cwd: string): string {
  return discoverProjectConfigs(cwd).found[0]?.directory ?? cwd;
}

export function claudeCliHere(): boolean {
  const probe = claudeAvailableProbe();
  return 0 === spawnSync(probe.command, probe.args, { stdio: 'ignore', timeout: 5_000 }).status;
}

/** The payload on stdin, bounded in size and in time. Never rejects. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const done = (): void => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, STDIN_WAIT_MS);
    timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (MAX_STDIN_BYTES < data.length) {
        data = '';
        done();
      }
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

/**
 * One row per agent: does it capture prompts here, through its hook or the MCP instructions, or is
 * capture off. `reticle doctor` prints the same rows.
 */
export function promptCaptureRows(
  projectDir: string,
  home: string,
  env: NodeJS.ProcessEnv,
  claudeCli: boolean,
): string[] {
  if (OFF_VALUES.has((env[ReticleEnv.PROMPT_CAPTURE] ?? '').toLowerCase())) {
    return [`off on this machine (${ReticleEnv.PROMPT_CAPTURE})`];
  }
  if (false === projectSetting(projectDir, 'promptCapture')) {
    return ['off in this project ("promptCapture": false in .reticle.json)'];
  }
  const targets = promptHookTargets(fileIo, projectDir, home, claudeCli, join);
  // Where the bin can run directly (not Windows), an npx-only install is slower than it needs to be.
  const direct = hookBinFor(home, process.platform) !== undefined;
  const rows = targets.map((t) => {
    if (!promptHookInstalled(t.spec, t.existing))
      return `✗ ${t.spec.label}: no hook; run \`reticle hook install\``;
    const slow =
      direct && promptHookNpxOnly(t.spec, t.existing)
        ? `, through npx (~400 ms slower per call); run \`reticle hook install\` to run it directly`
        : '';
    return `✓ ${t.spec.label}: hook installed (${t.path})${slow}${t.spec.activation === undefined ? '' : `. ${t.spec.activation}`}`;
  });
  rows.push(`MCP instructions only: ${MCP_FALLBACK_AGENTS.join(', ')}`);
  return rows;
}

function install(cwd: string, print: (line: string) => void): number {
  const projectDir = projectDirOf(cwd);
  const targets = promptHookTargets(fileIo, projectDir, homedir(), claudeCliHere(), join);
  if (0 === targets.length) {
    print('No agent with a prompt hook is used here. The MCP instructions cover the others.');
    return 0;
  }
  let failed = 0;
  for (const target of targets) {
    const merged = installPromptHook(
      target.spec,
      target.existing,
      hookBinFor(homedir(), process.platform),
    );
    if (PromptHookStatus.ALREADY === merged.status) {
      print(`✓ ${target.spec.label}: already installed (${target.path})`);
    } else if (PromptHookStatus.MANUAL === merged.status) {
      failed++;
      print(`✗ ${target.spec.label}: ${target.path} is not plain JSON, so it was left alone`);
    } else {
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, merged.content);
      print(`✓ ${target.spec.label}: installed (${target.path})`);
    }
    if (target.spec.activation !== undefined) print(`  ${target.spec.activation}`);
  }
  print(PROMPT_CAPTURE_NOTICE);
  return 0 === failed ? 0 : 1;
}

/** Remove our entry from every config any agent reads here. Other entries stay. */
function uninstall(cwd: string, print: (line: string) => void): number {
  const projectDir = projectDirOf(cwd);
  let removed = 0;
  for (const spec of PROMPT_HOOK_AGENTS) {
    for (const rel of spec.paths) {
      const path = join(projectDir, rel);
      const out = uninstallPromptHook(spec, readText(path));
      if (!out.changed) continue;
      removed++;
      if (null === out.content) rmSync(path, { force: true });
      else writeFileSync(path, out.content);
      print(`✓ ${spec.label}: removed (${path})`);
    }
  }
  if (0 === removed) print('No prompt-capture hook was installed here.');
  return 0;
}

export async function handleHook(
  argv: readonly string[],
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const action = argv[0] ?? HookAction.STATUS;
  const cwd = process.cwd();
  // `prompt` normally never reaches here either: the fast path answers it and runs `prompt-write`.
  if (HookAction.PROMPT === action || PROMPT_WRITE_ACTION === action) {
    const at = argv.indexOf(AGENT_FLAG);
    const agent = (-1 === at ? undefined : argv[at + 1]) ?? DEFAULT_AGENT;
    // The fast path's writer is told when the prompt arrived; run directly, it is now.
    const given = Number(argv[argv.indexOf(AT_FLAG) + 1]);
    const arrived = -1 !== argv.indexOf(AT_FLAG) && Number.isFinite(given) ? given : Date.now();
    capturePrompt(agent, await readStdin(), { cwd, env: process.env, now: () => arrived });
    if (HookAction.PROMPT === action) process.stdout.write(hookAck(agent));
    return 0;
  }
  // `tool` normally never reaches here: `bin/reticle.js` answers it on the fast path and runs
  // `tool-write`, the capture itself, in a detached child. Both write the same record.
  if (HookAction.TOOL === action || TOOL_WRITE_ACTION === action) {
    const at = argv.indexOf(AGENT_FLAG);
    const agent = (-1 === at ? undefined : argv[at + 1]) ?? DEFAULT_AGENT;
    const payload = await readStdin();
    captureToolCall(agent, payload, { cwd, env: process.env, now: () => Date.now() });
    if (HookAction.TOOL === action) process.stdout.write(toolHookAck(agent, payload));
    return 0;
  }
  if (HookAction.EXPORT === action) {
    if (!argv.includes(STRUCTURE_FLAG)) {
      print(
        `hook export needs ${STRUCTURE_FLAG}: the text-free page structure is the only export.`,
      );
      return 1;
    }
    const root = join(projectDirOf(cwd), ReticleDir.ROOT);
    const summary = exportStructure(root, (line) => process.stdout.write(`${line}\n`));
    process.stderr.write(
      `${String(summary.steps)} snapshot steps exported; ${String(summary.skippedCut)} cut short and skipped\n`,
    );
    return 0;
  }
  if (HookAction.INSTALL === action) return install(cwd, print);
  if (HookAction.UNINSTALL === action) return uninstall(cwd, print);
  if (HookAction.STATUS === action) {
    const rows = promptCaptureRows(projectDirOf(cwd), homedir(), process.env, claudeCliHere());
    for (const row of rows) print(row);
    return 0;
  }
  print(
    `unknown hook action: ${action}. Use install, uninstall, status, prompt --agent <id>, tool --agent <id> or export --structure.`,
  );
  return 1;
}
