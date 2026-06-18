import { describe, expect, it } from 'vitest';
import { claudeAddCommand, claudeExistsProbe, mcpManual, MCP_SERVER_NAME } from './mcp.js';

describe('claudeAddCommand', () => {
  it('registers iris at user scope via npx (global, all projects)', () => {
    const c = claudeAddCommand(undefined);
    expect(c.command).toBe('claude');
    expect(c.args).toEqual([
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '-s',
      'user',
      '--',
      'npx',
      '@syrin/iris',
      'mcp',
    ]);
  });

  it('bakes the port into the registered invocation', () => {
    const c = claudeAddCommand(4500);
    expect(c.args).toEqual([
      'mcp',
      'add',
      'iris',
      '-s',
      'user',
      '--',
      'npx',
      '@syrin/iris',
      'mcp',
      '--port',
      '4500',
    ]);
    expect(c.display).toContain('--port 4500');
  });
});

describe('claudeExistsProbe', () => {
  it('uses `claude mcp get iris`', () => {
    expect(claudeExistsProbe()).toEqual({ command: 'claude', args: ['mcp', 'get', 'iris'] });
  });
});

describe('mcpManual', () => {
  it('explains the one-time global registration', () => {
    const m = mcpManual(undefined);
    expect(m).toContain('claude mcp add iris -s user');
    expect(m).toContain('globally');
  });
});
