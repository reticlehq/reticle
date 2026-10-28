/**
 * Which agents really connected, by name, on this machine.
 *
 * The defect: `attach-<port>.json` records that SOME client attached on a port, never which one.
 * So the installer could not say "Connected: Cursor ✓", and with two agents a healthy one hid a
 * broken one. This record keeps the client named in the MCP `initialize` handshake, machine wide.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  connectedAgentClients,
  initializeClientName,
  rememberAgentConnected,
} from './agents-connected.js';

describe('the connected-agents record', () => {
  it('is empty before any agent connects, and after a broken file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-'));
    expect(connectedAgentClients(dir).size).toBe(0);
    writeFileSync(join(dir, 'agents-connected.json'), '{not json');
    expect(connectedAgentClients(dir).size).toBe(0);
  });

  it('keeps each client named in a handshake', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-'));
    rememberAgentConnected(dir, 'claude_code');
    rememberAgentConnected(dir, 'cursor');
    rememberAgentConnected(dir, 'claude_code');
    expect([...connectedAgentClients(dir)].sort()).toEqual(['claude_code', 'cursor']);
  });
});

describe('the client name in an initialize request', () => {
  it('reads clientInfo.name from an initialize request', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'codex-mcp-client', version: '1' } },
    });
    expect(initializeClientName(line)).toBe('codex-mcp-client');
  });

  it('reads nothing from another method or a malformed line', () => {
    expect(initializeClientName(JSON.stringify({ method: 'tools/list' }))).toBeUndefined();
    expect(initializeClientName('{not json')).toBeUndefined();
    expect(
      initializeClientName(JSON.stringify({ method: 'initialize', params: {} })),
    ).toBeUndefined();
  });
});
