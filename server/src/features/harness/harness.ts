/**
 * The harness: a model driving Reticle's own tool surface, so a verification needs no coding agent.
 *
 * The premise that the AGENT drives is not abandoned here — an agent pointed at the daemon still gets
 * exactly that. This is for the case where there is no agent in the loop, or where having one is the
 * expensive part: a preview URL from CI, a persona journey nobody wants to pay 50k context tokens to
 * re-drive, a first run on an app with no saved flows at all.
 *
 * Three properties are load-bearing:
 *
 * 1. **It drives the SAME surface an agent would.** Not a private API, not a shortcut into the
 *    session. If the harness ever needs something the tool surface does not expose, the tool surface
 *    is missing a tool and that is the bug to fix.
 * 2. **It decides nothing.** The model chooses what to TRY; the engine decides what HAPPENED. A model
 *    that graded its own driving would be scoring its own homework, and the verdict would be
 *    unfalsifiable. The verdict is built from the flows it saved and the journal it left behind.
 * 3. **Everything is injected** — the model, the tools, the clock. The loop below has no network in
 *    it, which is what lets the whole thing be tested against a scripted model with no API key.
 */

import { withTimeout } from './with-timeout.js';

/** One tool as the model sees it. JSON Schema, because that is what the wire wants. */
export interface HarnessTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What the harness may do to the app. Supplied by the caller; the loop never imports a transport. */
export interface HarnessToolset {
  tools: readonly HarnessTool[];
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** One call the model asked for. */
export interface ToolRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** What a turn cost, including how much of it was served from cache.
 *
 * The cache fields are the only way to CONFIRM the prompt is being cached rather than merely marked
 * for caching. A breakpoint that silently misses — a byte that moved in the prefix, a turn that added
 * more blocks than the lookback window — costs full price and looks identical from here otherwise.
 * Caching is most of what makes a drive affordable, so a missed one has to be visible. */
export interface TokenUsage {
  /** Processed at full price: the part of this request that was not cached. */
  input: number;
  output: number;
  /** Served from cache at roughly a tenth of the input price. */
  cacheRead: number;
  /** Written to cache at roughly 1.25x. Paid once per new prefix. */
  cacheWrite: number;
}

/** What a model turn produced: some prose, and zero or more calls. */
export interface ModelTurn {
  text: string;
  calls: readonly ToolRequest[];
  /** Tokens this turn cost, when the driver can report them. */
  usage?: TokenUsage;
}

/** The result of one tool call, as it goes back to the model. */
export interface ToolOutcome {
  id: string;
  name: string;
  /**
   * What the model asked for, kept so the run can be read back as actions rather than results.
   *
   * The result alone says what happened; only the arguments say what was ATTEMPTED. Two consumers
   * need that and neither can recover it: a report that lists what was driven, and promoting a drive
   * to a saved flow, which records the anchor plus the action. Without this, two clicks on different
   * buttons are indistinguishable after the fact.
   */
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
}

/** The conversation, in the loop's own shape. The driver translates it to whatever the wire wants. */
export type HistoryEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: readonly ToolRequest[] }
  | { role: 'tool'; outcomes: readonly ToolOutcome[] };

/**
 * The model, reduced to the only thing the loop needs from it.
 *
 * A driver is handed the full history each turn rather than being asked to hold it, because the loop
 * owns what gets remembered — that is where budget enforcement and truncation have to live.
 */
export interface ModelDriver {
  turn(input: {
    system: string;
    tools: readonly HarnessTool[];
    history: readonly HistoryEntry[];
  }): Promise<ModelTurn>;
}

/** Why a run stopped. Every one of these is a real outcome; none of them is an error. */
export const StopReason = {
  /** The model called `finish` — it believes it is done. */
  FINISHED: 'finished',
  /** The step budget ran out. The run is still gradeable; it is just incomplete. */
  BUDGET: 'budget',
  /** The model stopped asking for tools without finishing. Rare, and worth counting. */
  STALLED: 'stalled',
  /** The toolset or the model itself failed in a way the loop cannot continue through. */
  BROKEN: 'broken',
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

export interface HarnessResult {
  stopReason: StopReason;
  /** The model's own account of what it drove. NOT a verdict — nothing downstream grades from it. */
  summary: string;
  steps: number;
  toolCalls: readonly ToolOutcome[];
  usage: TokenUsage;
  /** Set when `stopReason` is BROKEN. */
  error?: string;
}

/**
 * The one tool the harness adds to Reticle's surface.
 *
 * It exists so "I am done" is a decision the model states explicitly rather than something inferred
 * from it going quiet — a run that ends because a model had nothing more to say is indistinguishable
 * from one that ended because the model lost track, and those need different handling.
 */
export const FINISH_TOOL: HarnessTool = {
  name: 'finish',
  description:
    'Call this when you have finished driving the app, or when you cannot make further progress. Summarise what you drove and what you observed. This does not decide whether the app is correct — the engine does that from what it recorded.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'What you drove, in a few sentences: which flows you exercised, what you asserted, and anything you could not reach.',
      },
    },
    required: ['summary'],
    additionalProperties: false,
  },
};

export interface HarnessOptions {
  /** Hard ceiling on model turns. The run is graded whatever happens, so this bounds cost, not value. */
  maxSteps?: number;
  /** Extra standing instruction appended to the system prompt (a persona, an intent, a named flow). */
  focus?: string;
  /** How long one model turn may take. Injected so a test can prove the bound without waiting for it. */
  turnTimeoutMs?: number;
}

export const DEFAULT_MAX_STEPS = 40;

/**
 * How long a single model turn may take before the run gives up on it.
 *
 * Without a bound, `await driver.turn(...)` can hang forever, and a hung turn does not fail quietly —
 * it holds a leased browser context for as long as it lasts, with nothing anywhere saying why. A
 * provider stall, a dropped connection or a proxy that accepts and never answers all arrive this way.
 *
 * Two minutes is far past any real turn (measured turns are seconds) and far short of an outage. A
 * turn that times out is a BROKEN drive, and a broken drive is never reported as clean — so this
 * cannot turn a stall into a false green.
 */
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** The opening message. The app is already connected by the time the loop starts. */
const OPENING = 'The app is loaded and connected. Begin by looking at the page, then drive it.';

/**
 * The standing instruction.
 *
 * Written for a SMALL model on purpose. It states the loop, the vocabulary, and the one rule that
 * makes a drive worth anything — name the consequence BEFORE acting — and then gets out of the way.
 * It deliberately does not teach bug-finding: the oracles do that, deterministically, and a model
 * told to hunt for bugs will report its guesses as findings.
 *
 * The recording instruction is what makes the drive worth paying for twice. A drive that is not
 * saved as a flow has to be re-driven by a model on every future run; a drive that IS saved replays
 * deterministically for a few hundred tokens, forever. That is the whole economics of this feature,
 * so it is an instruction and not a hope.
 */
export function systemPrompt(focus?: string): string {
  return [
    'You are driving a real web application through a verification tool, to find out whether it actually works.',
    '',
    'The loop is: look at the page, act on it, and state what should happen BEFORE you act. Naming the',
    'expected consequence in advance is the difference between a check and a rationalisation.',
    '',
    'Use reticle_snapshot to see the page and get element refs, and reticle_query to find one control.',
    'Use reticle_act_and_wait with `until` to act and get a verdict in one call — that is the tool',
    'that proves something. reticle_act just performs an action and proves nothing. Use',
    'reticle_observe and reticle_state to see what the app did. Prefer asserting a signal, a network',
    'request, or a store value over asserting that some text is on screen — text can be right while',
    'the app is broken underneath.',
    '',
    'Drive the app the way a user would: complete whole journeys, not single clicks. Submit the forms.',
    'Follow the navigation. If something looks interactive, try it.',
    '',
    'RECORD WHAT YOU DRIVE. Before each journey call reticle_record { action: "start" }, drive it, then',
    'reticle_flow_save with a short descriptive name. A saved flow replays deterministically on every',
    'future run with no model in the loop, so an unrecorded drive is work that has to be paid for again.',
    '',
    'Real users are impatient, and impatience is where a whole class of defect lives. When several',
    'controls do the same kind of thing (filters, tabs, symbols, tags), drive two of them back to back',
    'in ONE reticle_act_sequence with `steps`, rather than waiting for the first to finish. An app that',
    'handles them one at a time and an app that races them look identical until someone hurries.',
    '',
    'You are NOT judging whether the app is correct — the engine records everything you do and decides',
    'that afterwards. Your job is coverage: exercise as much real behaviour as you can, and state clear',
    'expectations as you go. Do not report bugs; drive the app.',
    '',
    'Call `finish` when you have covered the app or cannot get further.',
    ...(focus === undefined ? [] : ['', `Focus for this run: ${focus}`]),
  ].join('\n');
}

/**
 * Run the harness to completion.
 *
 * Pure orchestration: no network, no clock, no filesystem. Everything that touches the world arrives
 * through `driver` and `toolset`, which is what makes this testable against a scripted model.
 */
export async function runHarness(
  driver: ModelDriver,
  toolset: HarnessToolset,
  options: HarnessOptions = {},
): Promise<HarnessResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const tools = [...toolset.tools, FINISH_TOOL];
  const system = systemPrompt(options.focus);
  const history: HistoryEntry[] = [{ role: 'user', text: OPENING }];
  const toolCalls: ToolOutcome[] = [];
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (let step = 0; step < maxSteps; step += 1) {
    let turn: ModelTurn;
    try {
      turn = await withTimeout(
        driver.turn({ system, tools, history }),
        options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        'the model did not answer',
      );
    } catch (error) {
      return {
        stopReason: StopReason.BROKEN,
        summary: '',
        steps: step,
        toolCalls,
        usage,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (turn.usage !== undefined) {
      usage.input += turn.usage.input;
      usage.output += turn.usage.output;
      usage.cacheRead += turn.usage.cacheRead;
      usage.cacheWrite += turn.usage.cacheWrite;
    }

    if (0 === turn.calls.length) {
      // Nothing asked for and no `finish`. Not an error, and not success either — naming it keeps
      // "the model gave up" out of the same bucket as "the model completed the work".
      return {
        stopReason: StopReason.STALLED,
        summary: turn.text,
        steps: step + 1,
        toolCalls,
        usage,
      };
    }

    history.push({ role: 'assistant', text: turn.text, calls: turn.calls });

    const finish = turn.calls.find((call) => FINISH_TOOL.name === call.name);
    if (finish !== undefined) {
      const summary = finish.args['summary'];
      return {
        stopReason: StopReason.FINISHED,
        summary: 'string' === typeof summary ? summary : turn.text,
        steps: step + 1,
        toolCalls,
        usage,
      };
    }

    // Every call the model asked for is answered, including ones that fail. A dropped result leaves
    // the model waiting on an answer that never comes, and it will usually re-ask — burning the
    // budget on a call that already ran, against an app it already changed.
    const outcomes = await Promise.all(turn.calls.map((call) => invokeOne(toolset, call)));
    toolCalls.push(...outcomes);
    history.push({ role: 'tool', outcomes });
  }

  return { stopReason: StopReason.BUDGET, summary: '', steps: maxSteps, toolCalls, usage };
}

/**
 * One tool call, with its failure captured rather than thrown.
 *
 * A tool that throws is information for the model — a wrong ref, a control that is not there yet —
 * and it recovers from that routinely. Letting the throw escape would end a run over something the
 * model was about to handle.
 */
async function invokeOne(toolset: HarnessToolset, call: ToolRequest): Promise<ToolOutcome> {
  try {
    const result = await toolset.invoke(call.name, call.args);
    return { id: call.id, name: call.name, args: call.args, result, isError: false };
  } catch (error) {
    return {
      id: call.id,
      name: call.name,
      args: call.args,
      result: { error: error instanceof Error ? error.message : String(error) },
      isError: true,
    };
  }
}
