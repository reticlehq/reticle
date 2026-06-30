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
    const r = mergeCursorConfig(null);
    expect(r.status).toBe(CursorMergeStatus.APPLY);
    expect(parse(r.content).mcpServers['reticle']).toEqual({
      command: 'npx',
      args: ['@reticle/core', 'mcp'],
    });
  });

  it('is portless — the global Cursor entry never bakes in a port', () => {
    // One global entry per user serves every project; the port is read per-project from
    // .reticle.json at runtime, so pinning a port here would break multi-project isolation.
    const r = mergeCursorConfig(null);
    expect(parse(r.content).mcpServers['reticle']?.args).toEqual(['@reticle/core', 'mcp']);
    expect(parse(r.content).mcpServers['reticle']?.args).not.toContain('--port');
  });

  it('preserves other servers', () => {
    const r = mergeCursorConfig(JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const parsed = parse(r.content);
    expect(parsed.mcpServers['other']).toEqual({ command: 'x' });
    expect(parsed.mcpServers['reticle']).toBeDefined();
  });

  it('never clobbers an existing reticle entry (idempotent)', () => {
    const existing = JSON.stringify({ mcpServers: { reticle: { command: 'custom' } } });
    const r = mergeCursorConfig(existing);
    expect(r.status).toBe(CursorMergeStatus.ALREADY);
    expect(r.content).toBe(existing);
  });

  it('bails to manual on unparseable jsonc without rewriting', () => {
    const jsonc = '{\n  // servers\n  "mcpServers": {}\n}\n';
    const r = mergeCursorConfig(jsonc);
    expect(r.status).toBe(CursorMergeStatus.MANUAL);
    expect(r.content).toBe(jsonc);
  });
});
