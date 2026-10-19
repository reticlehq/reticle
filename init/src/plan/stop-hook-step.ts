/**
 * `init --hooks`: the print-only Claude Code Stop hook, merged into `.claude/settings.json`.
 *
 * Opt-in, because it writes into a file the user and other tools own. When the agent stops without a
 * single claim having held, the hook prints one line saying so; it never blocks the agent. The line
 * itself is `reticle report --hook`, which reads the session journal on disk.
 */
import { RETICLE_NPM_PACKAGE } from '@/version.js';
import { StepStatus, type Step } from './plan-types.js';
import {
  PROMPT_HOOK_AGENTS,
  PromptHookAgent,
  PromptHookStatus,
  installPromptHook,
  promptHookCommand,
  type PromptHookTarget,
} from '@/register/prompt-hooks.js';

export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';
export const STOP_HOOK_COMMAND = `npx ${RETICLE_NPM_PACKAGE} report --hook`;

const TITLE = 'Claude Code Stop hook';
const STOP_EVENT = 'Stop';
const HOOK_ENTRY = { hooks: [{ type: 'command', command: STOP_HOOK_COMMAND }] };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  'object' === typeof value && null !== value && !Array.isArray(value);

/** The settings as an object, or undefined when the text is not one. */
function parseSettings(text: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function stopHookStep(path: string, existing: string | null | undefined): Step {
  const settings = null === existing || undefined === existing ? {} : parseSettings(existing);
  if (settings === undefined) {
    return {
      title: TITLE,
      target: path,
      status: StepStatus.MANUAL,
      detail: `${CLAUDE_SETTINGS_PATH} is not a JSON object, so it was left alone. Add a Stop hook running \`${STOP_HOOK_COMMAND}\``,
    };
  }
  const hooks = isObject(settings['hooks']) ? settings['hooks'] : {};
  const stop = Array.isArray(hooks[STOP_EVENT]) ? (hooks[STOP_EVENT] as unknown[]) : [];
  if (JSON.stringify(stop).includes(STOP_HOOK_COMMAND)) {
    return {
      title: TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'hook already installed',
    };
  }
  const merged = { ...settings, hooks: { ...hooks, [STOP_EVENT]: [...stop, HOOK_ENTRY] } };
  return {
    title: TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail: 'print one line when the agent stops without a claim that held; never blocks it',
    write: { path, content: `${JSON.stringify(merged, null, 2)}\n`, expect: [STOP_HOOK_COMMAND] },
  };
}

/**
 * The Claude Code `SessionStart` hook with matcher `compact`: right after a compaction it prints
 * `reticle context --compact` — what this session proved, what failed, what is still owed — back
 * into the agent's fresh context. Reticle holds the memory; this is how it is handed back without
 * the agent having to remember to ask.
 *
 * Written by default wherever the CLAUDE.md rule is (it only reads the project's own `.reticle/`, and
 * prints nothing where there is none). Removable like any hook: delete the entry.
 */
export const COMPACT_HOOK_COMMAND = `npx ${RETICLE_NPM_PACKAGE} context --compact`;
const COMPACT_TITLE = 'Claude Code resume-after-compaction hook';
const SESSION_START_EVENT = 'SessionStart';
const COMPACT_MATCHER = 'compact';

export function compactHookStep(path: string, existing: string | null | undefined): Step {
  const settings = null === existing || undefined === existing ? {} : parseSettings(existing);
  if (settings === undefined) {
    return {
      title: COMPACT_TITLE,
      target: path,
      status: StepStatus.MANUAL,
      detail: `${CLAUDE_SETTINGS_PATH} is not a JSON object, so it was left alone. Add a SessionStart hook (matcher "${COMPACT_MATCHER}") running \`${COMPACT_HOOK_COMMAND}\``,
    };
  }
  const hooks = isObject(settings['hooks']) ? settings['hooks'] : {};
  const start = Array.isArray(hooks[SESSION_START_EVENT])
    ? (hooks[SESSION_START_EVENT] as unknown[])
    : [];
  if (JSON.stringify(start).includes(COMPACT_HOOK_COMMAND)) {
    return {
      title: COMPACT_TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'hook already installed',
    };
  }
  const entry = {
    matcher: COMPACT_MATCHER,
    hooks: [{ type: 'command', command: COMPACT_HOOK_COMMAND }],
  };
  const merged = { ...settings, hooks: { ...hooks, [SESSION_START_EVENT]: [...start, entry] } };
  return {
    title: COMPACT_TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail:
      'after a context compaction, hand the agent back what this session proved and still owes',
    write: {
      path,
      content: `${JSON.stringify(merged, null, 2)}\n`,
      expect: [COMPACT_HOOK_COMMAND],
    },
  };
}

/**
 * Every hook this run writes into `.claude/settings.json`, each merged on top of the one before, so
 * two steps writing the same file cannot undo each other.
 */
export function claudeSettingsSteps(
  path: string,
  existing: string | null | undefined,
  options: { stop: boolean; compact: boolean; prompt?: boolean; bin?: string | undefined },
): Step[] {
  const steps: Step[] = [];
  let current = existing;
  if (options.stop) {
    const stop = stopHookStep(path, current);
    steps.push(stop);
    current = stop.write?.content ?? current;
  }
  if (options.compact) {
    const compact = compactHookStep(path, current);
    steps.push(compact);
    current = compact.write?.content ?? current;
  }
  const claude = PROMPT_HOOK_AGENTS.find((agent) => PromptHookAgent.CLAUDE_CODE === agent.id);
  if (true === options.prompt && claude !== undefined)
    steps.push(
      promptHookStep({
        spec: claude,
        path,
        existing: current ?? null,
        ...(options.bin === undefined ? {} : { bin: options.bin }),
      }),
    );
  return steps;
}

/**
 * The prompt-capture hook, for each agent found. On by default, because the request is what a
 * verdict is checked against and an agent forgets to relay it. `--no-prompt-capture` skips it;
 * `"promptCapture": false` in `.reticle.json` keeps the hook from writing; `reticle hook uninstall`
 * removes exactly what this added.
 */
const PROMPT_TITLE = 'Prompt capture';
const NOTICE_TARGET = '.reticle/request.json';

/** The consent line. Names where prompts go and every way to switch it off. */
export const PROMPT_CAPTURE_NOTICE =
  'Each prompt you send is saved, with secrets removed, to .reticle/ in this project. ' +
  'While you are signed in and the project is linked, it syncs with its runs to your own workspace. ' +
  'Turn off: --no-prompt-capture, "promptCapture": false in .reticle.json, or `reticle hook uninstall`. ' +
  'Stop background sync: "backgroundSync": false in .reticle.json, or RETICLE_BACKGROUND_SYNC=0.';

export function promptHookStep(target: PromptHookTarget): Step {
  const { spec, path, existing, bin } = target;
  const title = `${PROMPT_TITLE}: ${spec.label}`;
  const merged = installPromptHook(spec, existing, bin);
  const then = spec.activation === undefined ? '' : `. ${spec.activation}`;
  if (PromptHookStatus.ALREADY === merged.status) {
    return {
      title,
      target: path,
      status: StepStatus.ALREADY,
      detail: `hook already installed${then}`,
    };
  }
  if (PromptHookStatus.MANUAL === merged.status) {
    return {
      title,
      target: path,
      status: StepStatus.MANUAL,
      detail: `${path} is not plain JSON, so it was left alone. Add a prompt-submit hook that runs \`${promptHookCommand(spec.id)}\` (${spec.docs})`,
    };
  }
  return {
    title,
    target: path,
    status: StepStatus.APPLY,
    detail: `save each prompt to .reticle/ before the agent reads it; never blocks the prompt${then}`,
    write: { path, content: merged.content, expect: [promptHookCommand(spec.id)] },
  };
}

/** The steps for every detected agent, then the one consent line when any hook is in place. */
export function promptHookSteps(
  targets: readonly PromptHookTarget[],
  claude: boolean,
  bin?: string,
): Step[] {
  const steps = targets.map((target) =>
    promptHookStep(bin === undefined ? target : { ...target, bin }),
  );
  if (0 === steps.length && !claude) return steps;
  return [
    ...steps,
    {
      title: PROMPT_TITLE,
      target: NOTICE_TARGET,
      status: StepStatus.NOTICE,
      detail: PROMPT_CAPTURE_NOTICE,
    },
  ];
}
