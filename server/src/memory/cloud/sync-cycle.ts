/**
 * One full conversation with the dashboard: ask, send the difference, collect what came back.
 *
 * ── WHY IT LOOKS LIKE THIS ─────────────────────────────────────────────────────────────────────
 * `.reticle/` is the source of truth and always will be. Reticle has to work with no account and no
 * network; a verification that blocks on an HTTP round trip is one somebody switches off. So the
 * dashboard is a REPLICA, and this is the replication protocol:
 *
 *   1. ASK      GET /v1/sync/status  → run ids it already holds, a content hash per derived record
 *   2. SEND     POST /v1/sync        → only unseen runs, only records whose hash moved
 *   3. COLLECT  GET /v1/sync/pull    → decisions a human made there, since our cursor
 *   4. APPLY    write them to .reticle/issues.json so the HUD and the next run can see them
 *
 * ASK-THEN-SEND, not send-everything. A three-hour session rewrites impact.json on every tool call;
 * uploading it each time would re-send the same megabytes dozens of times, and a sync that costs
 * that much is one people turn off — which is the real failure, because a dashboard nobody syncs to
 * is a dashboard nobody opens. When nothing has moved, a cycle sends nothing at all, and that is
 * what makes running it on a timer affordable.
 *
 * HASHES, NOT TIMESTAMPS. Two machines comparing their own clocks is a guess: they drift, and a
 * laptop that was asleep will cheerfully decide it is current. A content hash is an answer.
 *
 * BOTH DIRECTIONS, ALWAYS. The pull runs even when there is nothing to push — a quiet machine is
 * precisely the one whose dashboard somebody has been triaging on, so skipping the pull when the
 * push is empty would starve the direction that matters most.
 *
 * NOTHING IS DELETED LOCALLY ON SUCCESS. A lost response costs one redundant upload rather than a
 * hole in the record, and the server dedupes by run id anyway.
 *
 * Every dependency is injected — the clock, the fetch, the reads and writes — because this is the
 * one piece of Reticle that talks to a network AND to a disk, and it must be provable without either.
 */
import { FlowErrorCode, ReticleDir, SYNC_BATCH_LIMITS } from '@reticlehq/core';
import { hashPayload } from './sync-hash.js';

/** The server's own doors. Kept beside the code that calls them, like the other cloud paths. */
const SYNC_PATH = '/v1/sync';
const SYNC_STATUS_PATH = '/v1/sync/status';
const SYNC_PULL_PATH = '/v1/sync/pull';

/**
 * The derived records that ride along with runs, and the file each one lives in.
 *
 * A list rather than three hand-written blocks so adding a fourth is one line and cannot be
 * half-done — the bundle, the hashing and the reporting all walk this.
 */
const DERIVED_RECORDS = [
  { kind: 'impact', file: ReticleDir.IMPACT_FILE },
  { kind: 'flake', file: ReticleDir.FLAKE_FILE },
  { kind: 'intent', file: ReticleDir.INTENT_FILE },
  // How each page normally behaves, and how strong each flow's checks are. Kept only here, they
  // cannot tell a server a page that drifted from one that always behaved that way.
  { kind: 'envelopes', file: ReticleDir.ENVELOPES_FILE },
  { kind: 'assertion-tiers', file: ReticleDir.TIERS_FILE },
] as const;

type DerivedKind = (typeof DERIVED_RECORDS)[number]['kind'];

/** What the machine reads from disk. Injected so a cycle is testable with no filesystem at all. */
export interface SyncSource {
  /** Every run artifact currently on disk. */
  runs: () => ReadonlyArray<{ runId: string; payload: unknown }>;
  /** Every saved flow. Small, upserted by name, so they ride along whenever anything else does. */
  flows: () => readonly unknown[];
  /**
   * Every bug capsule on disk — the minimal failing flow that reproduces a defect, plus its evidence.
   *
   * Rides along with flows, and for the same reason: small, upserted by id, and worth nothing on the
   * machine that found the bug. A verdict count tells a dashboard THAT something broke; the capsule
   * is the only artifact that lets somebody else make it break again.
   */
  capsules: () => readonly unknown[];
  /** One derived record, or undefined when the file is absent. */
  derived: (kind: DerivedKind) => unknown;
}

/** What the machine writes back. Separated from reads so a dry run is a source with no sink. */
export interface SyncSink {
  /** Persist the triage decisions pulled from the dashboard. */
  writeIssues: (issues: PulledIssues) => void;
  /** Persist the cursor and the bookkeeping. */
  writeState: (state: CloudSyncState) => void;
}

/** A decision a human made on the dashboard, as the machine stores it. */
interface PulledIssue {
  status: string;
  flowName: string | null;
  title: string;
  at: number;
}

export interface PulledIssues {
  /** Keyed by the server's fingerprint — stable across runs, which is the point of it. */
  triage: Record<string, PulledIssue>;
}

/** `.reticle/cloud-state.json`. This machine's side of the conversation, never git-checked. */
export interface CloudSyncState {
  /** Opaque. Handed back to the server verbatim; the machine must never parse or invent one. */
  cursor?: string;
  lastPushAt?: number;
  lastPullAt?: number;
  /** The last failure, kept so `reticle sync` can say why it is behind instead of just "0 sent". */
  lastError?: string;
  /**
   * Run ids this machine has watched the server accept, kept only for the runs still held locally.
   *
   * Read ONLY when the server says its own `knownRunIds` was truncated. A complete list is a
   * complete answer — a run missing from one is genuinely missing and must be re-sent — so this
   * fills the gap the server declared and never overrides the server on a question it answered.
   */
  sentRunIds?: string[];
  /**
   * Runs the server refused, by run id: its reason, and the two things that could change the answer
   * (a hash of the run file, and of what the platform said it reads). A refused run is not offered
   * again until one of them changes; re-offering it every cycle got the same refusal and dragged
   * every flow and capsule along with it.
   */
  refusedRuns?: Record<string, RefusedRun>;
  /**
   * Hashes of the flow set and the capsule set the platform last answered for. A flow saved or
   * edited with no new run used to wait for one, because flows only rode along with other data; now
   * a changed set is sent on its own, and an unchanged one is not sent again.
   */
  sentFlowsHash?: string;
  sentCapsulesHash?: string;
  /**
   * A flow or capsule set the platform refused, kept so the refusal stays visible on the cycles that
   * do not resend it, and so the set is offered again once it changes or the platform reads more.
   */
  refusedSets?: Partial<Record<SetPart, RefusedSet>>;
}

type SetPart = 'flow' | 'capsule';

interface RefusedSet {
  hash: string;
  acceptsHash: string;
  count: number;
  reason: string;
}

interface RefusedRun {
  reason: string;
  payloadHash: string;
  acceptsHash: string;
}

export interface SyncReport {
  /**
   * False if the cycle failed, the server refused anything, or a run or flow was held back for a
   * version the platform does not read. A completed HTTP exchange alone is not a successful push.
   * A record KIND the platform does not know yet is reported in `held` and does not fail it.
   */
  ok: boolean;
  /** Runs the server accepted this cycle. */
  runsSent: number;
  /** Runs it refused, with the reason, so a bad artifact is visible rather than silently stuck. */
  runsRejected: Array<{ index: number; reason: string }>;
  flowsSent: number;
  /** Capsules the server accepted. Zero when it reported none, which includes not knowing the field. */
  capsulesSent: number;
  /** Derived records the server ACCEPTED this cycle. Empty on a quiet cycle, the normal case. */
  derivedSent: DerivedKind[];
  /**
   * Everything else the server refused: a flow, a capsule, or a derived record. Each reason is a
   * complete sentence naming the item, because this is often read from a background daemon's log.
   */
  refused: Refusal[];
  /**
   * What was deliberately NOT sent, and why: a record kind or a file version this platform does
   * not read. Sending it would only be refused again on every cycle.
   */
  held: string[];
  /** Runs refused on an earlier cycle and not offered again, because nothing has changed since. */
  notRetried: Array<{ runId: string; reason: string }>;
  /** Flow or capsule sets refused on an earlier cycle and not offered again. */
  setsNotRetried: Array<{ part: SetPart; count: number; reason: string }>;
  /** Decisions collected from the dashboard. */
  pulled: number;
  /** True when the pull page was full — call again now rather than waiting for the next tick. */
  morePending: boolean;
  /**
   * The repo holds NO artifacts at all — no runs, no flows, no derived records.
   *
   * Distinct from "everything here is already pushed", which is the healthy steady state and looks
   * identical from the outside. An empty repo usually means the app announces no projectId, so its
   * runs are pooling into a different root and this binding will never report anything. Tracked so
   * the summary can tell a user which of the two they are looking at.
   */
  localIsEmpty?: boolean;
  /** Set when the cycle could not complete. The local record is untouched either way. */
  error?: string;
}

/** One item the server refused that is not a run. */
export interface Refusal {
  /** `flow`, `capsule`, or the derived record's kind. */
  part: string;
  reason: string;
}

interface SyncDeps {
  config: { url: string; apiKey: string };
  source: SyncSource;
  sink: SyncSink;
  state: CloudSyncState;
  now: () => number;
  /** Injected so a cycle can be driven against a scripted server with no network. */
  request: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<{ status: number; text: string }>;
}

interface StatusResponse {
  knownRunIds?: string[];
  truncated?: boolean;
  stateHashes?: Record<string, string | null>;
  /** What this platform reads. Absent on a platform that predates the handshake. */
  accepts?: unknown;
}

interface PullResponse {
  triage?: Array<{
    fingerprint: string;
    status: string;
    flowName?: string | null;
    title?: string;
    at: number;
  }>;
  cursor?: string;
  more?: boolean;
}

const asJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => 'object' === typeof v && null !== v;

/** A list of numbers, or undefined when the server did not send a list at all. */
const numbersIn = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? v.filter((n): n is number => 'number' === typeof n) : undefined;

/** A numeric field of an artifact, or undefined when it has none. */
const numberAt = (v: unknown, field: string): number | undefined => {
  const n = isRecord(v) ? v[field] : undefined;
  return 'number' === typeof n ? n : undefined;
};

/** The name a person knows a flow by, falling back to its position. */
const flowName = (flow: unknown, index: number): string => {
  const name = isRecord(flow) ? flow['name'] : undefined;
  return 'string' === typeof name && name.length > 0 ? name : `flow #${String(index)}`;
};

const FLOW_VERSION_FIX = 'update the platform or remove `compare` from the flow';
const RUN_VERSION_FIX = 'update the platform';

/** The server's per-part answer: accepted count and rejection list, each read defensively. */
function partResult(body: Record<string, unknown>, part: string) {
  const raw = isRecord(body[part]) ? body[part] : {};
  const accepted = 'number' === typeof raw['accepted'] ? raw['accepted'] : 0;
  const rejected = (Array.isArray(raw['rejected']) ? raw['rejected'] : [])
    .filter(isRecord)
    .map((r) => ({
      index: 'number' === typeof r['index'] ? r['index'] : -1,
      reason: 'string' === typeof r['reason'] ? r['reason'] : 'no reason given',
      code: r['code'],
      version: r['version'],
    }));
  return { accepted, rejected };
}

/**
 * Split runs into requests bounded by count and by serialized size. A run bigger than the byte
 * bound on its own still goes, alone: it cannot be split, and holding it back would hide it.
 */
function batchRuns<T extends { payload: unknown }>(runs: readonly T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const run of runs) {
    const size = Buffer.byteLength(JSON.stringify(run.payload));
    const full =
      current.length >= SYNC_BATCH_LIMITS.MAX_RUNS || bytes + size > SYNC_BATCH_LIMITS.MAX_BYTES;
    if (current.length > 0 && full) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(run);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Run one cycle. Never throws: the local record is already safe on disk, and a sync that can take
 * down the thing it is backing up is worse than no sync.
 */
export async function runSyncCycle(deps: SyncDeps): Promise<SyncReport> {
  const empty: SyncReport = {
    ok: false,
    runsSent: 0,
    runsRejected: [],
    flowsSent: 0,
    capsulesSent: 0,
    derivedSent: [],
    refused: [],
    held: [],
    notRetried: [],
    setsNotRetried: [],
    pulled: 0,
    morePending: false,
  };

  const call = async (
    path: string,
    init?: { method: string; body?: string },
  ): Promise<{ status: number; json: unknown; text: string }> => {
    const res = await deps.request(`${deps.config.url}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.config.apiKey}`,
      },
      ...(init?.body === undefined ? {} : { body: init.body }),
    });
    return { status: res.status, json: asJson(res.text), text: res.text };
  };

  const nextState: CloudSyncState = { ...deps.state };

  try {
    // 1. ASK.
    const status = await call(SYNC_STATUS_PATH);
    if (200 !== status.status) {
      const error = `status ${String(status.status)}: ${status.text.slice(0, 200)}`;
      deps.sink.writeState({ ...nextState, lastError: error });
      return { ...empty, error };
    }
    const held = isRecord(status.json) ? (status.json as StatusResponse) : {};
    /*
     * Validated, not trusted. `new Set(someString)` builds a set of CHARACTERS, so a `knownRunIds`
     * that arrived as a string made `known.has('a')` true and silently skipped any run whose id was
     * one of those letters — the client deciding, on the server's malformed word, not to upload
     * something the server does not have. Silent data loss is the one failure this protocol must
     * not have, and an unreadable answer has to mean "it knows nothing", never "it knows this".
     */
    const onlyStrings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((id): id is string => 'string' === typeof id) : [];
    /*
     * The server may answer "here are the ids I hold, and there are more than I listed". Read as the
     * whole truth, that short list made every run past the server's page look unsent, so a project
     * with enough runs to truncate it re-uploaded its history on every single cycle, forever. The
     * field was declared on this response and read nowhere.
     *
     * Only then is the machine's own record consulted, and it is subject to the same rule as the
     * server's: anything that is not a list of strings reads as "nothing is known".
     */
    const known = new Set([
      ...onlyStrings(held.knownRunIds),
      ...(true === held.truncated ? onlyStrings(deps.state.sentRunIds) : []),
    ]);
    // Same rule for the hashes: only a string can equal a hash we computed, so anything else reads
    // as "unknown" and the record is sent once. Re-sending costs a request; skipping costs the data.
    const hashes = isRecord(held.stateHashes) ? held.stateHashes : {};
    /*
     * What this platform reads. `accepts` says so outright; a platform that predates it still lists
     * every record kind it knows in `stateHashes`, null when it holds nothing. A kind it does not
     * list is one it does not know, and it will never answer with a hash for it: sending on "hash
     * differs" then re-sent that record, and every flow and capsule riding with it, on every cycle.
     */
    const accepts = isRecord(held.accepts) ? held.accepts : {};
    const acceptedKinds = new Set(
      Array.isArray(accepts['derived']) ? onlyStrings(accepts['derived']) : Object.keys(hashes),
    );
    const flowVersions = numbersIn(accepts['flowVersions']);
    const runVersions = numbersIn(accepts['runVersions']);
    const heldBack: string[] = [];
    /** Held runs and flows mean the dashboard is missing something; unknown record kinds do not. */
    let heldArtifacts = false;

    // 2. SEND — only what the server does not already have, and only what it can read.
    const allRuns = deps.source.runs();
    const acceptsHash = hashPayload(held.accepts ?? null);
    const priorRefusals = isRecord(deps.state.refusedRuns) ? deps.state.refusedRuns : {};
    const refusedRuns: Record<string, RefusedRun> = {};
    const notRetried: Array<{ runId: string; reason: string }> = [];
    const unsent = allRuns.filter((run) => {
      if (known.has(run.runId)) return false;
      const prior = priorRefusals[run.runId];
      const unchanged =
        prior !== undefined &&
        'string' === typeof prior.reason &&
        prior.acceptsHash === acceptsHash &&
        prior.payloadHash === hashPayload(run.payload);
      if (!unchanged) return true;
      refusedRuns[run.runId] = prior;
      notRetried.push({ runId: run.runId, reason: prior.reason });
      return false;
    });
    const sendable = unsent.filter((run) => {
      const version = numberAt(run.payload, 'schemaVersion');
      if (runVersions === undefined || version === undefined || runVersions.includes(version))
        return true;
      heldBack.push(
        `this platform reads run versions ${runVersions.join(', ')}; run ${run.runId} is version ${String(version)} — ${RUN_VERSION_FIX}`,
      );
      heldArtifacts = true;
      return false;
    });
    const derivedOffered: DerivedKind[] = [];
    const unsupported: DerivedKind[] = [];
    const bundle: Record<string, unknown> = {};
    for (const { kind } of DERIVED_RECORDS) {
      const payload = deps.source.derived(kind);
      if (payload === undefined) continue;
      if (!acceptedKinds.has(kind)) {
        unsupported.push(kind);
        continue;
      }
      // The one comparison the whole protocol rests on. Same hash, do not send it.
      if (hashPayload(payload) === hashes[kind]) continue;
      bundle[kind] = payload;
      derivedOffered.push(kind);
    }
    if (unsupported.length > 0)
      heldBack.push(`this platform does not accept ${unsupported.join(', ')} yet`);
    // Flows and capsules are upserted by name/id, so the whole set goes whenever it differs from the
    // set the platform last answered for, and rides along with anything else being sent.
    const flows = deps.source.flows().filter((flow, index) => {
      const version = numberAt(flow, 'version');
      if (flowVersions === undefined || version === undefined || flowVersions.includes(version))
        return true;
      heldBack.push(
        `this platform reads flow versions ${flowVersions.join(', ')}; ${flowName(flow, index)} is version ${String(version)} — ${FLOW_VERSION_FIX}`,
      );
      heldArtifacts = true;
      return false;
    });
    const capsulesAll = deps.source.capsules();
    const flowsHash = hashPayload(flows);
    const capsulesHash = hashPayload(capsulesAll);
    const priorSets = isRecord(deps.state.refusedSets) ? deps.state.refusedSets : {};
    const setsNotRetried: Array<{ part: SetPart; count: number; reason: string }> = [];
    const refusedSets: Partial<Record<SetPart, RefusedSet>> = {};
    /** A set is due when it changed, or when it was refused and the platform now reads more. */
    const due = (
      part: SetPart,
      hash: string,
      size: number,
      sentHash: string | undefined,
    ): boolean => {
      if (0 === size) return false;
      const prior = priorSets[part];
      if (prior !== undefined && prior.hash === hash) {
        if (prior.acceptsHash !== acceptsHash) return true;
        refusedSets[part] = prior;
        setsNotRetried.push({ part, count: prior.count, reason: prior.reason });
        return false;
      }
      return hash !== sentHash;
    };
    const flowsChanged = due('flow', flowsHash, flows.length, deps.state.sentFlowsHash);
    const capsulesChanged = due(
      'capsule',
      capsulesHash,
      capsulesAll.length,
      deps.state.sentCapsulesHash,
    );
    const ridesAlong =
      sendable.length > 0 || derivedOffered.length > 0 || flowsChanged || capsulesChanged;
    if (ridesAlong && flows.length > 0) bundle['flows'] = flows;
    const capsules = ridesAlong ? capsulesAll : [];
    if (capsules.length > 0) bundle['capsules'] = capsules;

    let runsSent = 0;
    let flowsSent = 0;
    let capsulesSent = 0;
    const runsRejected: Array<{ index: number; reason: string }> = [];
    const refused: Refusal[] = [];
    const derivedSent: DerivedKind[] = [];
    let pushError: string | undefined;
    /*
     * Runs go up in bounded batches; everything else rides in the first. One request used to carry
     * the whole backlog, and a backlog over the platform's body limit was refused whole, forever.
     */
    const batches = batchRuns(sendable);
    const requests =
      Object.keys(bundle).length > 0 || batches.length > 0 ? Math.max(1, batches.length) : 0;
    let offset = 0;
    for (let i = 0; i < requests; i += 1) {
      const batch = batches[i] ?? [];
      const body: Record<string, unknown> = 0 === i ? { ...bundle } : {};
      if (batch.length > 0) body['runs'] = batch.map((r) => r.payload);
      const pushed = await call(SYNC_PATH, { method: 'POST', body: JSON.stringify(body) });
      if (200 !== pushed.status) {
        pushError = `sync ${String(pushed.status)}: ${pushed.text.slice(0, 200)}`;
        break;
      }
      const answer = isRecord(pushed.json) ? pushed.json : {};
      const runs = partResult(answer, 'runs');
      runsSent += runs.accepted;
      // Accepted means the server has it. A rejected run was refused by index, so it is exactly as
      // unsent as it was before and must never be remembered as delivered.
      const refusedHere = new Map(runs.rejected.map((r) => [r.index, r.reason]));
      batch.forEach((run, index) => {
        const reason = refusedHere.get(index);
        if (reason === undefined) known.add(run.runId);
        else
          refusedRuns[run.runId] = { reason, payloadHash: hashPayload(run.payload), acceptsHash };
      });
      runsRejected.push(
        ...runs.rejected.map((r) => ({ index: r.index + offset, reason: r.reason })),
      );
      offset += batch.length;
      if (0 !== i) continue;
      // Absent means the server said nothing about a part — an older one that does not know the
      // field. Read as zero accepted, never as an error: an added field must not break a sync.
      const flowsPart = partResult(answer, 'flows');
      const capsulesPart = partResult(answer, 'capsules');
      flowsSent = flowsPart.accepted;
      capsulesSent = capsulesPart.accepted;
      for (const r of flowsPart.rejected) {
        const name = flowName(flows[r.index], r.index);
        refused.push({
          part: 'flow',
          reason:
            FlowErrorCode.WRONG_VERSION === r.code && 'number' === typeof r.version
              ? `${name} is version ${String(r.version)} — ${FLOW_VERSION_FIX}`
              : `flow ${name}: ${r.reason}`,
        });
      }
      for (const r of capsulesPart.rejected)
        refused.push({ part: 'capsule', reason: `capsule #${String(r.index)}: ${r.reason}` });
      const firstOf = (part: SetPart): string =>
        refused.find((r) => r.part === part)?.reason ?? 'no reason given';
      if (flowsPart.rejected.length > 0)
        refusedSets.flow = {
          hash: flowsHash,
          acceptsHash,
          count: flowsPart.rejected.length,
          reason: firstOf('flow'),
        };
      if (capsulesPart.rejected.length > 0)
        refusedSets.capsule = {
          hash: capsulesHash,
          acceptsHash,
          count: capsulesPart.rejected.length,
          reason: firstOf('capsule'),
        };
      // `state` has a key per record sent: "accepted", or the message that refused it.
      const state = isRecord(answer['state']) ? answer['state'] : {};
      for (const kind of derivedOffered) {
        const verdict = state[kind];
        if ('accepted' === verdict) derivedSent.push(kind);
        else if ('string' === typeof verdict)
          refused.push({ part: kind, reason: `${kind}: ${verdict}` });
      }
    }
    if (requests > 0 && pushError === undefined) {
      nextState.lastPushAt = deps.now();
      // The platform answered for these sets, refusals included (reported above, and not re-offered
      // until the set changes — the same rule as a refused run).
      if (ridesAlong && flows.length > 0) nextState.sentFlowsHash = flowsHash;
      if (capsules.length > 0) nextState.sentCapsulesHash = capsulesHash;
    }
    nextState.refusedRuns = refusedRuns;
    nextState.refusedSets = refusedSets;
    if (pushError !== undefined) {
      nextState.sentRunIds = allRuns.map((r) => r.runId).filter((id) => known.has(id));
      deps.sink.writeState({ ...nextState, lastError: pushError });
      return {
        ...empty,
        runsSent,
        runsRejected,
        flowsSent,
        capsulesSent,
        derivedSent,
        refused,
        held: heldBack,
        notRetried,
        error: pushError,
      };
    }

    /*
     * Bounded by the runs still on disk rather than by a cap. Retention already decides how many
     * runs a workspace keeps, and an id for a run nobody holds any more cannot stop an upload that
     * will never be attempted — so the record follows the artifacts and needs no number of its own.
     */
    nextState.sentRunIds = allRuns.map((r) => r.runId).filter((id) => known.has(id));

    // 3. COLLECT — always, even when there was nothing to send.
    const query =
      nextState.cursor === undefined ? '' : `?since=${encodeURIComponent(nextState.cursor)}`;
    const pull = await call(`${SYNC_PULL_PATH}${query}`);
    if (200 !== pull.status) {
      // The push already landed; report it rather than throwing the whole cycle away.
      const error = `pull ${String(pull.status)}: ${pull.text.slice(0, 200)}`;
      deps.sink.writeState({ ...nextState, lastError: error });
      return {
        ...empty,
        ok: false,
        runsSent,
        flowsSent,
        capsulesSent,
        derivedSent,
        runsRejected,
        refused,
        held: heldBack,
        notRetried,
        error,
      };
    }
    const pulled = isRecord(pull.json) ? (pull.json as PullResponse) : {};
    const decisions = pulled.triage ?? [];

    // 4. APPLY.
    if (decisions.length > 0) {
      const triage: Record<string, PulledIssue> = {};
      for (const d of decisions) {
        triage[d.fingerprint] = {
          status: d.status,
          flowName: d.flowName ?? null,
          title: d.title ?? '',
          at: d.at,
        };
      }
      deps.sink.writeIssues({ triage });
    }
    // The cursor is written even on an empty page: it is the server's, and it never goes backwards.
    if ('string' === typeof pulled.cursor) nextState.cursor = pulled.cursor;
    nextState.lastPullAt = deps.now();

    const report: SyncReport = {
      // Anything refused, or any artifact held back, means the dashboard is missing something.
      ok:
        0 === runsRejected.length &&
        0 === refused.length &&
        0 === notRetried.length &&
        0 === setsNotRetried.length &&
        !heldArtifacts,
      runsSent,
      runsRejected,
      flowsSent,
      capsulesSent,
      derivedSent,
      refused,
      held: heldBack,
      notRetried,
      setsNotRetried,
      pulled: decisions.length,
      morePending: true === pulled.more,
      /*
       * Nothing on disk at all, as opposed to nothing NEW. Computed from what the source offered
       * before any cursor filtering, because a repo whose runs were all already pushed is healthy
       * and a repo that has never recorded one is usually misconfigured.
       */
      localIsEmpty:
        0 === allRuns.length &&
        0 === deps.source.flows().length &&
        DERIVED_RECORDS.every(({ kind }) => deps.source.derived(kind) === undefined),
    };
    /*
     * A refusal is kept as the last error rather than cleared by a completed exchange: it is what
     * `reticle whoami` shows, and "the transfer worked" is not "the dashboard has it".
     */
    if (report.ok) delete nextState.lastError;
    else nextState.lastError = problemsOf(report).join('; ');
    deps.sink.writeState(nextState);
    return report;
  } catch (error: unknown) {
    // A network that is down is not an error condition for a local-first tool; it is Tuesday.
    const message = describeTransportError(error, deps.config.url);
    deps.sink.writeState({ ...nextState, lastError: message });
    return { ...empty, error: message };
  }
}

/**
 * Say WHICH host failed and WHY.
 *
 * Node's fetch rejects with the bare string "fetch failed" and hides the real reason — a refused
 * connection, a bad hostname, an expired certificate — one level down in `cause`. A machine that
 * has quietly stopped syncing shows that string in `reticle whoami`, and on its own it is
 * indistinguishable from every other network problem, so the person reading it learns nothing and
 * checks nothing. Naming the origin and the underlying code turns it into one thing to look at.
 */
function describeTransportError(error: unknown, url: string): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return `${error.message} (${url})`;
  const code = (cause as { code?: unknown }).code;
  // The code and the message are each sometimes empty — an aggregate DNS failure carries a code and
  // no text, a TLS failure the reverse. Joined only when both are there, so the line never trails
  // off into a dangling separator.
  const parts = ['string' === typeof code && code.length > 0 ? code : '', cause.message].filter(
    (part) => part.length > 0,
  );
  const detail = parts.join(': ');
  return 0 === detail.length
    ? `${error.message} (${url})`
    : `${error.message} — ${detail} (${url})`;
}

/** One line a human can read, for the CLI and the daemon log. */
export function describeSync(report: SyncReport): string {
  if (report.error !== undefined) return `sync failed — ${report.error}`;
  const sent: string[] = [];
  if (report.runsSent > 0) sent.push(`${String(report.runsSent)} run(s)`);
  if (report.flowsSent > 0) sent.push(`${String(report.flowsSent)} flow(s)`);
  if (report.capsulesSent > 0) sent.push(`${String(report.capsulesSent)} capsule(s)`);
  if (report.derivedSent.length > 0) sent.push(report.derivedSent.join(', '));
  /*
   * "Nothing to send" is a statement about the QUEUE, and it is false the moment the queue was full
   * and the server threw it away. Built from what was accepted, the sentence used to read "nothing
   * to send, 3 rejected" — something was very much sent, and the reader is told both that it was
   * not and nothing about why.
   */
  const rejectedCount = report.runsRejected.length + report.refused.length;
  const push =
    sent.length > 0
      ? `sent ${sent.join(' + ')}`
      : rejectedCount > 0
        ? 'nothing accepted'
        : true === report.localIsEmpty
          ? // Not the same statement as "nothing to send", which describes a repo that is simply up
            // to date. This one has never recorded anything, which for a LINKED repo usually means
            // the app announces no projectId and its runs are landing under a different root.
            'nothing recorded here yet — if this app has been driven, it is reporting somewhere else'
          : 'nothing to send';
  const pull =
    0 === report.pulled
      ? ''
      : `, pulled ${String(report.pulled)} decision(s)${report.morePending ? ' (more waiting)' : ''}`;
  return `${push}${pull}${problemsOf(report)
    .map((problem) => `, ${problem}`)
    .join('')}`;
}

/**
 * What went wrong, one phrase per kind of problem.
 *
 * One reason, not a count. A rejection count tells somebody they have a problem and nothing about
 * which problem — and these arrive from a BACKGROUND daemon, so the summary line is often the only
 * place anybody ever sees it. Rejections in one cycle almost always share a cause (a version skew
 * refuses every payload the same way), so the first reason plus the count is the whole story
 * without printing a line per item; `reticle sync` still lists them all.
 */
function problemsOf(report: SyncReport): string[] {
  const problems: string[] = [];
  const count = report.runsRejected.length + report.refused.length;
  if (count > 0) {
    const first = report.runsRejected[0]?.reason ?? report.refused[0]?.reason ?? 'no reason given';
    problems.push(`${String(count)} rejected — ${first}`);
  }
  const firstRefusal = report.notRetried[0];
  if (firstRefusal !== undefined)
    problems.push(
      `refused, not retried: ${String(report.notRetried.length)} run(s) (${firstRefusal.reason})`,
    );
  for (const set of report.setsNotRetried)
    problems.push(`refused, not retried: ${String(set.count)} ${set.part}(s) (${set.reason})`);
  if (report.held.length > 0) problems.push(`not sent: ${report.held.join('; ')}`);
  return problems;
}
