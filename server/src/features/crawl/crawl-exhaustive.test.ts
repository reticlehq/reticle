import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BehaviourFindingKind,
  EventType,
  ReticleCommand,
  SnapshotMode,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { LedgerStore, holesOf } from '@/features/exhaust/ledger.js';
import type { PortSession } from '@/features/exhaust/session-port.js';
import { runExhaustive } from './crawl-exhaustive.js';

/*
 * The whole exhaustive run over a session that speaks page commands: a form whose Save posts twice
 * when it is pressed twice. The plain explorer presses it once and sees nothing wrong. The edge
 * drive must press it twice, and the finding must reach the ledger and the crawl's anomalies.
 */
function formApp() {
  let clock = 0;
  const events: ReticleEvent[] = [];
  let page: 'form' | 'done' = 'form';
  let title = '';
  let nextId = 1;
  let refs = new Map<string, string>();
  let current: PortSession;
  const ok = (result: unknown): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
  const tree = (mode: unknown): string => {
    refs = new Map();
    const controls = 'form' === page ? ['textbox "Title"', 'button "Save"'] : ['button "New"'];
    const lines = controls.map((c, i) => {
      refs.set(`e${String(i + 1)}`, c);
      return `- ${c} (ref=e${String(i + 1)})`;
    });
    if (SnapshotMode.FULL === mode && 'done' === page) {
      lines.push('- status "Note saved"');
    }
    return lines.join('\n');
  };
  const make = (): PortSession => {
    const session: PortSession = {
      id: 's1',
      url: 'http://h/form',
      elapsed: () => clock,
      eventsSince: (since) => events.filter((e) => e.t > since),
      command: (name, args) => {
        if (ReticleCommand.SNAPSHOT === name) {
          return ok({ tree: tree(args?.['mode']), status: { route: `/${page}` } });
        }
        if (ReticleCommand.NAVIGATE === name || ReticleCommand.REFRESH === name) {
          if (ReticleCommand.NAVIGATE === name) {
            page = 'form';
            title = '';
          }
          current = make();
          return ok({});
        }
        if (ReticleCommand.QUERY === name) {
          return ok({ elements: [{ attrs: { maxlength: '20' } }] });
        }
        const label = refs.get(String(args?.['ref']));
        if ('textbox "Title"' === label) {
          const value: unknown = (args?.['args'] as { value?: unknown } | undefined)?.value;
          title = 'string' === typeof value ? value : '';
        } else if ('button "Save"' === label) {
          clock += 1;
          events.push({
            type: EventType.NET_REQUEST,
            t: clock,
            data: {
              method: 'POST',
              url: 'http://h/api/notes',
              status: 201,
              requestBody: JSON.stringify({ title }),
              responseBody: JSON.stringify({ id: nextId }),
            },
          } as unknown as ReticleEvent);
          nextId += 1;
          page = 'done';
        }
        return ok({ dispatched: true });
      },
    };
    return session;
  };
  current = make();
  return { sessions: { get: () => current }, session: current };
}

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('runExhaustive drives edge cases', () => {
  it('finds the double save, and puts it in the ledger and the anomalies', async () => {
    root = await mkdtemp(join(tmpdir(), 'reticle-exhaustive-'));
    const app = formApp();
    const fs = createNodeFileSystem();
    const result = await runExhaustive({
      sessions: app.sessions,
      session: app.session,
      startUrl: 'http://h/form',
      maxActions: 200,
      settleMs: 0,
      fillValue: () => 'hello',
      now: () => 0,
      sleep: () => Promise.resolve(),
      fs,
      reticleRoot: root,
    });

    const anomalies = result['anomalies'] as { kind: string; desc: string }[];
    expect(anomalies).toContainEqual(
      expect.objectContaining({
        kind: BehaviourFindingKind.REPEAT_CHANGED_STATE,
        desc: 'button "Save"',
      }),
    );
    const exhaustive = result['exhaustive'] as { edges: { probed: number; findings: number } };
    expect(exhaustive.edges.probed).toBeGreaterThan(0);

    const ledger = await new LedgerStore(fs, root).load();
    expect(ledger.edges.probed).toEqual(
      expect.arrayContaining(['button "Save"', 'textbox "Title"']),
    );
    expect(ledger.findings.map((f) => f.kind)).toContain(BehaviourFindingKind.REPEAT_CHANGED_STATE);
    expect(holesOf(ledger).edges.items).not.toContain('button "Save"');
  });
});
