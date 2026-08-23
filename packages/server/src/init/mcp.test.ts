import { describe, expect, it } from 'vitest';
import {
  claudeAddCommand,
  claudeExistsProbe,
  mcpManual,
  windowsMcpNote,
  MCP_SERVER_NAME,
} from './mcp.js';

describe('claudeAddCommand', () => {
  it('registers reticle at user scope via npx (global, all projects)', () => {
    const c = claudeAddCommand();
    expect(c.command).toBe('claude');
    expect(c.args).toEqual([
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '-s',
      'user',
      '--',
      'npx',
      '@reticlehq/server',
      'mcp',
    ]);
  });

  it('is portless — never bakes a port into the global registration', () => {
    // A single global entry serves every project; the port is resolved per-project from
    //.reticle.json at runtime. Baking --port here would pin all projects to one port.
    const c = claudeAddCommand();
    expect(c.args).not.toContain('--port');
    expect(c.display).not.toContain('--port');
    expect(c.display).toBe('claude mcp add reticle -s user -- npx @reticlehq/server mcp');
  });
});

describe('claudeExistsProbe', () => {
  it('passes NO options — `claude mcp get` accepts none', () => {
    // With `-s user` the probe exits 1 ("unknown option '-s'") on every machine, so init concluded
    // "not registered", ran `claude mcp add`, and that exits 1 with "already exists" — every re-run
    // reported a failed MCP step and a manual command that fails identically.
    expect(claudeExistsProbe()).toEqual({
      command: 'claude',
      args: ['mcp', 'get', 'reticle'],
    });
  });

  it('probes the server claudeAddCommand registers', () => {
    expect(claudeAddCommand().args).toContain('reticle');
    expect(claudeExistsProbe().args).toContain('reticle');
  });
});

describe('mcpManual', () => {
  it('explains the one-time global registration', () => {
    const m = mcpManual();
    expect(m).toContain('claude mcp add reticle -s user');
    expect(m).toContain('globally');
    expect(m).not.toContain('--port');
  });
});

describe('windowsMcpNote', () => {
  /**
   * #509: on Windows the registered command stayed bare `npx`, the session came up with ZERO
   * reticle_* tools, and the daemon never started — and because `claude mcp add` itself succeeded,
   * init reported a clean install and never printed the one paragraph (the cmd /c fallback from
   * mcpManual) that fixes it. The fallback therefore has to ride along with every Windows
   * registration, not only the manual path. Off-Windows it is noise and stays absent.
   */
  it('names the cmd /c fallback on Windows', () => {
    const note = windowsMcpNote('win32');
    expect(note).toContain('cmd');
    expect(note).toContain('/c');
    expect(note).toContain(MCP_SERVER_NAME);
    expect(note).toContain('zero');
  });

  it('is absent off-Windows', () => {
    expect(windowsMcpNote('darwin')).toBeUndefined();
    expect(windowsMcpNote('linux')).toBeUndefined();
  });
});
