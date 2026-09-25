/**
 * `init --hooks`: the print-only Claude Code Stop hook, merged into `.claude/settings.json`.
 *
 * Opt-in, because it writes into a file the user and other tools own. When the agent stops without a
 * single claim having held, the hook prints one line saying so; it never blocks the agent. The line
 * itself is `reticle report --hook`, which reads the session journal on disk.
 */
import { RETICLE_NPM_PACKAGE } from '@/version.js';
import { StepStatus, type Step } from './plan-types.js';

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
    return { title: TITLE, target: path, status: StepStatus.ALREADY, detail: 'hook already installed' };
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
