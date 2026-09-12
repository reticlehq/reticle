/**
 * Reticle's own tool surface, handed to the harness.
 *
 * The harness drives exactly what an agent drives — same definitions, same dispatcher, same session.
 * There is no private path into the engine, and that is a design rule rather than an implementation
 * detail: the moment the harness needs something the tool surface does not expose, the tool surface
 * is missing a tool and THAT is the bug. Every capability a harness run proves is one a user's own
 * agent can reach.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ReticleTool } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { runTool } from './invoke-tool.js';
import { TOOL_SURFACE, filterTools } from './tool-surface.js';
import { withTimeout } from '../../features/harness/with-timeout.js';
import type { HarnessTool, HarnessToolset } from '../../features/harness/harness.js';

/**
 * The two tools the harness is given beyond the advertised surface.
 *
 * Recording is what makes a drive worth paying for twice: a journey the model drove and SAVED
 * replays deterministically for a few hundred tokens on every future run, and one it merely drove
 * has to be re-driven by a model every time. Both sit in the extended surface, reachable by an agent
 * only through a discovery hop — and a hop the model has to take on every journey is a hop it will
 * sometimes skip, which silently turns the cheap path off.
 */
const HARNESS_EXTRA_TOOLS: readonly string[] = [ReticleTool.RECORD, ReticleTool.FLOW_SAVE];

/**
 * The one deliberate subtraction.
 *
 * `reticle_feedback` exists so a human's agent can tell us what is missing. A model driving in a loop
 * will report its own confusion as a product defect at a rate that would drown the channel it is
 * meant to protect.
 */
const HARNESS_EXCLUDED: ReadonlySet<string> = new Set([ReticleTool.FEEDBACK]);

/**
 * Parameters the model is never asked for, because the harness supplies them.
 *
 * `sessionId` is pinned by the run: `invoke` stamps it on every call so a drive that leased one tab
 * cannot have a tool resolve a different one. Advertising it therefore buys nothing and costs twice —
 * the same paragraph of prose on every tool on EVERY turn, and a parameter the model can get wrong
 * in the one place where being wrong means a verdict about the wrong tab.
 */
const INJECTED_PARAMS: ReadonlySet<string> = new Set(['sessionId']);

/**
 * How long one tool call may take before the drive gives up on it.
 *
 * The engine puts no bound on tool execution and it is right not to: it does not know what its caller
 * can afford. The harness does. A wedged browser — a Chromium that stops answering CDP, a page in an
 * infinite layout loop — hangs the call that touches it, and a hung call holds the leased context
 * exactly like a stalled model turn does.
 *
 * A BACKSTOP, not a policy, and deliberately far above any real call: a crawl drives every control on
 * a page and legitimately takes minutes on a large app, so a tight bound here would not catch a
 * wedge, it would manufacture one.
 */
const TOOL_TIMEOUT_MS = 300_000;

/** What the MCP SDK passes its own converter, restated so the two surfaces cannot drift apart. */
const MCP_SCHEMA_OPTIONS = { strictUnions: true, pipeStrategy: 'input' } as const;

/** Convert one tool's zod shape into the JSON Schema the model wire wants. */
function toHarnessTool(tool: ToolDef): HarnessTool {
  const asked = Object.fromEntries(
    Object.entries(tool.inputSchema).filter(([name]) => !INJECTED_PARAMS.has(name)),
  );
  return {
    name: tool.name,
    description: tool.description,
    /*
     * The SAME conversion the MCP layer hands an agent — options included.
     *
     * Not a detail: `reticle_act_and_wait`'s `until` is a RECURSIVE predicate (and/or/not nest), and
     * inlining a recursive schema is impossible, so a converter told not to emit `$ref` quietly
     * degrades that one parameter to `any`. The model would then be guessing the shape of the single
     * argument that decides whether a drive proves anything. Definitions and refs are what every
     * agent driving Reticle over MCP already reads.
     */
    inputSchema: zodToJsonSchema(z.object(asked), MCP_SCHEMA_OPTIONS),
  };
}

export interface ReticleToolsetOptions {
  /** Pinned session, so a drive works the tab it opened rather than whichever one resolves. */
  sessionId?: string;
  /** Restrict to these names. Defaults to the advertised surface plus the recording pair. */
  only?: readonly string[];
}

/**
 * Bind the live tool surface to a set of dependencies.
 *
 * `deps` is the daemon's own dependency bag — the same one the MCP layer dispatches with — so a
 * harness drive and an agent drive are indistinguishable from inside the engine. That is what makes
 * a harness run a measurement of the product rather than of a test harness.
 */
export function reticleToolset(
  deps: ToolDeps,
  options: ReticleToolsetOptions = {},
): HarnessToolset {
  const usable = TOOLS.filter((tool) => !HARNESS_EXCLUDED.has(tool.name));
  /**
   * Everything callable, whether or not it is advertised. `reticle_run` dispatches against this, so
   * trimming the ADVERTISED list never trims what a drive can reach.
   */
  const byName = new Map(usable.map((tool) => [tool.name, tool]));

  const advertised =
    options.only === undefined
      ? [
          ...filterTools([...usable], TOOL_SURFACE.DEFAULT),
          ...usable.filter((tool) => HARNESS_EXTRA_TOOLS.includes(tool.name)),
        ]
      : usable.filter((tool) => true === options.only?.includes(tool.name));

  return {
    tools: advertised.map(toHarnessTool),
    async invoke(name, args) {
      const [target, targetArgs] =
        ReticleTool.RUN === name ? [asName(args['tool']), asArgs(args['args'])] : [name, args];
      const tool = target === undefined ? undefined : byName.get(target);
      if (tool === undefined) {
        // Answered rather than thrown: a model that asked for a name it cannot call needs the live
        // list, and this is the same recovery the MCP surface gives an agent that does the same.
        return { error: `unknown tool ${target ?? name}`, available: [...byName.keys()] };
      }
      const scoped = pinSession(targetArgs, options.sessionId);
      return withTimeout(
        runTool(tool, deps, scoped),
        TOOL_TIMEOUT_MS,
        `${tool.name} never returned`,
      );
    },
  };
}

/**
 * Stamp the drive's own session onto a call.
 *
 * Without it a drive that opened one tab can have a tool resolve a DIFFERENT one — and a verdict
 * about the wrong tab is the false green this product exists to prevent, arriving through our own
 * front door. An explicit `sessionId` in the arguments wins: `reticle_sessions` hands the model real
 * ids, and silently overwriting one would make a deliberate cross-tab call lie about which tab it
 * read.
 */
export function pinSession(
  args: Record<string, unknown>,
  sessionId: string | undefined,
): Record<string, unknown> {
  if (sessionId === undefined || 'sessionId' in args) return args;
  return { ...args, sessionId };
}

function asName(value: unknown): string | undefined {
  return 'string' === typeof value && value.length > 0 ? value : undefined;
}

function asArgs(value: unknown): Record<string, unknown> {
  return 'object' === typeof value && null !== value && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
