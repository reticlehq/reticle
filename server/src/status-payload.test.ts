import { describe, expect, it } from 'vitest';
import { strandedClientsNote } from './status-payload.js';

// #812: `restart --force` upgraded the daemon past the agent's own MCP server, which a running
// agent cannot restart, and nothing said so first.
describe('a restart that would strand attached agents', () => {
  it('names the older versions and how to restart at theirs', () => {
    const note = strandedClientsNote({ mcpPeers: ['3.5.0', '3.5.0', '3.6.0'] }, '3.6.0');
    expect(note).toContain('3 agent MCP server(s) are attached at 3.5.0');
    expect(note).toContain('npx @reticlehq/server@3.5.0 restart');
  });

  it('says nothing when every attached agent matches, or the daemon did not say', () => {
    expect(strandedClientsNote({ mcpPeers: ['3.6.0'] }, '3.6.0')).toBeUndefined();
    expect(strandedClientsNote(undefined, '3.6.0')).toBeUndefined();
    expect(strandedClientsNote({ running: true }, '3.6.0')).toBeUndefined();
  });
});
