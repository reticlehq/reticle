/**
 * A live session, as the explorer's port.
 *
 * The one hard part is that a full page load REPLACES the session: the SDK reconnects under the
 * same id (sessionStorage keeps it) but as a new object, and a command in flight on the old one is
 * rejected. So every call reads the CURRENT session, and anything that may have navigated waits for
 * the successor before it answers — the same wait `navigate { reload }` does.
 */

import {
  ActionType,
  ReticleCommand,
  ReticleTool,
  SnapshotMode,
  asRecord,
  asString,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import {
  RELOAD_RECONNECT_TIMEOUT_MS,
  waitForReconnect,
} from '@/portal/session/session-reconnect.js';
import { isSessionReplacedError } from '@/portal/session/facts/session-replaced.js';
import type { ExplorePort } from './explorer.js';

export interface PortSession {
  readonly id: string;
  readonly url: string;
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  elapsed(): number;
  eventsSince(cursor: number): ReticleEvent[];
  beginAction?(tool: string, args: Record<string, unknown>): unknown;
  finishAction?(): void;
}

export function sessionPort(input: {
  sessions: { get(id: string): PortSession | undefined };
  start: PortSession;
  startUrl: string;
  settleMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  setMocks?: (
    sessionUrl: string,
    rules: { urlContains: string; method?: string; abort?: boolean }[],
  ) => Promise<boolean>;
}): ExplorePort & { current(): PortSession } {
  let current = input.start;

  /** Wait for the document that replaced `before`. False when none arrived in time. */
  const successor = async (before: PortSession): Promise<boolean> => {
    const back = await waitForReconnect({
      current: () => input.sessions.get(before.id),
      previous: before,
      timeoutMs: RELOAD_RECONNECT_TIMEOUT_MS,
      now: input.now,
      sleep: input.sleep,
    });
    const next = input.sessions.get(before.id);
    if (!back || next === undefined) return false;
    current = next;
    return true;
  };

  const look = async (): Promise<{ tree: string; route?: string }> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await current.command(ReticleCommand.SNAPSHOT, {
          mode: SnapshotMode.INTERACTIVE,
        });
        const body = asRecord(res.result);
        const route = asString(asRecord(body['status'])['route']);
        return { tree: asString(body['tree']) ?? '', ...(route === undefined ? {} : { route }) };
      } catch (error) {
        // A click that followed a real link leaves the next read on a dead document.
        if (!isSessionReplacedError(error) || !(await successor(current))) break;
      }
    }
    return { tree: '' };
  };

  return {
    current: () => current,
    look,

    async reset(): Promise<boolean> {
      const before = current;
      try {
        const res = await before.command(ReticleCommand.NAVIGATE, { url: input.startUrl });
        if (!res.ok) return false;
      } catch (error) {
        if (!isSessionReplacedError(error)) return false;
      }
      if (!(await successor(before))) return false;
      await input.sleep(input.settleMs);
      return true;
    },

    async act(ref, action, value) {
      const session = current;
      const since = session.elapsed();
      session.beginAction?.(ReticleTool.CRAWL, { ref, action });
      let ok = false;
      let replaced = false;
      try {
        const res = await session.command(ReticleCommand.ACT, {
          ref,
          action: 'fill' === action ? ActionType.FILL : ActionType.CLICK,
          args: value === undefined ? {} : { value },
        });
        ok = res.ok && false !== asRecord(res.result)['dispatched'];
      } catch (error) {
        // Following a real link replaces the document mid-command: the click WORKED.
        if (!isSessionReplacedError(error)) throw error;
        replaced = true;
        ok = true;
      } finally {
        session.finishAction?.();
      }
      await input.sleep(input.settleMs);
      const events = session.eventsSince(since);
      if (replaced && (await successor(session)))
        return { ok, events: [...events, ...current.eventsSince(0)] };
      return { ok, events };
    },

    ...(input.setMocks === undefined
      ? {}
      : {
          mock: (rules: { urlContains: string; method?: string; abort?: boolean }[]) =>
            input.setMocks?.(current.url, rules) ?? Promise.resolve(false),
        }),
  };
}
