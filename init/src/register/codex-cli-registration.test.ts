/**
 * `init` registers Reticle with Codex through its own CLI (#1238).
 *
 * Every other client `init` finds got Reticle registered, while Codex (desktop and CLI) got
 * `[⚠] add this by hand`, because `mergeClientConfig` answers MANUAL for every TOML client. Agents
 * do not paste the block, so a Codex session started with no `reticle_*` tools and no idea why.
 * Claude Code has the same problem and is solved by calling its CLI; Codex has
 * `codex mcp add <name> -- <command>` for the same job, so no TOML is ever edited by us.
 *
 * One property decides how careful this has to be: `codex mcp add` REPLACES an existing entry of the
 * same name and still exits 0. So it runs only when the config names no `reticle` server at all. An
 * entry somebody wrote themselves, in any shape, is theirs and is never overwritten.
 */
import { describe, expect, it } from 'vitest';
import { runInit } from '@/run.js';
import { memoryIo } from '@/memory-io.test-helpers.js';
import { Framework } from '@/detect/detect.js';
import { buildPlan, StepStatus, type Plan, type PlanInput } from '@/plan/plan.js';
import { codexNamesOurServer } from './codex-toml.js';
import { McpClient } from './mcp-clients.js';
import { codexAddCommand, codexAvailableProbe, NPX, npxServerArgs } from './mcp.js';

const KEY = 'mcp_servers';
const CODEX_CONFIG = '/home/u/.codex/config.toml';
const CODEX_TITLE = 'MCP server (Codex CLI)';
const ADD_COMMAND = 'codex mcp add reticle -- npx @reticlehq/server mcp';

const OTHER = '[mcp_servers.other]\ncommand = "foo"\n';
const WIRED = `[mcp_servers.reticle]\ncommand = "${NPX}"\nargs = [${npxServerArgs()
  .map((a) => `"${a}"`)
  .join(', ')}]\n`;
const OWN_BUILD = '[mcp_servers.reticle]\ncommand = "node"\nargs = ["/opt/local/reticle.js"]\n';
const URL_SHAPED = '[mcp_servers.reticle]\nurl = "https://example.test/mcp"\n';
const WRONG_PACKAGE = `[mcp_servers.reticle]\ncommand = "${NPX}"\nargs = ["@reticlehq/core", "mcp"]\n`;
const INLINE_ROOT = 'mcp_servers = { reticle = { url = "https://example.test/mcp" } }\n';
const PROJECT_NAMED_RETICLE = '[projects."/home/u/reticle"]\ntrust_level = "trusted"\n';

describe('codexAddCommand', () => {
  it('registers reticle through `codex mcp add`, the same server every other client gets', () => {
    const cmd = codexAddCommand();

    expect(cmd.command).toBe('codex');
    expect(cmd.args).toEqual(['mcp', 'add', 'reticle', '--', NPX, ...npxServerArgs()]);
    expect(cmd.display).toBe(ADD_COMMAND);
  });

  it('is probed with --version, which launches nothing', () => {
    expect(codexAvailableProbe()).toEqual({ command: 'codex', args: ['--version'] });
  });
});

describe('codexNamesOurServer', () => {
  it('is false for no config and for a config without a reticle server', () => {
    expect(codexNamesOurServer(null, KEY)).toBe(false);
    expect(codexNamesOurServer('', KEY)).toBe(false);
    expect(codexNamesOurServer(OTHER, KEY)).toBe(false);
  });

  it('is true for every shape an entry takes, including ones with no command to read', () => {
    for (const config of [
      WIRED,
      OWN_BUILD,
      URL_SHAPED,
      INLINE_ROOT,
      '[mcp_servers.reticle.env]\nTOKEN = "x"\n',
      '[mcp_servers]\nreticle = { command = "node" }\n',
      'mcp_servers.reticle = { url = "https://example.test/mcp" }\n',
      // Dotted keys inside an inline table, which a `reticle =` pattern alone misses (found in review).
      'mcp_servers = { reticle.command = "node", reticle.args = ["/opt/local/server.js"] }\n',
      'mcp_servers = { other = { command = "foo" }, "reticle".url = "https://example.test/mcp" }\n',
      WIRED.replace('reticle]', '"reticle"]'),
    ]) {
      expect(codexNamesOurServer(config, KEY), config).toBe(true);
    }
  });

  it('is not fooled by the word elsewhere, so a project called reticle does not block registration', () => {
    expect(codexNamesOurServer(PROJECT_NAMED_RETICLE, KEY)).toBe(false);
    expect(codexNamesOurServer('# reticle is registered below\n', KEY)).toBe(false);
    expect(codexNamesOurServer('[mcp_servers.other]\ncommand = "reticle"\n', KEY)).toBe(false);
    // A value that merely starts with the name is not a key, even inside the inline mcp_servers table.
    expect(
      codexNamesOurServer(
        'mcp_servers = { other = { command = "reticle.js", args = ["reticle.js"] } }\n',
        KEY,
      ),
    ).toBe(false);
  });
});

const detection = {
  framework: Framework.VITE,
  packageManager: 'npm' as const,
  hasReact: true,
  deps: {},
};

const base = (partial: Partial<PlanInput>): PlanInput =>
  ({
    detection,
    claudeCli: false,
    mcpExists: false,
    viteConfig: null,
    nextConfigFile: null,
    nextConfigSource: null,
    options: { mcp: true },
    ...partial,
  }) as PlanInput;

const planWith = (
  existing: string | null,
  codexCli: boolean | undefined,
): { plan: Plan; step: Plan['steps'][number] | undefined } => {
  const plan = buildPlan(
    base({
      codexCli,
      detectedClients: [{ id: McpClient.CODEX, configPath: CODEX_CONFIG, existing }],
    }),
  );
  return { plan, step: plan.steps.find((s) => s.title === CODEX_TITLE) };
};

describe('the Codex step in the plan', () => {
  it('runs `codex mcp add` when the CLI is there and the config names no reticle server', () => {
    for (const existing of [null, '', OTHER, PROJECT_NAMED_RETICLE]) {
      const { step } = planWith(existing, true);

      expect(step?.status, `config: ${existing}`).toBe(StepStatus.APPLY);
      expect(step?.exec?.command).toBe('codex');
      expect(step?.exec?.args).toEqual(['mcp', 'add', 'reticle', '--', NPX, ...npxServerArgs()]);
      expect(step?.exec?.fallback, 'what the person is told to run if it fails').toBe(ADD_COMMAND);
      expect(step?.write, 'we never write the TOML ourselves').toBeUndefined();
    }
  });

  it('reports it as already registered on the second run, and runs nothing', () => {
    const { step } = planWith(WIRED, true);

    expect(step?.status).toBe(StepStatus.ALREADY);
    expect(step?.exec).toBeUndefined();
  });

  it('never replaces an entry somebody else wrote, since `codex mcp add` overwrites silently', () => {
    const left = planWith(OWN_BUILD, true).step;
    expect(left?.status, 'their own build is a deliberate choice').toBe(StepStatus.ALREADY);
    expect(left?.exec).toBeUndefined();

    for (const config of [URL_SHAPED, INLINE_ROOT, WRONG_PACKAGE]) {
      const { step } = planWith(config, true);
      expect(step?.status, config).toBe(StepStatus.MANUAL);
      expect(step?.exec, `would overwrite: ${config}`).toBeUndefined();
    }
  });

  it('is manual, with the snippet, when the codex CLI is not on PATH', () => {
    for (const codexCli of [false, undefined]) {
      const { step } = planWith(OTHER, codexCli);

      expect(step?.status).toBe(StepStatus.MANUAL);
      expect(step?.exec).toBeUndefined();
      expect(step?.detail).toContain('[mcp_servers.reticle]');
    }
  });
});

describe('init on a machine with Codex', () => {
  const PROJECT = {
    'package.json': JSON.stringify({
      name: 'a',
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^7.0.0' },
    }),
    'vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({});\n",
  };

  function run(config: string | null, codexInstalled: boolean) {
    const ran: string[] = [];
    // `.codex` is the marker the client is detected by; the config file inside it may not exist yet.
    const home = {
      '/home/u/.codex': '',
      ...(null === config ? {} : { [CODEX_CONFIG]: config }),
    };
    const io = memoryIo({ ...PROJECT, ...home });
    const recorded = {
      ...io,
      probe: (command: string, args: readonly string[]) => {
        ran.push(`probe ${command} ${args.join(' ')}`);
        return codexAvailableProbe().command === command ? codexInstalled : false;
      },
      exec: (command: string, args: readonly string[]) => {
        ran.push(`exec ${command} ${args.join(' ')}`);
        return true;
      },
    };
    runInit(
      { cwd: '/project', port: undefined, mcp: true, install: false, dryRun: false },
      recorded,
    );
    return { ran, io };
  }

  it('registers Reticle with Codex and does not ask for a hand edit', () => {
    const { ran, io } = run(OTHER, true);

    expect(ran).toContain(`exec ${ADD_COMMAND}`);
    expect(io.lines.join('\n')).not.toContain('add this to /home/u/.codex/config.toml by hand');
    expect(io.written[CODEX_CONFIG], 'init never edits the TOML itself').toBeUndefined();
  });

  it('registers even when the config file does not exist yet, since .codex is the marker', () => {
    const { ran } = run(null, true);

    expect(ran).toContain(`exec ${ADD_COMMAND}`);
  });

  it('runs nothing for Codex once it is registered', () => {
    const { ran } = run(WIRED, true);

    expect(ran.filter((c) => c.startsWith('exec codex'))).toEqual([]);
  });

  it('falls back to the manual block when the codex CLI is absent', () => {
    const { ran, io } = run(OTHER, false);

    expect(ran.filter((c) => c.startsWith('exec codex'))).toEqual([]);
    expect(io.lines.join('\n')).toContain('[mcp_servers.reticle]');
  });
});
