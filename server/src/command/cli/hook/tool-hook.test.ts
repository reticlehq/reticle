/**
 * `reticle hook tool --agent <id>`: what an agent's post-tool hook runs.
 *
 * The coding agent's own calls (a shell command, a file edit, a web fetch) never pass through
 * Reticle's MCP tools, so the episode log saw none of them. The hook keeps each one locally, with
 * secrets redacted, and never stands in the agent's way: a bad payload is nothing written, exit 0.
 */
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import {
  AGENT_MODEL_RECORD,
  AGENT_STOP_RECORD,
  AGENT_TOOL_RECORD,
  MAX_TOOL_TEXT,
  captureToolCall,
  toolHookAck,
} from './tool-hook.js';

function project(config: Record<string, unknown> = { projectId: 'shop-1' }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-tool-hook-')));
  writeFileSync(join(dir, '.reticle.json'), JSON.stringify(config));
  return dir;
}

const records = (dir: string): Record<string, unknown>[] => {
  const episodes = join(dir, ReticleDir.ROOT, ReticleDir.EPISODES_SUBDIR);
  return readdirSync(episodes).flatMap((file) =>
    readFileSync(join(episodes, file), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
};

const run = (payload: unknown, env: NodeJS.ProcessEnv = {}, agent = 'claude-code') =>
  captureToolCall(agent, JSON.stringify(payload), {
    cwd: '/nowhere',
    env,
    now: () => 10_000,
  });

describe("the coding agent's own tool calls", () => {
  it('keeps a failed shell command with its exit code, timing and redacted output', () => {
    const dir = project();
    const written = run({
      session_id: 'sess-1',
      cwd: dir,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_input: { command: 'curl -H "Authorization: Bearer sk-live-abcdefghijklmnop1234" x' },
      error: 'Exit code 7\ncould not connect',
      duration_ms: 420,
    });
    expect(written.written).toHaveLength(1);
    const [record] = records(dir);
    expect(record).toMatchObject({
      kind: AGENT_TOOL_RECORD,
      agent: 'claude-code',
      agentSession: 'sess-1',
      toolUseId: 'toolu_1',
      tool: 'Bash',
      ok: false,
      exitCode: 7,
      startedAt: 9_580,
      endedAt: 10_000,
      durationMs: 420,
    });
    expect(JSON.stringify(record)).not.toContain('sk-live-abcdefghijklmnop1234');
  });

  it('keeps an edit whole and a large result as its head and its size', () => {
    const dir = project();
    const big = 'y'.repeat(MAX_TOOL_TEXT * 3);
    run({
      session_id: 's',
      cwd: dir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: `${dir}/a.ts`, old_string: 'a', new_string: 'b' },
      tool_response: { filePath: `${dir}/a.ts`, body: big },
      duration_ms: 3,
    });
    const [record] = records(dir);
    expect(record).toMatchObject({
      tool: 'Edit',
      ok: true,
      args: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
    });
    const result = record?.['result'] as { head: string; chars: number; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(result.head.length).toBe(MAX_TOOL_TEXT);
    expect(result.chars).toBeGreaterThan(MAX_TOOL_TEXT * 3);
  });

  it("skips Reticle's own tools: the daemon already keeps them in full", () => {
    const dir = project();
    expect(
      run({ cwd: dir, tool_name: 'mcp__reticle__reticle_act', tool_input: {}, tool_response: {} })
        .written,
    ).toEqual([]);
  });

  it('writes nothing when the journal is off, outside a project, or on a bad payload', () => {
    const dir = project({ projectId: 'p', journal: false });
    const call = { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} };
    expect(run(call).written).toEqual([]);
    expect(run({ ...call, cwd: project() }, { RETICLE_JOURNAL: '0' }).written).toEqual([]);
    expect(run({ ...call, cwd: realpathSync(tmpdir()) }).written).toEqual([]);
    expect(
      captureToolCall('claude-code', 'not json', { cwd: dir, env: {}, now: () => 0 }).written,
    ).toEqual([]);
  });
});

/*
 * Each agent's post-tool payload, as its own documentation gave it on 2026-10-18. The model comes
 * from the payload where the agent sends it: Claude Code only at session start and on a model
 * switch, Cursor and Codex on every hook, Gemini CLI nowhere documented.
 */
describe('each agent payload, and the model behind it', () => {
  it("keeps Claude Code's model from session start and from a model switch", () => {
    const dir = project();
    run({ hook_event_name: 'SessionStart', session_id: 's', cwd: dir, model: 'claude-x' });
    run({ hook_event_name: 'PostModelSwitch', session_id: 's', cwd: dir, to_model: 'claude-y' });
    expect(records(dir)).toMatchObject([
      { kind: AGENT_MODEL_RECORD, agent: 'claude-code', agentSession: 's', model: 'claude-x' },
      { kind: AGENT_MODEL_RECORD, model: 'claude-y' },
    ]);
  });

  it("reads Cursor's tool output, failure and model", () => {
    const dir = project();
    const base = { conversation_id: 'c1', cwd: dir, model: 'cursor-model', tool_name: 'Shell' };
    run(
      {
        ...base,
        hook_event_name: 'postToolUse',
        tool_input: { command: 'ls' },
        tool_output: '{"exitCode":0}',
        duration: 50,
      },
      {},
      'cursor',
    );
    run(
      {
        ...base,
        hook_event_name: 'postToolUseFailure',
        tool_input: {},
        error_message: 'timed out',
        failure_type: 'timeout',
      },
      {},
      'cursor',
    );
    expect(records(dir)).toMatchObject([
      {
        tool: 'Shell',
        ok: true,
        model: 'cursor-model',
        agentSession: 'c1',
        result: { head: '{"exitCode":0}' },
        reportedDuration: 50,
      },
      { ok: false, failureType: 'timeout', error: { head: 'timed out' } },
    ]);
    expect(toolHookAck('cursor')).toBe('{}\n');
  });

  it("reads Codex's response and model", () => {
    const dir = project();
    run(
      {
        session_id: 'x',
        cwd: dir,
        model: 'codex-model',
        tool_name: 'apply_patch',
        tool_input: { command: 'patch' },
        tool_response: 'Done',
      },
      {},
      'codex',
    );
    expect(records(dir)).toMatchObject([
      { tool: 'apply_patch', ok: true, model: 'codex-model', result: { head: 'Done' } },
    ]);
  });

  it('claims no exit code for a Codex shell command: a failed one arrives without an error field', () => {
    const dir = project();
    run(
      {
        session_id: 'x',
        cwd: dir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: 'FAIL sum(2,3)=-1',
      },
      {},
      'codex',
    );
    const [record] = records(dir);
    expect(record).toMatchObject({ tool: 'Bash', ok: true });
    expect(record?.['exitCode']).toBeUndefined();
  });

  it('reads a Gemini CLI tool error from inside its response, and answers with JSON', () => {
    const dir = project();
    run(
      {
        session_id: 'g',
        cwd: dir,
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'false' },
        tool_response: { llmContent: 'x', error: { message: 'exit 1' } },
      },
      {},
      'gemini',
    );
    expect(records(dir)).toMatchObject([{ tool: 'run_shell_command', ok: false }]);
    expect(records(dir)[0]?.['model']).toBeUndefined();
    expect(toolHookAck('gemini')).toBe('{}\n');
    expect(toolHookAck('claude-code')).toBe('');
  });

  it("reads Windsurf's action, Copilot CLI's camelCase payload and Factory Droid's", () => {
    const dir = project();
    run(
      {
        agent_action_name: 'post_run_command',
        trajectory_id: 't1',
        execution_id: 'x',
        timestamp: '2026-10-18T00:00:00Z',
        model_name: 'windsurf-model',
        tool_info: { command_line: 'npm test', cwd: dir },
      },
      {},
      'windsurf',
    );
    // Windsurf's hook runs in the workspace root, and an edit names no folder of its own.
    captureToolCall(
      'windsurf',
      JSON.stringify({
        agent_action_name: 'post_write_code',
        trajectory_id: 't1',
        model_name: 'Unknown',
        tool_info: { file_path: `${dir}/a.ts`, edits: [] },
      }),
      { cwd: dir, env: {}, now: () => 10_000 },
    );
    run(
      {
        sessionId: 'cp',
        cwd: dir,
        toolName: 'bash',
        toolArgs: { command: 'ls' },
        toolResult: { resultType: 'success', textResultForLlm: 'a.ts' },
      },
      {},
      'copilot',
    );
    run(
      {
        session_id: 'fd',
        cwd: dir,
        tool_name: 'Execute',
        tool_input: { command: 'ls' },
        tool_response: { output: 'a.ts' },
      },
      {},
      'factory-droid',
    );
    const [copilot, factory, ws, write] = records(dir).sort(
      (a, b) =>
        String(a['agent']).localeCompare(String(b['agent'])) ||
        Number(a['endedAt']) - Number(b['endedAt']),
    );
    expect(copilot).toMatchObject({
      agent: 'copilot',
      agentSession: 'cp',
      tool: 'bash',
      ok: true,
      args: { command: 'ls' },
      result: { head: '{"resultType":"success","textResultForLlm":"a.ts"}' },
    });
    expect(factory).toMatchObject({
      agent: 'factory-droid',
      agentSession: 'fd',
      tool: 'Execute',
      ok: true,
    });
    expect(ws).toMatchObject({
      agent: 'windsurf',
      agentSession: 't1',
      tool: 'post_run_command',
      model: 'windsurf-model',
      args: { command_line: 'npm test' },
    });
    // Windsurf says "Unknown" when it does not know the model: that is not a model.
    expect(write).toMatchObject({ tool: 'post_write_code', args: { file_path: 'a.ts' } });
    expect(write?.['model']).toBeUndefined();
    // Windsurf sends no result: none is invented.
    expect(ws?.['result']).toBeUndefined();
  });

  it('reads a Copilot CLI result that is not a success as a failure', () => {
    const dir = project();
    run(
      {
        sessionId: 'cp',
        cwd: dir,
        toolName: 'edit',
        toolArgs: {},
        toolResult: { resultType: 'failure', textResultForLlm: 'no such file' },
      },
      {},
      'copilot',
    );
    expect(records(dir)).toMatchObject([{ ok: false, error: { head: 'no such file' } }]);
  });
});

/*
 * The episode had no closing claim: what the agent said when it finished the turn. Each agent's
 * end-of-turn hook, where its docs give the final message (2026-10-18): Claude Code and Codex
 * `Stop` (`last_assistant_message`), Cursor `afterAgentResponse` (`text`), Gemini CLI `AfterAgent`
 * (`prompt_response`), Windsurf `post_cascade_response` (`response`).
 */
describe("the agent's closing message", () => {
  it('keeps each agent final message, redacted and bounded', () => {
    const dir = project();
    // A made-up key in the shape the redaction removes; not a real credential.
    const fakeKey = ['sk', 'live', 'abcdefghijklmnop1234'].join('-');
    run({
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: dir,
      last_assistant_message: `Done. Key ${fakeKey}`,
    });
    run(
      { hook_event_name: 'Stop', session_id: 'x', cwd: dir, last_assistant_message: null },
      {},
      'codex',
    );
    run(
      {
        hook_event_name: 'afterAgentResponse',
        conversation_id: 'c',
        cwd: dir,
        model: 'm',
        text: 'All set',
      },
      {},
      'cursor',
    );
    run(
      {
        hook_event_name: 'AfterAgent',
        session_id: 'g',
        cwd: dir,
        prompt: 'p',
        prompt_response: 'x'.repeat(MAX_TOOL_TEXT * 2),
      },
      {},
      'gemini',
    );
    captureToolCall(
      'windsurf',
      JSON.stringify({
        agent_action_name: 'post_cascade_response',
        trajectory_id: 't',
        model_name: 'w',
        tool_info: { response: 'Planner says done' },
      }),
      { cwd: dir, env: {}, now: () => 10_000 },
    );
    const stops = records(dir).filter((r) => AGENT_STOP_RECORD === r['kind']);
    const by = (agent: string) => stops.find((r) => agent === r['agent']);
    expect(stops).toHaveLength(5);
    expect(JSON.stringify(stops)).not.toContain(fakeKey);
    expect(by('claude-code')).toMatchObject({ agentSession: 's', message: { truncated: false } });
    // Codex may send no message: the stop is still on record, with none invented.
    expect(by('codex')?.['message']).toBeUndefined();
    expect(by('cursor')).toMatchObject({ model: 'm', message: { head: 'All set' } });
    expect(by('gemini')).toMatchObject({ message: { truncated: true } });
    expect(by('windsurf')).toMatchObject({ message: { head: 'Planner says done' } });
    // None of them is read as a tool call.
    expect(records(dir).filter((r) => AGENT_TOOL_RECORD === r['kind'])).toHaveLength(0);
  });
});
