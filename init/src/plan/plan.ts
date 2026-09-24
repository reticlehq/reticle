/**
 * Pure assembly of the `reticle init` action plan. Given the detection result and the relevant file
 * contents, produce an ordered list of steps — each marked apply / manual / already / skip. The
 * runner performs the `write` side-effects; this module decides *what* should happen.
 */

import {
  Framework,
  UiLibrary,
  installCommand,
  installCommandParts,
} from '@/detect/detect.js';
import { installFailureHint } from '@/diagnose/install-hint.js';
import { installRetries } from '@/diagnose/install-retries.js';
import { claudeAddCommand, claudeProjectMcpJson, mcpManual } from '@/register/mcp.js';
import {
  mergeClientConfig,
  ClientMergeStatus,
  clientSnippet,
  clientSpec,
  McpClient,
} from '@/register/mcp-clients.js';
import {
  CLAUDE_COMMAND_PATH,
  CURSOR_COMMAND_PATH,
  SLASH_COMMAND_BODY,
  SLASH_COMMAND_SIGNATURE,
} from '@/register/slash-command.js';
import {
  mergeMarkedInstruction,
  reticleMdFile,
  cursorRuleFile,
  AgentRuleStatus,
  CLAUDE_MD_PATH,
  markedBlock,
  AGENTS_MD_PATH,
  RETICLE_MD_PATH,
  CURSOR_RULE_PATH,
} from '@/project/agent-rules.js';
import { cspStep } from './plan-framework.js';
import { frameworkSteps } from './framework-adapter.js';
import { FRAMEWORK_ADAPTERS, RETICLE_BROWSER_SDK, RETICLE_REACT_KIT } from './framework-adapter.js';
import {
  MCP_TARGET,
  StepStatus,
  type Step,
  type Plan,
  type PlanInput,
} from './plan-types.js';
export {
  DEPS_TARGET,
  MCP_TARGET,
  StepStatus,
  type Step,
  type Plan,
  type PlanInput,
} from './plan-types.js';
import { join } from 'node:path';
import { reticleConfigContent } from '@/patch/snippets.js';
import { configWithInstallSource } from '@/project/install-source-config.js';
import { containerisedStep, uiLibraryStep, webGlCanvasStep, windowsMcpNoteStep } from './notices.js';
import { existingConfigProblem, projectIdOf, RETICLE_CONFIG_FILE } from '@/detect/existing-config.js';

// Re-exported: it moved to the module that reads it, and every existing importer says `plan.js`.
export { RETICLE_CONFIG_FILE };

/**
 * Pin the SDK to the CLI's own version.
 *
 * `pnpm add -D @reticlehq/react` once installed an older release in one project while npm and yarn
 * took the current one in the next — a stale registry metadata cache, invisible to everyone. A
 * version-skewed SDK talking to a newer daemon is the `-32000` failure path: the app connects, the
 * protocol disagrees, and nothing on either side names a version. Asking for the CLI's exact version
 * makes the cache irrelevant, and a skewed pair impossible to install by accident.
 */
function pinnedPackages(
  packages: readonly string[],
  version: string | undefined,
): readonly string[] {
  if (version === undefined || 0 === version.length) return packages;
  return packages.map((p) => `${p}@${version}`);
}

/**
 * Does this codebase want the React kit, or the framework-neutral sensor?
 *
 * The kit is what adds component identity — component names and stacks — and it is worth having
 * wherever React or Preact is rendering (the adapter reaches Preact through `preact/compat`).
 * Everywhere else it is a package named `@reticlehq/react`, carrying `react` in its peer
 * dependencies, being installed into a codebase that has no React in it.
 *
 * UNKNOWN keeps the kit deliberately. Absence of evidence is not evidence of Vue, and guessing
 * "sensor" on no information silently drops component identity from apps that should have it.
 */
function wantsReactKit(ui: UiLibrary): boolean {
  return ui !== UiLibrary.VUE && ui !== UiLibrary.SVELTE;
}

/**
 * The dev-dependencies `reticle init` installs — kit (or sensor) first, build plugin next.
 *
 * `uiLibrary` matters because the framework does not always name the renderer. The rule below was
 * already written for Nuxt, correctly, and applied only there: a Vue app on plain Vite is
 * `Framework.VITE` and a SvelteKit app renders Svelte, and both were being handed the React kit
 * right after `init` had detected the real UI library and said so on screen.
 */
export function frameworkPackages(
  framework: Framework,
  uiLibrary: UiLibrary = UiLibrary.UNKNOWN,
): readonly string[] {
  const kit = wantsReactKit(uiLibrary) ? RETICLE_REACT_KIT : RETICLE_BROWSER_SDK;
  return FRAMEWORK_ADAPTERS[framework].packages(kit);
}


/**
 * Where the agent-facing files go, which is not always where the app is.
 *
 * Reported from the field (#318): a repo with its app at `src/admin` got `.claude/commands/reticle.md`
 * written into the app directory, while the human's agent session runs at the repo root — so
 * `/reticle` did not exist for them at all until they copied it up by hand. The rule and command
 * files are read by the AGENT, so they belong where the agent stands; the app files stay with the
 * app. The two are the same directory in a single-package repo, which is why this went unnoticed.
 */
function agentFile(input: PlanInput, relPath: string): string {
  const root = input.agentFileRoot;
  return root === undefined || 0 === root.length ? relPath : join(root, relPath);
}

const CLAUDE_MCP_TITLE = 'MCP server (Claude, global)';

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

/**
 * One step per OTHER detected client.
 *
 * The shapes differ enough that a shared "write mcp.json" would be wrong for three of them — see
 * mcp-clients.ts. What is shared is the DECISION: already-correct is left alone, a file we cannot
 * parse is reported with a paste-able block rather than overwritten, and everything else is written.
 */
function otherClientSteps(input: PlanInput): Step[] {
  const steps: Step[] = [];
  for (const detected of input.detectedClients ?? []) {
    const spec = clientSpec(detected.id);
    const merged = mergeClientConfig(spec, detected.existing);
    const title = `MCP server (${spec.label})`;
    if (merged.status === ClientMergeStatus.ALREADY) {
      steps.push({
        title,
        target: detected.configPath,
        status: StepStatus.ALREADY,
        detail: `reticle already registered with ${spec.label}`,
      });
      continue;
    }
    if (merged.status === ClientMergeStatus.MANUAL) {
      // Either the file did not parse, or the format is one we refuse to edit blind (TOML). Both
      // end the same way: say so, and hand over the exact block.
      steps.push({
        title,
        target: detected.configPath,
        status: StepStatus.MANUAL,
        detail: `add this to ${detected.configPath} by hand:\n${clientSnippet(spec)}`,
      });
      continue;
    }
    steps.push({
      title,
      target: detected.configPath,
      status: StepStatus.APPLY,
      detail: `register reticle with ${spec.label}`,
      write: { path: detected.configPath, content: merged.content },
    });
  }
  return steps;
}

/** One global registration per detected agent (Claude + Cursor). Falls back to a manual note. */
function mcpSteps(input: PlanInput): Step[] {
  if (!input.options.mcp) {
    return [
      {
        title: 'MCP server (global)',
        target: MCP_TARGET,
        status: StepStatus.SKIP,
        // Names everything it turns off. `--no-mcp` reads like "skip one step" and skips three: the
        // registration, the agent rule files, and the /reticle command. A gate running with this flag
        // therefore covers far less than its name suggests, which is worth saying out loud.
        detail:
          '--no-mcp — also skips the agent rule files (CLAUDE.md / AGENTS.md / .cursor) and the /reticle command',
      },
    ];
  }
  // Claude and Cursor first (they have their own registration paths), then every other detected
  // client. A machine with Cursor AND Windsurf gets both — registering only the first one found is
  // how a user ends up with Reticle in the editor they were not using.
  const steps = [...stepsForAgents(input, (a) => a.mcpStep), ...otherClientSteps(input)];
  if (0 === steps.length) {
    // No agent detected. mcpManual already carries the Windows cmd fallback — do not append it again.
    return [
      {
        title: 'MCP server (global)',
        target: MCP_TARGET,
        status: StepStatus.MANUAL,
        detail: mcpManual(),
      },
    ];
  }
  /*
   * Claude Code never leaves the plan without a word (#1071).
   *
   * It is the only client detected by CLI-on-PATH rather than by its config, so inside a Claude Code
   * VS Code extension session — where `claude` is not on PATH — it reads as absent while the user is
   * sitting in it. `claudeMcpStep` then returned null, and the manual fallback below only fires when
   * NO agent at all was found. With Gemini and Codex present, Claude Code vanished from the plan
   * entirely and nothing said so. A step that disappears is exactly what the install gate's baseline
   * diff exists to catch, and the plan is the one artifact a person reads to learn what init did.
   *
   * Only when something else WAS found. With nothing found, the generic note below already says how
   * to register, so nothing has silently vanished — and leaving that path untouched keeps every
   * pristine scaffold in the install baseline reading exactly as it did.
   */
  if (!input.claudeCli && steps.length > 0) {
    steps.push({
      title: CLAUDE_MCP_TITLE,
      target: MCP_TARGET,
      // NOTICE, not MANUAL. Nothing here FAILED and the reader may not use Claude Code at all, so
      // this is something to know rather than work owed — and the install gate asserts zero `⚠`,
      // which would turn an informational line into a gate failure on any machine that happens to
      // have another agent's config. A notice prints in full exactly like a manual step.
      status: StepStatus.NOTICE,
      detail: `no \`claude\` on PATH, so it could not be registered from here. Inside a Claude Code VS Code extension session the CLI is genuinely absent while the editor is not — add ${claudeProjectMcpJson()}`,
    });
  }
  const windowsNote = windowsMcpNoteStep(input);
  if (windowsNote !== null) steps.push(windowsNote);
  return steps;
}



const SLASH_COMMAND_TITLE = 'The /reticle command';

/**
 * Nothing to do for this command file: it already holds the CURRENT body, or it is not ours at all.
 *
 * Gating on mere existence froze the command at whatever release wrote it. Rewriting anything found
 * there would be worse — a human may have claimed `/reticle` for their own prompt — so a file without
 * our signature is left exactly as it is.
 */
function commandIsSettled(content: string | null | undefined): boolean {
  if (null === content || content === undefined) return false;
  return content === SLASH_COMMAND_BODY || !content.includes(SLASH_COMMAND_SIGNATURE);
}

/**
 * `/reticle` — the entry point SKILL.md promises in three places and nothing ever created, so it
 * silently did nothing in every tool.
 *
 * CURRENT, not merely present — same reason as the Cursor rule: a command file frozen at whatever
 * release created it is a command that can never be improved for anyone who already ran init. The
 * whole file is Reticle's, so a stale one is rewritten.
 */
function commandStepFor(
  path: string,
  present: boolean,
  content: string | null | undefined,
): Step | null {
  if (!present) return null;
  return commandIsSettled(content)
    ? {
        title: SLASH_COMMAND_TITLE,
        target: path,
        status: StepStatus.ALREADY,
        detail: 'command already exists',
      }
    : {
        title: SLASH_COMMAND_TITLE,
        target: path,
        status: StepStatus.APPLY,
        detail: 'type /reticle to verify one flow in the browser',
        write: { path, content: SLASH_COMMAND_BODY },
      };
}

function claudeCommandStep(input: PlanInput): Step | null {
  return commandStepFor(
    agentFile(input, CLAUDE_COMMAND_PATH),
    input.claudeCli,
    input.claudeCommandContent,
  );
}

function cursorCommandStep(input: PlanInput): Step | null {
  const cursorGlobal = (input.detectedClients ?? []).some((c) => c.id === McpClient.CURSOR);
  const present = true === input.cursorProjectPresent || (cursorGlobal && !input.claudeCli);
  return commandStepFor(agentFile(input, CURSOR_COMMAND_PATH), present, input.cursorCommandContent);
}

const AGENT_RULE_TITLE = 'Agent verification rule';
const AGENT_RULE_DETAIL = 'teach the agent to verify features with Reticle after building them';

/**
 * What this step is about to do to a file somebody else already writes in.
 *
 * Creating an instruction file and APPENDING to an existing one are different acts, and the plan
 * said the same sentence for both. Reported from the field on a monorepo audit: `init` appended 68
 * lines to `CLAUDE.md` — the repo's binding agent contract, the file every agent there reads first —
 * described only as "teach the agent to verify features with Reticle after building them". The
 * reporter reverted the whole install.
 *
 * `--dry-run` already exists, so the consent mechanism was never missing; what was missing was the
 * plan telling the truth loudly enough to act on. A reader deciding whether to allow this needs the
 * SIZE and the fact that the file is already theirs — both of which are known here and were being
 * withheld. The markers are named too, because a reversible edit and an irreversible one are also
 * different acts, and this one is reversible.
 */
function ruleWriteDetail(existing: string | null | undefined, file: string): string {
  const hasContent = existing !== null && existing !== undefined && existing.trim().length > 0;
  if (!hasContent) return `${AGENT_RULE_DETAIL} — creates ${file}`;
  const added = markedBlock().split('\n').length - 1;
  return (
    `${AGENT_RULE_DETAIL} — APPENDS ${String(added)} lines to your existing ${file}, ` +
    'inside `reticle:begin`/`reticle:end` markers; delete the marked block to undo'
  );
}
const RETICLE_MD_TITLE = 'Full agent rules';
const RETICLE_MD_DETAIL =
  'the reference the always-loaded rule points at (when NOT to verify, recovery, feedback)';

function claudeRuleStep(input: PlanInput): Step | null {
  if (!input.claudeCli) return null;
  const path = agentFile(input, CLAUDE_MD_PATH);
  const r = mergeMarkedInstruction(input.claudeMdContent);
  if (r.status === AgentRuleStatus.ALREADY) {
    return {
      title: AGENT_RULE_TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'Reticle rule already in CLAUDE.md',
    };
  }
  return {
    title: AGENT_RULE_TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail: ruleWriteDetail(input.claudeMdContent, CLAUDE_MD_PATH),
    write: { path, content: r.content },
  };
}

/**
 * The Cursor rule is a PROJECT file, so it is written only when Cursor plausibly works on THIS
 * project — the repo has a `.cursor/` dir, or Cursor is the only agent found. `~/.cursor` merely
 * existing on the machine meant every Claude Code user got an unexplained `.cursor/rules/reticle.mdc`
 * committed into their repo. (Global MCP registration is different: it is global, and stays.)
 */
function cursorRuleStep(input: PlanInput): Step | null {
  const cursorGlobal = (input.detectedClients ?? []).some((c) => c.id === McpClient.CURSOR);
  if (!cursorGlobal && true !== input.cursorProjectPresent) return null;
  if (input.cursorProjectPresent !== true && input.claudeCli) return null;
  // The whole file is Reticle's — init created it — so a stale one is REWRITTEN rather than merged.
  // Comparing content is what makes the rule updatable; comparing existence made it permanent.
  const path = agentFile(input, CURSOR_RULE_PATH);
  if (input.cursorRuleContent === cursorRuleFile()) {
    return {
      title: AGENT_RULE_TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'Reticle rule already in .cursor/rules',
    };
  }
  return {
    title: AGENT_RULE_TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail: AGENT_RULE_DETAIL,
    write: { path, content: cursorRuleFile() },
  };
}

/**
 * Every coding agent `reticle init` knows how to wire itself into, and the three surfaces it wires:
 * the global MCP registration, the project rule file that makes the agent USE Reticle, and the
 * `/reticle` command.
 *
 * One list, because those three surfaces used to enumerate Claude and Cursor separately in three
 * places — so supporting a fourth agent meant finding all three and getting each right. Adding one
 * is now an entry here plus its builders; each builder answers null when that agent is not present
 * for this user or this project, which is also how "no agent detected" falls through to the
 * cross-agent AGENTS.md.
 *
 * Deliberately functions rather than data: registering with Claude runs its CLI while Cursor merges
 * a JSON file, and pretending those are the same shape would cost more than it saves.
 */
const AgentId = {
  CLAUDE: 'claude',
  CURSOR: 'cursor',
} as const;
type AgentId = (typeof AgentId)[keyof typeof AgentId];

interface AgentIntegration {
  readonly id: AgentId;
  /** Global MCP registration. Omit when the generic `otherClientSteps` loop handles it. */
  readonly mcpStep?: (input: PlanInput) => Step | null;
  /** The project instruction file this agent re-reads every session. */
  readonly ruleStep: (input: PlanInput) => Step | null;
  /** The project slash-command file, for agents that have a command surface. */
  readonly commandStep: (input: PlanInput) => Step | null;
}

const AGENT_INTEGRATIONS: readonly AgentIntegration[] = [
  {
    id: AgentId.CLAUDE,
    mcpStep: claudeMcpStep,
    ruleStep: claudeRuleStep,
    commandStep: claudeCommandStep,
  },
  {
    id: AgentId.CURSOR,
    ruleStep: cursorRuleStep,
    commandStep: cursorCommandStep,
  },
];

/** The steps one surface contributes across every known agent, in registry order. */
function stepsForAgents(
  input: PlanInput,
  surface: (a: AgentIntegration) => ((input: PlanInput) => Step | null) | undefined,
): Step[] {
  return AGENT_INTEGRATIONS.map((a) => surface(a)?.(input) ?? null).filter(
    (s): s is Step => s !== null,
  );
}

/** The `/reticle` command file for every agent that has a command surface and is present here. */
function slashCommandSteps(input: PlanInput): Step[] {
  return stepsForAgents(input, (a) => a.commandStep);
}

/**
 * `AGENTS.md`, always. It is the file every agent that is not Claude or Cursor reads.
 *
 * This used to be a FALLBACK, written only when no agent was detected. So a repo set up on a machine
 * with Claude Code got `CLAUDE.md` and nothing else, and the next person to open it with Codex,
 * Copilot, Amp, Gemini or any other agent found a fully instrumented app whose rules were addressed
 * to somebody else's tool. The detection tells you which agent is running the install; it says
 * nothing about which agents will open the repository afterwards.
 */
function agentsMdStep(input: PlanInput): Step {
  const r = mergeMarkedInstruction(input.agentsMdContent);
  const path = agentFile(input, AGENTS_MD_PATH);
  if (r.status === AgentRuleStatus.ALREADY) {
    return {
      title: AGENT_RULE_TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'Reticle rule already in AGENTS.md',
    };
  }
  return {
    title: AGENT_RULE_TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail: ruleWriteDetail(input.agentsMdContent, AGENTS_MD_PATH),
    write: { path, content: r.content },
  };
}

/**
 * `RETICLE.md`, the reference the always-loaded blocks point at.
 *
 * Written whole rather than merged, because `init` owns the entire file: there is no user content to
 * preserve, and the marker dance exists only for files somebody else already writes in.
 */
function reticleMdStep(input: PlanInput): Step {
  const path = agentFile(input, RETICLE_MD_PATH);
  const content = reticleMdFile();
  if (input.reticleMdContent === content) {
    return {
      title: RETICLE_MD_TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'full rules already current',
    };
  }
  return {
    title: RETICLE_MD_TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail: RETICLE_MD_DETAIL,
    write: { path, content },
  };
}

/**
 * The behavioral rules that make the agent actually USE Reticle, and know when not to.
 *
 * Every detected agent's own file, plus `AGENTS.md` for the ones that will open this repo later, plus
 * `RETICLE.md` holding the reference half. Rides with the MCP wiring: `--no-mcp` opts out of
 * registering the tools AND of every rule file, because rules for tools the agent cannot reach are
 * noise.
 */
function agentRuleSteps(input: PlanInput): Step[] {
  if (!input.options.mcp) return [];
  return [...stepsForAgents(input, (a) => a.ruleStep), agentsMdStep(input), reticleMdStep(input)];
}

/**
 * What to say when the install command fails.
 *
 * pnpm's `minimumReleaseAge` refuses any release younger than the configured window — a deliberate
 * supply-chain policy, not a bug — with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Unpinned it silently
 * resolves to an OLDER version instead, which is how an app ends up running a stale SDK against a
 * newer daemon: the connection succeeds, the protocol disagrees, and the failure surfaces as -32000
 * with nothing naming a version. Pinning turns that into this loud failure, which is the better
 * trade — but only if the message says what to do about it.
 */

function installStep(input: PlanInput): Step {
  const pm = input.detection.packageManager;
  const packages = pinnedPackages(
    frameworkPackages(input.detection.framework, input.detection.uiLibrary),
    input.options.sdkVersion,
  );
  const command = installCommand(pm, packages);
  if (!input.options.install) {
    return {
      title: 'Install dependencies',
      target: 'package.json',
      status: StepStatus.MANUAL,
      detail: command,
    };
  }
  const parts = installCommandParts(pm, packages);
  return {
    title: 'Install dependencies',
    target: 'package.json',
    status: StepStatus.APPLY,
    detail: command,
    exec: {
      command: parts.command,
      args: parts.args,
      fallback: `${command}\n\n${installFailureHint(pm)}`,
    },
    retries: installRetries(
      pm,
      packages,
      frameworkPackages(input.detection.framework, input.detection.uiLibrary),
      input.options.sdkVersion,
    ),
  };
}

const RETICLE_CONFIG_TITLE = 'Reticle config';
const AGENT_ROOT_CONFIG_TITLE = 'Reticle config (agent root)';

/**
 * The SECOND `.reticle.json`, in the directory the agent runs from.
 *
 * `.reticle.json` is not app wiring — nothing in the app reads it. The CLI and `reticle mcp` read it
 * from their own CWD (see cli-port), and that CWD is the repo root, not the app directory a redirect
 * wired. Reported from the field: an app in `frontend/` on a non-default bridge port left the root
 * with no config at all, so `reticle mcp` fell back to 4400 — which on that machine was ANOTHER
 * project's daemon, and `reticle_sessions` would have listed a different app's tabs while the wired
 * app sat unseen. Nothing in the report said so; every step was green.
 *
 * Written in BOTH places rather than moved: a human standing in the app runs `reticle status` there,
 * and the two files are byte-identical, so neither can disagree with the other about the port or the
 * project identity.
 */

function agentRootConfigStep(input: PlanInput, content: string): Step[] {
  const root = input.agentFileRoot;
  if (root === undefined || 0 === root.length) return [];
  const path = agentFile(input, RETICLE_CONFIG_FILE);
  const existingProject = projectIdOf(input.agentRootConfigSource);
  const wantedProject = projectIdOf(content);
  /**
   * A monorepo has more than one app and the root can only point at one of them.
   *
   * ABSENT and CONFLICTING used to share this branch, so the second got the first's treatment and
   * its reassuring wording. Reported from the field: two instrumented apps, a root config naming
   * the first, and `init --app <the second>` repointed the root with no warning -- after which an
   * agent started at the root reads one project's config and drives another. That is the
   * silent-wrong-target failure this product exists to prevent, shipped by its own installer.
   *
   * Neither answer is ours to pick. Overwriting discards the other app's identity; skipping quietly
   * leaves the agent aimed away from the app just wired. So the conflict is NAMED and nothing is
   * written -- the app's own config is still correct either way, so the app is fully instrumented
   * and only the root pointer is left for a human to decide.
   */
  if (
    existingProject !== undefined &&
    wantedProject !== undefined &&
    existingProject !== wantedProject
  ) {
    return [
      {
        title: AGENT_ROOT_CONFIG_TITLE,
        target: path,
        status: StepStatus.NOTICE,
        detail:
          `left alone: it names project "${existingProject}", not "${wantedProject}". An agent ` +
          'started here would read that project and drive this one. Point it at whichever app ' +
          'this agent should verify, or run the agent from the app directory.',
      },
    ];
  }
  if (input.agentRootConfigSource === content) {
    return [
      {
        title: AGENT_ROOT_CONFIG_TITLE,
        target: path,
        status: StepStatus.ALREADY,
        detail: 'the agent already reads the same project config',
      },
    ];
  }
  return [
    {
      title: AGENT_ROOT_CONFIG_TITLE,
      target: path,
      status: StepStatus.APPLY,
      detail:
        'the same config where the agent runs — `reticle mcp` reads it from ITS cwd, and without ' +
        'it the agent talks to whatever daemon is on the default port',
      write: { path, content },
    },
  ];
}

function reticleConfigStep(input: PlanInput, content: string): Step {
  if (true === input.reticleConfigExists) {
    const problem = existingConfigProblem(input.reticleConfigSource);
    if (problem !== undefined) {
      // `ℹ`, not `·`: the step is done and something about the result still stops things working,
      // which is the one mark that says "there is something here to read".
      return {
        title: RETICLE_CONFIG_TITLE,
        target: RETICLE_CONFIG_FILE,
        status: StepStatus.NOTICE,
        detail: problem,
      };
    }
    // The one thing a re-run can still learn: which channel the user actually arrived through.
    // See configWithInstallSource — it only ever ADDS a field that is absent.
    const backfilled = configWithInstallSource(input.reticleConfigSource, input.installSource);
    if (backfilled !== undefined) {
      return {
        title: RETICLE_CONFIG_TITLE,
        target: RETICLE_CONFIG_FILE,
        status: StepStatus.APPLY,
        detail: 'record which install route this project came through',
        write: { path: RETICLE_CONFIG_FILE, content: backfilled },
      };
    }
    return {
      title: RETICLE_CONFIG_TITLE,
      target: RETICLE_CONFIG_FILE,
      status: StepStatus.ALREADY,
      detail: '.reticle.json already exists',
    };
  }
  return {
    title: RETICLE_CONFIG_TITLE,
    target: RETICLE_CONFIG_FILE,
    status: StepStatus.APPLY,
    detail: 'write project config (framework + port)',
    write: { path: RETICLE_CONFIG_FILE, content },
  };
}

/**
 * The project config, in every directory that has to read it: the app's, and — after a redirect —
 * the one the agent runs from. One content string for both, so they cannot disagree; an existing
 * app-side config wins over a freshly derived one, or a re-run would copy a DIFFERENT identity up.
 */
function reticleConfigSteps(input: PlanInput): Step[] {
  const existing = input.reticleConfigSource;
  const content =
    true === input.reticleConfigExists && null !== existing && existing !== undefined
      ? existing
      : reticleConfigContent(
          input.detection.framework,
          input.options.port,
          input.options.projectId,
          // Only when it is actually known. Writing `unknown` would be indistinguishable from a
          // config written before this field existed, and the two mean different things.
          input.installSource,
        );
  return [reticleConfigStep(input, content), ...agentRootConfigStep(input, content)];
}


export function buildPlan(input: PlanInput): Plan {
  const steps: Step[] = [
    ...cspStep(input),
    ...mcpSteps(input),
    ...agentRuleSteps(input),
    ...slashCommandSteps(input),
    ...uiLibraryStep(input),
    ...webGlCanvasStep(input),
    installStep(input),
    ...reticleConfigSteps(input),
  ];
  steps.push(...frameworkSteps(input));
  // LAST, and a notice rather than an action: it is a statement about this machine's shape, and it
  // only matters once every file above has been written. See containerised-dev-server.ts.
  const container = containerisedStep(input);
  if (container !== null) steps.push(container);
  return { framework: input.detection.framework, uiLibrary: input.detection.uiLibrary, steps };
}
