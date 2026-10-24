import { describe, expect, it } from 'vitest';
import { retiresOlderDaemon } from './mcp-command.js';

/**
 * A proxy from a newer release found an older daemon on its port. It only described the skew, so
 * every tool refused or answered `unknown` until a person ran `reticle restart`.
 */
describe('a newer proxy meets an older daemon', () => {
  const status = (version: string, extra: Record<string, unknown> = {}) => ({
    running: true,
    version,
    sessions: [],
    ...extra,
  });

  it('retires it when no tab and no other agent is attached', () => {
    expect(retiresOlderDaemon(status('3.7.0'), '3.8.0')).toBe(true);
  });

  it('keeps it when a tab is attached, and the skew is described as before', () => {
    const tab = { sessionId: 's1', url: 'http://localhost:5173/' };
    expect(retiresOlderDaemon(status('3.7.0', { sessions: [tab] }), '3.8.0')).toBe(false);
  });

  it('keeps it when another agent is attached, because a call can be in flight', () => {
    expect(retiresOlderDaemon(status('3.7.0', { mcpPeers: ['3.7.0'] }), '3.8.0')).toBe(false);
  });

  // An older daemon never sends `mcpPeers`, so a missing list does not mean that no agent is there.
  it('keeps a daemon too old to say whether an agent is attached', () => {
    expect(retiresOlderDaemon(status('3.5.9'), '3.8.0')).toBe(false);
    expect(retiresOlderDaemon(status('3.0.0'), '3.8.0')).toBe(false);
  });

  it('retires an idle daemon from the first release that reports its agents', () => {
    expect(retiresOlderDaemon(status('3.6.0'), '3.8.0')).toBe(true);
  });

  it('keeps a daemon of the same or a newer release', () => {
    expect(retiresOlderDaemon(status('3.8.0'), '3.8.0')).toBe(false);
    expect(retiresOlderDaemon(status('3.9.0'), '3.8.0')).toBe(false);
  });

  it('keeps a daemon whose status it cannot read', () => {
    expect(retiresOlderDaemon(undefined, '3.8.0')).toBe(false);
    expect(retiresOlderDaemon({ running: true, version: 'dev' }, '3.8.0')).toBe(false);
  });
});
