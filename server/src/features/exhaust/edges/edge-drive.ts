/**
 * Edge cases, driven: the inputs and the interaction orders the plain explorer never tries, run on
 * the states it found, and judged by the checks in `invariants.ts`.
 *
 * The order is the order defects are found in. Controls whose click sent a write come first: a
 * submit pressed twice and a double click on them, then a reload after their write. Edge-case
 * values for each field come next, one round across every field before the next value of any field.
 * Controls that only read come after, then the rest of the sequences, then cancel controls.
 *
 * Each probe replays its state from a fresh start page, so the budget buys whole probes in that
 * order and the caller keeps it apart from exploration's. Deterministic: the same states, port and
 * clock give the same probes in the same order.
 */

import {
  EdgeAction,
  EdgeInteraction,
  edgeInputs,
  edgeInteractions,
  looksLikeSubmit,
  type EdgeStep,
  type FieldSpec,
} from '../edge-cases.js';
import type { ActResult, ExploredSurface, ExplorePort, Step } from '../explorer.js';
import {
  checkDeterministic,
  checkReloadKeeps,
  checkRepeat,
  checkUndo,
  type PageObservation,
  type WriteObservation,
} from '../invariants.js';
import type { BehaviourFinding } from '../ledger.js';
import { faultsOf, runEdge, shownVsSent, type EdgeDriver, type EdgeRun } from './edge-run.js';

/** Edge-case values per field. `edgeInputs` puts the most telling first. */
export const VALUES_PER_FIELD = 6;
/** A value shorter than this is found on almost any page, so its absence after a reload says nothing. */
const MIN_KEPT_VALUE = 3;
const CANCEL = /^button\s+"(?:cancel|close|undo|dismiss)\b/i;
const FIELD_LINE = /^\s*-?\s*(?:textbox|searchbox|spinbutton|combobox)\b/;
const SETTLE: EdgeStep = { action: EdgeAction.SETTLE };
const OK_MIN = 200;
const OK_END = 300;

export interface EdgeReport {
  /** Controls whose edge cases were driven. */
  probed: string[];
  /** Each finding, with the control it is about. */
  found: { control: string; finding: BehaviourFinding }[];
  actions: number;
  /** True when the budget ran out before every probe was driven. */
  budgetExhausted: boolean;
  /** Probes stopped by an error from the page. They drove nothing that is reported. */
  failed: number;
}

export interface EdgeOptions {
  maxActions: number;
  now: () => number;
  wait?: () => Promise<void>;
  /** Faults the explorer already reported, as `control\nkind`. An edge case does not report them again. */
  known?: Iterable<string>;
}

interface Target {
  surface: ExploredSurface;
  control: string;
  writes: boolean;
}

interface Probe {
  control: string;
  /** True when it drove the control. */
  run: () => Promise<boolean>;
}

const click = (key: string): EdgeStep => ({ action: EdgeAction.CLICK, key });

/** Each control that sends a request or looks like a submit, once, on the first state it is on. */
function targetsOf(surfaces: readonly ExploredSurface[]): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const surface of surfaces) {
    for (const control of surface.order) {
      if (seen.has(control) || (!surface.requests.includes(control) && !looksLikeSubmit(control))) {
        continue;
      }
      seen.add(control);
      out.push({ surface, control, writes: surface.writes.includes(control) });
    }
  }
  return out;
}

/** A field's spec from its control key and the attributes the page gave. */
export function specOf(control: string, attrs: Record<string, string> = {}): FieldSpec {
  const [, role = '', name] = /^(\S+)(?:\s+"([^"]*)")?/.exec(control) ?? [];
  const count = (raw: string | undefined): number | undefined => {
    const n = Number(raw);
    return raw === undefined || !Number.isInteger(n) ? undefined : n;
  };
  const optional: Record<string, string | number | undefined> = {
    name,
    type: attrs['type'],
    inputMode: attrs['inputmode'],
    min: attrs['min'],
    max: attrs['max'],
    pattern: attrs['pattern'],
    maxLength: count(attrs['maxlength']),
    minLength: count(attrs['minlength']),
  };
  const spec: FieldSpec = { role, required: attrs['required'] !== undefined };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) {
      Object.assign(spec, { [key]: value });
    }
  }
  return spec;
}

/** The writes in `twice` beyond those `once` sent: a second request to the same endpoint. */
function extraWrites(
  twice: readonly WriteObservation[],
  once: readonly WriteObservation[],
): WriteObservation[] {
  const left = [...once];
  return twice.filter((w) => {
    const index = left.findIndex((o) => o.key === w.key);
    if (index < 0) {
      return true;
    }
    left.splice(index, 1);
    return false;
  });
}

const shownOutsideFields = (page: PageObservation, value: string): boolean =>
  page.tree.split('\n').some((line) => !FIELD_LINE.test(line) && line.includes(value));

const sourceOf = (run: EdgeRun): { source?: { file: string; line: number } } =>
  run.source === undefined ? {} : { source: run.source };

export async function driveEdges(
  port: ExplorePort,
  surfaces: readonly ExploredSurface[],
  opts: EdgeOptions,
): Promise<EdgeReport> {
  let actions = 0;
  let failed = 0;
  const spent = (): boolean => actions >= opts.maxActions;
  const known = new Set(opts.known ?? []);
  const found: EdgeReport['found'] = [];
  const probed = new Set<string>();
  const driver: EdgeDriver = {
    port,
    act: (ref, action, value, actOpts): Promise<ActResult> => {
      actions += 1;
      return port.act(ref, action, value, actOpts);
    },
    move: (action) => {
      const move = EdgeAction.BACK === action ? port.back : port.reload;
      if (move === undefined) {
        return Promise.resolve(false);
      }
      actions += 1;
      return move();
    },
    spent,
    ...(opts.wait === undefined ? {} : { wait: opts.wait }),
  };

  const report = (control: string, findings: readonly BehaviourFinding[]): void => {
    for (const finding of findings) {
      found.push({ control, finding });
    }
  };
  /** Run, report the faults any run can show, and hand the run to `judge` for the rest. */
  const probe = async (
    target: { surface: ExploredSurface; control: string },
    steps: readonly EdgeStep[],
    shown: readonly EdgeStep[],
    judge: (run: EdgeRun) => BehaviourFinding[] = () => [],
  ): Promise<EdgeRun | undefined> => {
    const run = await runEdge(driver, target.surface.path, steps);
    if (run !== undefined) {
      report(target.control, [
        ...faultsOf(run, target.control, shown, known),
        ...shownVsSent(run, shown),
        ...judge(run),
      ]);
    }
    return run;
  };
  const baselines = new Map<string, EdgeRun | undefined>();
  /** The control pressed once after its fills, with a settle before the press. */
  const baseline = async (t: Target): Promise<EdgeRun | undefined> => {
    if (!baselines.has(t.control)) {
      const steps = [...t.surface.fills, SETTLE, click(t.control)];
      baselines.set(t.control, await probe(t, steps, [...t.surface.fills, click(t.control)]));
    }
    return baselines.get(t.control);
  };
  const sequence = (t: Target, kind: EdgeInteraction): EdgeStep[] | undefined => {
    const seq = edgeInteractions({
      control: t.control,
      order: t.surface.order,
      fills: t.surface.fills,
    }).find((s) => s.kind === kind);
    if (seq === undefined) {
      return undefined;
    }
    // The two submit sequences place the fills themselves; every other one starts from a filled form.
    const own =
      EdgeInteraction.SUBMIT_TWICE === kind || EdgeInteraction.SUBMIT_BEFORE_FILL === kind;
    return own ? seq.steps : [...t.surface.fills, ...seq.steps];
  };

  const submitTwice = async (t: Target): Promise<boolean> => {
    const shown = sequence(t, EdgeInteraction.SUBMIT_TWICE);
    if (shown === undefined) {
      return false;
    }
    const fills = t.surface.fills.length;
    const steps = [...shown.slice(0, fills), SETTLE, ...shown.slice(fills)];
    const run = await probe(t, steps, shown, (r) =>
      checkRepeat({
        before: r.marks[0] ?? r.before,
        afterFirst: r.marks[1] ?? r.after,
        afterSecond: r.after,
        firstWrites: r.writes[1] ?? [],
        secondWrites: r.writes[2] ?? [],
        steps: shown,
        ...sourceOf(r),
      }),
    );
    return run !== undefined;
  };

  /** Pressed back to back, against a run pressed once. Only writes the single press did not send count. */
  const repeated = async (t: Target, kind: EdgeInteraction): Promise<boolean> => {
    const shown = sequence(t, kind);
    const once = await baseline(t);
    if (shown === undefined || once === undefined) {
      return false;
    }
    const fills = t.surface.fills.length;
    const steps = [...shown.slice(0, fills), SETTLE, ...shown.slice(fills)];
    const run = await probe(t, steps, shown, (r) =>
      checkRepeat({
        before: once.marks[0] ?? once.before,
        afterFirst: once.after,
        afterSecond: r.after,
        firstWrites: once.writes[1] ?? [],
        secondWrites: extraWrites(r.writes[1] ?? [], once.writes[1] ?? []),
        steps: shown,
        ...sourceOf(r),
      }),
    );
    return run !== undefined;
  };

  /** A write, a settle, then a reload: every value the saved page showed must still be there. */
  const reloadKeeps = async (t: Target): Promise<boolean> => {
    const shown = [...t.surface.fills, click(t.control)];
    const steps = [...shown, SETTLE, { action: EdgeAction.RELOAD } as const];
    const run = await probe(t, steps, shown, (r) => {
      const saved = r.marks[0];
      const ok = (r.writes[0] ?? []).some(
        (w) => w.status !== undefined && w.status >= OK_MIN && w.status < OK_END,
      );
      if (saved === undefined || !ok) {
        return [];
      }
      return t.surface.fills.flatMap((fill) => {
        const value = (fill.value ?? '').trim();
        if (value.length < MIN_KEPT_VALUE || !shownOutsideFields(saved, value)) {
          return [];
        }
        return checkReloadKeeps({ value, afterReload: r.after, steps: shown, ...sourceOf(r) });
      });
    });
    return run !== undefined;
  };

  const deterministic = async (t: Target): Promise<boolean> => {
    const once = await baseline(t);
    if (once === undefined) {
      return false;
    }
    const shown = [...t.surface.fills, click(t.control)];
    const run = await probe(t, [...t.surface.fills, SETTLE, click(t.control)], shown, (r) =>
      checkDeterministic({ first: once.after, second: r.after, steps: shown, ...sourceOf(r) }),
    );
    return run !== undefined;
  };

  const plain = async (t: Target, kind: EdgeInteraction): Promise<boolean> => {
    const steps = sequence(t, kind);
    return steps !== undefined && (await probe(t, steps, steps)) !== undefined;
  };

  /** One edge value in one field, the other fields as the explorer filled them, then the submit. */
  const edgeInput = async (
    surface: ExploredSurface,
    submit: string,
    field: string,
    value: string,
  ): Promise<boolean> => {
    const fill: Step = { key: field, action: EdgeAction.FILL, value };
    // A pre-filled field is not among the explorer's fills: it gets its fill after them.
    const fills = surface.fills.some((f) => f.key === field)
      ? surface.fills.map((f) => (f.key === field ? fill : f))
      : [...surface.fills, fill];
    const steps = [...fills, click(submit)];
    return (await probe({ surface, control: field }, steps, steps)) !== undefined;
  };

  /** A cancel on a dialog: the page after it must be the page before the dialog opened. */
  const undo = async (surface: ExploredSurface, cancel: string): Promise<boolean> => {
    const open = surface.path.at(-1);
    if (open === undefined || EdgeAction.CLICK !== open.action) {
      return false;
    }
    const shown = [click(open.key), click(cancel)];
    const run = await runEdge(driver, surface.path.slice(0, -1), [
      click(open.key),
      SETTLE,
      click(cancel),
    ]);
    if (run === undefined) {
      return false;
    }
    // Only a dialog: a cancel that leaves for another page loads it fresh, and a fresh page is
    // not the page the user left.
    if (run.marks[0]?.route === run.before.route) {
      report(
        cancel,
        checkUndo({ before: run.before, after: run.after, steps: shown, ...sourceOf(run) }),
      );
    }
    report(cancel, faultsOf(run, cancel, shown, known));
    return true;
  };

  const targets = targetsOf(surfaces);
  const writers = targets.filter((t) => t.writes);
  const readers = targets.filter((t) => !t.writes);
  const probes: Probe[] = [];
  const add = (control: string, run: () => Promise<boolean>): void => {
    probes.push({ control, run });
  };
  for (const t of writers) {
    add(t.control, () => submitTwice(t));
    add(t.control, () => repeated(t, EdgeInteraction.DOUBLE_ACTIVATION));
  }
  for (const t of writers) {
    add(t.control, () => reloadKeeps(t));
  }
  const inputs = surfaces.flatMap((surface) => {
    const submit =
      surface.writes[0] ?? surface.requests[0] ?? surface.order.find((c) => looksLikeSubmit(c));
    if (submit === undefined) {
      return [];
    }
    return surface.fields.map((field) => ({
      surface,
      submit,
      field,
      values: edgeInputs(specOf(field, surface.attrs[field]), {
        now: opts.now,
        max: VALUES_PER_FIELD,
      }),
    }));
  });
  for (let round = 0; round < VALUES_PER_FIELD; round += 1) {
    for (const i of inputs) {
      const edge = i.values[round];
      if (edge !== undefined) {
        add(i.field, () => edgeInput(i.surface, i.submit, i.field, edge.value));
      }
    }
  }
  for (const t of readers) {
    add(t.control, () => repeated(t, EdgeInteraction.DOUBLE_ACTIVATION));
    add(t.control, () => deterministic(t));
  }
  for (const t of targets) {
    add(t.control, () => repeated(t, EdgeInteraction.RAPID_REPEAT));
    add(t.control, () => plain(t, EdgeInteraction.ACT_THEN_BACK));
    add(t.control, () => plain(t, EdgeInteraction.SUBMIT_BEFORE_FILL));
    add(t.control, () => plain(t, EdgeInteraction.OUT_OF_ORDER));
  }
  for (const surface of surfaces) {
    for (const cancel of surface.order.filter((c) => CANCEL.test(c))) {
      add(cancel, () => undo(surface, cancel));
    }
  }

  for (const p of probes) {
    if (spent()) {
      break;
    }
    try {
      if (await p.run()) {
        probed.add(p.control);
      }
    } catch {
      failed += 1;
    }
  }
  return {
    probed: [...probed],
    found,
    actions,
    budgetExhausted: spent(),
    failed,
  };
}
