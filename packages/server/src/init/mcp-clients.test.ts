/**
 * Registering Reticle with the agent the user actually runs.
 *
 * `init` knew two clients: Claude Code (a CLI shell-out) and Cursor (a JSON merge). Everything else
 * got a printed snippet and a hope. That is the blocker under the whole release matrix — a
 * a per-client release artifact for a client `init` cannot wire measures whether somebody pasted JSON
 * correctly, not whether the product works.
 *
 * Every path and shape here was READ FROM THE CLIENT'S DOCUMENTATION rather than recalled, because
 * they differ in ways that look like they should not:
 *
 *   Cursor / Windsurf / Gemini   `mcpServers: { name: { command, args } }`  — same shape, three paths
 *   VS Code                      `servers:` — a different key entirely
 *   OpenCode                     `mcp: { name: { type, command: [cmd, ...args] } }` — command is an ARRAY
 *   Codex                        TOML
 *
 * A single "write mcp.json" that assumed the Cursor shape would silently produce a file three of
 * these clients ignore — an install that reports success and registers nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  McpClient,
  MCP_CLIENTS,
  clientSpec,
  mergeClientConfig,
  ClientMergeStatus,
  ConfigScope,
  type ClientSpec,
  clientMarkerRelPath,
  clientSnippet,
} from './mcp-clients.js';
import { MCP_SERVER_NAME } from './mcp.js';

const parse = (content: string): Record<string, unknown> =>
  JSON.parse(content) as Record<string, unknown>;

describe('the client registry', () => {
  it('every client declares where its config lives and how to write it', () => {
    for (const spec of MCP_CLIENTS) {
      expect(spec.id, 'a client needs an id').toBeTruthy();
      expect(spec.label, `${spec.id} needs a human label`).toBeTruthy();
      expect(['home', 'project', 'cli'], `${spec.id} scope`).toContain(spec.scope);
      if (spec.scope !== 'cli') expect(spec.relPath, `${spec.id} needs a path`).toBeTruthy();
    }
  });

  it('no two clients claim the same config path', () => {
    // A collision here would mean writing one client's shape into another's file.
    const paths = MCP_CLIENTS.filter((s) => s.scope !== 'cli').map(
      (s) => `${s.scope}:${s.relPath}`,
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('covers the clients the release matrix names', () => {
    const ids = MCP_CLIENTS.map((s) => s.id);
    for (const id of [
      McpClient.CLAUDE_CODE,
      McpClient.CURSOR,
      McpClient.WINDSURF,
      McpClient.OPENCODE,
      McpClient.CODEX,
      McpClient.GEMINI,
      McpClient.VSCODE,
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe('the mcpServers-shaped clients', () => {
  for (const id of [McpClient.CURSOR, McpClient.WINDSURF, McpClient.GEMINI] as const) {
    it(`${id}: writes our entry into an empty config`, () => {
      const result = mergeClientConfig(clientSpec(id), null);
      expect(result.status).toBe(ClientMergeStatus.APPLY);
      const servers = parse(result.content)['mcpServers'] as Record<string, unknown>;
      expect(servers[MCP_SERVER_NAME]).toBeDefined();
    });

    it(`${id}: leaves every other server and top-level key untouched`, () => {
      const existing = JSON.stringify({
        mcpServers: { other: { command: 'node', args: ['x.js'] } },
        somethingElse: { keep: true },
      });
      const merged = parse(mergeClientConfig(clientSpec(id), existing).content);
      expect((merged['mcpServers'] as Record<string, unknown>)['other']).toEqual({
        command: 'node',
        args: ['x.js'],
      });
      expect(merged['somethingElse']).toEqual({ keep: true });
    });
  }

  it('vscode uses `servers`, not `mcpServers` — the key is the whole difference', () => {
    const result = mergeClientConfig(clientSpec(McpClient.VSCODE), null);
    const parsed = parse(result.content);
    expect(parsed['servers']).toBeDefined();
    expect(parsed['mcpServers'], 'writing mcpServers here registers nothing').toBeUndefined();
  });
});

describe('opencode', () => {
  /** Narrow once: the map is `unknown` to the type system but is asserted present by the test itself. */
  const openCodeEntry = (content: string): Record<string, unknown> => {
    const mcp = parse(content)['mcp'] as Record<string, Record<string, unknown>> | undefined;
    const found = mcp?.[MCP_SERVER_NAME];
    expect(found, 'opencode entry missing').toBeDefined();
    return found as Record<string, unknown>;
  };

  it('uses `mcp`, and its command is an ARRAY that includes the command itself', () => {
    const result = mergeClientConfig(clientSpec(McpClient.OPENCODE), null);
    const entry = openCodeEntry(result.content);
    expect(entry['type']).toBe('local');
    expect(Array.isArray(entry['command'])).toBe(true);
    // The shape a `{command, args}` assumption would get wrong: the executable is element zero.
    expect((entry['command'] as string[])[0]).toBeTruthy();
    expect((entry['command'] as string[]).length).toBeGreaterThan(1);
  });

  it('is enabled explicitly — a registered-but-disabled server is the quietest possible failure', () => {
    const entry = openCodeEntry(mergeClientConfig(clientSpec(McpClient.OPENCODE), null).content);
    expect(entry['enabled']).toBe(true);
  });
});

describe('refusing to damage a file we do not understand', () => {
  for (const id of [McpClient.CURSOR, McpClient.VSCODE, McpClient.OPENCODE] as const) {
    it(`${id}: unparseable JSON is left byte-for-byte alone`, () => {
      const existing = '{ "mcpServers": { /* a comment */ } }';
      const result = mergeClientConfig(clientSpec(id), existing);
      expect(result.status).toBe(ClientMergeStatus.MANUAL);
      expect(result.content).toBe(existing);
    });

    it(`${id}: valid JSON that is not an object is left alone too`, () => {
      // The adjacent case that once destroyed a file: `[]` parses, is not a config, and the old code
      // fell through to an empty object and rewrote the whole thing.
      const result = mergeClientConfig(clientSpec(id), '[1,2,3]');
      expect(result.status).toBe(ClientMergeStatus.MANUAL);
      expect(result.content).toBe('[1,2,3]');
    });
  }
});

describe('idempotency, and the difference between "already right" and "not ours"', () => {
  it('a config we already wrote is ALREADY, and the file is not rewritten', () => {
    const first = mergeClientConfig(clientSpec(McpClient.CURSOR), null);
    const second = mergeClientConfig(clientSpec(McpClient.CURSOR), first.content);
    expect(second.status).toBe(ClientMergeStatus.ALREADY);
    expect(second.content).toBe(first.content);
  });

  it("a user's own reticle entry is left alone — pointing at a local build is a choice", () => {
    const existing = JSON.stringify({
      mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: ['/my/local/cli.js', 'mcp'] } },
    });
    expect(mergeClientConfig(clientSpec(McpClient.CURSOR), existing).status).toBe(
      ClientMergeStatus.ALREADY,
    );
  });

  it('a STALE entry of our own shape is repaired, because that is what an upgrade is for', () => {
    const existing = JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { command: 'npx', args: ['@reticlehq/server@0.0.1', 'mcp'] },
      },
    });
    const result = mergeClientConfig(clientSpec(McpClient.CURSOR), existing);
    expect(result.status).toBe(ClientMergeStatus.APPLY);
  });

  /**
   * The wrong @reticlehq package is a WRONG registration, not a user's choice — every JSON client,
   * not just the one it was reported on. `@reticlehq/core` has no `mcp` bin, so the client shows the
   * server errored with zero tools while `init` reports it already wired.
   */
  for (const id of [McpClient.CURSOR, McpClient.WINDSURF, McpClient.GEMINI, McpClient.VSCODE]) {
    it(`${id}: an entry naming the wrong @reticlehq package is rewritten, not reported wired`, () => {
      const spec = clientSpec(id);
      const existing = JSON.stringify({
        [spec.serversKey]: {
          [MCP_SERVER_NAME]: { command: 'npx', args: ['@reticlehq/core', 'mcp'] },
        },
      });
      const result = mergeClientConfig(spec, existing);
      expect(result.status).toBe(ClientMergeStatus.APPLY);
      expect(result.content).not.toContain('@reticlehq/core');
      expect(result.content).toContain('@reticlehq/server');
    });
  }

  it('opencode: the same wrong package inside its command ARRAY is rewritten too', () => {
    const spec = clientSpec(McpClient.OPENCODE);
    const existing = JSON.stringify({
      [spec.serversKey]: {
        [MCP_SERVER_NAME]: {
          type: 'local',
          command: ['npx', '@reticlehq/core', 'mcp'],
          enabled: true,
        },
      },
    });
    const result = mergeClientConfig(spec, existing);
    expect(result.status).toBe(ClientMergeStatus.APPLY);
    expect(result.content).not.toContain('@reticlehq/core');
  });
});

describe('codex', () => {
  it('is TOML, so it is NOT auto-written', () => {
    // Merging into TOML without a parser is how a config file gets corrupted. Printing the exact
    // block is honest; writing a guess is not.
    expect(clientSpec(McpClient.CODEX).format).toBe('toml');
    expect(mergeClientConfig(clientSpec(McpClient.CODEX), null).status).toBe(
      ClientMergeStatus.MANUAL,
    );
  });

  it('and its snippet is a real TOML section the user can paste', () => {
    const snippet = clientSnippet(clientSpec(McpClient.CODEX));
    expect(snippet).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(snippet).toContain('command');
  });
});

describe('every client can produce a paste-able snippet', () => {
  it('so a client we cannot write is still actionable', () => {
    for (const spec of MCP_CLIENTS) {
      const snippet = clientSnippet(spec);
      expect(snippet.length, `${spec.id} has no snippet`).toBeGreaterThan(10);
      expect(snippet, `${spec.id} snippet does not mention the server`).toContain(MCP_SERVER_NAME);
    }
  });
});

/**
 * OpenCode installs GLOBALLY and is registered globally, like Cursor — not per project.
 *
 * It was listed with a project-scoped `opencode.json`, and registration is gated on that file already
 * existing, so a project that had never written one was skipped in silence: the user has OpenCode
 * installed, `init` says nothing about it, and the tools never appear. In the field every OpenCode
 * user connected an MCP client and produced zero tool calls and zero app connections, which is what
 * "you were never wired" looks like from the outside.
 *
 * Verified against a real install (OpenCode 1.3.17): the config lives at
 * `~/.config/opencode/opencode.jsonc`. The extension is `.jsonc`, which the project-scoped marker
 * would never have matched even if a project config existed.
 */
describe('opencode is wired where it actually lives', () => {
  const spec = MCP_CLIENTS.find((c) => c.id === McpClient.OPENCODE);

  it('is registered in the user home, not per project', () => {
    expect(spec?.scope).toBe(ConfigScope.HOME);
  });

  it('targets the real config path, extension included', () => {
    expect(spec?.relPath).toBe('.config/opencode/opencode.jsonc');
  });

  it('merges into an existing config without disturbing what is there', () => {
    // The shape a real install has: a schema pointer and a plugin list, both of which must survive.
    const existing = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['opencode-supermemory@latest'],
    });
    const merged = mergeClientConfig(spec as ClientSpec, existing);
    expect(merged.status).toBe(ClientMergeStatus.APPLY);
    const parsed = JSON.parse(merged.content) as Record<string, unknown>;
    expect(parsed['$schema']).toBe('https://opencode.ai/config.json');
    expect(parsed['plugin']).toEqual(['opencode-supermemory@latest']);
    expect((parsed['mcp'] as Record<string, unknown>)['reticle']).toBeDefined();
  });

  it('falls back to a printed block when the JSONC genuinely has comments', () => {
    // `.jsonc` permits comments, and a parser that guessed would strip them from the user's own file.
    // A failed parse must degrade to MANUAL, never to a rewrite.
    const commented = '{\n  // my settings\n  "plugin": []\n}';
    expect(mergeClientConfig(spec as ClientSpec, commented).status).toBe(ClientMergeStatus.MANUAL);
  });
});

/**
 * Antigravity, which connected nine users and drove nothing.
 *
 * `init` did not know this client at all, so those users hand-wired an MCP registration (they reached
 * the daemon - the connections are in the field data) and then never ran `init`, never instrumented an
 * app, and never called a tool. Nothing told them there was a second half.
 *
 * Path and shape taken from Google's own documentation, not recalled: the config is
 * `~/.gemini/config/mcp_config.json` under a top-level `mcpServers` key, and one file serves the 2.0
 * IDE, the CLI and the SDK alike. The shape is the same `command`/`args` object Cursor, Windsurf and
 * Gemini CLI already use, so this is a registry entry rather than a new mechanism.
 *
 * NOT verified against a running install - Antigravity is not on the machine this was written on. The
 * path is documented, the merge is the shared JSON path with its own tests, and a config that fails to
 * parse still degrades to a printed block.
 */
describe('antigravity', () => {
  const spec = MCP_CLIENTS.find((c) => c.id === McpClient.ANTIGRAVITY);

  it('is a client init knows about', () => {
    expect(spec, 'antigravity entry missing').toBeDefined();
  });

  it('writes the documented global config path', () => {
    expect(spec?.scope).toBe(ConfigScope.HOME);
    expect(spec?.relPath).toBe('.gemini/config/mcp_config.json');
  });

  it('uses the mcpServers key, like the other Gemini-family clients', () => {
    expect(spec?.serversKey).toBe('mcpServers');
  });

  it('does not collide with the Gemini CLI entry that shares the ~/.gemini tree', () => {
    // Both live under ~/.gemini, and registration is gated on the marker DIRECTORY existing. If the
    // markers matched, having one client installed would make init write a config for the other.
    const gemini = MCP_CLIENTS.find((c) => c.id === McpClient.GEMINI);
    expect(spec?.relPath).not.toBe(gemini?.relPath);
    expect(clientMarkerRelPath(spec as ClientSpec)).not.toBe(
      clientMarkerRelPath(gemini as ClientSpec),
    );
  });

  it('merges into an existing config without touching the servers already there', () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: 'node', args: ['x.js'] } } });
    const merged = mergeClientConfig(spec as ClientSpec, existing);
    expect(merged.status).toBe(ClientMergeStatus.APPLY);
    const servers = (JSON.parse(merged.content) as { mcpServers: Record<string, unknown> })
      .mcpServers;
    expect(servers['other']).toBeDefined();
    expect(servers[MCP_SERVER_NAME]).toBeDefined();
  });
});
