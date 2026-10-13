/**
 * The agent ↔ platform round trip, through `reticle_memory`, against a fake platform that answers the
 * way the real one does: the project on the envelope, a key bound to one project, `POST /v1/memory`
 * and `POST /v1/flows` open to that key, and `PATCH /v1/memory/:id` taking `{ status: "stale" }` only.
 *
 * Before this the agent could READ the team's memory and nothing else: a teammate's flow lived only
 * on the dashboard, and what the agent learned reached the platform only if a sync cycle happened to
 * carry it, with no answer saying whether it had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleDir,
  ReticleTool,
  type FlowFile,
} from '@reticlehq/core';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { FlowStore } from '@/language/flows/flows.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { MEMORY_TOOLS } from './memory-tools.js';
import { MemoryAction, SetAsideRefused } from './platform-memory.js';

const CLOUD = 'https://cloud.test';
const PROJECT = 'shop';
const KEY = 'rk_live_x';
const ROOT = join('/repo/apps/web', ReticleDir.ROOT);
/** The tool reads the user's own credential store, so the fake key lives where it looks. */
const HOME = homedir();
const NOW = 1_700_000_000_000;

interface Call {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

/** The platform's side: memory rows and saved flows for ONE project, reached with ONE key. */
/** The statement whose key's member may not write: the platform's 403. */
const FORBIDDEN_ID = 'i-locked';

function fakePlatform() {
  const calls: Call[] = [];
  const memory: Record<string, unknown>[] = [
    {
      intentId: 'i1',
      subject: 'checkout',
      statement: 'paying shows the receipt',
      status: 'proved',
    },
  ];
  const flows = new Map<string, unknown>([
    [
      'teammate-flow',
      { name: 'teammate-flow', projectId: PROJECT, flow: { name: 'teammate-flow' } },
    ],
  ]);
  const reply = (status: number, body: unknown) =>
    Promise.resolve({
      ok: status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  vi.stubGlobal(
    'fetch',
    (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ method: init.method, url, auth: init.headers['authorization'], body });
      if (init.headers['authorization'] !== `Bearer ${KEY}`) return reply(401, {});
      const path = new URL(url).pathname;
      if ('GET' === init.method && '/v1/memory' === path)
        return reply(200, { projectId: PROJECT, entries: memory });
      if ('POST' === init.method && '/v1/memory' === path) {
        const b = body as Record<string, unknown>;
        const row = { intentId: `mem_${String(memory.length)}`, status: 'proposed', ...b };
        memory.push(row);
        return reply(201, row);
      }
      if ('GET' === init.method && path.startsWith('/v1/flows/')) {
        const found = flows.get(decodeURIComponent(path.slice('/v1/flows/'.length)));
        return found === undefined ? reply(404, { error: 'flow not found' }) : reply(200, found);
      }
      if ('PATCH' === init.method && path.startsWith('/v1/memory/')) {
        const id = decodeURIComponent(path.slice('/v1/memory/'.length));
        if (FORBIDDEN_ID === id) return reply(403, {});
        const row = memory.find((r) => r['intentId'] === id);
        if (row === undefined) return reply(404, {});
        const b = body as Record<string, unknown>;
        if ('stale' !== b['status'] || 1 !== Object.keys(b).length) return reply(400, {});
        row['status'] = 'stale';
        return reply(200, row);
      }
      if ('POST' === init.method && '/v1/flows' === path) {
        const flow = (body as { flow: FlowFile }).flow;
        flows.set(flow.name, { name: flow.name, projectId: PROJECT, flow });
        return reply(201, { name: flow.name });
      }
      return reply(404, {});
    },
  );
  return { calls, memory, flows };
}

function deps(): ToolDeps {
  const { fs, written } = createMemoryFs();
  written.set(
    join(ROOT, ReticleDir.CLOUD_LINK_FILE).split('\\').join('/'),
    JSON.stringify({ projectId: PROJECT, url: CLOUD }),
  );
  written.set(
    join(HOME, ReticleDir.ROOT, 'credentials.json').split('\\').join('/'),
    JSON.stringify({ [`${CLOUD}::${PROJECT}`]: KEY }),
  );
  return {
    fs,
    reticleRoot: ROOT,
    now: () => NOW,
    flows: new FlowStore(fs, ROOT, { now: () => NOW }),
    sessions: {
      resolve: () => {
        throw new Error('no session');
      },
    },
  } as unknown as ToolDeps;
}

const memoryTool = MEMORY_TOOLS.find((t) => t.name === ReticleTool.MEMORY);
const call = async (d: ToolDeps, args: Record<string, unknown>) =>
  (await memoryTool?.handler(d, args)) as Record<string, unknown>;

const localFlow = (steps: number): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'checkout-pay',
  createdAt: NOW,
  steps: Array.from({ length: steps }, () => ({
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: 'pay' },
    action: ActionType.CLICK,
    args: {},
    expect: { kind: 'signal', name: 'paid' },
  })),
});

describe('the agent ↔ platform round trip', () => {
  beforeEach(() => {
    // A key in this machine's environment would win over the link and reach a different project.
    vi.stubEnv('RETICLE_API_KEY', '');
    vi.stubEnv('RETICLE_CLOUD_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reads the project memory', async () => {
    fakePlatform();
    const out = await call(deps(), {});
    expect(out['total']).toBe(1);
    expect(JSON.stringify(out['known'])).toContain('paying shows the receipt');
  });

  it('reads one flow by name from the platform, a teammate’s flow this machine never saw', async () => {
    const { calls } = fakePlatform();
    const out = await call(deps(), { action: MemoryAction.FLOW, name: 'teammate-flow' });
    expect(out['flow']).toMatchObject({ name: 'teammate-flow' });
    expect(calls.at(-1)?.url).toBe(`${CLOUD}/v1/flows/teammate-flow?projectId=${PROJECT}`);
  });

  it('says plainly when the platform holds no flow by that name', async () => {
    fakePlatform();
    const out = await call(deps(), { action: MemoryAction.FLOW, name: 'nope' });
    expect(out['error']).toBeDefined();
    expect(out['reason']).toBe('not-found');
  });

  it('writes a memory statement, and the next read returns it', async () => {
    const { calls } = fakePlatform();
    const d = deps();
    const out = await call(d, {
      action: MemoryAction.ADD,
      subject: 'checkout',
      statement: 'a declined card keeps the cart',
    });
    expect(out['added']).toMatchObject({ statement: 'a declined card keeps the cart' });
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: `${CLOUD}/v1/memory`,
      body: {
        subject: 'checkout',
        statement: 'a declined card keeps the cart',
        projectId: PROJECT,
      },
    });
    const read = await call(d, {});
    expect(JSON.stringify(read['known'])).toContain('a declined card keeps the cart');
  });

  it('refuses a write with no statement, and sends nothing', async () => {
    const { calls } = fakePlatform();
    const out = await call(deps(), { action: MemoryAction.ADD, subject: 'checkout' });
    expect(out['error']).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('sets a statement aside: PATCH with the project key, stale and nothing else', async () => {
    const { calls, memory } = fakePlatform();
    const out = await call(deps(), { action: MemoryAction.SET_ASIDE, id: 'i1' });
    expect(out).toEqual({ setAside: 'i1' });
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      url: `${CLOUD}/v1/memory/i1`,
      auth: `Bearer ${KEY}`,
      body: { status: 'stale' },
    });
    expect(memory[0]?.['status']).toBe('stale');
  });

  it('a statement the project does not hold is answered in words, not as unreachable', async () => {
    fakePlatform();
    const out = await call(deps(), { action: MemoryAction.SET_ASIDE, id: 'nope' });
    expect(out['reason']).toBe(SetAsideRefused.NO_SUCH_STATEMENT);
    expect(String(out['error'])).toContain('"nope"');
  });

  it('a key whose member may not write is told so, and pointed at the dashboard', async () => {
    fakePlatform();
    const out = await call(deps(), { action: MemoryAction.SET_ASIDE, id: FORBIDDEN_ID });
    expect(out['reason']).toBe(SetAsideRefused.NOT_ALLOWED);
    expect(String(out['error'])).toContain('dashboard');
  });

  it('setting aside with no id refuses, and sends nothing', async () => {
    const { calls } = fakePlatform();
    const out = await call(deps(), { action: MemoryAction.SET_ASIDE });
    expect(out['error']).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('updates a flow: the local saved flow goes up, replaces the platform copy, and reads back', async () => {
    const { flows } = fakePlatform();
    const d = deps();
    await d.flows.saveFlow(localFlow(1));
    expect(
      (await call(d, { action: MemoryAction.PUSH_FLOW, name: 'checkout-pay' }))['pushed'],
    ).toBe('checkout-pay');
    await d.flows.saveFlow(localFlow(2));
    await call(d, { action: MemoryAction.PUSH_FLOW, name: 'checkout-pay' });
    const back = await call(d, { action: MemoryAction.FLOW, name: 'checkout-pay' });
    expect((back['flow'] as { flow: FlowFile }).flow.steps).toHaveLength(2);
    expect(flows.size).toBe(2);
  });

  it('pushing a flow that is not saved here refuses, and sends nothing', async () => {
    const { calls } = fakePlatform();
    const out = await call(deps(), { action: MemoryAction.PUSH_FLOW, name: 'never-saved' });
    expect(out['error']).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('a key the platform refuses is unreachable, not an empty answer', async () => {
    fakePlatform();
    const d = deps();
    const { fs } = d as unknown as { fs: { writeFile: (p: string, s: string) => Promise<void> } };
    await fs.writeFile(
      join(HOME, ReticleDir.ROOT, 'credentials.json'),
      JSON.stringify({ [`${CLOUD}::${PROJECT}`]: 'rk_revoked' }),
    );
    const out = await call(d, { action: MemoryAction.FLOW, name: 'teammate-flow' });
    expect(out['reason']).toBe('unreachable');
  });
});
