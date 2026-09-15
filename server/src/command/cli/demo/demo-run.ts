/**
 * The tutorial, run rather than printed.
 *
 * `reticle tutorial` described four steps and produced nothing. The last of those steps says that a
 * drive without a verdict has no result — and the tour itself ended without one, which is the lesson
 * taught by counter-example. So the same four steps now execute, against the demo page, and every
 * line the reader sees is a thing that actually happened.
 *
 * The steps are NOT re-listed here. They come from `tutorialScript`, the same source the printed tour
 * reads, because two descriptions of one sequence drift and the one nobody updated is the one
 * somebody follows.
 *
 * Tools are called in-process rather than over the daemon's MCP transport. This command starts the
 * daemon it drives, so it already holds the session; going back out over a socket to reach a server
 * inside this process would add a transport that can fail to a tour whose job is to not fail. The
 * funnel telemetry is unaffected either way — `runTool` is the chokepoint that reports it, and both
 * routes pass through it.
 */

import { ReticleTool } from '@reticlehq/core';
// TOOLS comes through the package barrel rather than from `surface/tools/tools.js` directly. That
// aggregator composes the tool arrays out of five directories, and anything importing it back is how
// this package accumulated cycles; the barrel sits above both it and this file, which is the
// direction that does not close a loop.
import { start, TOOLS, type RunningServer } from '../../../index.js';
import { runTool } from '../../../surface/tools/invoke-tool.js';
import type { ToolDef } from '../../../surface/tools/tool-kit.js';
import { buildVerifyDeps } from '../cli-verify.js';
import {
  readOrCreatePairingTokenSync,
  defaultPairingTokenDir,
} from '../../../portal/bridge/pairing-token.js';
import { tutorialScript, TutorialAudience, demoPlan } from '../tutorial.js';
import { sdkGraph, demoPageHtml, serveDemoPage, DEMO_SIGNAL } from './demo-page.js';

/** How long to wait for the demo page to dial the bridge before giving up on it. */
const SESSION_TIMEOUT_MS = 30_000;
const SESSION_POLL_MS = 250;

/** Only `verified: "yes"` is a pass — see the contract every verdict tool here is held to. */
const PROVED = 'yes';

export interface DemoTourOptions {
  port: number;
  headless: boolean;
  /** Every line the reader sees, in order. Injected so a test reads the tour instead of a terminal. */
  say: (line: string) => void;
  now?: () => number;
}

/** A tour either reached a verdict or it did not; the exit code says which. */
export interface DemoTourResult {
  code: number;
  verified: string | undefined;
}

function toolNamed(name: string): ToolDef {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`the tutorial cannot run: ${name} is not in the tool registry`);
  }
  return found;
}

function asRecord(value: unknown): Record<string, unknown> {
  return 'object' === typeof value && null !== value ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}

/** The controls `reticle_query` found, in the shape the safety rule reads them. */
function controlsIn(result: unknown): { ref: string; name: string; role?: string }[] {
  const raw = asRecord(result)['elements'];
  if (!Array.isArray(raw)) return [];
  const out: { ref: string; name: string; role?: string }[] = [];
  for (const item of raw) {
    const el = asRecord(item);
    const ref = asText(el['ref']);
    const name = asText(el['name']);
    if (ref === undefined || name === undefined) continue;
    const role = asText(el['role']);
    out.push(role === undefined ? { ref, name } : { ref, name, role });
  }
  return out;
}

async function waitForSession(running: RunningServer, now: () => number): Promise<boolean> {
  const deadline = now() + SESSION_TIMEOUT_MS;
  while (now() < deadline) {
    if (running.bridge.sessions.count() > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS));
  }
  return running.bridge.sessions.count() > 0;
}

/**
 * Run the tour, and report whether it ended at a proof.
 *
 * A step that cannot be taken stops the tour and says which one. Carrying on past a failed step
 * would end at a verdict taken against a page the earlier steps never reached — which is precisely
 * the false green the fourth step is there to warn about.
 */
export async function runDemoTour(options: DemoTourOptions): Promise<DemoTourResult> {
  const now = options.now ?? ((): number => Date.now());
  const steps = new Map(tutorialScript(TutorialAudience.HUMAN).map((s) => [s.id, s]));
  const announce = (id: string): void => {
    const step = steps.get(id);
    if (step === undefined) return;
    options.say('');
    options.say(step.say);
    options.say(`  why: ${step.why}`);
  };

  const graph = sdkGraph();
  const token = readOrCreatePairingTokenSync(defaultPairingTokenDir()) ?? '';
  const bridgeUrl = `ws://localhost:${String(options.port)}/reticle`;
  const page = await serveDemoPage(demoPageHtml(graph, token, bridgeUrl), graph);
  let running: RunningServer | undefined;

  try {
    running = await start({ port: options.port, driveUrl: page.url, headless: options.headless });
    const deps = buildVerifyDeps(running, process.cwd(), now);
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      await runTool(toolNamed(name), deps, args);

    announce('connect');
    if (!(await waitForSession(running, now))) {
      options.say('  the demo page never dialled the bridge, so there is nothing to show.');
      return { code: 1, verified: undefined };
    }
    options.say(`  one session connected: the demo app at ${page.url}`);

    announce('look');
    const snapshot = asRecord(await call(ReticleTool.SNAPSHOT, { mode: 'interactive' }));
    for (const line of (asText(snapshot['tree']) ?? '').split('\n')) options.say(`  ${line}`);

    announce('declare');
    const found = controlsIn(await call(ReticleTool.QUERY, { role: 'button' }));
    const plan = demoPlan(found);
    if (!plan.ok) {
      options.say(`  ${plan.because}`);
      return { code: 1, verified: undefined };
    }
    options.say(`  "${plan.name}" is safe to press. Saving should make the app say so itself:`);
    options.say(`  reticle_act_and_wait { ref: "${plan.ref}", action: "click", until: {`);
    options.say(`    kind: "signal", name: "${DEMO_SIGNAL}" } }`);

    announce('verdict');
    const verdict = asRecord(
      await call(ReticleTool.ACT_AND_WAIT, {
        ref: plan.ref,
        action: 'click',
        until: { kind: 'signal', name: DEMO_SIGNAL },
      }),
    );
    const verified = asText(verdict['verified']);
    const because = asText(verdict['verifiedReason']) ?? asText(verdict['failureReason']);
    options.say(`  verified: ${verified ?? 'unknown'}`);
    if (because !== undefined) options.say(`  because: ${because}`);
    return { code: PROVED === verified ? 0 : 1, verified };
  } finally {
    await page.close();
    await running?.close?.();
  }
}
