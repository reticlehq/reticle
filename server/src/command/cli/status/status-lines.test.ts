import { describe, expect, it } from 'vitest';
import { StatusLabel, statusLines } from './status-lines.js';

describe('statusLines', () => {
  it('renders a running daemon with a connected session', () => {
    const out = statusLines({
      port: 4400,
      running: true,
      pid: 90790,
      sessionCount: 1,
      sessions: [
        {
          sessionId: 'sa308f09a',
          url: 'http://localhost:7699/',
          throttled: true,
          hidden: true,
          stale: false,
          pendingMarks: 0,
        },
      ],
      mcpClient: 'enumerated',
    });
    expect(out[0]).toBe('reticle status');
    expect(out.join('\n')).toContain('running on :4400 (pid 90790)');
    expect(out.join('\n')).toContain('1 page connected');
    expect(out.join('\n')).toContain('http://localhost:7699/');
    // The flags a reader needs to explain a slow or blank capture.
    expect(out.join('\n')).toContain('throttled');
    expect(out.join('\n')).toContain('hidden');
  });

  it('renders a daemon that is not running, and carries the next action', () => {
    const out = statusLines({
      port: 4400,
      running: false,
      nextAction: 'run `npx @reticlehq/server init` in the app directory',
    });
    expect(out.join('\n')).toContain('not running on :4400');
    expect(out.join('\n')).toContain('npx @reticlehq/server init');
  });

  it('distinguishes a port held by a stranger from a port with nothing on it', () => {
    const foreign = statusLines({
      port: 4400,
      running: false,
      presence: 'foreign',
      reason: 'port 4400 is held by something that is not a Reticle daemon.',
    }).join('\n');
    expect(foreign).toContain('held by something that is not a Reticle daemon');
    // The word itself, because the prose is what a person reads and `free` must not read the same.
    expect(foreign).toContain('foreign');

    const free = statusLines({ port: 4400, running: false, presence: 'free' }).join('\n');
    expect(free).not.toContain('foreign');
    expect(free).toContain('free');
  });

  it('says a daemon with no sessions has none, rather than staying silent about it', () => {
    const out = statusLines({ port: 4400, running: true, pid: 7, sessionCount: 0 });
    expect(out.join('\n')).toContain('no page connected');
  });

  it('prints every optional note it is given, and no empty row for one it is not', () => {
    const withNotes = statusLines({
      port: 4400,
      running: true,
      pid: 7,
      sessionCount: 0,
      splitBrain: 'two daemons serve this project',
      updateAvailable: '3.2.0',
      why: 'the page has not dialled yet',
    });
    const text = withNotes.join('\n');
    expect(text).toContain('two daemons serve this project');
    expect(text).toContain('3.2.0');
    expect(text).toContain('the page has not dialled yet');

    const bare = statusLines({ port: 4400, running: true, pid: 7, sessionCount: 0 });
    for (const label of [StatusLabel.SPLIT_BRAIN, StatusLabel.UPDATE, StatusLabel.AGENT_LINK]) {
      expect(bare.join('\n')).not.toContain(label);
    }
  });

  it('every line after the heading is indented, so the block reads as one answer', () => {
    const out = statusLines({ port: 4400, running: true, pid: 7, sessionCount: 0 });
    for (const line of out.slice(1)) expect(line.startsWith('  ')).toBe(true);
  });

  it('narrows a payload it does not recognise instead of throwing', () => {
    expect(() => statusLines({})).not.toThrow();
    expect(statusLines({}).join('\n')).toContain(StatusLabel.DAEMON);
  });
});
