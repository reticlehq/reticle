import { describe, expect, it } from 'vitest';
import { mergeCursorConfig, CursorMergeStatus, cursorServerEntry } from './cursor.js';

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
      args: ['@reticlehq/server', 'mcp'],
    });
  });

  it('is portless — the global Cursor entry never bakes in a port', () => {
    // One global entry per user serves every project; the port is read per-project from
    //.reticle.json at runtime, so pinning a port here would break multi-project isolation.
    const r = mergeCursorConfig(null);
    expect(parse(r.content).mcpServers['reticle']?.args).toEqual(['@reticlehq/server', 'mcp']);
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
    const jsonc = '{\n  // servers\n "mcpServers": {}\n}\n';
    const r = mergeCursorConfig(jsonc);
    expect(r.status).toBe(CursorMergeStatus.MANUAL);
    expect(r.content).toBe(jsonc);
  });
});

/**
 * Two ways this could damage or fail to repair a user's config.
 *
 * The malformed-JSON path was already conservative — unparseable means MANUAL, file untouched. The
 * adjacent case was not: JSON that PARSES but is not an object (`[]`, `3`, `"x"`, `null`) fell
 * through to an empty config and the file was rewritten wholesale, destroying whatever was there.
 *
 * And idempotency was key-presence only, so a `reticle` entry left by an older release — pointing at
 * a command that no longer exists, or a stale pinned version — was reported "already registered" and
 * never repaired. An upgrade could not fix a bad entry, which is precisely when it needs to.
 */
describe('a config that parses but is not an object', () => {
  it.each([
    ['an array', '[]'],
    ['a number', '3'],
    ['a string', '"mcpServers"'],
    ['null', 'null'],
  ])('%s is left alone, never overwritten', (_label, content) => {
    const result = mergeCursorConfig(content);
    expect(result.status).toBe(CursorMergeStatus.MANUAL);
    expect(result.content, 'the file must survive verbatim').toBe(content);
  });
});

describe('an existing reticle entry', () => {
  it('is left alone when it already matches', () => {
    const current = JSON.stringify({ mcpServers: { reticle: cursorServerEntry() } });
    expect(mergeCursorConfig(current).status).toBe(CursorMergeStatus.ALREADY);
  });

  it("leaves a user's OWN customised entry alone — that is a choice, not staleness", () => {
    const custom = JSON.stringify({
      mcpServers: { reticle: { command: 'node', args: ['./my-build.js'] } },
    });
    expect(mergeCursorConfig(custom).status).toBe(CursorMergeStatus.ALREADY);
  });

  it('is REPAIRED when it is stale, rather than reported already-registered', () => {
    const stale = JSON.stringify({
      // Shaped like one WE wrote — an old pin — which is exactly the case an upgrade must repair.
      mcpServers: { reticle: { command: 'npx', args: ['@reticlehq/server@2.3.0', 'mcp'] } },
    });
    const result = mergeCursorConfig(stale);
    expect(result.status).toBe(CursorMergeStatus.APPLY);
    expect(result.content).not.toContain('@reticlehq/server@2.3.0');
  });

  /**
   * Reported from the field: `~/.cursor/mcp.json` carried `args: ["@reticlehq/core","mcp"]` — the
   * contract package, which has no `mcp` bin — so Cursor showed the server as "errored" with zero
   * tools, and `init` printed `·` "already in Cursor global config" on every re-run. A registration
   * that does not point at the server package is not a registration; it is the reason none of the
   * `reticle_*` tools exist, and it blocks everything until a human edits that file by hand.
   */
  it('is REWRITTEN when it points at the wrong @reticlehq package', () => {
    const wrong = JSON.stringify({
      mcpServers: { reticle: { command: 'npx', args: ['@reticlehq/core', 'mcp'] } },
    });
    const result = mergeCursorConfig(wrong);
    expect(result.status).toBe(CursorMergeStatus.APPLY);
    expect(result.content).not.toContain('@reticlehq/core');
    expect(result.content).toContain('@reticlehq/server');
  });

  it('repairs only OUR entry, leaving other servers untouched', () => {
    const stale = JSON.stringify({
      mcpServers: {
        reticle: { command: 'npx', args: ['@reticlehq/server@2.3.0', 'mcp'] },
        somebodyElse: { command: 'their-server', args: ['--flag'] },
      },
      otherTopLevelKey: { keep: true },
    });
    const result = mergeCursorConfig(stale);
    expect(result.content).toContain('somebodyElse');
    expect(result.content).toContain('their-server');
    expect(result.content).toContain('otherTopLevelKey');
  });
});
