import { afterEach, describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  QueryBy,
  ReticleTool,
  asProjectId,
  type CommandResult,
  type FlowFile,
  type ProjectId,
  type ReticleEvent,
} from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '@/surface/tools/tools.js';
import { READ_TOOLS } from '@/surface/tools/read-tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { RecordingStore, type CompiledProgram } from './recording/tape/recordings.js';
import { FlowStore } from './flows.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { resolveSuiteSelection } from './suite-selection.js';
import { createRunnerPort } from '@/judgement/runs/runner-port.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from './stores/annotation-store.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import { claimArtifactRoot, dropArtifactRootClaim } from '@/memory/project/root-claims.js';
import { sessionTarget } from '@/memory/project/session-root.js';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { createFakeSession } from '@/portal/session/fake-session.js';
import type { Session } from '@/portal/session/session.js';
import { SessionManager } from '@/portal/session/session-manager.js';

/**
 * Where a saved flow LANDS, as opposed to what it contains.
 *
 * `flows.save` already scopes by projectId into a subdirectory, so two projects under one daemon
 * never collide. What it could not do was choose the BASE: that came from the daemon's own
 * `process.cwd()`, decided once at construction, and a user-scoped MCP registration is started
 * wherever the editor happens to be. The flow then landed outside the repo it verifies — reported
 * from the field as a save that returned success, named no path, and was found afterwards with
 * `find`.
 *
 * These tests pin the base path and the reported path. The resolution rule itself is
 * `resolveArtifactRoot`'s and is tested there.
 */

const DAEMON_ROOT = '/daemon-cwd/.reticle';
const PROJECT_ROOT = '/repo/apps/web/.reticle';

const norm = (p: string): string => p.split('\\').join('/');

function depsFor(
  fs: FileSystemPort,
  recordings: RecordingStore,
  sessionProjectId: ProjectId | undefined,
  artifactRootFor: ToolDeps['artifactRootFor'],
): ToolDeps {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  const session: Partial<Session> = {
    id: 'demo',
    command,
    projectId: sessionProjectId,
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings,
    flows: new FlowStore(fs, DAEMON_ROOT, { now: () => 1234 }),
    project: new ProjectStore(fs, DAEMON_ROOT, { now: () => 1234 }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: DAEMON_ROOT,
    now: () => 1234,
    ...(artifactRootFor === undefined ? {} : { artifactRootFor }),
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return t;
}

function oneStep(name: string): CompiledProgram {
  return {
    name,
    version: 1,
    steps: [
      {
        tool: ReticleTool.ACT,
        stable: true,
        args: { by: QueryBy.TESTID, value: 'submit', action: ActionType.CLICK, args: {} },
      },
    ],
  };
}

describe('reticle_flow_save writes to the session project, not the daemon cwd', () => {
  it('writes under the resolved project root when the session names a known project', async () => {
    const { fs, written } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('login'));

    const deps = depsFor(fs, recordings, asProjectId('acme-web-9f3c1d'), () => ({
      root: PROJECT_ROOT,
      reason: ArtifactRootReason.MATCHED_PROJECT,
    }));

    await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' });

    const paths = [...written.keys()];
    expect(
      paths.some((p) => p.startsWith(`${PROJECT_ROOT}/flows`)),
      `expected a write under ${PROJECT_ROOT}/flows, got: ${paths.join(', ')}`,
    ).toBe(true);
    expect(paths.some((p) => p.startsWith(`${DAEMON_ROOT}/flows`))).toBe(false);
  });

  /**
   * The reporter who lost a `find` to this needs the path in the response, whichever branch
   * resolution took. A save that says it succeeded and not where is not checkable by its caller.
   */
  it('reports the absolute path it wrote', async () => {
    const { fs } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('login'));

    const deps = depsFor(fs, recordings, asProjectId('acme-web-9f3c1d'), () => ({
      root: PROJECT_ROOT,
      reason: ArtifactRootReason.MATCHED_PROJECT,
    }));

    const res = (await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' })) as {
      path?: string;
    };
    expect(res.path).toBeDefined();
    expect(norm(res.path ?? '')).toContain(PROJECT_ROOT);
  });

  /**
   * No resolver supplied is the shape every existing construction of ToolDeps has, and the shape a
   * consumer embedding this engine may keep. It must behave exactly as it does today.
   */
  it('falls back to the daemon root when no resolver is wired', async () => {
    const { fs, written } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('login'));

    const deps = depsFor(fs, recordings, asProjectId('acme-web-9f3c1d'), undefined);
    await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' });

    expect([...written.keys()].some((p) => p.startsWith(`${DAEMON_ROOT}/flows`))).toBe(true);
  });
});

/**
 * The listing is what an agent READS to learn what a project has, and it was the half still
 * answering from the daemon's own directory: the store was resolved but the reported path was
 * joined onto `deps.reticleRoot`, so a HUD driving a React dashboard listed an unrelated
 * checkout's Electron and Tauri flows and gave paths into a repo the user was not in.
 */
describe('reticle_flow_list reports paths in the session project', () => {
  it('joins listed names onto the resolved root, not the daemon root', async () => {
    const { fs } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('login'));

    const deps = depsFor(fs, recordings, asProjectId('acme-web-9f3c1d'), () => ({
      root: PROJECT_ROOT,
      reason: ArtifactRootReason.MATCHED_PROJECT,
    }));
    await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' });

    // FLOW_LIST is merged into the `reticle_flow` facade, so it is not in TOOLS by its own name.
    const listTool = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_LIST);
    if (listTool === undefined) {
      throw new Error('no flow_list tool');
    }
    const res = (await listTool.handler(deps, {})) as {
      flows: { name: string; path: string }[];
    };
    expect(res.flows.map((f) => f.name)).toContain('login');
    for (const flow of res.flows) {
      expect(norm(flow.path).startsWith(PROJECT_ROOT)).toBe(true);
      expect(norm(flow.path).startsWith(DAEMON_ROOT)).toBe(false);
    }
  });
});

/**
 * `load` and `delete` read `deps.flows`, the daemon's own store, while `list` and replay resolve the
 * session's project. With the two roots apart, `list` showed a flow that `load` called missing, and
 * `load` found a daemon-root flow that `list`, replay and `verify` could not.
 */
describe('reticle_flow load and delete resolve the session project, as list and replay do', () => {
  const flowTool = (name: string) => {
    const t = FLOW_TOOLS.find((x) => x.name === name);
    if (t === undefined) {
      throw new Error(`no tool ${name}`);
    }
    return t;
  };
  const projectId = asProjectId('acme-web-9f3c1d');
  const resolver: ToolDeps['artifactRootFor'] = () => ({
    root: PROJECT_ROOT,
    reason: ArtifactRootReason.MATCHED_PROJECT,
  });

  async function listed(deps: ToolDeps): Promise<string[]> {
    const res = (await flowTool(ReticleTool.FLOW_LIST).handler(deps, {})) as {
      flows: { name: string }[];
    };
    return res.flows.map((f) => f.name);
  }

  it('loads, replays and deletes a flow saved in the session project', async () => {
    const { fs } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('login'));
    const deps = depsFor(fs, recordings, projectId, resolver);
    await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' });
    expect(await listed(deps)).toContain('login');

    const loaded = (await flowTool(ReticleTool.FLOW_LOAD).handler(deps, {
      flowName: 'login',
    })) as { flowName?: string; code?: string };
    expect(loaded.code).toBeUndefined();
    expect(loaded.flowName).toBe('login');

    const replayed = (await flowTool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'login',
    })) as { name?: string; error?: { code: string } };
    expect(replayed.error).toBeUndefined();
    expect(replayed.name).toBe('login');

    const deleted = (await flowTool(ReticleTool.FLOW_DELETE).handler(deps, {
      flowName: 'login',
    })) as { deleted?: boolean; code?: string };
    expect(deleted.code).toBeUndefined();
    expect(deleted.deleted).toBe(true);
    expect(await listed(deps)).not.toContain('login');
  });

  it('does not load or delete a flow that is only in the daemon root', async () => {
    const { fs } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('daemon-only'));
    await tool(ReticleTool.FLOW_SAVE).handler(depsFor(fs, recordings, projectId, undefined), {
      flowName: 'daemon-only',
    });

    const deps = depsFor(fs, recordings, projectId, resolver);
    expect(await listed(deps)).not.toContain('daemon-only');

    const loaded = (await flowTool(ReticleTool.FLOW_LOAD).handler(deps, {
      flowName: 'daemon-only',
    })) as { code?: string };
    expect(loaded.code).toBe(FlowErrorCode.NOT_FOUND);

    const deleted = (await flowTool(ReticleTool.FLOW_DELETE).handler(deps, {
      flowName: 'daemon-only',
    })) as { deleted?: boolean; code?: string };
    expect(deleted.deleted).toBeUndefined();
    expect(deleted.code).toBe(FlowErrorCode.NOT_FOUND);
    expect(await listed(depsFor(fs, recordings, projectId, undefined))).toContain('daemon-only');
  });
});

describe('reticle_domain and the runner port read the session project, as reticle_flow does', () => {
  const projectId = asProjectId('acme-web-9f3c1d');
  const resolver: ToolDeps['artifactRootFor'] = () => ({
    root: PROJECT_ROOT,
    reason: ArtifactRootReason.MATCHED_PROJECT,
  });

  /** `login` saved in the session project, `daemon-only` in the daemon root. */
  async function savedInBothRoots(): Promise<ToolDeps> {
    const { fs } = createMemoryFs();
    // A disk has these once a flow is saved under them; the memory fs only knows dirs made explicitly.
    await fs.mkdir(`${DAEMON_ROOT}/flows`);
    await fs.mkdir(`${PROJECT_ROOT}/flows`);
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('daemon-only'));
    await tool(ReticleTool.FLOW_SAVE).handler(depsFor(fs, recordings, projectId, undefined), {
      flowName: 'daemon-only',
    });
    const deps = depsFor(fs, recordings, projectId, resolver);
    recordings.saveCompiled(oneStep('login'));
    await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' });
    return deps;
  }

  it('builds the domain model from the session project flows', async () => {
    const deps = await savedInBothRoots();
    const model = (await tool(ReticleTool.DOMAIN).handler(deps, {})) as {
      flows: { name: string }[];
    };
    expect(model.flows.map((f) => f.name)).toEqual(['login']);
  });

  it('lists the session project flows for the runner, where replay looks for them', async () => {
    const deps = await savedInBothRoots();
    expect(await createRunnerPort(deps).listFlows()).toEqual(['login']);
  });
});

/**
 * A leased tab from another project claims its own `.reticle` root, while the daemon's default
 * scope is the folder the daemon started in (#2293).
 *
 * Recording on that lease (`reticle_record { start/stop }` or `reticle_act { steps }`) names the
 * lease `sessionId`, and the follow-up `reticle_flow_save` often omits `sessionId` (as the `keep`
 * offer itself suggests). Without the recording's session, `sessionTarget(deps, undefined)` hit the
 * daemon's scope guard, fell back to `projectOnly(undefined)`, and wrote the flow into the daemon
 * folder where `reticle gate` and `reticle_verify { action: "flows" }` on the lease could not find
 * it.
 */
describe('reticle_flow_save and reticle_flow_save_recorded on a leased session (#2293)', () => {
  const LEASE_ID = 'lease-2293';
  const DAEMON_PROJECT = asProjectId('daemon-app-1111');
  const LEASE_PROJECT = asProjectId('leased-app-2222');

  afterEach(() => {
    dropArtifactRootClaim(LEASE_ID);
  });

  function readTool(name: string) {
    const found = READ_TOOLS.find((t) => t.name === name);
    if (found === undefined) {
      throw new Error(`no read tool ${name}`);
    }
    return found;
  }

  function flowTool(name: string) {
    const found = FLOW_TOOLS.find((t) => t.name === name);
    if (found === undefined) {
      throw new Error(`no flow tool ${name}`);
    }
    return found;
  }

  function leasedDeps(events: ReticleEvent[] = []): {
    deps: ToolDeps;
    written: Map<string, string>;
    sessions: SessionManager;
    leasedSession: Session;
  } {
    const { fs, written } = createMemoryFs();
    const recordings = new RecordingStore();
    const command = (): Promise<CommandResult> =>
      Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
    const leasedSession = createFakeSession(
      {
        command,
        eventsSince: () => events,
      },
      {
        sessionId: LEASE_ID,
        url: 'http://localhost:4173/',
        projectId: LEASE_PROJECT,
      },
    );
    const sessions = new SessionManager();
    sessions.setDefaultScope({ projectId: DAEMON_PROJECT });
    sessions.add(leasedSession);
    const deps: ToolDeps = {
      sessions,
      baselines: new BaselineStore(),
      recordings,
      flows: new FlowStore(fs, DAEMON_ROOT, { now: () => 1234 }),
      project: new ProjectStore(fs, DAEMON_ROOT, { now: () => 1234 }),
      annotations: new AnnotationStore(),
      fs,
      reticleRoot: DAEMON_ROOT,
      now: () => 1234,
    };
    return { deps, written, sessions, leasedSession };
  }

  it('saves a stopped recording from a leased session into the lease claimed root even when sessionId is omitted, so verify flows finds it', async () => {
    claimArtifactRoot(LEASE_ID, PROJECT_ROOT);
    const { deps, written } = leasedDeps();

    await readTool(ReticleTool.RECORD_START).handler(deps, {
      recordingName: 'checkout',
      sessionId: LEASE_ID,
    });
    deps.recordings.capture(
      {
        tool: ReticleTool.ACT,
        stable: true,
        args: { by: QueryBy.TESTID, value: 'buy', action: ActionType.CLICK, args: {} },
      },
      '/',
      LEASE_ID,
    );
    await readTool(ReticleTool.RECORD_STOP).handler(deps, {
      recordingName: 'checkout',
      sessionId: LEASE_ID,
    });

    const saved = (await tool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: 'checkout',
    })) as { name?: string; path?: string; error?: string };

    expect(saved.error).toBeUndefined();
    expect(norm(saved.path ?? '')).toContain(PROJECT_ROOT);
    const paths = [...written.keys()].map(norm);
    expect(
      paths.some((p) => p.startsWith(`${PROJECT_ROOT}/flows`)),
      `expected flow under ${PROJECT_ROOT}/flows, got: ${paths.join(', ')}`,
    ).toBe(true);
    expect(paths.some((p) => p.startsWith(`${DAEMON_ROOT}/flows`))).toBe(false);

    const selected = await resolveSuiteSelection(deps, sessionTarget(deps, LEASE_ID), {});
    expect(selected.run).toContain('checkout');
  });

  it('writes reticle_flow_save_recorded into the lease claimed root, not the daemon root', async () => {
    claimArtifactRoot(LEASE_ID, PROJECT_ROOT);
    const recordedFlow: FlowFile = {
      version: FLOW_FILE_VERSION,
      name: 'human-checkout',
      createdAt: 1234,
      steps: [
        {
          tool: ReticleTool.ACT,
          anchor: { kind: AnchorKind.TESTID, value: 'pay' },
          action: ActionType.CLICK,
          args: {},
        },
      ],
    };
    const event: ReticleEvent = {
      t: 1,
      type: EventType.FLOW_RECORDED,
      sessionId: LEASE_ID,
      data: { name: 'human-checkout', flow: recordedFlow },
    };
    const { deps, written } = leasedDeps([event]);

    const res = (await flowTool(ReticleTool.FLOW_SAVE_RECORDED).handler(deps, {
      sessionId: LEASE_ID,
    })) as { name?: string; error?: string };

    expect(res.error).toBeUndefined();
    expect(res.name).toBe('human-checkout');
    const paths = [...written.keys()].map(norm);
    expect(
      paths.some((p) => p.startsWith(`${PROJECT_ROOT}/flows`)),
      `expected flow under ${PROJECT_ROOT}/flows, got: ${paths.join(', ')}`,
    ).toBe(true);
    expect(paths.some((p) => p.startsWith(`${DAEMON_ROOT}/flows`))).toBe(false);
  });

  it('falls back safely when sessionId is omitted and the recording session has disconnected', async () => {
    claimArtifactRoot(LEASE_ID, PROJECT_ROOT);
    const { deps, written, sessions, leasedSession } = leasedDeps();

    await readTool(ReticleTool.RECORD_START).handler(deps, {
      recordingName: 'checkout',
      sessionId: LEASE_ID,
    });
    deps.recordings.capture(
      {
        tool: ReticleTool.ACT,
        stable: true,
        args: { by: QueryBy.TESTID, value: 'buy', action: ActionType.CLICK, args: {} },
      },
      '/',
      LEASE_ID,
    );
    await readTool(ReticleTool.RECORD_STOP).handler(deps, {
      recordingName: 'checkout',
      sessionId: LEASE_ID,
    });

    sessions.remove(leasedSession);
    dropArtifactRootClaim(LEASE_ID);

    const saved = (await tool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: 'checkout',
    })) as { name?: string; error?: string };

    expect(saved.error).toBeUndefined();
    expect(saved.name).toBe('checkout');
    const paths = [...written.keys()].map(norm);
    expect(paths.some((p) => p.startsWith(`${DAEMON_ROOT}/flows`))).toBe(true);
  });
});
