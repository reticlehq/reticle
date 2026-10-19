import { describe, expect, it } from 'vitest';
import {
  PROMPT_HOOK_AGENTS,
  PromptHookAgent,
  PromptHookStatus,
  installPromptHook,
  promptHookCommand,
  promptHookInstalled,
  promptHookNpxOnly,
  promptHookPath,
  directHookCommand,
  toolHookCommand,
  uninstallPromptHook,
} from './prompt-hooks.js';
import { RETICLE_VERSION } from '@/version.js';

/** The value at a path of keys and indexes in parsed JSON, or undefined. */
const dig = (text: string, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (node, key) =>
      'object' === typeof node && null !== node
        ? (node as Record<string, unknown>)[key]
        : undefined,
    JSON.parse(text) as unknown,
  );

const spec = (id: string) => {
  const found = PROMPT_HOOK_AGENTS.find((a) => a.id === id);
  if (found === undefined) throw new Error(`no spec for ${id}`);
  return found;
};

describe('the prompt-capture hook in each agent config', () => {
  it('writes each agent its documented shape', () => {
    const content = (id: string): string => installPromptHook(spec(id), null).content;
    expect(
      dig(content(PromptHookAgent.CLAUDE_CODE), 'hooks', 'UserPromptSubmit', 0, 'hooks', 0),
    ).toMatchObject({ type: 'command', command: promptHookCommand(PromptHookAgent.CLAUDE_CODE) });
    expect(JSON.parse(content(PromptHookAgent.CURSOR)) as unknown).toMatchObject({
      version: 1,
      hooks: { beforeSubmitPrompt: [{ command: promptHookCommand(PromptHookAgent.CURSOR) }] },
    });
    expect(
      dig(content(PromptHookAgent.GEMINI), 'hooks', 'BeforeAgent', 0, 'hooks', 0, 'command'),
    ).toBe(promptHookCommand(PromptHookAgent.GEMINI));
    // Factory's hooks file holds the events at the top, with no `hooks` wrapper.
    expect(
      dig(content(PromptHookAgent.FACTORY), 'UserPromptSubmit', 0, 'hooks', 0, 'command'),
    ).toBe(promptHookCommand(PromptHookAgent.FACTORY));
    expect(dig(content(PromptHookAgent.WINDSURF), 'hooks', 'pre_user_prompt', 0, 'command')).toBe(
      promptHookCommand(PromptHookAgent.WINDSURF),
    );
    // One file for both: VS Code reads `UserPromptSubmit`, Copilot CLI reads `userPromptSubmitted`.
    const copilot = content(PromptHookAgent.COPILOT);
    expect(dig(copilot, 'hooks', 'UserPromptSubmit', 0, 'command')).toBe(
      promptHookCommand(PromptHookAgent.COPILOT),
    );
    expect(dig(copilot, 'hooks', 'userPromptSubmitted', 0, 'bash')).toBe(
      promptHookCommand(PromptHookAgent.COPILOT),
    );
  });

  it('keeps the hooks and settings that are already there', () => {
    const existing = JSON.stringify({
      model: 'x',
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'stop.sh' }] }],
      },
    });
    const out = installPromptHook(spec(PromptHookAgent.CLAUDE_CODE), existing);
    expect(out.status).toBe(PromptHookStatus.APPLY);
    expect(dig(out.content, 'model')).toBe('x');
    // Theirs stays first; ours (the closing-message hook) follows it.
    expect(dig(out.content, 'hooks', 'Stop')).toHaveLength(2);
    expect(dig(out.content, 'hooks', 'Stop', 0, 'hooks', 0, 'command')).toBe('stop.sh');
    expect(dig(out.content, 'hooks', 'UserPromptSubmit')).toHaveLength(2);
    expect(dig(out.content, 'hooks', 'UserPromptSubmit', 0, 'hooks', 0, 'command')).toBe(
      'theirs.sh',
    );
  });

  it('adds nothing on a second run', () => {
    for (const agent of PROMPT_HOOK_AGENTS) {
      const once = installPromptHook(agent, null).content;
      const twice = installPromptHook(agent, once);
      expect(twice.status, agent.id).toBe(PromptHookStatus.ALREADY);
      expect(twice.content, agent.id).toBe(once);
      expect(promptHookInstalled(agent, once), agent.id).toBe(true);
    }
  });

  it('names the version that installed it, so a stale npx cache cannot run an older CLI', () => {
    expect(promptHookCommand(PromptHookAgent.CURSOR)).toBe(
      `npx -y @reticlehq/server@${RETICLE_VERSION} hook prompt --agent cursor`,
    );
  });

  it('replaces an entry an older version wrote, and keeps one', () => {
    const old = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'npx -y @reticlehq/server@0.0.1 hook prompt --agent claude-code',
              },
            ],
          },
          { hooks: [{ type: 'command', command: 'theirs.sh' }] },
        ],
      },
    });
    const claude = spec(PromptHookAgent.CLAUDE_CODE);
    expect(promptHookInstalled(claude, old)).toBe(false);
    const out = installPromptHook(claude, old);
    expect(out.status).toBe(PromptHookStatus.APPLY);
    const commands = JSON.stringify(dig(out.content, 'hooks', 'UserPromptSubmit'));
    expect(commands).not.toContain('@0.0.1');
    expect(commands).toContain('theirs.sh');
    expect(commands.split(promptHookCommand(PromptHookAgent.CLAUDE_CODE))).toHaveLength(2);
  });

  it('leaves a file that is not a JSON object alone', () => {
    const out = installPromptHook(spec(PromptHookAgent.GEMINI), '{ // comments\n}');
    expect(out.status).toBe(PromptHookStatus.MANUAL);
    expect(out.content).toBe('{ // comments\n}');
  });

  it('removes only its own entry on uninstall', () => {
    const theirs = { hooks: [{ type: 'command', command: 'theirs.sh' }] };
    const existing = JSON.stringify({ model: 'x', hooks: { UserPromptSubmit: [theirs] } });
    const installed = installPromptHook(spec(PromptHookAgent.CLAUDE_CODE), existing).content;
    const removed = uninstallPromptHook(spec(PromptHookAgent.CLAUDE_CODE), installed);
    expect(removed.changed).toBe(true);
    expect(JSON.parse(removed.content ?? '') as unknown).toEqual({
      model: 'x',
      hooks: { UserPromptSubmit: [theirs] },
    });
  });

  it('deletes a file it created and that holds nothing else', () => {
    for (const agent of PROMPT_HOOK_AGENTS) {
      const created = installPromptHook(agent, null).content;
      const removed = uninstallPromptHook(agent, created);
      expect(removed, agent.id).toEqual({ changed: true, content: null });
    }
  });

  it('changes nothing where it is not installed', () => {
    const existing = JSON.stringify({ hooks: { Stop: [] } });
    expect(uninstallPromptHook(spec(PromptHookAgent.CLAUDE_CODE), existing)).toEqual({
      changed: false,
      content: existing,
    });
    expect(uninstallPromptHook(spec(PromptHookAgent.CLAUDE_CODE), null).changed).toBe(false);
  });

  it('writes Windsurf where Windsurf reads first', () => {
    const windsurf = spec(PromptHookAgent.WINDSURF);
    expect(promptHookPath(windsurf, () => false)).toBe('.windsurf/hooks.json');
    expect(promptHookPath(windsurf, (p) => '.devin/hooks.json' === p)).toBe('.devin/hooks.json');
  });

  it("records Claude Code's own tool calls after they run, in the background", () => {
    const content = installPromptHook(spec(PromptHookAgent.CLAUDE_CODE), null).content;
    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      const entry = dig(content, 'hooks', event, 0);
      expect(entry).toMatchObject({
        matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch',
        hooks: [
          { type: 'command', command: toolHookCommand(PromptHookAgent.CLAUDE_CODE), async: true },
        ],
      });
    }
    expect(promptHookInstalled(spec(PromptHookAgent.CLAUDE_CODE), content)).toBe(true);
    // A config holding only the prompt entry still needs the tool entries.
    const promptOnly = JSON.stringify({
      hooks: { UserPromptSubmit: dig(content, 'hooks', 'UserPromptSubmit') },
    });
    expect(promptHookInstalled(spec(PromptHookAgent.CLAUDE_CODE), promptOnly)).toBe(false);
    expect(uninstallPromptHook(spec(PromptHookAgent.CLAUDE_CODE), content).content).toBeNull();
  });

  it('names the model through the events that carry it, and records Codex, Cursor and Gemini calls', () => {
    const content = (id: string): string => installPromptHook(spec(id), null).content;
    const claude = content(PromptHookAgent.CLAUDE_CODE);
    for (const event of ['SessionStart', 'PostModelSwitch']) {
      expect(dig(claude, 'hooks', event, 0, 'hooks', 0)).toMatchObject({
        type: 'command',
        command: toolHookCommand(PromptHookAgent.CLAUDE_CODE),
        async: true,
      });
    }
    expect(dig(content(PromptHookAgent.CODEX), 'hooks', 'PostToolUse', 0)).toMatchObject({
      matcher: 'Bash|apply_patch',
      hooks: [{ type: 'command', command: toolHookCommand(PromptHookAgent.CODEX), async: true }],
    });
    for (const event of ['postToolUse', 'postToolUseFailure']) {
      expect(dig(content(PromptHookAgent.CURSOR), 'hooks', event, 0)).toEqual({
        command: toolHookCommand(PromptHookAgent.CURSOR),
        matcher: 'Shell|Write|Delete',
      });
    }
    expect(dig(content(PromptHookAgent.GEMINI), 'hooks', 'AfterTool', 0)).toEqual({
      matcher: 'run_shell_command',
      hooks: [{ type: 'command', command: toolHookCommand(PromptHookAgent.GEMINI) }],
    });
  });

  it('records Windsurf, Copilot CLI and Factory Droid tool calls in their documented shapes', () => {
    const content = (id: string): string => installPromptHook(spec(id), null).content;
    const windsurf = content(PromptHookAgent.WINDSURF);
    for (const event of ['post_run_command', 'post_write_code']) {
      expect(dig(windsurf, 'hooks', event, 0)).toEqual({
        command: toolHookCommand(PromptHookAgent.WINDSURF),
      });
    }
    expect(dig(content(PromptHookAgent.COPILOT), 'hooks', 'postToolUse', 0)).toEqual({
      type: 'command',
      bash: toolHookCommand(PromptHookAgent.COPILOT),
      powershell: toolHookCommand(PromptHookAgent.COPILOT),
      timeoutSec: 30,
      matcher: 'bash|edit',
    });
    expect(dig(content(PromptHookAgent.FACTORY), 'PostToolUse', 0)).toEqual({
      matcher: 'Execute|Edit|ApplyPatch|Create|FetchUrl|WebSearch',
      hooks: [{ type: 'command', command: toolHookCommand(PromptHookAgent.FACTORY), timeout: 30 }],
    });
  });

  it("records each agent's closing message where its end-of-turn hook carries one", () => {
    const content = (id: string): string => installPromptHook(spec(id), null).content;
    expect(dig(content(PromptHookAgent.CLAUDE_CODE), 'hooks', 'Stop', 0, 'hooks', 0)).toMatchObject(
      {
        command: toolHookCommand(PromptHookAgent.CLAUDE_CODE),
        async: true,
      },
    );
    expect(dig(content(PromptHookAgent.CODEX), 'hooks', 'Stop', 0, 'hooks', 0)).toMatchObject({
      command: toolHookCommand(PromptHookAgent.CODEX),
      async: true,
    });
    expect(dig(content(PromptHookAgent.CURSOR), 'hooks', 'afterAgentResponse', 0)).toEqual({
      command: toolHookCommand(PromptHookAgent.CURSOR),
    });
    expect(dig(content(PromptHookAgent.GEMINI), 'hooks', 'AfterAgent', 0)).toEqual({
      hooks: [{ type: 'command', command: toolHookCommand(PromptHookAgent.GEMINI) }],
    });
    expect(dig(content(PromptHookAgent.WINDSURF), 'hooks', 'post_cascade_response', 0)).toEqual({
      command: toolHookCommand(PromptHookAgent.WINDSURF),
    });
  });

  /*
   * npx's own start (~350 ms) came before every hook run. Where the installed CLI's bin is known,
   * the hook runs it with node directly, and falls back to npx when that file is gone.
   */
  it('runs the installed bin directly, with npx as the fallback', () => {
    const bin = '$HOME/.npm/_npx/abc/node_modules/@reticlehq/server/bin/reticle.js';
    const command = directHookCommand(bin, promptHookCommand(PromptHookAgent.CURSOR));
    expect(command).toBe(
      `node "${bin}" hook prompt --agent cursor || ${promptHookCommand(PromptHookAgent.CURSOR)}`,
    );
    const content = installPromptHook(spec(PromptHookAgent.CURSOR), null, bin).content;
    expect(dig(content, 'hooks', 'beforeSubmitPrompt', 0, 'command')).toBe(command);
    expect(dig(content, 'hooks', 'postToolUse', 0, 'command')).toBe(
      directHookCommand(bin, toolHookCommand(PromptHookAgent.CURSOR)),
    );
    // Installed is installed on any machine: another teammate's path does not rewrite the file.
    expect(installPromptHook(spec(PromptHookAgent.CURSOR), content, '/other/bin.js').status).toBe(
      PromptHookStatus.ALREADY,
    );
    // PowerShell 5 has no `||`: Copilot's powershell field runs npx alone.
    const copilot = installPromptHook(spec(PromptHookAgent.COPILOT), null, bin).content;
    expect(dig(copilot, 'hooks', 'userPromptSubmitted', 0, 'powershell')).toBe(
      promptHookCommand(PromptHookAgent.COPILOT),
    );
    // Uninstall still finds it.
    expect(uninstallPromptHook(spec(PromptHookAgent.CURSOR), content).content).toBeNull();
  });

  /*
   * An install written before the direct form counted as installed, so it ran through npx (~426 ms
   * per call) until the version changed. Where a bin is known, it is now rewritten in place.
   */
  it('rewrites an npx-only install of this version to the direct form, for every agent', () => {
    const bin = '$HOME/.npm/_npx/abc/node_modules/@reticlehq/server/bin/reticle.js';
    for (const agent of PROMPT_HOOK_AGENTS) {
      const npxOnly = installPromptHook(agent, null).content;
      expect(promptHookInstalled(agent, npxOnly)).toBe(true);
      expect(promptHookNpxOnly(agent, npxOnly)).toBe(true);
      const out = installPromptHook(agent, npxOnly, bin);
      expect(out.status).toBe(PromptHookStatus.APPLY);
      expect(promptHookNpxOnly(agent, out.content)).toBe(false);
      expect(out.content).toContain(`node \\"${bin}\\"`);
      // Rewritten in place, not appended: the same entries a fresh direct install writes.
      expect(out.content).toBe(installPromptHook(agent, null, bin).content);
      // With no bin (Windows), npx alone is the only form, so it stays.
      expect(installPromptHook(agent, npxOnly).status).toBe(PromptHookStatus.ALREADY);
    }
  });

  it('keeps npx alone for a bin path a shell could misread', () => {
    for (const bad of ['/a "b"/bin.js', '/a/`x`/bin.js', '/a/$(x)/bin.js', 'relative/bin.js']) {
      expect(directHookCommand(bad, promptHookCommand(PromptHookAgent.CURSOR))).toBe(
        promptHookCommand(PromptHookAgent.CURSOR),
      );
    }
  });
});
