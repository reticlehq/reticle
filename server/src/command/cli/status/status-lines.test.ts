import { describe, expect, it } from 'vitest';
import { StatusLabel, statusLines } from './status-lines.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AttachState,
  attachStatusFields,
  rememberEnumerated,
  rememberProxyStarted,
  rememberToolCalled,
} from '@/surface/mcp/attach-memory.js';

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

/*
 * A member removed from the workspace ran `reticle status` with a key set that the platform now
 * refused, and read "not signed in — run reticle connect": the key was there, and refused.
 */
describe('an account whose key the platform refused', () => {
  it('says the key was refused, not that nobody is signed in', () => {
    const out = statusLines({
      port: 4400,
      running: false,
      signedInAs: null,
      linkedProject: 'bench-checkout',
      keyRefused: 'You were removed from Acme.',
    }).join('\n');
    expect(out).toContain('refused at the last sync: You were removed from Acme.');
    expect(out).not.toContain('not signed in');
  });
});

/* A re-drive: signed in to one workspace, `reticle status` did not say which one the repo sends to. */
describe('the workspace a linked repo sends to', () => {
  it('is named beside the project', () => {
    const out = statusLines({
      port: 4400,
      running: false,
      signedInAs: 'Omar\u2019s workspace',
      linkedProject: 'omar-notes',
      linkedWorkspace: 'Northwind Retail',
    }).join('\n');
    expect(out).toContain('this repo is linked to omar-notes in workspace "Northwind Retail"');
  });
});

/* Persona drives: the agent-link row printed the raw state name ("enumerated", "never-enumerated"). */
describe('the agent link row', () => {
  /** The status fields for a port whose record is in `state`, as the daemon reads them. */
  function attachFields(state: AttachState): Record<string, unknown> {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-attach-'));
    if (AttachState.NEVER_ATTACHED !== state) rememberProxyStarted(dir, 4400);
    if (AttachState.NEVER_ATTACHED !== state && AttachState.NEVER_ENUMERATED !== state)
      rememberEnumerated(dir, 4400);
    if (AttachState.ENUMERATED === state) rememberToolCalled(dir, 4400);
    return { ...attachStatusFields(dir, 4400) };
  }
  const out = (state: AttachState): string =>
    statusLines({ port: 4400, running: true, ...attachFields(state) }).join('\n');

  it('says in words that the agent has used the tools', () => {
    expect(out(AttachState.ENUMERATED)).toMatch(/✓ your agent has read and used Reticle's tools/);
  });

  it('never prints a state name, and gives the action when there is one', () => {
    const said = out(AttachState.NEVER_ENUMERATED);
    expect(said).not.toContain(AttachState.NEVER_ENUMERATED);
    expect(said).toContain('restart your MCP client');
  });
});
