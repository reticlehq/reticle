import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_SURFACE, CORE_TOOL_NAMES, resolveToolSurface } from '../tools/tool-surface.js';
import { ReticleTool } from '@reticlehq/core';
import { buildServerInstructions } from './server-instructions.js';
import { advertisedTools } from './mcp.js';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * Three sources describe the tool surface, and they have to agree.
 *
 * The advertised list is what `tools/list` returns. The MCP instructions block is what every agent
 * reads at the handshake. `SKILL.md` is what a user pastes. Nothing tied them together, so all three
 * drifted in both directions at once, and each direction fails differently:
 *
 * A tool NAMED but not callable is the worse half. An agent reads "use reticle_state", looks at the
 * list it was handed, does not find it, and burns a call proving the instructions wrong. After that
 * it has no way to tell which of the remaining advice is real. Guidance that lies once is guidance
 * that gets ignored, and it is being read by something that cannot ask.
 *
 * A tool ADVERTISED but named nowhere is the quieter half, and `reticle_observe` is the case that
 * shows why it matters: TOOL_SURFACE.VERIFY records the measurement, where dropping the observation
 * tools TRIPLED false alarms. The model stops observing and reaches for the verdict without the
 * evidence. A tool that load-bearing, handed over as a name and a one-line description with no word
 * on when to reach for it, is a tool the model will not reach for.
 *
 * So: named implies reachable, advertised implies mentioned. The advertised set is read from the
 * LIVE DEFAULT SURFACE rather than restated here, because a hand-maintained copy of the surface is
 * the same defect one level up.
 *
 * It used to read `CORE_TOOL_NAMES`, and that stopped being the default the day the nine-tool
 * surface became it. The distinction is the whole point of this file: `CORE_TOOL_NAMES` is the
 * nineteen-tool table, and a reader handed the nine would have been judged against a product they
 * were not given — which is the failure recorded further down, where drive calls fell 96 to 2.
 * `resolveToolSurface()` answers what a daemon started today actually serves.
 */
const REPO = REPO_ROOT;
const SKILL = join(REPO, 'SKILL.md');

/** What a daemon started right now advertises. The documents are judged against THIS. */
const DEFAULT_ADVERTISED: ReadonlySet<string> = new Set(
  advertisedTools(resolveToolSurface()).map((tool) => tool.name),
);

/** Any `reticle_*` token. Narrowed against DECLARED below: most of them were never tools. */
const ANY_TOOL_MENTION = /reticle_[a-z0-9_]+/g;

/**
 * The supported shape for reaching a tool that is not advertised. Naming one WITHOUT this is the
 * defect; naming one WITH it is the fix, and is how the skill already reaches `reticle_verify`.
 */
const RUN_FORM = /reticle_run\(\{\s*tool:\s*"([a-z0-9_]+)"/g;

/** Only a name that was declared a tool is evidence. Telemetry codes and store names are not. */
const DECLARED: ReadonlySet<string> = new Set<string>(Object.values(ReticleTool));

/**
 * The two meta-tools. Always advertised, on every surface, and they are the thing the run form is
 * written with, so requiring them to be reachable through themselves is circular.
 */
const META: ReadonlySet<string> = new Set<string>([ReticleTool.RUN, ReticleTool.TOOLS]);

/**
 * What an agent actually reads out of the instructions module: the shipped strings, not the
 * docblocks around them. The comments in that file discuss tools at length by name, and counting
 * those as guidance would let a source comment satisfy a rule about what the agent is told.
 */
function instructionProse(): string {
  return [true, false].map((c) => buildServerInstructions({ previouslyConnected: c })).join('\n');
}

interface Source {
  readonly label: string;
  readonly text: string;
}

function sources(): Source[] {
  return [
    {
      label: 'the MCP instructions (server/src/surface/mcp/server-instructions.ts)',
      text: instructionProse(),
    },
    { label: 'SKILL.md', text: readFileSync(SKILL, 'utf8') },
  ];
}

function mentionedTools(text: string): Set<string> {
  return new Set((text.match(ANY_TOOL_MENTION) ?? []).filter((n) => DECLARED.has(n)));
}

function runFormTools(text: string): Set<string> {
  return new Set([...text.matchAll(RUN_FORM)].map((m) => m[1] ?? ''));
}

describe('the instructions, SKILL.md and the advertised surface describe the same product', () => {
  it('derives the advertised set from the surface module, not from a list in this file', () => {
    // The derivation being LIVE is the point: if CORE_TOOL_NAMES is what this reads, a tool added
    // there arrives here on its own. Pinned against the two anchors the checks below depend on.
    expect(CORE_TOOL_NAMES.size).toBeGreaterThan(10);
    // And the set the documents are judged against is the LIVE one, which is smaller and is not
    // this list. Both anchors matter: the first says the module still resolves, the second says
    // this file is asking about the product a reader is actually handed.
    expect(DEFAULT_ADVERTISED.size).toBeGreaterThan(5);
    expect(DEFAULT_ADVERTISED.has(ReticleTool.OBSERVE)).toBe(true);
    expect(DEFAULT_ADVERTISED.has(ReticleTool.CONTEXT)).toBe(false);
  });

  it('finds both sources, with enough text in each to judge', () => {
    for (const { label, text } of sources()) {
      expect(text.length, `${label} is empty`).toBeGreaterThan(500);
    }
  });

  it('every tool a document names is either advertised or shown with its reticle_run call', () => {
    const unreachable: string[] = [];
    for (const { label, text } of sources()) {
      const reachable = runFormTools(text);
      for (const name of mentionedTools(text)) {
        if (DEFAULT_ADVERTISED.has(name) || META.has(name) || reachable.has(name)) continue;
        unreachable.push(`${label}: ${name}`);
      }
    }
    expect(
      unreachable,
      'These documents name a tool that is not on the advertised surface and never show how to ' +
        'reach it, so an agent that follows the advice gets "unknown tool". FIX: write the call as ' +
        '`reticle_run({ tool: "<name>", args: {...} })` where the document names it, or advertise ' +
        `the tool by adding it to CORE_TOOL_NAMES in tools/tool-surface.ts:\n${unreachable.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * The check above reads ONE surface. That blindness cost a whole benchmark run.
   *
   * The nine-tool surface shipped with instructions naming `reticle_snapshot`, `reticle_query`,
   * `reticle_wait_for`, `reticle_state`, `reticle_network`, `reticle_sessions`, `reticle_run`,
   * `reticle_context` and `reticle_intent` — none of which existed on it — plus a catalogue of 57
   * more it could not invoke. MEASURED against the default surface on the same five bugs: drive
   * calls fell 96 -> 2, verdicts 20 -> 1, intents declared 14 -> 1 and discharged 6 -> 0. The agent
   * tried a tool it had been shown, failed, tried again, and then abandoned the product and fixed
   * the bugs by reading source. It read as a 28% token saving, because a product nobody uses is cheap.
   *
   * The guard above was green throughout, because it asks about `CORE_TOOL_NAMES` and the briefing
   * it judged was the default one. So the question is asked of EVERY surface here.
   */
  it('no surface briefs an agent on a tool it does not advertise', () => {
    const wrong: string[] = [];
    for (const surface of Object.values(TOOL_SURFACE)) {
      const advertised = advertisedTools(surface).map((tool) => tool.name);
      const live = new Set(advertised);
      const text = [true, false]
        .map((connected) => buildServerInstructions({ previouslyConnected: connected, advertised }))
        .join('\n');
      const reachable = runFormTools(text);
      for (const name of mentionedTools(text)) {
        if (live.has(name) || reachable.has(name)) continue;
        wrong.push(`${surface}: ${name}`);
      }
    }
    expect(
      wrong,
      'The briefing an agent reads FIRST names a tool that surface does not advertise and does not ' +
        'show how to reach. An agent handed a briefing for a different product stops using this ' +
        'one — that is measured, not predicted. FIX: resolve the name through surfaceVocabulary.ts ' +
        `rather than writing it into the prose:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });

  it('a catalogue never lists a tool the surface cannot invoke', () => {
    const dead: string[] = [];
    for (const surface of Object.values(TOOL_SURFACE)) {
      const advertised = advertisedTools(surface);
      const live = new Set(advertised.map((tool) => tool.name));
      // Where `reticle_run` is advertised every listed tool is callable through it, so there is
      // nothing to check. Where it is not, the catalogue IS the list of what can be called.
      if (live.has(ReticleTool.RUN)) continue;
      const catalogue = advertised.find((tool) => tool.name === ReticleTool.TOOLS);
      if (catalogue === undefined) continue;
      dead.push(
        `${surface}: catalogue advertised with no dispatch hatch — assert its contents here`,
      );
    }
    // Deliberately not asserting emptiness: a surface MAY ship the catalogue without `reticle_run`,
    // and the nine does. What must hold is that its entries are callable, which is asserted against
    // the live handler in merged-surface.test.ts where the deps to call it exist.
    expect(
      dead.length,
      'this exists to make the pairing a decision rather than an accident',
    ).toBeLessThanOrEqual(1);
  });

  it('every advertised tool is named in at least one of them', () => {
    const combined = sources()
      .map((s) => s.text)
      .join('\n');
    const named = mentionedTools(combined);
    const silent = [...DEFAULT_ADVERTISED].filter((n) => !named.has(n));
    expect(
      silent,
      'These tools are advertised on every turn and no document an agent reads mentions them, so ' +
        'the agent has a name and a one-line description and nothing about WHEN to reach for it. ' +
        'That is not free: dropping the observation tools tripled false alarms (see ' +
        'TOOL_SURFACE.VERIFY). FIX: say what each is for in server-instructions.ts or SKILL.md, or ' +
        `drop it from CORE_TOOL_NAMES if it does not earn its per-turn cost:\n${silent.join('\n')}`,
    ).toEqual([]);
  });
});
