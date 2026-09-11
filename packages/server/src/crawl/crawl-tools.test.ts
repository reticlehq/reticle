import { describe, expect, it, vi } from 'vitest';
import {
  CrawlAnomalyKind,
  EventType,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { z } from 'zod';
import { TOOLS, type ToolDef, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { CAPPED_SNAPSHOT_NOTE, type CrawlReport } from './crawl.js';
import { CRAWL_TOOLS } from './crawl-tools.js';
import type { Session, SessionManager } from '../session/session.js';

/** Scripted session: one interactive control whose click does nothing (a dead control). */
function deadButtonSession(): Session {
  let clock = 0;
  const buffer: ReticleEvent[] = [];
  const ok = (result: unknown): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:3000/',
    elapsed: () => clock,
    eventsSince: (since) => buffer.filter((e) => e.t > since),
    command: (name) => {
      if (name === ReticleCommand.SNAPSHOT) return ok({ tree: 'button "Dead" (ref=e1)' });
      if (name === ReticleCommand.ACT) {
        clock += 1;
        return ok({ dispatched: true });
      }
      return ok({});
    },
  };
  return stub as Session;
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

/**
 * Crawl through the surface an agent actually reaches it by.
 *
 * It is `reticle_verify { action: "crawl" }` since the merge, so driving the merged tool exercises
 * the dispatch as well as the handler — strictly more than calling the member def directly did.
 */
const crawlAction = (deps: ToolDeps, args: Record<string, unknown>): Promise<unknown> =>
  tool(ReticleTool.VERIFY).handler(deps, { ...args, action: 'crawl' });

describe('reticle_crawl tool', () => {
  it('drives the resolved session and returns a structured anomaly report', async () => {
    const session = deadButtonSession();
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const deps = {
      sessions: sessions as SessionManager,
      project: { recordRoutes: () => Promise.resolve() },
    } as unknown as ToolDeps;

    const r = (await crawlAction(deps, { settleMs: 0 })) as CrawlReport;
    expect(r.interactiveFound).toBe(1);
    expect(r.stepsRun).toBe(1);
    expect(r.counts.deadControls).toBe(1);
    expect(r.anomalies[0]?.kind).toBe(CrawlAnomalyKind.DEAD_CONTROL);
  });

  it('persists actual routes discovered during the crawl, not clicked-control labels', async () => {
    let clock = 0;
    const buffer: ReticleEvent[] = [];
    const ok = (result: unknown): Promise<CommandResult> =>
      Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    const session = {
      id: 'demo',
      url: 'https://example.test/',
      elapsed: () => clock,
      eventsSince: (since: number) => buffer.filter((event) => event.t > since),
      command: (name: string) => {
        if (name === ReticleCommand.SNAPSHOT) return ok({ tree: 'link "Deployments" (ref=e1)' });
        if (name === ReticleCommand.ACT) {
          clock += 1;
          buffer.push({
            t: clock,
            type: EventType.ROUTE_CHANGE,
            sessionId: 'demo',
            data: {
              from: 'https://example.test/',
              to: 'https://example.test/deployments',
              pathname: '/deployments',
              search: '',
              hash: '',
            },
          });
          return ok({ dispatched: true });
        }
        return ok({});
      },
    } as Session;
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const recordRoutes = vi.fn<(routes: readonly string[]) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const deps = {
      sessions: sessions as SessionManager,
      project: { recordRoutes },
    } as unknown as ToolDeps;

    const report = (await crawlAction(deps, { settleMs: 0 })) as CrawlReport;

    expect(report.visited).toEqual(['link "Deployments"']);
    expect(recordRoutes).toHaveBeenCalledWith(['/', '/deployments']);
  });
});

/**
 * An undeclared field is stripped from structuredContent, so a schema-aware client never sees it —
 * the handler returns it, the text block carries it, and the structured result silently loses it.
 * This repo has now been bitten by that three times: `attrs` on query, `presentRegions` on the
 * zero-match hint, and the `source` pointer on crawl anomalies.
 *
 * This pins the crawl schema against the shape crawl actually produces, so adding a field to the
 * report without declaring it fails here rather than in a user's client.
 */
describe('the crawl output schema declares everything crawl returns', () => {
  const report: Required<CrawlReport> = {
    interactiveFound: 1,
    stepsRun: 1,
    anomalies: [
      {
        kind: CrawlAnomalyKind.DEAD_CONTROL,
        ref: 'e1',
        desc: 'button "Save"',
        detail: 'clicked but the app did nothing',
        source: 'src/components/Toolbar.tsx:44',
      },
    ],
    counts: { consoleErrors: 0, failedRequests: 0, deadControls: 1, contradictions: 0 },
    visited: ['button "Save"'],
    truncated: false,
    coverageNote: CAPPED_SNAPSHOT_NOTE,
  };

  /**
   * Read the schema off crawl's OWN definition, not off the merged tool.
   *
   * A merged tool carries no `outputSchema` — its members return different shapes and one schema
   * cannot describe them — so asking the merged def would assert nothing. The member def is
   * unchanged and still declares what crawl returns; what the merge changed is whether that schema
   * is ADVERTISED, not whether it is true. Keeping the guard here is what stops the merge from
   * quietly turning a checked contract into an unchecked one.
   */
  const tool = (): ToolDef => {
    const found = CRAWL_TOOLS.find((t) => t.name === ReticleTool.CRAWL);
    if (found === undefined) throw new Error('the crawl tool definition is gone');
    return found;
  };

  it('declares every top-level field of the report', () => {
    const declared = new Set(Object.keys(tool().outputSchema ?? {}));
    for (const key of Object.keys(report)) expect(declared).toContain(key);
  });

  it('declares every field of an anomaly', () => {
    const anomalySchema = (tool().outputSchema ?? {})['anomalies'];
    const parsed = z.array(z.unknown()).safeParse(report.anomalies);
    expect(parsed.success).toBe(true);
    // Round-trip the real shape through the declared schema: a missing key is dropped, so an
    // undeclared field shows up as an absent key rather than a validation error.
    const roundTripped = (anomalySchema as z.ZodType).parse(report.anomalies) as Record<
      string,
      unknown
    >[];
    for (const key of Object.keys(report.anomalies[0] ?? {})) {
      expect(Object.keys(roundTripped[0] ?? {})).toContain(key);
    }
  });
});
