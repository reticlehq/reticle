import { describe, expect, it } from 'vitest';
import { mergeCursorConfig, CursorMergeStatus } from './cursor.js';

interface CursorShape {
  mcpServers: Record<string, { command: string; args: string[] }>;
}
function parse(content: string): CursorShape {
  return JSON.parse(content) as CursorShape;
}

describe('mergeCursorConfig', () => {
  it('creates a fresh global config when none exists', () => {
    const r = mergeCursorConfig(null, undefined);
    expect(r.status).toBe(CursorMergeStatus.APPLY);
    expect(parse(r.content).mcpServers['iris']).toEqual({
      command: 'npx',
      args: ['@syrin/iris', 'mcp'],
    });
  });

  it('bakes the port into the args', () => {
    const r = mergeCursorConfig(null, 4500);
    expect(parse(r.content).mcpServers['iris']?.args).toEqual([
      '@syrin/iris',
      'mcp',
      '--port',
      '4500',
    ]);
  });

  it('preserves other servers', () => {
    const r = mergeCursorConfig(
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
      undefined,
    );
    const parsed = parse(r.content);
    expect(parsed.mcpServers['other']).toEqual({ command: 'x' });
    expect(parsed.mcpServers['iris']).toBeDefined();
  });

  it('never clobbers an existing iris entry (idempotent)', () => {
    const existing = JSON.stringify({ mcpServers: { iris: { command: 'custom' } } });
    const r = mergeCursorConfig(existing, undefined);
    expect(r.status).toBe(CursorMergeStatus.ALREADY);
    expect(r.content).toBe(existing);
  });

  it('bails to manual on unparseable jsonc without rewriting', () => {
    const jsonc = '{\n  // servers\n  "mcpServers": {}\n}\n';
    const r = mergeCursorConfig(jsonc, undefined);
    expect(r.status).toBe(CursorMergeStatus.MANUAL);
    expect(r.content).toBe(jsonc);
  });
});
