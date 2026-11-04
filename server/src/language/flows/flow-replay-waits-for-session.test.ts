/**
 * A replay that starts while the page reconnects waits for the page (#2168).
 *
 * `reticle verify` replays flows one after the other, and each flow reloads the page. A flow that
 * started in the short gap between disconnect and reconnect ended `unknown` with "no browser
 * session connected", although the page came back a few milliseconds later.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleCommand,
  ReticleTool,
  asRef,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { FlowStore } from './flows.js';
import { replayNamedFlow } from './flow-replay-run.js';

const FLOW_NAME = 'reconnect-gap';
const TESTID = 'save';
const NO_SESSION = 'no browser session connected.';
/** About the reconnect gap seen in the field. */
const RECONNECT_AFTER_MS = 40;
const QUERY_RESULT = {
  elements: [{ ref: asRef('e-1'), role: 'button', name: TESTID, states: [], visible: true }],
  hint: { route: '/', presentTestids: [TESTID], knownEmptyState: false },
};

let base = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-replay-gap-')));
  mkdirSync(join(base, '.reticle'), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: FLOW_NAME,
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: TESTID },
      action: ActionType.CLICK,
    },
  ],
};

describe('flow replay started while the page reconnects', () => {
  it('waits for the session and runs the flow', async () => {
    const fs = createNodeFileSystem();
    const root = join(base, '.reticle');
    await new FlowStore(fs, root, { now: () => 0 }).saveFlow(flow);

    const acts: string[] = [];
    const session: Partial<Session> = {
      id: 'tab',
      url: 'http://localhost:15999/',
      command: (name): Promise<CommandResult> => {
        if (ReticleCommand.ACT === name) {
          acts.push(name);
        }
        const result = ReticleCommand.QUERY === name ? QUERY_RESULT : {};
        return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
      },
      elapsed: () => 0,
      eventsSince: () => [],
      onEvent: () => () => undefined,
    };
    // No session at the start of the replay; the page reconnects a moment later.
    let connected = false;
    setTimeout(() => {
      connected = true;
    }, RECONNECT_AFTER_MS);
    const sessions: Partial<SessionManager> = {
      count: () => (connected ? 1 : 0),
      resolve: () => {
        if (!connected) {
          throw new Error(NO_SESSION);
        }
        return session as Session;
      },
    };
    const deps = {
      fs,
      now: () => Date.now(),
      // The daemon runs elsewhere; the session's project holds the flow and the run record.
      reticleRoot: join(base, 'daemon'),
      flows: new FlowStore(fs, join(base, 'daemon'), { now: () => 0 }),
      sessions: sessions as SessionManager,
      artifactRootFor: () => ({ root, reason: ArtifactRootReason.MATCHED_PROJECT }),
    } as unknown as ToolDeps;

    const result = await replayNamedFlow(deps, { flowName: FLOW_NAME });

    expect(result.unverifiable?.reason ?? '').not.toContain(NO_SESSION);
    expect(result.error).toBeUndefined();
    expect(acts).toHaveLength(1);
  });
});
