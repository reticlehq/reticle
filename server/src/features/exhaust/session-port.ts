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
  EventType,
  ReticleCommand,
  ReticleTool,
  SnapshotMode,
  asNumber,
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
import { FIELD_ATTRS, type ActResult, type ExplorePort, type PageRead } from './explorer.js';

export interface PortSession {
  readonly id: string;
  readonly url: string;
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  elapsed(): number;
  eventsSince(cursor: number): ReticleEvent[];
  beginAction?(tool: string, args: Record<string, unknown>): unknown;
  finishAction?(): void;
}

/** How long a press waits for the requests it started to answer. */
export const PENDING_WAIT_MS = 10_000;
const PENDING_POLL_MS = 100;

/** A request that was sent and has not answered: a `net.pending` with no `net.request` of its id. */
function inFlight(events: readonly ReticleEvent[]): boolean {
  const answered = new Set(
    events.filter((e) => EventType.NET_REQUEST === e.type).map((e) => asString(e.data['id'])),
  );
  return events.some(
    (e) => EventType.NET_PENDING === e.type && !answered.has(asString(e.data['id'])),
  );
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
  /** The URL the page had before the last action, for `back`. */
  let lastUrl: string | undefined;

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
    if (!back || next === undefined) {
      return false;
    }
    current = next;
    return true;
  };

  const read = async (mode: SnapshotMode): Promise<PageRead> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await current.command(ReticleCommand.SNAPSHOT, { mode });
        const body = asRecord(res.result);
        const route = asString(asRecord(body['status'])['route']);
        return { tree: asString(body['tree']) ?? '', ...(route === undefined ? {} : { route }) };
      } catch (error) {
        // A click that followed a real link leaves the next read on a dead document.
        if (!isSessionReplacedError(error) || !(await successor(current))) {
          break;
        }
      }
    }
    return { tree: '' };
  };

  /** Send a command that replaces the document, then wait for the new one and let it settle. */
  const load = async (name: string, args: Record<string, unknown>): Promise<boolean> => {
    const was = current;
    try {
      const res = await was.command(name, args);
      if (!res.ok) {
        return false;
      }
    } catch (error) {
      if (!isSessionReplacedError(error)) {
        return false;
      }
    }
    if (!(await successor(was))) {
      return false;
    }
    await input.sleep(input.settleMs);
    return true;
  };

  return {
    current: () => current,
    look: () => read(SnapshotMode.INTERACTIVE),
    lookFull: () => read(SnapshotMode.FULL),
    reset: () => load(ReticleCommand.NAVIGATE, { url: input.startUrl }),
    reload: () => load(ReticleCommand.REFRESH, {}),

    // ponytail: a load of the URL the page had before the last action, not the browser's history
    // back, which no page command sends. An app that keeps state in its history entries comes back
    // fresh here; add a history command if a finding needs it.
    back: () =>
      lastUrl === undefined
        ? Promise.resolve(false)
        : load(ReticleCommand.NAVIGATE, { url: lastUrl }),

    async fieldAttrs(control) {
      const [, role, name] = /^(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(control) ?? [];
      if (role === undefined) {
        return undefined;
      }
      try {
        const res = await current.command(ReticleCommand.QUERY, {
          role,
          ...(name === undefined ? {} : { name }),
          attrs: [...FIELD_ATTRS],
        });
        const first: unknown = asRecord(res.result)['elements'];
        const attrs = Array.isArray(first) ? asRecord(asRecord(first[0])['attrs']) : {};
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(attrs)) {
          if ('string' === typeof value) {
            out[key] = value;
          }
        }
        return out;
      } catch {
        return undefined;
      }
    },

    async act(ref, action, value, opts): Promise<ActResult> {
      const session = current;
      lastUrl = session.url;
      const since = session.elapsed();
      session.beginAction?.(ReticleTool.CRAWL, { ref, action });
      let ok = false;
      let replaced = false;
      let source: ActResult['source'];
      try {
        const res = await session.command(ReticleCommand.ACT, {
          ref,
          action: 'fill' === action ? ActionType.FILL : ActionType.CLICK,
          args: value === undefined ? {} : { value },
        });
        const body = asRecord(res.result);
        ok = res.ok && false !== body['dispatched'];
        const src = asRecord(body['source']);
        const file = asString(src['file']);
        const line = asNumber(src['line']);
        source = file === undefined || line === undefined ? undefined : { file, line };
      } catch (error) {
        // Following a real link replaces the document mid-command: the click WORKED.
        if (!isSessionReplacedError(error)) {
          throw error;
        }
        replaced = true;
        ok = true;
      } finally {
        session.finishAction?.();
      }
      let events = session.eventsSince(since);
      if (false !== opts?.settle) {
        await input.sleep(input.settleMs);
        events = session.eventsSince(since);
        // A slow write answers long after the page settles. Wait for the requests this press
        // started, up to a bound, so its answer, its error and a second copy are in its events.
        const poll = Math.max(input.settleMs, PENDING_POLL_MS);
        for (let i = 0; i < Math.floor(PENDING_WAIT_MS / poll) && inFlight(events); i += 1) {
          await input.sleep(poll);
          events = session.eventsSince(since);
        }
      }
      const found = source === undefined ? {} : { source };
      if (replaced && (await successor(session))) {
        return { ok, events: [...events, ...current.eventsSince(0)], ...found };
      }
      return { ok, events, ...found };
    },

    ...(input.setMocks === undefined
      ? {}
      : {
          mock: (rules: { urlContains: string; method?: string; abort?: boolean }[]) =>
            input.setMocks?.(current.url, rules) ?? Promise.resolve(false),
        }),
  };
}
