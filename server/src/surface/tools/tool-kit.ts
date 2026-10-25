/**
 * Shared kit for the MCP tool modules — the tool shape, the dependency bag, the common
 * session-id arg, and the two helpers (commandOrThrow, snapshotTree) every tool group needs. Lives
 * in its own leaf module (no dependency on any tool array) so the per-group tool files can import it
 * without a circular import — `tools.ts` assembles the groups and re-exports `ToolDef`/`ToolDeps`.
 */
import type { FirstRunWiring } from '@/portal/session/first-run-wiring.js';
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  asRecord,
  asString,
  type ProjectId,
  ReticleCommand,
  ReticleTool,
  SnapshotMode,
  RUN_REPORT_FIELD,
} from '@reticlehq/core';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { RealInputProvider } from '@/portal/input/real-input.js';
import type { BaselineStore } from '@/memory/project/baselines.js';
import { normalizeLines } from '@/memory/project/baselines.js';
import type { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import type { ArtifactRoot } from '@/memory/project/artifact-root.js';
import type { NonceMinter } from '@/portal/production/production-activation.js';
import type { FlowStore } from '@/language/flows/flows.js';
import type { ProjectStore } from '@/memory/project/project-store.js';
import type { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { SnapshotCache } from './read/snapshot-delta.js';
import type { BrowserPool } from '@/portal/pool/browser-pool.js';
import type { ChromiumProbe } from '@/command/cli/doctor/browser/chromium-hint.js';

export interface ToolDeps<Ext = unknown> {
  sessions: SessionManager;
  /** shared one-browser/N-context pool for headless leases. undefined ⇒ lease tools report unavailable. */
  pool?: BrowserPool;
  /**
   * Probe for a launchable Chromium, so the lease path can refuse at the FIRST call with the install
   * fix rather than failing several calls in with a message that reads as "the app is not running".
   * Optional: absent ⇒ no preflight — every existing test construction of ToolDeps keeps working, and
   * the fake-pool lease tests are deliberately runnable without a real Chromium.
   */
  browserProbe?: () => Promise<ChromiumProbe>;
  baselines: BaselineStore;
  recordings: RecordingStore;
  /** on-disk anchored-flow store (.reticle/flows/). */
  flows: FlowStore;
  /**
   * The credential this machine already holds for the linked project, if it is linked.
   *
   * INJECTED rather than read here. `reticle link` files a project-scoped key in
   * `~/.reticle/credentials.json`, and the harness needs it so that somebody who has signed in and
   * linked is not also asked to export a key by hand. Resolving it inside the tool surface would
   * make `tools` reach into `memory/cloud`, which the directory guard refused — and it was right
   * to: this is a port, and the daemon already resolves exactly this for cloud sync.
   *
   * Absent ⇒ nothing is linked, or the caller is an embedder with no filesystem. Never an error.
   * `root` is the `.reticle` whose link is asked for; absent, the daemon's own.
   */
  linkedCloud?: (root?: string) => Promise<{ url: string; apiKey: string } | null>;
  /** structured annotations accumulating for the live recording. */
  annotations: AnnotationStore;
  /**
   * This CLIENT's snapshot baselines, backing `diff: true`.
   *
   * Per MCP attach, never per daemon: the baseline is "the tree we last sent YOU", and one daemon
   * serves every agent on the machine. Shared, the second agent to look at a session was answered
   * `unchanged` against a page it had never been sent. Absent ⇒ the module-level fallback in
   * `tools.ts`, which keeps every existing `ToolDeps` construction working unchanged.
   */
  snapshots?: SnapshotCache;
  /**
   * The skew between THIS client's MCP server and the daemon, told once to this connection only.
   *
   * Per attach for the same reason as `snapshots`: one daemon serves every agent on the machine, and
   * a daemon-wide queue handed one agent's "restart your MCP server" to whichever agent called next,
   * whose server matched (#1136). Absent ⇒ this connection's server matched, or it did not announce.
   */
  peerSkew?: { take(): string | undefined };
  /**
   * Who is asking: one id per MCP attach. A browser lease is handed back only to the attach that took
   * it, so two agents on one origin never share a tab (#1226). Absent ⇒ every acquire gets its own.
   */
  attachId?: string;
  /**
   * The coding agent's own session id, as its MCP server announced it on connect. Joins this
   * connection's episode to the agent hooks' records. Absent: the agent announced none.
   */
  agentSession?: string;
  /** Run one sync cycle with the platform now, for `reticle_project { push }`. Absent: not linked here. */
  syncNow?: () => Promise<unknown>;
  /** Wires the app on the agent's first use, instead of at installation. Absent: tell, do not wire. */
  firstRun?: FirstRunWiring;
  /**
   * On the first page-needing call with nothing connected, opens this caller's UNWIRED app in a
   * lease that supplies the SDK (see zero-install-first-call.ts). Absent: answer no-session as before.
   */
  openUnwiredApp?: () => Promise<{ url: string; notice: string } | undefined>;
  /** The one dev server running in the caller's project folder, for a lease that names no url. */
  projectAppUrl?: () => Promise<string | undefined>;
  /** cross-run outcome memory (.reticle/project.json). */
  project: ProjectStore;
  /** optional native-input provider. undefined ⇒ everything stays synthetic. */
  realInput?: RealInputProvider;
  /** injected filesystem seam (tests pass a fake/temp-dir adapter). */
  fs: FileSystemPort;
  /** absolute.reticle path (index.ts computes cwd/.reticle). The FALLBACK, not the answer. */
  reticleRoot: string;
  /**
   * Which `.reticle` a SESSION's artifacts belong in, resolved per call.
   *
   * `reticleRoot` above is fixed at construction from the daemon's own `process.cwd()`, which is a
   * statement about where the daemon was launched and was being read as a statement about which
   * project is being verified. Those are usually not the same tree: an editor starts a user-scoped
   * MCP server wherever it likes, so flows landed outside the repo they verify, or died on
   * `mkdir '/.reticle'`.
   *
   * Optional because every existing construction of ToolDeps predates it and because a consumer
   * embedding this engine may not have a filesystem to search. Absent ⇒ `reticleRoot`, which is
   * exactly today's behaviour.
   */
  artifactRootFor?: (projectId: ProjectId | undefined, origin?: string) => ArtifactRoot;
  /**
   * A verification run just landed — wake cloud sync instead of waiting for its next tick.
   *
   * The run itself is pushed immediately on this path, but everything AROUND it — the impact
   * counters, the flows it exercised, flake and intent — moves only on the timer. That is what
   * produced a dashboard showing a fresh run beside stale numbers, which reads as a sync bug and is
   * really just two different clocks. Waking the loop here makes the run and its context arrive
   * together.
   *
   * Optional: absent ⇒ the timer alone, which is exactly today's behaviour.
   */
  onRunPersisted?: () => void;
  /**
   * This daemon's OWN project id, derived from the directory it was started in.
   *
   * Optional because a daemon above an uninitialised directory has none, and because every existing
   * test construction of ToolDeps predates it. Absence means "cannot tell", which must never be
   * treated as a mismatch.
   */
  projectId?: ProjectId;
  /** injected clock for the contract's generatedAt stamp. */
  now: () => number;
  /**
   * The port this daemon's bridge listens on.
   *
   * Needed wherever a message has to name the OTHER half of a port mismatch — the commonest reason
   * a leased tab loads the app and never dials in. Optional so every existing test construction of
   * ToolDeps keeps working; absent falls back to the default port.
   */
  bridgePort?: number;
  /**
   * The bridge's session-nonce registry. Local callers only: a production lease mints its nonce
   * here. Absent where no bridge runs in this process, and a production lease then refuses.
   */
  nonces?: NonceMinter;
  /**
   * A consumer's OWN dependencies, carried through untouched.
   *
   * Nothing in this package reads it. It exists so a consumer embedding the engine can add tools of
   * its own — answering out of a store this package has never heard of — without either widening the
   * fields above with a stranger's vocabulary or forking to get a handle through.
   *
   * The type parameter, rather than `unknown`, is what keeps the seam typed: a consumer writes
   * `ToolDef<TheirExt>` once and their handlers see their own type. Casting out of `unknown` in every
   * handler is how a typed seam quietly becomes an untyped one.
   *
   * Optional, and defaulted to `unknown`, so every existing construction of this bag — and every test
   * that builds one — is unchanged.
   */
  ext?: Ext;
}

export interface ToolDef<Ext = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  /**
   * JSON Schema-compatible output schema for this tool. When present, the MCP server advertises it
   * in the tools/list response so schema-aware clients (like @reticlehq/cli) can validate outputs and
   * compose tool calls safely. Also drives TOON encoding for snapshot/query results.
   */
  outputSchema?: Record<string, z.ZodType>;
  /**
   * One concrete, valid call — the shape, not the prose.
   *
   * A schema tells an agent the FIELD NAMES; it does not tell it how they compose, and under a lean
   * profile only the first sentence of the description survives. So an agent reads "execute one
   * action against a ref", sees `ref` / `action` / `args`, and guesses `{ action, testid }`. The
   * guess fails inside the MCP SDK's own validation — BEFORE this package's error handling runs — so
   * what comes back is a raw zod dump: the validator's internal state, naming no field and showing
   * no correct shape. Two of those round trips cost more than the lean snapshot saves, which means
   * arg-guessing quietly refunds the entire token advantage.
   *
   * Rendered into the advertised description, so it survives the terse profiles where it matters
   * most. `tool-examples.test.ts` parses every one of these against its OWN inputSchema, because an
   * example that does not validate is worse than none at all.
   */
  example?: Record<string, unknown>;
  /**
   * Declared method-style, not as a property, and that is load-bearing rather than stylistic.
   *
   * Under `strictFunctionTypes` a property holding a function has CONTRAVARIANT parameters, so
   * `ToolDef<TheirExt>` and `ToolDef<unknown>` become mutually unassignable and a consumer composing
   * `[...TOOLS, ...theirTools]` needs a cast — as does every internal helper that then touches the
   * array. Method-style parameters are checked bivariantly, which collapses all of that.
   *
   * The unsoundness bivariance admits is that a handler written against `ToolDeps<TheirExt>` could be
   * handed a bag carrying no `ext` at all. That costs nothing here, because `ext` is optional by
   * design: any handler reading it already has to survive `undefined`.
   */
  handler(deps: ToolDeps<Ext>, args: Record<string, unknown>, call?: ToolCall): Promise<unknown>;
}

/**
 * What the MCP request itself offers a handler: its cancellation, and a way to say it is still
 * working. Absent off the MCP path (the Harness's own calls, the CLI, tests).
 */
export interface ToolCall {
  /** Aborts when the client cancels or the connection drops. */
  signal?: AbortSignal;
  /** Present when the client asked for progress: tells it the call is alive, and how far along. */
  progress?: (progress: number, message: string) => void;
}

/**
 * The optional inline intent, on every tool that draws a verdict.
 *
 * One field, carrying either prose or the id of an intent already declared, because the surface is
 * the scarce thing and a second field for the reference case would double the cost of the idea to
 * make one of its two uses marginally more explicit. Told apart by the ledger — see
 * `intent/inline-intent.ts`.
 *
 * The first sentence is what a lean surface advertises, so it carries both readings; the rest is for
 * the profiles that send the whole description.
 */
export const intentArg = z
  .string()
  .optional()
  .describe(
    'What this change is meant to make true — as a durable statement ABOUT THE PRODUCT, or the id of an intent you already declared. ' +
      'Write it so a teammate who was not here understands it in six months: name the behaviour, not this run. ' +
      'GOOD: "a filtered issue queue is a shareable link — the filter is in the URL". ' +
      'BAD: "P1 step 5", "drive 2 of 2", "same as before the fix", "the board renders cleanly" — these name a session, ' +
      'a step number or nothing checkable, and the person reading them later has none of that context. ' +
      'This is shared memory: it is pooled per project and later agents read it back to avoid re-deriving what you just established. ' +
      'Recorded in .reticle/intent/, the same ledger reticle_intent writes, and marked proved by this verdict if it passes.',
  );

export const sessionIdShape = {
  sessionId: z
    .string()
    .optional()
    .describe(
      'OMIT THIS unless you mean a specific tab — Reticle scopes to your project, prefers the active one, and refuses rather than guesses when ambiguous. Pass an id from reticle_sessions only to target a particular tab. The previous wording ("omit when only ONE session is open") was wrong and cost real turns: with three sessions connected — an app plus two pool leases — resolution is still unambiguous, but that sentence sent the agent off to list and filter sessions by hand before every single call.',
    ),
};

/**
 * Every key `runTool` splices onto a session-bound result, as a closed list.
 *
 * These are wire strings and were inlined at the splice sites, which is exactly how four of them
 * came to be spliced and never declared. `sessionEnvelopeShape` is derived from this object and
 * `envelope-keys-declared.test.ts` fails if a member is missing from it, so the two cannot drift.
 *
 * Each of these is a channel that exists BECAUSE the agent had no other way to learn the fact.
 * Undeclared, a schema-strict client validating `structuredContent` drops it, and the channel is
 * indistinguishable from never having been built.
 */
export const EnvelopeKey = {
  /** Session health — which tab, how fresh. */
  SESSION: 'session',
  /** One-shot pool-lease reminder. */
  SESSION_LEASE: 'session_lease',
  /** One-shot "these sessions are old, clean them up". */
  SESSION_AGE_WARNING: 'session_age_warning',
  /** The delivered-once human-in-the-loop guidance envelope. Losing it is a safety failure. */
  CONTROL: 'control',
  /**
   * Rides alongside `session` whenever the tab is THROTTLED. It was declared on `reticle_act`'s
   * schema and nowhere else, so on a validating profile every other session-bound tool silently
   * dropped it — a throttled tab, where drives can no-op, returned a healthy-looking result.
   */
  WARNING: 'warning',
  /** One-shot "ask the human how this went". */
  FEEDBACK_PROMPT: 'feedback_prompt',
  /** One-shot "a newer Reticle exists". */
  UPDATE_AVAILABLE: 'update_available',
  /**
   * "You have driven this page N times without asking for a verdict."
   *
   * The largest known lever on the metric this product is judged by: verdict-less sessions
   * overwhelmingly never call a verdict-producing tool at all. It was spliced undeclared, so on a
   * validating client the nudge was built, fired, and thrown away before any agent saw it.
   */
  VERIFY_NEXT: 'verify_next',
  /** The contextual "tell us what just went wrong" invitation. Same story, same release. */
  FEEDBACK_INVITE: 'feedback_invite',
  /**
   * The same moment, for the HUMAN: a call with the founder, or an email through `identify`. The
   * agent is told to offer it and never to book or submit anything itself.
   */
  TALK_TO_US: 'talk_to_us',
  /** SDK/daemon version skew — often the one fact that explains everything else in the session. */
  VERSION_SKEW: 'version_skew',
  /** On each verdict from a page whose SDK is behind the daemon. See session-info.ts. */
  SDK_BEHIND: 'sdk_behind',
  /** A feedback report that was accepted and then failed to send. Only the reporter can act on it. */
  FEEDBACK_UNDELIVERED: 'feedback_undelivered',
  /** Once per project: verified runs exist only on this machine. See platform-moment.ts. */
  PLATFORM: 'platform',
  /**
   * This leased tab runs a STUB of the bindings a desktop shell injects (`reticle_lease acquire`'s
   * `initScript`), so a verdict here is about the app's view logic and not about the real shell.
   */
  HOST_STUB: 'host_stub',
  /** The one thing to do next: declare the request, yield, fix sync, connect. See next-step.ts. */
  NEXT: 'next',
  /** One-shot: a Harness drive started or finished, from any origin, and how to read it. */
  HARNESS: 'harness',
  /** Where this step's screenshot is (`{ path, source }`), or why there is none. See step-shots.ts. */
  SCREENSHOT: 'screenshot',
  /**
   * One-shot: this call's tab was opened by Reticle on an app nobody wired, with the SDK supplied —
   * what it cannot see, and the command that wires the app for good. See zero-install-first-call.ts.
   */
  ZERO_INSTALL: 'zero_install',
  /** Once-per-session advisory lines an agent's own call carries. See agent/notices.ts. */
  NOTICES: 'notices',
  /** The end-of-run report, on the call that ends an agent's run. See run-report.ts. */
  RUN_REPORT: RUN_REPORT_FIELD,
} as const;
export type EnvelopeKey = (typeof EnvelopeKey)[keyof typeof EnvelopeKey];

/**
 * The sentence every session-bound result carries while its leased tab runs on a stubbed shell.
 *
 * Spliced wherever the tab's health is spliced, because the fact matters to exactly the same
 * readings: a green from a tab whose `window.go` Reticle faked is not evidence about the real shell,
 * and nothing else in the result would say so.
 */
export const HOST_STUB_NOTE =
  'a stub for the bindings a desktop shell injects was installed in this tab before its scripts ' +
  'ran, so a green here is not a verdict against the real shell.';

/**
 * The tools whose every answer leaves a screenshot of the page. A sequence (`reticle_act` with
 * `steps`) takes one per step, inside the sequence, rather than one for the whole call.
 */
export const STEP_SHOT_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.ACT,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.NAVIGATE,
  ReticleTool.ASSERT,
]);

/**
 * Tools that DRIVE the page. An action with no verdict after it is the signature of the loop
 * breaking mid-task — see `abandonedActions`. `act_and_wait` is one of these AND a verification, so
 * it settles its own action, which is exactly right: it is the tool that does both.
 */
export const ACTION_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.ACT,
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.ACT_AND_WAIT,
]);

/**
 * Tools that go through Playwright CDP rather than the page SDK.
 *
 * Under version skew these fail with "Target page, context or browser has been closed" while every
 * DOM tool against the same tab still works (#688). They are session-EXEMPT (own result contracts),
 * so the bound-tool resolve in `runTool` never runs for them — resolve again there so we can refuse with
 * the skew sentence before Playwright lies about a closed page.
 */
export const CDP_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.SCREENSHOT,
  ReticleTool.VISUAL_DIFF,
  ReticleTool.NETWORK_MOCK,
  ReticleTool.VIEWPORT,
  // Breaks a request through the same Playwright route `reticle_network_mock` uses, so it fails the
  // same way under version skew and must be refused with the same sentence.
  ReticleTool.FLOW_MUTATE,
]);

/**
 * Tools whose result hands the agent refs. The tab they were minted in is remembered, so the call
 * that spends one cannot be routed to a different tab without saying so — see ref-provenance.ts.
 *
 * Over-inclusion is the safe direction here and under-inclusion is not dangerous either: both ends
 * produce a REFUSAL naming the two tabs, never a silent drive against the wrong one.
 */
export const REF_MINTING_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.INSPECT,
  // The same three merged, on the `merged` surface. Its `state` action mints nothing, and
  // over-inclusion is the safe direction here: the worst case is a refusal naming two tabs.
  ReticleTool.LOOK,
  ReticleTool.EXPLORE,
  // `crawl` mints refs for the controls it drives and `coverage` for the ones it reports untouched.
  // Both are actions on the merged verify tool now.
  ReticleTool.VERIFY,
]);

/**
 * The live-session tools whose result MUST carry the
 * session-health envelope. Owned in ONE place — not retrofitted per handler — so a throttled tab
 * can never return a healthy-looking result from any of these. `runTool` is the single choke point
 * (mcp.ts + tool-invoker.ts) that splices health on (`invoke-tool.ts`); the guard test asserts the set is exhaustive.
 */
export const SESSION_BOUND_TOOLS: ReadonlySet<string> = new Set([
  // Resolves a session and reads its event window (`session.eventsSince`), exactly as OBSERVE and
  // NETWORK do. Without this it runs with no session and answers from nothing.
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.INSPECT,
  // All four merged. Every member here is session-bound, so unlike `verify` there is no split to
  // adjudicate — the merged tool inherits the only answer its members ever gave.
  ReticleTool.LOOK,
  // Merged change/flows/affected/coverage/crawl. Its members were SPLIT across bound and exempt —
  // coverage/change/crawl bound, flow_verify exempt because it returns its own suite contract — and
  // a merged tool has to be one or the other. Bound is the right side: `crawl` drives the app
  // itself, so a throttled or event-dropping tab is exactly the condition its verdict depends on,
  // and dropping the health disclosure there to protect a sibling's output shape would trade an
  // honesty signal for a formatting preference.
  ReticleTool.VERIFY,
  ReticleTool.ACT,
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.OBSERVE,
  ReticleTool.WAIT_FOR,
  ReticleTool.ASSERT,
  // Reads the live page as well as the event window, so a throttled tab can make it compare a stale
  // render against fresh data — exactly the case the health envelope exists to disclose.
  ReticleTool.RECONCILE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.ANIMATIONS,
  ReticleTool.BASELINE, // merged save/list/diff — save+diff are live reads
  ReticleTool.RECORD, // merged start/stop — both live
  ReticleTool.REPLAY,
  ReticleTool.CLOCK,
  ReticleTool.STATE,
  ReticleTool.STORAGE,
  ReticleTool.EXPLORE,
  ReticleTool.SCROLL_TO,
  ReticleTool.NAVIGATE,
]);

/**
 * Tools that carry a `sessionId` arg but are NOT live-session-health tools — they read/write
 * disk (capabilities/contract/flow/project), drain a buffer, or steer session lifecycle. They are
 * exempt from the health splice ON PURPOSE. Kept explicit so the guard test can force every new
 * `sessionId`-bearing tool to be classified into exactly one set (bound XOR exempt).
 */
export const SESSION_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.CAPABILITIES, // has a fromDisk mode with no live session
  ReticleTool.CONTRACT_SAVE, // persists the registry to disk
  ReticleTool.FLOW_SAVE, // sessionId only scopes the write to the app's flow subdir; disk-side
  ReticleTool.FLOW, // merged list/load/delete — sessionId only scopes the project; all disk-side
  ReticleTool.FLOW_REPLAY, // returns its own FlowReplayResult contract (+ auto-records a run)
  ReticleTool.FLOW_SAVE_RECORDED, // reads the recording buffer, writes disk
  // FLOW_HEAL is no longer a name runTool ever sees: it became `reticle_verify {action:"heal"}`,
  // and VERIFY is already listed here, so the exemption is inherited from the parent. Left as a
  // dangling name it would be a lie this file's own test 6 is written to catch.
  ReticleTool.INTENT, // reads/writes .reticle/intent/; sessionId only picks the project
  ReticleTool.CONTEXT, // folds the journal + intent ledger; must still answer when nothing is connected
  ReticleTool.MAP, // folds the journals on disk into the App Graph; answers with no tab connected
  ReticleTool.PROJECT, // reads .reticle/project.json
  // Reads the team's shared memory over HTTP; sessionId only resolves WHICH project's link file to
  // use. It must answer with no tab connected — "what does this project know?" is a question an
  // agent asks before it has opened anything.
  ReticleTool.MEMORY,
  ReticleTool.RUN_EXPORT, // reads .reticle/runs/<id>.json (verification-run artifact)
  ReticleTool.SESSION, // merged lifecycle/human-channel family (tune/yield/end/resume/messages/review/narrate)
  ReticleTool.SCREENSHOT, // own contract; provider-driven, not a live-DOM-health read
  ReticleTool.VISUAL_DIFF, // own contract (matched/ratio/region)
  ReticleTool.NETWORK_MOCK, // own contract (applied/count); provider-driven, not a live-DOM read
  ReticleTool.VIEWPORT, // own contract (applied/width/height); provider-driven, not a live-DOM read
  ReticleTool.ANNOTATE, // annotates a recording's steps; pure disk-side metadata, no live DOM read
  ReticleTool.LEASE, // merged acquire/release — its sessionId is a pool lease id, not a live session
  // Its sessionId only enriches the report with the tab's runtime/engine, and it must stay callable
  // when NO session exists — "nothing ever connected" is feedback we especially want.
  ReticleTool.FEEDBACK,
]);

/** A step-screenshot tool, with the one sentence about its screenshot on the end of its description. */
export function withScreenshotDoc(tool: ToolDef): ToolDef {
  return STEP_SHOT_TOOLS.has(tool.name)
    ? { ...tool, description: `${tool.description}${SCREENSHOT_DOC}` }
    : tool;
}

/** The one sentence every tool that takes a step screenshot says about it. */
export const SCREENSHOT_DOC =
  ' `screenshot.path` is a picture of the page at the outcome: open it when the look of the page matters; reading it is your choice. When `pending: true`, the file may still be in write; wait before you read it.';

/**
 * Fields that `runTool` / `withControl` splice onto EVERY session-bound tool result at runtime.
 * Merged into each session-bound tool's outputSchema so a schema-strict client (structuredContent
 * validation) keeps them instead of silently dropping them.
 *
 * Derived from `EnvelopeKey` rather than re-listed: this shape and the splice sites disagreed for a
 * whole release, and every key that went missing was a channel nobody could see was missing.
 */
export const sessionEnvelopeShape: Record<string, z.ZodType> = Object.fromEntries(
  Object.values(EnvelopeKey).map((key) => [
    key,
    // `warning` is the one with a narrower type; the rest are opaque envelopes the client forwards.
    EnvelopeKey.WARNING === key ? z.string().optional() : z.unknown().optional(),
  ]),
);

/** Unwrap a browser command result or throw its error so the agent sees a clean failure. */
export async function commandOrThrow(
  deps: ToolDeps,
  sessionId: string | undefined,
  // ReticleCommand, not string: the union already exists and every caller passes a member. Typed as
  // `string` a sessionId/name swap compiled cleanly and failed at runtime with a stringly error.
  name: ReticleCommand,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = deps.sessions.resolve(sessionId);
  const result = await session.command(name, args);
  if (!result.ok) {
    throw new Error(result.error ?? `command '${name}' failed`);
  }
  return result.result;
}

interface SnapshotResult {
  tree?: string;
  status?: { route?: string };
}

/** Full DOM snapshot → normalized tree lines + route, for tools that diff or scan the page. */
export async function snapshotTree(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<{ lines: string[]; route: string }> {
  const session = deps.sessions.resolve(sessionId);
  const result = await session.command(ReticleCommand.SNAPSHOT, { mode: SnapshotMode.FULL });
  if (!result.ok) {
    throw new Error(result.error ?? 'snapshot failed');
  }
  const snap = (result.result ?? {}) as SnapshotResult;
  return { lines: normalizeLines(snap.tree ?? ''), route: snap.status?.route ?? '' };
}

/**
 * One client's snapshot baselines.
 *
 * Lives here rather than in the `tools.ts` barrel, which sits at the file-size cap, and rather than
 * having the MCP layer reach into `read/` for the class — this kit is what the surface already
 * imports. See `ToolDeps.snapshots` for why a daemon-wide store cannot be correct.
 */
export const newSnapshotCache = (): SnapshotCache => new SnapshotCache();

/** The argument a replay takes its redacted fields' values in, for that call only. */
export const CALL_SECRETS_ARG = 'secrets';

/** Secrets a call supplied; never written anywhere, gone when the call ends. */
const callSecretStore = new AsyncLocalStorage<Readonly<Record<string, string>>>();

/** The secrets the current call supplied, keyed as given (a field, or its variable name). */
export function callSecrets(): Readonly<Record<string, string>> | undefined {
  return callSecretStore.getStore();
}

/**
 * Take the call's secrets out of its arguments, so nothing downstream — the tool log, the journal,
 * telemetry — ever sees them.
 */
export function takeCallSecrets(args: Record<string, unknown>): {
  secrets: Record<string, string> | undefined;
  rest: Record<string, unknown>;
} {
  if (!(CALL_SECRETS_ARG in args)) {
    return { secrets: undefined, rest: args };
  }
  const { [CALL_SECRETS_ARG]: raw, ...rest } = args;
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(raw))) {
    const text = asString(value);
    if (text !== undefined && 0 < text.length) {
      secrets[key] = text;
    }
  }
  return { secrets, rest };
}

/** Run `fn` with these secrets supplied for it alone. */
export function withCallSecrets<T>(
  secrets: Readonly<Record<string, string>> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return secrets === undefined ? fn() : callSecretStore.run(secrets, fn);
}
