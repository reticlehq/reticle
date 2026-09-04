/**
 * A complete `Session` for tool tests. Test-only.
 *
 * Ad-hoc `Partial<Session> as Session` casts defeat the type system: a new method on Session is a
 * runtime error in every stub that never listed it, in files that have nothing to do with the
 * change. `inertSession` is typed as the public shape, so the next method is a compile error here
 * — and adding it gets a default for free. The single `as Session` on the way out is the private-
 * field brand; a class with `#fields` cannot be constructed as a literal.
 *
 * Callers pass only the fields they actually exercise. Do not change a test's assertions to match
 * a default; if a test goes red, the default is wrong for that test — override it.
 */
import {
  SessionState,
  type CommandResult,
  type HumanControlData,
  type ImpactSnapshot,
  type JournalAction,
  type PresenterTone,
  type ReticleEvent,
} from '@reticlehq/core';
import { CaptureLedger } from '../honesty/feature-capture.js';
import { GapLedger } from '../honesty/gap-ledger.js';
import type { EventQueryOptions } from '../journal/journal-query.js';
import type { JournalReader, JournalRecorder } from '../journal/journal-recorder.js';
import { LastAct } from './last-act.js';
import type { Session } from './session.js';
import type { SessionHealth } from './session-health.js';
import type { SessionInfo } from './session-info.js';
import type { SessionLease } from './session-lease.js';
import type { InboxMessage } from './live-control.js';
import type { ReviewMark } from './review-store.js';

/** Public members only — private fields are why a stub cannot be a real `Session` without a cast. */
type SessionShape = { [K in keyof Session]: Session[K] };

const OK: CommandResult = { kind: 'command_result', id: 'c', ok: true, result: {} };

const HEALTHY: SessionHealth = { lastSeenMs: 0, throttled: false, focused: true };

function inertSession(): SessionShape {
  return {
    id: 'demo',
    projectId: undefined,
    artifactRoot: undefined,
    url: 'http://localhost:5173/',
    title: '',
    adapters: [],
    hasCapabilities: false,
    redactKeys: [],
    lastAct: new LastAct(),
    gaps: new GapLedger(),
    capture: new CaptureLedger(),
    runtime: undefined,
    engine: undefined,
    brand: undefined,
    currentDocumentId: undefined,
    currentEditEpoch: undefined,
    actionCount: 0,
    elapsed: () => 0,
    touch: () => undefined,
    lastSeenMs: () => 0,
    applyHealth: () => undefined,
    throttled: () => false,
    health: () => HEALTHY,
    info: (): SessionInfo => ({
      sessionId: 'demo',
      url: 'http://localhost:5173/',
      adapters: [],
      hasCapabilities: false,
      lastSeenMs: 0,
      hidden: false,
      focused: true,
      throttled: false,
    }),
    unresponsive: () => false,
    staleMs: () => 0,
    pushEvent: (_event: ReticleEvent, _byteSize?: number) => undefined,
    recordActedRef: (_ref: string) => undefined,
    actedLabels: () => new Set<string>(),
    actedRefs: () => new Set<string>(),
    noteRateLimited: (_dropped: number) => undefined,
    blindSpots: () => ({}),
    ambientCounts: () => ({}),
    ownAmbientCounts: () => ({}),
    seedAmbient: () => undefined,
    setJournal: (_recorder: JournalRecorder, _reader?: JournalReader) => undefined,
    queryEvents: (_options: EventQueryOptions) => Promise.resolve([]),
    beginAction: (_tool: string, _args: Record<string, unknown>) => 'a1',
    recordAction: (_tool: string, _args: Record<string, unknown>, _effect?: unknown) => 'a1',
    finishAction: (_effect?: unknown, _settled?: boolean, _settledInMs?: number) => undefined,
    readJournalActions: () => Promise.resolve([] as JournalAction[]),
    flushJournal: () => Promise.resolve(),
    eventsSince: (_cursor: number) => [],
    markAgentActivity: () => undefined,
    agentIdleMs: () => 0,
    idleEndMs: () => 0,
    setIdleEndMs: (_ms: number) => undefined,
    autoEnd: (_text?: string, _tone?: PresenterTone) => undefined,
    eventsInWindow: (_windowMs: number) => [],
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    lostSince: (_cursor: number) => false,
    onEvent: (_listener: (event: ReticleEvent) => void) => () => undefined,
    onDisconnect: (_listener: () => void) => () => undefined,
    command: (_name: string, _args?: Record<string, unknown>, _timeoutMs?: number) =>
      Promise.resolve(OK),
    handleResult: (_result: CommandResult) => undefined,
    rejectAll: (_reason: string, _replaced?: boolean) => undefined,
    succeededBy: (_next: Session) => undefined,
    disconnect: (_reason: string, _replaced?: boolean) => undefined,
    getState: () => SessionState.ACTIVE,
    isPaused: () => false,
    isEnded: () => false,
    setState: (_next: SessionState, _text?: string, _tone?: PresenterTone) => undefined,
    pushMessage: (_text: string) => undefined,
    drainInbox: () => [] as InboxMessage[],
    inboxSize: () => 0,
    inboxHistory: () => [] as InboxMessage[],
    pendingMarks: () => [] as ReviewMark[],
    allMarks: () => [] as ReviewMark[],
    pendingMarkCount: () => 0,
    resolveMark: (_id: string) => false,
    applyHumanControl: (_data: HumanControlData) => undefined,
    pushImpact: (_read: () => ImpactSnapshot | undefined, _immediate?: boolean) => undefined,
    pushPresenter: (_state: SessionState, _text?: string, _tone?: PresenterTone) => undefined,
    pushNarration: (_text: string) => undefined,
    takeSessionLease: (): SessionLease | undefined => undefined,
    ageWarning: () => undefined,
    setViewers: (_read: () => Session[]) => undefined,
  };
}

export function createFakeSession(overrides: Partial<Session> = {}): Session {
  return { ...inertSession(), ...overrides } as Session;
}
