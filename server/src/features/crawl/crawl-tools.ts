import { z } from 'zod';
import { sessionRoot } from '@/memory/project/session-root.js';
import { projectForRoot } from '@/memory/project/project-for-root.js';
import { ReticleTool } from '@reticlehq/core';
import { asNumber, asString } from '@reticlehq/core';
import { stepCountSchema, timeoutMsSchema } from '@/surface/tools/args/numeric-bounds.js';
import { crawl, type CrawlOptions } from './crawl.js';
import { EXHAUST_DEFAULT_ACTIONS, runExhaustive } from '@/features/exhaust/exhaust-run.js';
import { heuristicFillValue } from '@/features/harness/fill-values.js';
import { secretEnvKey } from '@/language/flows/flows.js';
import type { MockRule } from '@/portal/input/network-mock.js';
import { CRAWL_DEFAULTS } from '@reticlehq/core';
import type { ToolDef, ToolDeps } from '@/surface/tools/tool-kit.js';
import { routeFromUrl, routesFromEvents } from '@/memory/project/learned-routes.js';

const nodeSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The configured secret for a field, only on the origin the crawl started on. The field name comes
 * from whatever page is on screen, so without the check a page on another origin could name an
 * empty textbox after a secret and have the crawl type it in.
 */
export function crawlSecret(
  startUrl: string,
  env: Readonly<Record<string, string | undefined>>,
): (name: string, pageUrl: string) => string | undefined {
  const originOf = (url: string): string | undefined => {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  };
  const home = originOf(startUrl);
  return (name, pageUrl) =>
    home !== undefined && home === originOf(pageUrl) ? env[secretEnvKey(name)] : undefined;
}

/**
 * The autonomous "smart monkey" tool. Builds on reticle_explore (which only LISTS) by
 * actually clicking each reachable control and classifying the reaction. DESTRUCTIVE by nature —
 * it drives the app — so it's an explicit, bounded tool, never part of a passive read.
 */
export const CRAWL_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.CRAWL,
    description:
      'Autonomously click every reachable interactive control (bounded by maxSteps, default 25) and report anomalies WITHOUT a script. Two classes: single-channel faults (console errors, failed requests ≥400, DEAD controls that dispatched but did nothing) and CONTRADICTIONS — two channels disagreeing about the same click, e.g. the UI advanced while its write failed, a success signal fired over a failed request, a write succeeded and nothing changed, the same write fired twice, or the UI moved on over an in-flight request. Contradictions are the false greens a human cannot see, because a human watches one channel (the screen) and it looks correct. DESTRUCTIVE — it really clicks (may navigate/mutate state); use reticle_explore first for a non-destructive list. Returns { interactiveFound, stepsRun, anomalies[{kind,ref,desc,detail}], counts, visited, truncated }.',
    inputSchema: {
      maxSteps: stepCountSchema
        .optional()
        .describe('Maximum number of controls to click. Default: 25.'),
      settleMs: timeoutMsSchema
        .optional()
        .describe('Milliseconds to wait after each click for the app to react. Default: 500.'),
      scope: z
        .string()
        .optional()
        .describe('CSS selector or element ref to restrict crawling to a subtree.'),
      exhaustive: z
        .boolean()
        .optional()
        .describe(
          "Walk every state it can tell apart, drive each write's failure path, fold into the coverage ledger.",
        ),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe(
          'Set true to allow controls classified as destructive. Default false; those controls are blocked by the browser.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
    },
    // An UNDECLARED field is stripped from structuredContent, so a schema-aware client never sees it
    // even though the handler returns it. Everything crawl produces has to be listed here or it is
    // silently lost — which is how the source pointer and the visited list were being dropped.
    outputSchema: {
      interactiveFound: z.number(),
      stepsRun: z.number(),
      // Present only when nothing was clicked, saying WHICH zero this is — an empty page, a step
      // budget of zero, or controls found and none driven. A bare zero was unactionable.
      note: z.string().optional(),
      anomalies: z.array(
        z.object({
          kind: z.string(),
          ref: z.string(),
          desc: z.string(),
          detail: z.string().optional(),
          source: z
            .string()
            .optional()
            .describe(
              'Where the fault is written, as `file:line`; console errors prefer their own stack and fall back to the clicked control.',
            ),
        }),
      ),
      counts: z.record(z.number()),
      visited: z.array(z.string()).describe('The controls actually clicked, in order.'),
      coverageNote: z
        .string()
        .optional()
        .describe(
          'Present only when the page exceeded one snapshot, so controls past the cap were never listed. When present, a zero-anomaly result does NOT mean the app is clean.',
        ),
      truncated: z.boolean(),
      notJudged: z
        .array(z.object({ ref: z.string(), desc: z.string(), reason: z.string() }))
        .optional()
        .describe(
          'Controls clicked whose silence could not be judged, e.g. on a background tab. They are NOT reported as dead, and they are not known to work either.',
        ),
      // Only on `exhaustive` — see features/exhaust/exhaust-run.ts. Loose: it carries the levels.
      exhaustive: z.record(z.unknown()).optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = session.elapsed();
      const initialRoute = routeFromUrl(session.url);
      const maxSteps = asNumber(args['maxSteps']);
      const settleMs = asNumber(args['settleMs']);
      const scope = asString(args['scope']);
      const opts: CrawlOptions = {
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(settleMs !== undefined ? { settleMs } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(true === args['confirmDangerous'] ? { confirmDangerous: true } : {}),
      };
      if (true === args['exhaustive']) {
        // Starts code-coverage collection, so the drive below is measured. See takeCodeCoverage.
        await deps.realInput?.takeCodeCoverage?.(session.url);
        const secret = crawlSecret(session.url, process.env);
        return runExhaustive({
          sessions: deps.sessions,
          session,
          startUrl: session.url,
          maxActions: maxSteps ?? EXHAUST_DEFAULT_ACTIONS,
          settleMs: settleMs ?? CRAWL_DEFAULTS.SETTLE_MS,
          fillValue: (label, pageUrl) => {
            const name = /"([^"]*)"/.exec(label)?.[1] ?? label;
            return secret(name, pageUrl) ?? heuristicFillValue(name);
          },
          now: deps.now,
          sleep: nodeSleep,
          ...(deps.realInput?.setMocks === undefined
            ? {}
            : {
                setMocks: (url: string, rules: MockRule[]) =>
                  deps.realInput?.setMocks?.(url, rules) ?? Promise.resolve(false),
              }),
          ...(deps.realInput?.takeCodeCoverage === undefined
            ? {}
            : {
                takeCode: (url: string) =>
                  deps.realInput?.takeCodeCoverage?.(url) ?? Promise.resolve(undefined),
              }),
          fs: deps.fs,
          reticleRoot: sessionRoot(deps, session.id),
        });
      }
      const report = await crawl(session, opts, nodeSleep);
      const routes = [
        ...(initialRoute === undefined ? [] : [initialRoute]),
        ...routesFromEvents(session.eventsSince(since)),
      ];
      if (routes.length > 0)
        await projectForRoot(deps, sessionRoot(deps, session.id)).recordRoutes(routes);
      return report;
    },
  },
];
