/**
 * The prompt-capture hook, in the config of each agent that runs a command when a prompt is sent.
 *
 * The user's request is what a verdict is checked against. An agent relays it with
 * `reticle_intent { declare, request }` only when it remembers to, so the agents that have a
 * prompt-submit hook hand it over themselves: the hook runs `reticle hook prompt`, which writes the
 * prompt into the project's `.reticle/`.
 *
 * Every event name, path and shape here comes from the vendor's documentation, read on 2026-10-14
 * (the `docs` field names the page). The configs are PROJECT-level, so the capture follows the
 * repository. An agent with no prompt hook, or one whose hook format is not documented well enough
 * to write, is not here: it relies on the MCP instructions, which tell the agent to declare the
 * request. A config at a guessed path is one nobody reads, and that looks the same as success.
 *
 * The merge is JSON only, and it never rewrites a file that is not a plain JSON object (comments,
 * trailing commas): the caller prints the entry instead.
 */
import { RETICLE_NPM_PACKAGE, RETICLE_VERSION } from '@/version.js';

export const PromptHookAgent = {
  CLAUDE_CODE: 'claude-code',
  CURSOR: 'cursor',
  CODEX: 'codex',
  GEMINI: 'gemini',
  WINDSURF: 'windsurf',
  /** VS Code agent mode and Copilot CLI: both read `.github/hooks/*.json`. */
  COPILOT: 'copilot',
  FACTORY: 'factory-droid',
} as const;
export type PromptHookAgent = (typeof PromptHookAgent)[keyof typeof PromptHookAgent];

export const PromptHookStatus = {
  APPLY: 'apply',
  ALREADY: 'already',
  MANUAL: 'manual',
} as const;
export type PromptHookStatus = (typeof PromptHookStatus)[keyof typeof PromptHookStatus];

/** The words every version of our command holds, and no other command does. */
export const PROMPT_HOOK_MARKER = ' hook prompt --agent ';
export const AGENT_FLAG = '--agent';
/**
 * Seconds. The hook itself finishes in well under one. The rest is for `npx`, which downloads the
 * pinned version once when its cache does not hold it.
 */
const HOOK_TIMEOUT_S = 30;

/**
 * The command, PINNED to the version that installed it. Unpinned, `npx` runs whatever version its
 * cache holds: on a real machine that was 3.4.0, which has no `hook` command, so every prompt was
 * lost while the hook still exited quietly. A re-run of `init` moves the pin forward.
 */
export const promptHookCommand = (agent: PromptHookAgent): string =>
  `npx -y ${RETICLE_NPM_PACKAGE}@${RETICLE_VERSION}${PROMPT_HOOK_MARKER}${agent}`;

/** The words every version of the post-tool command holds. */
export const TOOL_HOOK_MARKER = ' hook tool --agent ';
/**
 * The post-tool command: keeps one of the agent's own tool calls in `.reticle/episodes/`. Pinned
 * for the same reason as the prompt command.
 */
export const toolHookCommand = (agent: PromptHookAgent): string =>
  `npx -y ${RETICLE_NPM_PACKAGE}@${RETICLE_VERSION}${TOOL_HOOK_MARKER}${agent}`;

/**
 * The agent's own tools worth keeping: shell, edits, and the web. Reads and searches of the local
 * tree are left out: they change nothing, and they are most of the calls.
 */
const RECORDED_TOOLS = 'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch';

/**
 * Claude Code's post-tool entry. `async`, documented on 2026-10-18, runs it in the background, so
 * the `npx` start never slows the agent's next step.
 */
const postToolGroup = (command: string): Record<string, unknown> => ({
  matcher: RECORDED_TOOLS,
  hooks: [{ type: 'command', command, async: true }],
});

/** Claude Code names the model only at SessionStart (`model`) and on PostModelSwitch (`to_model`). */
const modelGroup = (command: string): Record<string, unknown> => ({
  hooks: [{ type: 'command', command, async: true }],
});

/**
 * Codex's post-tool entry: the tool names its reference gives (`Bash`, `apply_patch`), and `async`,
 * which it documents for command hooks (2026-10-18).
 */
const codexPostTool = (command: string): Record<string, unknown> => ({
  matcher: 'Bash|apply_patch',
  hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S, async: true }],
});

/**
 * Cursor's post-tool entry, for the tool names its reference lists (`Shell`, `Write`, `Delete`).
 * Cursor documents no background option, so the agent may wait for each run.
 */
const cursorPostTool = (command: string): Record<string, unknown> => ({
  command,
  matcher: 'Shell|Write|Delete',
});

/**
 * Gemini CLI's AfterTool entry, for the one built-in tool name its reference gives
 * (`run_shell_command`). No background option is documented, and no timeout: the unit is unsettled.
 */
/** An entry that is only the command: Windsurf and Cursor events with no matcher (2026-10-18). */
const commandOnly = (command: string): Record<string, unknown> => ({ command });

/**
 * Copilot CLI's `postToolUse` entry. `matcher` is a full-match regex on `toolName`; `bash` and
 * `edit` are the names its reference shows (2026-10-18). VS Code reads `PostToolUse` from the same
 * file, but its reference gives no input fields, so nothing is written for it.
 */
const copilotPostTool = (command: string): Record<string, unknown> => ({
  type: 'command',
  bash: command,
  powershell: npxPart(command),
  timeoutSec: HOOK_TIMEOUT_S,
  matcher: 'bash|edit',
});

/** Factory Droid's `PostToolUse` entry, for its documented shell, edit and web tool names. */
const factoryPostTool = (command: string): Record<string, unknown> => ({
  matcher: 'Execute|Edit|ApplyPatch|Create|FetchUrl|WebSearch',
  hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }],
});

/** Codex's Stop entry, in the background like its post-tool one. */
const codexStop = (command: string): Record<string, unknown> => ({
  hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S, async: true }],
});

/** Gemini CLI's AfterAgent entry: not a tool event, so no matcher. */
const geminiAfterAgent = (command: string): Record<string, unknown> => ({
  hooks: [{ type: 'command', command }],
});

const geminiAfterTool = (command: string): Record<string, unknown> => ({
  matcher: 'run_shell_command',
  hooks: [{ type: 'command', command }],
});

/** One place in the config that holds a list of hook entries, and the entry we add to it. */
interface HookSlot {
  /** Keys from the top of the file down to the list. */
  readonly path: readonly string[];
  readonly entry: (command: string) => Record<string, unknown>;
  /** The command this slot runs, when it is not the prompt command. */
  readonly command?: (agent: PromptHookAgent) => string;
}

/**
 * A bin path a shell reads as one word: absolute (or under `$HOME`), with no quote, backtick,
 * backslash or other `$`. Anything else keeps npx alone: a hook that runs the wrong thing is worse
 * than a slow one.
 */
const SAFE_BIN = /^(?:\$HOME)?\/[^"`\\$]*$/;

/**
 * Run the installed CLI with node, and fall back to the pinned npx command when that file is gone.
 * npx's own start (~350 ms on a laptop) came before every prompt and tool call. The path is this
 * machine's; the npx half is what every other machine runs, so the entry stays correct for a
 * teammate. `node` exits at once on a missing file, before it reads stdin, so the fallback still
 * gets the payload.
 */
export function directHookCommand(bin: string, npx: string): string {
  if (!SAFE_BIN.test(bin)) return npx;
  const args = npx.slice(npx.indexOf(' hook ') + 1);
  return `node "${bin}" ${args}${OR_ELSE}${npx}`;
}

/**
 * The npx half of a command. Windows PowerShell 5 has no `||`, and a committed file reaches
 * teammates on every shell, so a `powershell` field always runs npx alone.
 */
function npxPart(command: string): string {
  const at = command.indexOf(OR_ELSE);
  return -1 === at ? command : command.slice(at + OR_ELSE.length);
}
const OR_ELSE = ' || ';

const slotCommand = (spec: PromptHookSpec, slot: HookSlot): string =>
  (slot.command ?? promptHookCommand)(spec.id);

export interface PromptHookSpec {
  readonly id: PromptHookAgent;
  readonly label: string;
  /** Project-relative configs this agent reads, first wins. We write to the first that exists. */
  readonly paths: readonly string[];
  /** Written when none of `paths` exists. */
  readonly defaultPath: string;
  /** Keys we add at the top of a NEW file, and remove again when the file holds nothing else. */
  readonly header?: Readonly<Record<string, unknown>>;
  readonly slots: readonly HookSlot[];
  /** Project-relative directories that show the agent is used here. */
  readonly projectMarkers: readonly string[];
  /** Home-relative directories that show the agent is on this machine. */
  readonly homeMarkers: readonly string[];
  readonly docs: string;
  /** What the user must do before the agent runs a hook it was given, when writing it is not enough. */
  readonly activation?: string;
}

/** `{ hooks: [{ type, command, timeout }] }`: Claude Code's group shape, which Codex and Factory copy. */
const group = (command: string): Record<string, unknown> => ({
  hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }],
});

export const PROMPT_HOOK_AGENTS: readonly PromptHookSpec[] = [
  {
    id: PromptHookAgent.CLAUDE_CODE,
    label: 'Claude Code',
    paths: ['.claude/settings.json'],
    defaultPath: '.claude/settings.json',
    slots: [
      { path: ['hooks', 'UserPromptSubmit'], entry: group },
      // The agent's own tool calls, after they ran or failed (2026-10-18).
      { path: ['hooks', 'PostToolUse'], entry: postToolGroup, command: toolHookCommand },
      { path: ['hooks', 'PostToolUseFailure'], entry: postToolGroup, command: toolHookCommand },
      // The model, which no other Claude Code event carries.
      { path: ['hooks', 'SessionStart'], entry: modelGroup, command: toolHookCommand },
      { path: ['hooks', 'PostModelSwitch'], entry: modelGroup, command: toolHookCommand },
      // The closing message: Stop carries `last_assistant_message` (2026-10-18).
      { path: ['hooks', 'Stop'], entry: modelGroup, command: toolHookCommand },
    ],
    projectMarkers: ['.claude'],
    homeMarkers: ['.claude'],
    docs: 'https://code.claude.com/docs/en/hooks',
  },
  {
    id: PromptHookAgent.CURSOR,
    label: 'Cursor',
    paths: ['.cursor/hooks.json'],
    defaultPath: '.cursor/hooks.json',
    header: { version: 1 },
    slots: [
      { path: ['hooks', 'beforeSubmitPrompt'], entry: (command) => ({ command }) },
      { path: ['hooks', 'postToolUse'], entry: cursorPostTool, command: toolHookCommand },
      { path: ['hooks', 'postToolUseFailure'], entry: cursorPostTool, command: toolHookCommand },
      // Cursor's `stop` carries no text; `afterAgentResponse` carries the final message.
      { path: ['hooks', 'afterAgentResponse'], entry: commandOnly, command: toolHookCommand },
    ],
    projectMarkers: ['.cursor'],
    homeMarkers: ['.cursor'],
    docs: 'https://cursor.com/docs/agent/hooks',
  },
  {
    id: PromptHookAgent.CODEX,
    label: 'Codex CLI',
    paths: ['.codex/hooks.json'],
    defaultPath: '.codex/hooks.json',
    slots: [
      { path: ['hooks', 'UserPromptSubmit'], entry: group },
      { path: ['hooks', 'PostToolUse'], entry: codexPostTool, command: toolHookCommand },
      { path: ['hooks', 'Stop'], entry: codexStop, command: toolHookCommand },
    ],
    projectMarkers: ['.codex'],
    homeMarkers: ['.codex'],
    docs: 'https://learn.chatgpt.com/docs/hooks',
    // Codex runs a project hook only once its hash is trusted, and skips it silently until then:
    // a headless `codex exec` ran a whole task here on 2026-10-19 and no hook fired.
    activation:
      'Codex runs these hooks only after you trust them: open `codex` here, type /hooks and trust the Reticle entries (again after an upgrade changes them). Its web search reaches no hook, so each Reticle hook imports it from the Codex session transcript.',
  },
  {
    id: PromptHookAgent.GEMINI,
    label: 'Gemini CLI',
    paths: ['.gemini/settings.json'],
    defaultPath: '.gemini/settings.json',
    // No timeout: the docs do not settle its unit.
    slots: [
      {
        path: ['hooks', 'BeforeAgent'],
        entry: (command) => ({ matcher: '*', hooks: [{ type: 'command', command }] }),
      },
      { path: ['hooks', 'AfterTool'], entry: geminiAfterTool, command: toolHookCommand },
      { path: ['hooks', 'AfterAgent'], entry: geminiAfterAgent, command: toolHookCommand },
    ],
    projectMarkers: ['.gemini'],
    // The settings FILE: Antigravity shares `~/.gemini` and has no prompt hook.
    homeMarkers: ['.gemini/settings.json'],
    docs: 'https://geminicli.com/docs/hooks/reference/',
  },
  {
    id: PromptHookAgent.WINDSURF,
    label: 'Windsurf',
    // The current layout first; the legacy file is read when the current one is absent.
    paths: ['.devin/hooks.json', '.windsurf/hooks.json'],
    defaultPath: '.windsurf/hooks.json',
    slots: [
      { path: ['hooks', 'pre_user_prompt'], entry: (command) => ({ command }) },
      { path: ['hooks', 'post_run_command'], entry: commandOnly, command: toolHookCommand },
      { path: ['hooks', 'post_write_code'], entry: commandOnly, command: toolHookCommand },
      { path: ['hooks', 'post_cascade_response'], entry: commandOnly, command: toolHookCommand },
    ],
    projectMarkers: ['.windsurf', '.devin'],
    homeMarkers: ['.codeium/windsurf'],
    docs: 'https://docs.devin.ai/desktop/cascade/hooks.md',
  },
  {
    id: PromptHookAgent.COPILOT,
    label: 'VS Code Copilot and Copilot CLI',
    // A file of our own, so uninstall can remove it whole.
    paths: ['.github/hooks/reticle-prompt-capture.json'],
    defaultPath: '.github/hooks/reticle-prompt-capture.json',
    header: { version: 1 },
    slots: [
      {
        path: ['hooks', 'UserPromptSubmit'],
        entry: (command) => ({ type: 'command', command, timeout: HOOK_TIMEOUT_S }),
      },
      {
        path: ['hooks', 'userPromptSubmitted'],
        entry: (command) => ({
          type: 'command',
          bash: command,
          powershell: npxPart(command),
          timeoutSec: HOOK_TIMEOUT_S,
        }),
      },
      { path: ['hooks', 'postToolUse'], entry: copilotPostTool, command: toolHookCommand },
    ],
    projectMarkers: ['.github/hooks', '.vscode'],
    homeMarkers: ['.copilot', '.vscode'],
    docs: 'https://code.visualstudio.com/docs/copilot/customization/hooks and https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference',
  },
  {
    id: PromptHookAgent.FACTORY,
    label: 'Factory Droid',
    paths: ['.factory/hooks.json'],
    defaultPath: '.factory/hooks.json',
    // The events sit at the top of this file, with no `hooks` key around them.
    slots: [
      { path: ['UserPromptSubmit'], entry: group },
      { path: ['PostToolUse'], entry: factoryPostTool, command: toolHookCommand },
    ],
    projectMarkers: ['.factory'],
    homeMarkers: ['.factory'],
    docs: 'https://docs.factory.com/reference/hooks-reference.md',
  },
];

/**
 * The agents with no prompt hook that can be written, which therefore rely on the MCP instructions
 * telling the agent to declare the request. Each one was checked on 2026-10-14: no prompt-submit
 * event, or one whose config format the vendor does not document well enough to write.
 */
export const MCP_FALLBACK_AGENTS: readonly string[] = [
  'Claude Desktop (chat)',
  'Cursor CLI in -p mode',
  'Codex IDE extension',
  'OpenCode',
  'Antigravity',
  'Zed',
  'Warp',
  'Kiro',
  'Amazon Q Developer CLI',
  'Cline',
  'Roo Code',
  'Continue',
  'Amp',
];

/** One agent found here: its spec, its config's absolute path, and what that file holds now. */
export interface PromptHookTarget {
  readonly spec: PromptHookSpec;
  readonly path: string;
  readonly existing: string | null;
  /** The installed CLI's bin, when known. See `directHookCommand`. */
  readonly bin?: string;
}

/**
 * The agents used in `projectDir` or installed under `home`, each with the config to write.
 *
 * Only those: a `.gemini/settings.json` in the repository of somebody who has never run Gemini is
 * litter, and it makes the next tool's detection wrong too. `claudeCli` counts Claude Code as
 * present, because it keeps its registration behind its CLI rather than in a folder.
 */
export function promptHookTargets(
  io: { exists(path: string): boolean; readFile(path: string): string | null },
  projectDir: string,
  home: string,
  claudeCli: boolean,
  join: (...parts: string[]) => string,
): PromptHookTarget[] {
  const inProject = (rel: string): string => join(projectDir, rel);
  return PROMPT_HOOK_AGENTS.flatMap((spec) => {
    const used =
      (PromptHookAgent.CLAUDE_CODE === spec.id && claudeCli) ||
      spec.projectMarkers.some((marker) => io.exists(inProject(marker))) ||
      spec.homeMarkers.some((marker) => io.exists(join(home, marker)));
    if (!used) return [];
    const path = inProject(promptHookPath(spec, (rel) => io.exists(inProject(rel))));
    return [{ spec, path, existing: io.readFile(path) }];
  });
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  'object' === typeof value && null !== value && !Array.isArray(value);

/** The config as an object, or undefined when the text is not one. Empty text is an empty config. */
function parseConfig(text: string | null): Json | undefined {
  if (null === text || 0 === text.trim().length) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const serialize = (config: Json): string => `${JSON.stringify(config, null, 2)}\n`;

/** Any version of our entry. */
const ours = (item: unknown): boolean => {
  const text = JSON.stringify(item);
  return (
    text.includes(RETICLE_NPM_PACKAGE) &&
    (text.includes(PROMPT_HOOK_MARKER) || text.includes(TOOL_HOOK_MARKER))
  );
};

/** The list at `path`, or an empty one. */
function listAt(config: Json, path: readonly string[]): unknown[] {
  let node: unknown = config;
  for (const key of path) node = isObject(node) ? node[key] : undefined;
  return Array.isArray(node) ? node : [];
}

/** A copy of `config` with the list at `path` replaced, or its key removed when the list is empty. */
function withList(config: Json, path: readonly string[], list: unknown[]): Json {
  const [key, ...rest] = path;
  if (key === undefined) return config;
  if (0 === rest.length) {
    const { [key]: _dropped, ...others } = config;
    return 0 === list.length ? others : { ...config, [key]: list };
  }
  const child = isObject(config[key]) ? config[key] : {};
  const next = withList(child, rest, list);
  if (0 < Object.keys(next).length) return { ...config, [key]: next };
  const { [key]: _gone, ...others } = config;
  return others;
}

/** The project-relative config to write, given which files exist. */
export function promptHookPath(spec: PromptHookSpec, exists: (path: string) => boolean): string {
  return spec.paths.find((path) => exists(path)) ?? spec.defaultPath;
}

/** THIS version's entry is in every slot. An older version's entry is replaced by install. */
export function promptHookInstalled(spec: PromptHookSpec, text: string | null): boolean {
  const config = parseConfig(text);
  return (
    config !== undefined &&
    spec.slots.every((slot) =>
      listAt(config, slot.path).some((item) =>
        JSON.stringify(item).includes(slotCommand(spec, slot)),
      ),
    )
  );
}

/**
 * THIS version is installed, but some slot runs it through npx alone (~426 ms of npx start per
 * call): an install from before the direct form. Any machine's bin counts as direct, so a
 * teammate's path is never rewritten with this one's.
 */
export function promptHookNpxOnly(spec: PromptHookSpec, text: string | null): boolean {
  const config = parseConfig(text);
  return (
    config !== undefined &&
    promptHookInstalled(spec, text) &&
    spec.slots.some(
      (slot) =>
        !listAt(config, slot.path).some((item) =>
          JSON.stringify(item).includes(`${OR_ELSE}${slotCommand(spec, slot)}`),
        ),
    )
  );
}

/** Our entry merged into the config. `content` is the text to write; MANUAL keeps the text as it is. */
export function installPromptHook(
  spec: PromptHookSpec,
  text: string | null,
  /** The installed CLI's bin, when known: the hook runs it directly. See `directHookCommand`. */
  bin?: string,
): { status: PromptHookStatus; content: string } {
  const config = parseConfig(text);
  if (config === undefined) return { status: PromptHookStatus.MANUAL, content: text ?? '' };
  // An npx-only install is rewritten when this machine can run the bin directly.
  const direct = bin !== undefined && SAFE_BIN.test(bin);
  if (promptHookInstalled(spec, text) && !(direct && promptHookNpxOnly(spec, text))) {
    return { status: PromptHookStatus.ALREADY, content: text ?? '' };
  }
  let next: Json = { ...(spec.header ?? {}), ...config };
  for (const slot of spec.slots) {
    const list = listAt(next, slot.path).filter((item) => !ours(item));
    const npx = slotCommand(spec, slot);
    const command = bin === undefined ? npx : directHookCommand(bin, npx);
    next = withList(next, slot.path, [...list, slot.entry(command)]);
  }
  return { status: PromptHookStatus.APPLY, content: serialize(next) };
}

/**
 * The config with our entries removed. `content` null means delete the file: it holds nothing but
 * what install added. A config that is not ours to parse is never changed.
 */
export function uninstallPromptHook(
  spec: PromptHookSpec,
  text: string | null,
): { changed: boolean; content: string | null } {
  const config = parseConfig(text);
  if (null === text || config === undefined) return { changed: false, content: text };
  let next = config;
  let changed = false;
  for (const slot of spec.slots) {
    const list = listAt(next, slot.path);
    const kept = list.filter((item) => !ours(item));
    if (kept.length === list.length) continue;
    changed = true;
    next = withList(next, slot.path, kept);
  }
  if (!changed) return { changed: false, content: text };
  const header = spec.header ?? {};
  const onlyHeader = Object.keys(next).every(
    (key) => JSON.stringify(next[key]) === JSON.stringify(header[key]),
  );
  return { changed: true, content: onlyHeader ? null : serialize(next) };
}
