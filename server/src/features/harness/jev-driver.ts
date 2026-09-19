/**
 * A harness driver with no text generator in it.
 *
 * `driver.ts` binds the harness to a frontier model, and the comment at the top of it has always
 * claimed the tier is "a standing test of the design": the driver is not reasoning about business
 * logic, it is choosing what to touch next and saying what it expects, and if that needed a large
 * model then the engine would not be doing its job. Nothing tested the claim, because the only
 * driver in the repo was a large model.
 *
 * This is the test. Jev is a System One model — it evaluates typed questions against a state and
 * answers with probabilities, in one parallel pass, and it does not emit prose. It therefore cannot
 * invent a tool call. So every call this driver makes is built HERE, deterministically, out of what
 * the page actually offers, and the model's only contribution is picking one of them. That is a
 * strictly smaller surface than a generating driver has, and it is the whole reason this is worth
 * having: a driver that cannot name an element that is not on the page cannot hallucinate one.
 *
 * What did NOT move: the verdict. `decideVerified` still decides, on evidence, with no model in it.
 * A System One model cannot hallucinate a type, but it still returns a PROBABILITY, and a
 * probability is not proof. Anyone reading this file as an invitation to let Jev answer
 * "did it work?" should read `engine/src/evidence/verified.ts` first — the seventeen clauses there
 * exist because this product is the verdict, and a verdict sourced from a model's confidence is the
 * thing Reticle sells the absence of.
 */

import { ReticleEnv, ReticleTool, asRecord, parseInteractive } from '@reticlehq/core';

import { FINISH_TOOL } from './harness.js';
import type { HistoryEntry, ModelDriver, ModelTurn, ToolRequest } from './harness.js';
import type { HarnessFetch } from './driver.js';

export const DEFAULT_JEV_MODEL = 'jev-latest';
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';
const SYSTEMONE_PATH = '/v1/systemone';

/**
 * Tool names this driver emits.
 *
 * Taken from core rather than spelled again here: these cross a wire, and a second spelling of a
 * wire string is a rename waiting to half-land. `finish` is the exception — it is the harness's own
 * synthetic tool and has no wire identity, so it comes from the loop that defines it.
 */
const Tool = {
  SNAPSHOT: ReticleTool.SNAPSHOT,
  ACT_AND_WAIT: ReticleTool.ACT_AND_WAIT,
  RECORD: ReticleTool.RECORD,
  FLOW_SAVE: ReticleTool.FLOW_SAVE,
  FINISH: FINISH_TOOL.name,
} as const;

/** The synthetic option meaning "stop driving". Not a tool arg — a key in the choice set. */
const FINISH_OPTION = 'finish';
/** The synthetic option meaning "I cannot tell from this page; look again". */
const RELOOK_OPTION = 'look_again';

/**
 * How many interactive elements may go into one choice set.
 *
 * Not a token budget — Jev prices the state, and 44 candidates measured at 1,421 input tokens, which
 * is noise. It is a QUALITY bound: a list of two hundred near-identical row links is a page where the
 * useful next action is a control, not a row, and offering all of them mostly buys ties. Document
 * order is kept, so the controls a page puts first stay in.
 */
const MAX_CANDIDATES = 40;

/** Above this, `journey_complete` is taken as a yes. Deliberately high — finishing early loses coverage. */
const COMPLETE_THRESHOLD = 0.7;

/**
 * Turns held back at the end of the budget to stop recording, save the flow and finish.
 *
 * Without this the driver spends every step exploring and the run ends on BUDGET with `savedFlows`
 * empty — which is not a cheap drive, it is a drive that produced nothing. Measured before the
 * reserve existed: 24 steps, a real journey driven through a real app, and no flow at the end of it,
 * because the teardown never got a turn. A saved flow is the entire product of an explore, so the
 * last three turns are not negotiable and the exploring gets what is left.
 */
const TEARDOWN_TURNS = 3;

/**
 * The consequences the driver can declare, and the predicate each one becomes.
 *
 * Declaring one is not optional decoration — it is the difference between a drive and a click. The
 * first version of this driver emitted `act_and_wait` with no `until` at all, and the engine said
 * so in every single result: "the page settled and no channel reported a problem, but nothing was
 * declared to prove — this is not verification". Six actions, zero proved. A flow recorded from that
 * drive passes even when the feature is broken, which is the exact failure this product exists to
 * catch, sitting inside the thing meant to catch it.
 *
 * Every predicate here is BARE — a kind with no specifics — because before acting the driver does
 * not know which endpoint, signal or route to expect. Bare is still consequence-grade evidence: it
 * asserts the app's own machinery moved, which a presence check on screen text does not.
 *
 * Only SIGNAL and NET can be declared bare, and that is a fact about the engine rather than a
 * preference. `engine/src/evidence/already-true.ts` lists the kinds that read live state — element,
 * text, route and state — and those are checked BEFORE the action as well as after, precisely so a
 * condition that already held cannot be sold as something the action caused. A bare predicate of
 * one of those kinds is unconditionally true: there is always a current route, and there is always
 * some store. That file says so in as many words at its `ROUTE` case.
 *
 * This driver tried all four anyway and the engine refused all four, every time, with
 * `already_true` — "the declared consequence was already true before this action, so it proves
 * nothing about it". Signal and net are event-based and floored at the act's own cursor, so they
 * cannot be answered by the past, which is exactly what makes them safe to declare with no
 * specifics. Route and state come back the moment the driver can name a pathname or a store path
 * instead of a bare kind, and they are the stronger evidence when it can.
 *
 * `anyOf` is not a loophole: it reports as live-reading if ANY branch does, so it holds only the
 * two safe kinds for the same reason.
 *
 * ponytail: bare `net` can in principle be satisfied by unrelated traffic inside the action's
 * window — a page polling every second would answer for a button that did nothing. The window is
 * the action's own, not "ever", so the exposure is small but real. The upgrade is to learn the
 * app's vocabulary first (one `reticle_observe` early in the drive gives the actual signal names
 * and endpoint paths) and declare `urlContains`/`name` instead of a bare kind. Until then `state`
 * and `signal` are the trustworthy ones and `net` is the one to distrust on a chatty app.
 */
const CONSEQUENCES = {
  signal: {
    predicate: { kind: 'signal' },
    describes: 'The app fires one of its own signals (the strongest evidence it did something).',
  },
  net: {
    predicate: { kind: 'net' },
    describes: 'The app sends a request to its backend — expect this for anything that saves.',
  },
  any: {
    predicate: { kind: 'anyOf', predicates: [{ kind: 'signal' }, { kind: 'net' }] },
    describes: 'Something the app owns moves, but which one is not predictable from here.',
  },
} as const;

/**
 * Declaring nothing, named so it can be CHOSEN rather than defaulted to.
 *
 * A control that genuinely changes nothing observable — opening a menu, focusing a field — should
 * be recorded as such, not given an expectation it will fail. The verdict then comes back
 * `no-fault`, which is honest: nothing was claimed, so nothing was proved.
 */
const NO_CONSEQUENCE = 'nothing';

/** Roles that want text typed into them rather than clicked. */
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);
/** Roles that toggle. */
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch']);

interface JevAnswerChoice {
  choice?: string;
  confidence?: number;
}
interface JevAnswerNoul {
  noul?: number;
}
interface JevResponse {
  answers?: Record<string, JevAnswerChoice & JevAnswerNoul>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevDriverOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * The loop's step budget, so the driver can stop exploring in time to save what it drove.
   *
   * The loop does not tell a driver how much budget is left — it does not have to, because a
   * generating model is expected to call `finish` when it is ready. This driver has a teardown it
   * must reach, so it needs the number. Absent ⇒ no reserve, and a run that ends on BUDGET keeps
   * nothing, which is why every caller inside the repo passes it.
   */
  maxSteps?: number;
  /** What to call the recording, and so the saved flow. Defaults to `harness-drive`. */
  recordingName?: string;
  /** Injected for tests. Defaults to the platform `fetch`. */
  fetch?: HarnessFetch;
}

/**
 * Read this driver's configuration out of the environment.
 *
 * A direct Jev key wins over the platform key, so that someone debugging the upstream is never
 * quietly talking to the proxy they were trying to bypass. Returns `undefined` when neither is set,
 * which is a routine answer and not a failure — the caller falls back to the Anthropic driver.
 */
export function jevOptionsFromEnv(
  env: Record<string, string | undefined>,
): JevDriverOptions | undefined {
  const direct = env[ReticleEnv.HARNESS_JEV_KEY];
  if (direct !== undefined && 0 < direct.length) {
    const baseUrl = env[ReticleEnv.HARNESS_JEV_URL];
    return {
      apiKey: direct,
      ...(baseUrl === undefined || 0 === baseUrl.length ? {} : { baseUrl }),
    };
  }
  // The ordinary path: the key the user minted on the platform, against the platform's own proxy.
  // Reticle never ships a Jev key, so without a base URL to send it to this is not a usable driver.
  const cloudKey = env[ReticleEnv.CLOUD_KEY];
  const cloudUrl = env[ReticleEnv.CLOUD_URL];
  if (cloudKey === undefined || 0 === cloudKey.length) return undefined;
  if (cloudUrl === undefined || 0 === cloudUrl.length) return undefined;
  return { apiKey: cloudKey, baseUrl: cloudUrl };
}

/** Strip the snapshot's list marker, so a description reads as a phrase rather than a bullet. */
function cleanDesc(desc: string): string {
  return desc.replace(/^-\s*/, '').trim();
}

/** The role is the first word of a snapshot line: `- textbox "Card number"`. */
function roleOf(desc: string): string {
  return cleanDesc(desc).split(/\s+/)[0]?.toLowerCase() ?? '';
}

/** The accessible name, which the snapshot quotes. */
function nameOf(desc: string): string {
  return /"([^"]*)"/.exec(desc)?.[1] ?? '';
}

/**
 * What to type into a field, chosen from its label.
 *
 * A System One model answers questions; it does not write strings, so the value cannot come from it.
 * That is less of a loss than it sounds: an exploration drive needs PLAUSIBLE input, not creative
 * input — the engine is judging what the app did with the value, not the value. A field that rejects
 * everything here is itself worth finding, and shows up as an act that did not settle.
 */
function fillValueFor(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('email')) return 'harness@reticle.dev';
  if (l.includes('password')) return 'password';
  if (l.includes('url') || l.includes('link')) return 'https://example.com';
  if (l.includes('phone') || l.includes('tel')) return '5550100';
  if (l.includes('date')) return '2026-01-01';
  if (l.includes('amount') || l.includes('price') || l.includes('qty') || l.includes('quantity'))
    return '2';
  if (l.includes('search') || l.includes('filter')) return 'a';
  if (l.includes('number') || l.includes('count')) return '42';
  return 'reticle harness';
}

/** The action verb a role wants. */
function actionFor(role: string): string {
  if (TEXT_ROLES.has(role)) return 'fill';
  if (TOGGLE_ROLES.has(role)) return 'check';
  return 'click';
}

interface Candidate {
  ref: string;
  desc: string;
  role: string;
}

/** What the history says has happened so far, reduced to the few facts the next call depends on. */
interface DriveState {
  recording: boolean;
  recordStopped: boolean;
  flowSaved: boolean;
  /** The most recent snapshot tree, or undefined when the last thing we did was change the page. */
  tree: string | undefined;
  /** The name recording started under, so the stop and the save agree with it. */
  name: string | undefined;
  /** Every action already driven, so the choice set can prefer something new. */
  acted: string[];
  /** Turns the loop has spent. The budget is counted in turns, so this must be too. */
  turns: number;
}

/**
 * Derive the drive's state from the history the loop hands us.
 *
 * Deliberately derived rather than held in a closure. The loop owns what gets remembered — it does
 * the truncation and the budget — so a driver that kept its own parallel copy would have two
 * versions of the same fact and no rule for which one is right when a turn is retried or dropped.
 */
function readState(history: readonly HistoryEntry[]): DriveState {
  const state: DriveState = {
    recording: false,
    recordStopped: false,
    flowSaved: false,
    tree: undefined,
    name: undefined,
    acted: [],
    turns: 0,
  };
  for (const entry of history) {
    if ('tool' !== entry.role) continue;
    state.turns += 1;
    for (const outcome of entry.outcomes) {
      if (Tool.RECORD === outcome.name) {
        const args = asRecord(outcome.args);
        const started = args['recordingName'];
        if ('start' === args['action'] && !outcome.isError) {
          state.recording = true;
          if ('string' === typeof started) state.name = started;
        }
        if ('stop' === args['action']) state.recordStopped = true;
      }
      if (Tool.FLOW_SAVE === outcome.name && !outcome.isError) state.flowSaved = true;
      if (Tool.SNAPSHOT === outcome.name && !outcome.isError) {
        const tree = asRecord(outcome.result)['tree'];
        if ('string' === typeof tree) state.tree = tree;
      }
      if (Tool.ACT_AND_WAIT === outcome.name) {
        const ref = asRecord(outcome.args)['ref'];
        if ('string' === typeof ref) state.acted.push(ref);
        // The page has almost certainly moved; the tree we hold describes a page that is gone.
        state.tree = undefined;
      }
    }
  }
  return state;
}

/** Build the choice set: every interactive element on the page, plus the two synthetic options. */
function candidatesFrom(tree: string): Candidate[] {
  return parseInteractive(tree)
    .filter((item) => 0 < item.ref.length)
    .slice(0, MAX_CANDIDATES)
    .map((item) => ({ ref: item.ref, desc: cleanDesc(item.desc), role: roleOf(item.desc) }));
}

/**
 * The state Jev reads.
 *
 * It is the standing instruction, what has been driven, and the page — in that order, because the
 * question is always "what next, given where we are". Kept as plain lines rather than JSON: the
 * snapshot is already a line-per-element format a reader can follow, and wrapping it in braces costs
 * tokens to say nothing.
 */
function buildState(system: string, history: readonly HistoryEntry[], drive: DriveState): string {
  const goal = history.find((entry) => 'user' === entry.role)?.text ?? '';
  const driven =
    0 === drive.acted.length
      ? ' (nothing yet)'
      : `\n${drive.acted.map((r, i) => ` ${i + 1}. acted on ${r}`).join('\n')}`;
  return [
    system,
    '',
    `OPENING INSTRUCTION: ${goal}`,
    `ACTIONS DRIVEN SO FAR:${driven}`,
    '',
    'CURRENT PAGE (interactive elements only):',
    drive.tree ?? '(not looked at yet)',
  ].join('\n');
}

/** One POST. Narrowed at the boundary rather than trusted, same as the Anthropic driver does. */
async function callJev(
  options: Required<Pick<JevDriverOptions, 'apiKey'>> & {
    model: string;
    baseUrl: string;
    doFetch: HarnessFetch;
  },
  state: string,
  questions: Record<string, unknown>,
): Promise<JevResponse> {
  const res = await options.doFetch(`${options.baseUrl}${SYSTEMONE_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ state, model: options.model, questions }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`jev ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as JevResponse;
}

/**
 * The recording, and so the flow, this drive writes.
 *
 * A System One model cannot supply a name, so one is chosen here. It was briefly minted from a
 * module-level counter, which is wrong in the one place this code actually runs: a daemon is
 * long-lived and drives more than once, so the counter was shared between drives that know nothing
 * about each other, and the name a drive used depended on how many drives had happened before it in
 * that process. The name now comes from the drive's own history when there is one, and otherwise
 * from the caller — no globals, no clock, and the same history always yields the same name.
 */
const DEFAULT_RECORDING_NAME = 'harness-drive';

/**
 * Build a driver backed by a System One model.
 *
 * Every turn emits exactly ONE call. The loop dispatches a turn's calls with `Promise.all`, so an
 * act and the snapshot that reads its result cannot be batched into one turn — they would race, and
 * the snapshot would describe a page mid-flight. One call per turn costs a step and buys a reading
 * that is actually of the page the action produced.
 */
export function jevDriver(options: JevDriverOptions): ModelDriver {
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const baseUrl = options.baseUrl ?? DEFAULT_JEV_BASE_URL;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const chosenName = options.recordingName ?? DEFAULT_RECORDING_NAME;
  const budget = options.maxSteps;
  // Tool-call ids only have to be unique within a turn, and this driver emits one call per turn.
  // A per-instance counter is therefore enough, and it keeps the clock out of pure logic.
  let callSeq = 0;

  const only = (call: ToolRequest, text: string, usage?: ModelTurn['usage']): ModelTurn => ({
    text,
    calls: [call],
    ...(usage === undefined ? {} : { usage }),
  });
  const request = (tool: string, args: Record<string, unknown>): ToolRequest => {
    callSeq += 1;
    return { id: `jev-${String(callSeq)}-${tool}`, name: tool, args };
  };

  return {
    async turn(input): Promise<ModelTurn> {
      const drive = readState(input.history);
      // The name recording actually started under wins over the one we would have picked, so the
      // stop and the save can never address a recording that does not exist.
      const name = drive.name ?? chosenName;

      // ── deterministic scaffolding ────────────────────────────────────────────────────────────
      // These four steps have exactly one right answer, so asking a model would spend a call to be
      // told what the code already knows. The model is only consulted where there is a real choice.
      if (!drive.recording && !drive.recordStopped)
        return only(
          request(Tool.RECORD, { action: 'start', recordingName: name }),
          'start recording the journey',
        );

      if (drive.recordStopped && !drive.flowSaved)
        return only(
          // `intent` is not decoration. A flow saved without one still replays, but when it goes red
          // the report can only name the step that broke, not the thing that stopped being true.
          request(Tool.FLOW_SAVE, {
            flowName: name,
            intent: `Autonomous coverage drive: ${String(drive.acted.length)} actions through the app.`,
          }),
          'save the recorded journey',
        );

      if (drive.recordStopped && drive.flowSaved)
        return only(
          request(Tool.FINISH, {
            summary: `Drove ${String(drive.acted.length)} actions and saved ${name}.`,
          }),
          'done',
        );

      if (drive.tree === undefined)
        return only(request(Tool.SNAPSHOT, { mode: 'interactive' }), 'look at the page');

      // Out of budget to explore: bank what has been driven rather than spend the last turns on one
      // more click nobody will ever be able to replay.
      if (budget !== undefined && drive.turns >= budget - TEARDOWN_TURNS)
        return only(
          request(Tool.RECORD, { action: 'stop', recordingName: name }),
          'out of budget to explore; stop recording and save what was driven',
        );

      // ── the one real decision ────────────────────────────────────────────────────────────────
      const candidates = candidatesFrom(drive.tree);
      if (0 === candidates.length)
        return only(
          request(Tool.RECORD, { action: 'stop', recordingName: name }),
          'nothing interactive here; stop recording',
        );

      const criteria: Record<string, string> = {
        [FINISH_OPTION]:
          'Stop driving: the app has been covered, or nothing here leads anywhere new.',
        [RELOOK_OPTION]:
          'Look at the page again without acting, because this reading looks incomplete.',
      };
      for (const candidate of candidates) {
        const verb = actionFor(candidate.role);
        const already = drive.acted.includes(candidate.ref) ? ' (already driven once)' : '';
        criteria[candidate.ref] = `${verb} the ${candidate.desc}${already}`;
      }

      const response = await callJev(
        { apiKey: options.apiKey, model, baseUrl, doFetch },
        buildState(input.system, input.history, drive),
        {
          next_action: {
            type: 'choice',
            instructions:
              'Which single action best advances coverage of this application right now? Prefer a control that completes a real user journey, and prefer something not already driven.',
            criteria,
          },
          journey_complete: {
            type: 'noul',
            instructions:
              'The application has been meaningfully covered by the actions driven so far, and further clicking would add nothing.',
          },
        },
      );

      const usage: ModelTurn['usage'] = {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      const chosen = response.answers?.['next_action']?.choice ?? FINISH_OPTION;
      const complete = response.answers?.['journey_complete']?.noul ?? 0;

      if (FINISH_OPTION === chosen || COMPLETE_THRESHOLD < complete)
        return only(
          request(Tool.RECORD, { action: 'stop', recordingName: name }),
          'journey covered; stop recording',
          usage,
        );

      if (RELOOK_OPTION === chosen)
        return only(request(Tool.SNAPSHOT, { mode: 'interactive' }), 'look again', usage);

      const picked = candidates.find((candidate) => candidate.ref === chosen);
      if (picked === undefined)
        // Jev answers with one of the keys it was given, so this is unreachable by construction —
        // but a driver that trusted that and was wrong would emit a call naming an element that is
        // not on the page, which is precisely the failure this driver exists to make impossible.
        return only(
          request(Tool.SNAPSHOT, { mode: 'interactive' }),
          'unrecognised choice; look again',
          usage,
        );

      const action = actionFor(picked.role);

      // A SECOND call, deliberately. Jev answers every question in one pass and the answers are
      // independent, so "what should I expect from the element I am about to choose" cannot be
      // asked in the same breath as "which element". It costs another ~350ms and ~$0.00004, and it
      // costs nothing from the STEP budget, which is what is actually scarce here.
      const expectation = await callJev(
        { apiKey: options.apiKey, model, baseUrl, doFetch },
        `${buildState(input.system, input.history, drive)}\n\nABOUT TO: ${action} ${picked.desc}`,
        {
          expected_consequence: {
            type: 'choice',
            instructions:
              'If this action works, what should the application itself be observed to do? Name the consequence you would check for. Choose `nothing` only for a control that genuinely changes nothing observable, such as focusing a field.',
            criteria: {
              ...Object.fromEntries(
                Object.entries(CONSEQUENCES).map(([key, value]) => [key, value.describes]),
              ),
              [NO_CONSEQUENCE]: 'Nothing observable should change.',
            },
          },
        },
      );
      const expected = expectation.answers?.['expected_consequence']?.choice ?? NO_CONSEQUENCE;
      const consequence = CONSEQUENCES[expected as keyof typeof CONSEQUENCES];

      const args: Record<string, unknown> = {
        ref: picked.ref,
        action,
        // The element's own description, so the drive reads back as a journey rather than as refs.
        // A ref is a handle that expired when the page changed; this survives being read tomorrow.
        intent: `${action} ${picked.desc}`,
        ...(consequence === undefined ? {} : { until: consequence.predicate }),
      };
      if ('fill' === action) args['args'] = { value: fillValueFor(nameOf(picked.desc)) };

      const spent: ModelTurn['usage'] = {
        input: usage.input + (expectation.usage?.input_tokens ?? 0),
        output: usage.output + (expectation.usage?.output_tokens ?? 0),
        cacheRead: 0,
        cacheWrite: 0,
      };
      return only(
        request(Tool.ACT_AND_WAIT, args),
        `${action} ${picked.desc}, expecting ${expected}`,
        spent,
      );
    },
  };
}
