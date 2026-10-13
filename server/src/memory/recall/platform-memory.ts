/**
 * The agent's writes to the platform, and its read of one flow, beside `readProjectMemory`.
 *
 * Every call here is answered by the platform before the tool answers, so an agent is told whether
 * the platform has it rather than trusting a later sync cycle to carry it. Each reads the link of the
 * project being driven (its `.reticle`, not the daemon's) and names that project on the wire.
 */
import { homedir } from 'node:os';
import { cloudFetch, syncFlowToCloud, SyncOutcome } from '@/memory/cloud/cloud-sync.js';
import { resolveProjectCloud, type ProjectCloud } from '@/memory/cloud/cloud-config.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import type { FlowFile } from '@reticlehq/core';
import { MemoryUnavailable } from './project-memory.js';

/** What `reticle_memory` can be asked to do. `read` is the default and needs no `action`. */
export const MemoryAction = {
  READ: 'read',
  FLOW: 'flow',
  ADD: 'add',
  SET_ASIDE: 'set-aside',
  PUSH_FLOW: 'push-flow',
} as const;
export type MemoryAction = (typeof MemoryAction)[keyof typeof MemoryAction];

/** Why the platform would not set a statement aside, each from its own answer. */
export const SetAsideRefused = {
  NO_SUCH_STATEMENT: 'no-such-statement',
  NOT_ALLOWED: 'not-allowed',
  REFUSED: 'refused',
} as const;

/** The status a statement set aside takes on the platform: kept, but no longer relied on. */
const STALE = 'stale';

const MEMORY_PATH = '/v1/memory';
const FLOWS_PATH = '/v1/flows';
const NOT_FOUND = 'not-found';
const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_REQUEST = 400;

export type PlatformAnswer = Record<string, unknown>;

const unavailable = (reason: string, error: string): PlatformAnswer => ({ error, reason });

const UNREACHABLE = unavailable(
  MemoryUnavailable.UNREACHABLE,
  'the platform could not be reached, or refused this project’s key',
);

type Linked = ProjectCloud & { config: NonNullable<ProjectCloud['config']> };

/** The link, or the reason there is none. Writes honour `sync.memory` / `sync.flows` like the sync. */
async function linked(
  fs: FileSystemPort,
  root: string,
  allowed: (cloud: ProjectCloud) => boolean,
): Promise<{ ok: true; cloud: Linked } | { ok: false; answer: PlatformAnswer }> {
  const cloud = await resolveProjectCloud(fs, root, homedir(), process.env);
  const { config } = cloud;
  if (null === config)
    return {
      ok: false,
      answer: unavailable(
        MemoryUnavailable.NOT_LINKED,
        'this project is not linked to the platform',
      ),
    };
  if (!allowed(cloud))
    return {
      ok: false,
      answer: unavailable(
        MemoryUnavailable.DISABLED,
        'this kind of sync is off in .reticle/cloud.json',
      ),
    };
  return { ok: true, cloud: { ...cloud, config } };
}

const headers = (apiKey: string): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${apiKey}`,
});

const projectQuery = (projectId: string | null): string =>
  null === projectId ? '' : `?projectId=${encodeURIComponent(projectId)}`;

/** One saved flow from the platform: a teammate's, or this project's as the platform holds it. */
export async function fetchPlatformFlow(
  fs: FileSystemPort,
  root: string,
  name: string,
): Promise<PlatformAnswer> {
  const link = await linked(fs, root, (c) => c.policy.flows);
  if (!link.ok) return link.answer;
  const { config, projectId } = link.cloud;
  try {
    const res = await cloudFetch(
      `${config.url}${FLOWS_PATH}/${encodeURIComponent(name)}${projectQuery(projectId)}`,
      { method: 'GET', headers: headers(config.apiKey) },
    );
    if (HTTP_NOT_FOUND === res.status)
      return unavailable(NOT_FOUND, `the platform holds no flow named "${name}" for this project`);
    if (200 !== res.status) return UNREACHABLE;
    const flow: unknown = await res.json();
    return { flow };
  } catch {
    return UNREACHABLE;
  }
}

/** Add one statement to the project's memory. It lands as a proposal; only a passing check proves it. */
export async function addMemoryStatement(
  fs: FileSystemPort,
  root: string,
  entry: { subject: string; statement: string; flowName?: string | undefined },
): Promise<PlatformAnswer> {
  const link = await linked(fs, root, (c) => c.policy.memory);
  if (!link.ok) return link.answer;
  const { config, projectId } = link.cloud;
  try {
    const res = await cloudFetch(`${config.url}${MEMORY_PATH}`, {
      method: 'POST',
      headers: headers(config.apiKey),
      body: JSON.stringify({
        subject: entry.subject,
        statement: entry.statement,
        ...(entry.flowName === undefined ? {} : { flowName: entry.flowName }),
        ...(null === projectId ? {} : { projectId }),
      }),
    });
    if (res.status >= 300) return UNREACHABLE;
    const added: unknown = await res.json();
    return { added };
  } catch {
    return UNREACHABLE;
  }
}

/** Put this machine's saved flow on the platform now, replacing the platform's copy of that name. */
export async function pushFlow(
  fs: FileSystemPort,
  root: string,
  flow: FlowFile,
  projectId: string | undefined,
): Promise<PlatformAnswer> {
  const link = await linked(fs, root, (c) => c.policy.flows);
  if (!link.ok) return link.answer;
  const result = await syncFlowToCloud(flow, link.cloud.config, projectId, cloudFetch);
  return SyncOutcome.SYNCED === result.outcome ? { pushed: flow.name } : UNREACHABLE;
}

/**
 * Set one statement aside: the platform keeps it, marked stale, and stops offering it as known. The
 * one change a project key may make to a statement; proving one takes a passing check, and new
 * words on a settled one are the team's to agree.
 */
export async function setAsideStatement(
  fs: FileSystemPort,
  root: string,
  intentId: string,
): Promise<PlatformAnswer> {
  const link = await linked(fs, root, (c) => c.policy.memory);
  if (!link.ok) return link.answer;
  const { config } = link.cloud;
  try {
    const res = await cloudFetch(`${config.url}${MEMORY_PATH}/${encodeURIComponent(intentId)}`, {
      method: 'PATCH',
      headers: headers(config.apiKey),
      body: JSON.stringify({ status: STALE }),
    });
    if (HTTP_NOT_FOUND === res.status)
      return unavailable(
        SetAsideRefused.NO_SUCH_STATEMENT,
        `the platform holds no statement "${intentId}" in this project. Read reticle_memory again for the current ids.`,
      );
    if (HTTP_FORBIDDEN === res.status)
      return unavailable(
        SetAsideRefused.NOT_ALLOWED,
        'the platform refused: the teammate who made this project’s key may not change flows or memory. Ask the user to set it aside on the dashboard (Memory), and meanwhile do not rely on it.',
      );
    if (HTTP_BAD_REQUEST === res.status)
      return unavailable(
        SetAsideRefused.REFUSED,
        'the platform refused the change: with a project key a statement can only be set aside.',
      );
    if (res.status >= 300) return UNREACHABLE;
    return { setAside: intentId };
  } catch {
    return UNREACHABLE;
  }
}
