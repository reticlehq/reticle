/**
 * The post-tool hook answers at once and keeps the call in a detached child.
 *
 * Cursor and Gemini CLI document no background option, so the agent waits for the hook to exit.
 * Measured on 100 payloads each, the hook through the full CLI took p50 ~300 ms and p95 325–494 ms,
 * because the whole CLI loaded before a byte was written. The fast path loads nothing heavy: it
 * reads the payload, answers, hands the payload to a detached writer, and exits.
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_WRITE_ACTION,
  hookBinFor,
  TOOL_WRITE_ACTION,
  promptHookAck,
  runPromptHookFast,
  runToolHookFast,
  toolHookAck,
} from './hook-fast.js';

describe('the post-tool hook fast path', () => {
  it('answers, hands the payload to a detached writer, and writes nothing itself', async () => {
    const out: string[] = [];
    const spawned: { args: readonly string[]; input: string; detached: boolean }[] = [];
    await runToolHookFast(['--agent', 'cursor'], {
      readStdin: () => Promise.resolve('{"tool_name":"Shell"}'),
      write: (text) => out.push(text),
      spawnWriter: (args, input) => {
        spawned.push({ args, input, detached: true });
        return Promise.resolve();
      },
    });
    expect(out).toEqual(['{}\n']);
    expect(spawned).toEqual([
      {
        args: ['hook', TOOL_WRITE_ACTION, '--agent', 'cursor'],
        input: '{"tool_name":"Shell"}',
        detached: true,
      },
    ]);
  });

  it('still answers when the writer cannot start', async () => {
    const out: string[] = [];
    await runToolHookFast(['--agent', 'gemini'], {
      readStdin: () => Promise.resolve('{}'),
      write: (text) => out.push(text),
      spawnWriter: () => Promise.reject(new Error('no spawn')),
    });
    expect(out).toEqual(['{}\n']);
  });

  it('answers Cursor and Gemini CLI with JSON and the others with nothing', () => {
    expect(toolHookAck('cursor')).toBe('{}\n');
    expect(toolHookAck('gemini')).toBe('{}\n');
    expect(toolHookAck('claude-code')).toBe('');
    // Codex's Stop needs JSON on stdout when it exits 0; its other hooks need nothing.
    expect(toolHookAck('codex', '{"hook_event_name":"Stop"}')).toBe('{}\n');
    expect(toolHookAck('codex', '{"hook_event_name":"PostToolUse"}')).toBe('');
  });
});

/*
 * The prompt hook stood in front of every prompt the user sent: p50 ~400-600 ms through the full
 * CLI. It takes the same fast path. The writer is told when the prompt ARRIVED, so a slower writer
 * that finishes later can never put an older prompt over a newer one.
 */
describe('the prompt hook fast path', () => {
  it('lets the prompt through at once and hands it to a writer with its arrival time', async () => {
    const out: string[] = [];
    const spawned: (readonly string[])[] = [];
    await runPromptHookFast(['--agent', 'cursor'], {
      readStdin: () => Promise.resolve('{"prompt":"hi"}'),
      write: (text) => out.push(text),
      spawnWriter: (args) => {
        spawned.push(args);
        return Promise.resolve();
      },
      now: () => 1234,
    });
    expect(out).toEqual(['{"continue":true}\n']);
    expect(spawned).toEqual([['hook', PROMPT_WRITE_ACTION, '--agent', 'cursor', '--at', '1234']]);
  });

  it('answers each agent the way it reads a prompt hook', () => {
    expect(promptHookAck('cursor')).toBe('{"continue":true}\n');
    expect(promptHookAck('gemini')).toBe('{}\n');
    expect(promptHookAck('claude-code')).toBe('');
  });
});

describe('the bin an agent hook names', () => {
  it('is home-relative under the home folder, absolute elsewhere, and absent on Windows', () => {
    expect(hookBinFor('/Users/me', 'darwin', '/Users/me/.npm/x/bin/reticle.js')).toBe(
      '$HOME/.npm/x/bin/reticle.js',
    );
    expect(hookBinFor('/Users/me', 'linux', '/opt/reticle/bin/reticle.js')).toBe(
      '/opt/reticle/bin/reticle.js',
    );
    expect(hookBinFor('C:\\Users\\me', 'win32', 'C:\\x\\reticle.js')).toBeUndefined();
  });
});
