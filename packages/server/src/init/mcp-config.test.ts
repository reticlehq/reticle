import { describe, expect, it } from 'vitest';
import { mergeMcpConfig, McpMergeStatus } from './mcp-config.js';

interface McpShape {
  mcpServers: Record<string, { command: string; args: string[] }>;
}

function parse(content: string): McpShape {
  return JSON.parse(content) as McpShape;
}

describe('mergeMcpConfig', () => {
  it('creates a fresh config when none exists', () => {
    const r = mergeMcpConfig(null, undefined);
    expect(r.status).toBe(McpMergeStatus.APPLY);
    const parsed = parse(r.content);
    expect(parsed.mcpServers['iris']).toEqual({ command: 'npx', args: ['@syrin/iris', 'mcp'] });
    expect(r.content.endsWith('\n')).toBe(true);
  });

  it('bakes a port into the args when provided', () => {
    const r = mergeMcpConfig(null, 4500);
    expect(parse(r.content).mcpServers['iris']?.args).toEqual([
      '@syrin/iris',
      'mcp',
      '--port',
      '4500',
    ]);
  });

  it('preserves other servers when adding iris', () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: 'x' } } });
    const r = mergeMcpConfig(existing, undefined);
    const parsed = parse(r.content);
    expect(parsed.mcpServers['other']).toEqual({ command: 'x' });
    expect(parsed.mcpServers['iris']).toBeDefined();
  });

  it('never clobbers an existing iris entry (idempotent)', () => {
    const existing = JSON.stringify({ mcpServers: { iris: { command: 'custom' } } });
    const r = mergeMcpConfig(existing, undefined);
    expect(r.status).toBe(McpMergeStatus.ALREADY);
    expect(r.content).toBe(existing);
  });
});
