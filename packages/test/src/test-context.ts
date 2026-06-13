import { IrisTool, type ToolInvoker } from '@iris/server';
import { ActionType, type ElementQuery, type ElementState } from '@iris/protocol';
import { resolveTestid } from './resolve.js';
import { buildClock, type TestClock } from './clock.js';
import { InputModeTracker, expectInputModeReal } from './input-mode.js';
import { failFromVerdict } from './matchers.js';
import type { MatcherDeps, Verdict } from './matchers.js';
import {
  expectAbsent,
  expectElement,
  expectNet,
  expectNoConsoleErrors,
  expectSignal,
  expectText,
} from './matchers.js';
import { DEFAULT_ASSERT_TIMEOUT_MS } from './constants.js';

/** A declarative predicate (the iris_assert/until DSL). Kept structural to avoid a server type dep. */
export type Predicate = Record<string, unknown>;

export interface TestContextOptions {
  /** Forwarded into every tool call's args so multi-session runs target the right tab. */
  sessionId?: string;
  /** Wait window for assertion matchers (default DEFAULT_ASSERT_TIMEOUT_MS). */
  defaultTimeoutMs?: number;
}

/** The per-spec `t` façade: a typed, thin wrapper over the tool invoker. */
export interface TestContext {
  readonly invoke: ToolInvoker;

  act(testid: string, action: ActionType, args?: Record<string, unknown>): Promise<void>;
  fill(testid: string, value: string): Promise<void>;
  actAndWait(testid: string, action: ActionType, until: Predicate): Promise<void>;

  expectSignal(name: string, dataMatches?: Record<string, unknown>): Promise<void>;
  expectNet(method: string, urlContains: string, status?: number): Promise<void>;
  expectElement(query: ElementQuery, state?: ElementState): Promise<void>;
  expectText(contains: string): Promise<void>;
  expectAbsent(query: ElementQuery): Promise<void>;
  expectNoConsoleErrors(): Promise<void>;

  state(storeOrRef: string): Promise<unknown>;
  clock: TestClock;
  expectInputModeReal(): Promise<void>;
}

function asVerdict(value: unknown): Verdict {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const verdict = record['verdict'];
  if (typeof verdict !== 'object' || verdict === null) {
    return { pass: false, failureReason: 'act_and_wait returned no verdict' };
  }
  const v = verdict as Record<string, unknown>;
  const failureReason = typeof v['failureReason'] === 'string' ? v['failureReason'] : undefined;
  return {
    pass: v['pass'] === true,
    evidence: v['evidence'],
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}

/**
 * Build the `t` handed to each spec. A pure façade over `invoke`: every method maps to one or two
 * tool calls and throws structured errors on failure (the runner catches them). No transport, DOM,
 * or Node FS lives here — the only dependency is the injected invoker.
 */
export function createTestContext(
  invoke: ToolInvoker,
  options: TestContextOptions = {},
): TestContext {
  const sessionId = options.sessionId;
  const timeoutMs = options.defaultTimeoutMs ?? DEFAULT_ASSERT_TIMEOUT_MS;
  const tracker = new InputModeTracker();
  const deps: MatcherDeps = {
    invoke,
    timeoutMs,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };

  async function runAct(
    testid: string,
    action: ActionType,
    args?: Record<string, unknown>,
  ): Promise<void> {
    const ref = await resolveTestid(invoke, testid, sessionId);
    const actArgs: Record<string, unknown> = {
      ref,
      action,
      ...(args !== undefined ? { args } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    const result = await invoke(IrisTool.ACT, actArgs);
    tracker.record(result);
  }

  return {
    invoke,
    act: (testid, action, args) => runAct(testid, action, args),
    fill: (testid, value) => runAct(testid, ActionType.FILL, { value }),
    async actAndWait(testid, action, until): Promise<void> {
      const ref = await resolveTestid(invoke, testid, sessionId);
      const waitArgs: Record<string, unknown> = {
        ref,
        action,
        until,
        timeout_ms: timeoutMs,
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
      const raw = await invoke(IrisTool.ACT_AND_WAIT, waitArgs);
      const verdict = asVerdict(raw);
      if (!verdict.pass) {
        const trace = (raw as Record<string, unknown>)['trace'];
        failFromVerdict(verdict, trace !== undefined ? { trace } : undefined);
      }
    },

    expectSignal: (name, dataMatches) => expectSignal(deps, name, dataMatches),
    expectNet: (method, urlContains, status) => expectNet(deps, method, urlContains, status),
    expectElement: (query, state) => expectElement(deps, query, state),
    expectText: (contains) => expectText(deps, contains),
    expectAbsent: (query) => expectAbsent(deps, query),
    expectNoConsoleErrors: () => expectNoConsoleErrors(deps),

    async state(storeOrRef): Promise<unknown> {
      const args: Record<string, unknown> = {
        store: storeOrRef,
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
      return invoke(IrisTool.STATE, args);
    },
    clock: buildClock(invoke, sessionId),
    expectInputModeReal: () => expectInputModeReal(invoke, tracker, sessionId),
  };
}
