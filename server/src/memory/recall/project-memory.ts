/**
 * What the PROJECT knows, read on demand.
 *
 * Shared memory reached three places before this one: the sync writes it, flow replay consults it
 * automatically, and `reticle memory` prints it at a terminal. The one caller who could not ask was
 * the agent actually doing the work — mid-drive, holding a question, with 44 tools and none of them
 * "what does this team already know about checkout?". That is the gap this closes, and it is the
 * difference between a corpus and a wiki nobody opens.
 *
 * The read is ATTRIBUTED. It carries an agent header, so the coverage map counts it as a
 * consultation and a manager can see which flows are actually being pulled and by whom — the
 * question the fetch counters exist to answer and could not while nothing was reading.
 */
import { cloudFetch } from '@/memory/cloud/cloud-sync.js';
import { resolveProjectCloud } from '@/memory/cloud/cloud-config.js';
import {
  isReadableMemoryScope,
  memoryReadUrl,
  scopedMemoryEntries,
  scopeOfMemoryResponse,
} from '@/memory/cloud/memory-scope.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';

/** Named so a read from the tool surface is distinguishable from the CLI's and from replay's. */
const MCP_AGENT_ID = 'reticle-mcp';

/** Why a lookup returned nothing. Each one is a different thing for the agent to do next. */
export const MemoryUnavailable = {
  /** No `.reticle/cloud.json` — this project has never been linked to a workspace. */
  NOT_LINKED: 'not-linked',
  /** Linked, but the link says not to sync memory. A setting, not a failure. */
  DISABLED: 'memory-sync-disabled',
  /** The server was reached and said no, or could not be reached at all. */
  UNREACHABLE: 'unreachable',
  /**
   * The server answered, and the answer could not be shown to be about THIS project: its envelope
   * named another one, or named none at all.
   *
   * Its own reason rather than an empty list, because the two are opposite facts about the corpus.
   * "This project knows nothing" is something an agent can act on; "we cannot tell whose knowledge
   * this is" is something it must not, and an empty list reports the first while meaning the second.
   */
  UNVERIFIED: 'unverified',
  /**
   * The server answered about THIS project, and the body is a shape this build cannot read entries
   * out of — no `entries` field, or one that is not a list.
   *
   * Apart from `UNREACHABLE` on purpose. That reason's advice is "try again, or check the link", and
   * neither applies: the workspace WAS reached, its answer IS this project's, and the shape will be
   * the same on the second attempt. Sending an agent to retry it costs a round trip and teaches it
   * to distrust a link that is fine, which is what a reason is for.
   */
  UNREADABLE: 'unreadable',
} as const;
export type MemoryUnavailable = (typeof MemoryUnavailable)[keyof typeof MemoryUnavailable];

export interface KnownThing {
  statement: string;
  status: string;
  flowName: string | null;
  sourceFile: string | null;
  subject: string;
}

type ProjectMemoryResult =
  | { ok: true; subject: string | null; known: KnownThing[]; total: number }
  | { ok: false; reason: MemoryUnavailable };

/** Defensive: the wire is somebody else's server, so every field is checked before it is trusted. */
const asKnown = (raw: unknown): KnownThing | null => {
  if (null === raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const statement = r['statement'];
  if (typeof statement !== 'string' || 0 === statement.length) return null;
  return {
    statement,
    status: 'string' === typeof r['status'] ? r['status'] : 'unknown',
    flowName: 'string' === typeof r['flowName'] ? r['flowName'] : null,
    sourceFile: 'string' === typeof r['sourceFile'] ? r['sourceFile'] : null,
    subject: 'string' === typeof r['subject'] ? r['subject'] : 'unsorted',
  };
};

/**
 * Proved first, then the rest.
 *
 * An agent reading this is about to act on it, and a statement a verdict has actually established
 * is worth more than one somebody merely wrote down. Stable within each group so the same call
 * twice returns the same order — an unstable list reads as the corpus churning when it has not.
 */
const PROVED = 'proved';
export const rankKnown = (things: readonly KnownThing[]): KnownThing[] => [
  ...things.filter((t) => PROVED === t.status),
  ...things.filter((t) => PROVED !== t.status),
];

export async function readProjectMemory(
  fs: FileSystemPort,
  root: string,
  home: string,
  env: NodeJS.ProcessEnv,
  opts: { subject?: string | undefined; limit: number },
): Promise<ProjectMemoryResult> {
  const cloud = await resolveProjectCloud(fs, root, home, env);
  if (null === cloud.config) return { ok: false, reason: MemoryUnavailable.NOT_LINKED };
  if (!cloud.policy.memory) return { ok: false, reason: MemoryUnavailable.DISABLED };

  // Scoped to the LINKED project, not to whatever the key happens to cover. A workspace can hold
  // more than one repo, and a read that named no project could be answered with another one's
  // established knowledge — indistinguishable from this project's, and acted on. See memory-scope.
  const url = memoryReadUrl(cloud.config.url, {
    projectId: cloud.projectId,
    subject: opts.subject,
  });
  try {
    const res = await cloudFetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${cloud.config.apiKey}`,
        // What makes this read COUNT as an agent consulting the corpus rather than a human
        // browsing — the distinction the dashboard's "times an agent consulted it" rests on.
        'x-reticle-agent': MCP_AGENT_ID,
      },
    });
    if (200 !== res.status) return { ok: false, reason: MemoryUnavailable.UNREACHABLE };
    // `cloudFetch` returns a real Response, so the body is a METHOD. Reading `res.json` as a
    // property yields the function, and every downstream field is undefined — a silent "the project
    // knows nothing" that is indistinguishable from the honest empty case. It cost a live drive to
    // find once already.
    const body: unknown = await res.json();
    // The envelope first, and it decides everything. The platform names the project on the response
    // and NOT on each entry, so an entry-level filter alone keeps a whole sibling workspace while
    // looking like it did something — see `memory-scope.ts`. A response that names another project,
    // or names none, is UNVERIFIED: not empty, and not this project's.
    const entries = scopedMemoryEntries(body, cloud.projectId);
    if (entries === undefined) {
      return {
        ok: false,
        reason: isReadableMemoryScope(scopeOfMemoryResponse(body, cloud.projectId))
          ? MemoryUnavailable.UNREADABLE // scoped fine, but no readable `entries` — a shape we do not know
          : MemoryUnavailable.UNVERIFIED,
      };
    }
    // The entry-level pass is redundant against the envelope check above and kept for a server that
    // labels entries instead. `total` is counted AFTER it, so a truncated list still tells the truth
    // about how many of THIS project's statements there were.
    const known = entries.map(asKnown).filter((k): k is KnownThing => k !== null);
    return {
      ok: true,
      subject: opts.subject ?? null,
      // Capped for the agent's context, but `total` always reports the truth so the cap is never
      // silent — a truncated list that looks complete is how an agent concludes a project knows
      // less than it does.
      known: rankKnown(known).slice(0, opts.limit),
      total: known.length,
    };
  } catch {
    return { ok: false, reason: MemoryUnavailable.UNREACHABLE };
  }
}
