/**
 * The `state` predicate: everything that reads a registered store.
 *
 * Split out of `predicate.ts` when it crossed the file cap, and it is a cohesive unit on its own
 * terms — one command (`STATE_READ`), one kind, and the whole scoped-vs-whole-store negotiation
 * that exists because an older SDK ignores `path` and answers with the entire store. Nothing else
 * in the predicate layer talks to that command.
 */

import { PredicateKind, ReticleCommand, capDepth, selectPath } from '@reticlehq/core';
import { matchValue, type EvalResult, type Predicate } from './predicate-eval.js';
import { satisfiesProperty, type Baseline } from './property.js';
import type { PredicateSession } from './predicate-session.js';

/** One name, or none — two candidates is a question, not an answer. */
function oneOf(names: readonly string[]): string | undefined {
  return 1 === names.length ? names[0] : undefined;
}

/**
 * `readState`'s truncation report, when the caps actually fired.
 *
 * Its PRESENCE is the warning — the field is omitted entirely on an intact read, which is what lets
 * "the list is short" stay distinguishable from "I shortened the list".
 */
function truncationOf(result: unknown): Record<string, unknown> | undefined {
  if ('object' !== typeof result || null === result) return undefined;
  const report = (result as { truncation?: unknown }).truncation;
  return 'object' === typeof report && null !== report
    ? (report as Record<string, unknown>)
    : undefined;
}

/** A scoped `readState` reply, narrowed to the shape `selectPath` would have produced. */
function asSelection(result: unknown): { found: boolean; value: unknown } | undefined {
  if ('object' !== typeof result || null === result) return undefined;
  const record = result as { found?: unknown; value?: unknown };
  return 'boolean' === typeof record.found
    ? { found: record.found, value: record.value }
    : undefined;
}

/**
 * A NAMED store needs no whole-store read. `reticle_state`'s scoped mode selects the path out of the
 * RAW store IN-PAGE and returns only it, so the assertion resolves in one round trip against a payload
 * the size of the value — not the store. The unnamed case below still needs the wide read, because
 * that is how it discovers WHICH store carries the path; only the named branch changes.
 *
 * A scoped read answers `found: false` for both "no such store" and "no such path", so the two are
 * kept distinct here using the `storeNames` list the reply always carries — otherwise the payload gets
 * cheaper while the message gets worse.
 */
async function evalStateNamed(
  session: PredicateSession,
  p: Extract<Predicate, { kind: typeof PredicateKind.STATE }>,
  storeName: string,
  baseline?: Baseline,
): Promise<EvalResult> {
  const scoped = await session.command(ReticleCommand.STATE_READ, {
    store: storeName,
    path: p.path,
  });
  if (!scoped.ok) {
    return {
      pass: false,
      failureReason: 'state read failed',
      observed: 'the store could not be read',
      expected: 'a readable registered store',
      assertion: 'state.unreadable',
    };
  }
  const reply = (scoped.result ?? {}) as {
    stores?: Record<string, unknown>;
    storeNames?: unknown;
    availableKeys?: unknown;
  };
  const names = Array.isArray(reply.storeNames) ? (reply.storeNames as string[]) : [];

  // Resolve the value. A CURRENT SDK honours the scoped read and answers `{ found, value }` selected
  // in-page — the whole point of this path. An OLDER SDK (version skew) or any transport that ignores
  // `path` answers the whole-store shape `{ stores }`; walk the path server-side there so the verdict
  // stays correct across SDK versions. The scoped win is simply unavailable on the old ones.
  const scopedSel = asSelection(scoped.result);
  const wholeStores = reply.stores;
  const scopedKeys = Array.isArray(reply.availableKeys)
    ? (reply.availableKeys as string[])
    : undefined;
  let selection: { found: boolean; value?: unknown; availableKeys?: string[] };
  if (scopedSel !== undefined) {
    selection =
      scopedKeys === undefined
        ? { found: scopedSel.found, value: scopedSel.value }
        : { found: scopedSel.found, value: scopedSel.value, availableKeys: scopedKeys };
  } else if (wholeStores !== undefined) {
    selection = selectPath(wholeStores[storeName], p.path);
  } else {
    selection = { found: false };
  }

  // "no store named X" and "X has no such path" both surface as found:false; keep them distinct using
  // the store list the reply carries, or the message regresses while the payload improves.
  const storeAbsent =
    wholeStores !== undefined
      ? !(storeName in wholeStores)
      : names.length > 0 && !names.includes(storeName);
  if (!selection.found && storeAbsent) {
    return {
      pass: false,
      failureReason: `no store named '${storeName}' is registered (${names.join(', ')})`,
      observed: `store '${storeName}' is not registered`,
      expected: `a registered store named '${storeName}'`,
      assertion: 'state.store-missing',
      evidence: { searchedStores: names },
    };
  }
  // A scoped sub-tree can itself be too big for the caps; a comparison against a value known to be
  // incomplete is an unanswered question, not a failure. Same rule the whole-store path applies.
  if (truncationOf(scoped.result) !== undefined) {
    const reason =
      `state '${p.path}' could not be read intact — the transport caps truncated it, so the ` +
      'value was never compared. Assert a narrower path, or a smaller field inside it';
    return { pass: false, failureReason: reason, inconclusive: reason };
  }
  if (!selection.found) {
    return {
      pass: false,
      failureReason: `state path '${p.path}' not found in store '${storeName}'`,
      observed: `no path '${p.path}' in store '${storeName}'`,
      expected: `store '${storeName}' to expose '${p.path}'`,
      assertion: 'state.path-missing',
      evidence: { availableKeys: selection.availableKeys },
    };
  }
  /*
   * A PROPERTY assertion runs before equality and can stand alone.
   *
   * `satisfies` is what makes a generated value verifiable at all: its exact bytes differ every run
   * and are right every time, so `equals` can only ever be wrong about it. Both may be supplied and
   * then both must hold — `satisfies` narrows, it never excuses.
   */
  if (p.satisfies !== undefined) {
    const r = satisfiesProperty(selection.value, p.satisfies, baseline);
    if (true === r.unevaluated) {
      // Nothing was compared. `pass` stays false because nothing was proven, but a false nobody
      // could have made true is not a defect in the app — it is a reading we failed to take.
      return { pass: false, failureReason: r.because, inconclusive: r.because };
    }
    if (!r.ok) {
      return {
        pass: false,
        failureReason: `state '${p.path}' ${r.because}`,
        observed: `${p.path} = ${JSON.stringify(capDepth(selection.value, 0))}`,
        expected: `${p.path} to satisfy ${p.satisfies.property}`,
        assertion: `state.${p.satisfies.property}`,
        evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
      };
    }
    if (p.equals === undefined) {
      return {
        pass: true,
        evidence: {
          store: storeName,
          path: p.path,
          value: capDepth(selection.value, 1),
          satisfied: r.because,
        },
      };
    }
  }
  const want = p.equals === undefined ? '*' : p.equals;
  if (matchValue(selection.value, want)) {
    return {
      pass: true,
      evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
    };
  }
  return {
    pass: false,
    failureReason: `state '${p.path}' is ${JSON.stringify(capDepth(selection.value, 0))}, expected ${JSON.stringify(want)}`,
    observed: `${p.path} = ${JSON.stringify(capDepth(selection.value, 0))}`,
    expected: `${p.path} = ${JSON.stringify(want)}`,
    assertion: 'state.equals',
    evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
  };
}

export async function evalState(
  session: PredicateSession,
  p: Extract<Predicate, { kind: typeof PredicateKind.STATE }>,
  baseline?: Baseline,
): Promise<EvalResult> {
  // Named store: one scoped read, no whole-store payload (issue #336).
  if (p.store !== undefined) return await evalStateNamed(session, p, p.store, baseline);
  const res = await session.command(ReticleCommand.STATE_READ, {});
  if (!res.ok) {
    return {
      pass: false,
      failureReason: 'state read failed',
      observed: 'the store could not be read',
      expected: 'a readable registered store',
      assertion: 'state.unreadable',
    };
  }
  const stores = ((res.result ?? {}) as { stores?: Record<string, unknown> }).stores ?? {};
  const names = Object.keys(stores);
  // Ambiguity is about the PATH, not the store count.
  //
  // Registering more than one store is normal — an app store, a query cache, and the render meter
  // Reticle registers itself — and asking "which of these three?" when only one of them HAS the
  // path is a question with one possible answer. It was costing a real verdict: a bench-app drive
  // asserting `{path:'view'}` returned `unknown` while the same response body carried the matching
  // `view` state diff. `unknown` is not a pass, so that is a verification that did not happen.
  //
  // So narrow to the stores that actually carry the path, and refuse only when THOSE collide.
  const candidates =
    p.store === undefined ? names.filter((n) => selectPath(stores[n], p.path).found) : [];
  const storeName = p.store ?? (1 === names.length ? names[0] : oneOf(candidates));
  if (storeName === undefined) {
    // With no store registered there is nothing to read, and with two stores that both carry the
    // path there is no way to pick — neither is a finding about the app, no assertion was evaluated,
    // so both are inconclusive rather than failed: an unevaluated predicate is never a failure.
    //
    // Zero candidates is the one case that is NOT a question: every registered store was searched
    // and none exposes the path, so the assertion cannot hold anywhere. That is the same verdict a
    // named store has always produced for a missing path, and it falls through to it below.
    if (0 === names.length) {
      const reason = 'no registered store to read state from';
      return { pass: false, failureReason: reason, inconclusive: reason };
    }
    if (candidates.length > 1) {
      // Names the stores that actually collide. Listing all of them made the reader weigh
      // candidates that could never have matched.
      const reason = `multiple stores (${candidates.join(', ')}) expose '${p.path}'; name one with \`store\``;
      return { pass: false, failureReason: reason, inconclusive: reason };
    }
    return {
      pass: false,
      failureReason: `state path '${p.path}' not found in any registered store (${names.join(', ')})`,
      observed: `no path '${p.path}' in ${names.join(', ')}`,
      expected: `some registered store to expose '${p.path}'`,
      assertion: 'state.path-missing',
      evidence: { searchedStores: names },
    };
  }
  let selection = selectPath(stores[storeName], p.path);
  // The whole-store read walks into a value the transport caps may already have mangled.
  //
  // `readState` has a SCOPED mode that selects the path out of the RAW store before sanitising, added
  // precisely so a large or deep path still resolves. This path was not using it, so a store with one
  // big collection in it truncated the small value sitting beside it, and the comparison then ran
  // against the literal string "[TRUNCATED]" and returned a confident `no`. Measured on the Atlas
  // fixture: a one-element array reported as a failed assertion while the same payload's state diffs
  // showed the assertion holding.
  //
  // Re-read only when a cap actually fired, so an intact read costs exactly what it did before.
  if (truncationOf(res.result) !== undefined) {
    const scoped = await session.command(ReticleCommand.STATE_READ, {
      store: storeName,
      path: p.path,
    });
    const result = scoped.ok ? scoped.result : undefined;
    const scopedTruncation = truncationOf(result);
    if (scopedTruncation !== undefined) {
      // Even the raw sub-tree was too big. Nothing here knows what the value IS, so nothing here can
      // say the assertion failed — that would be an accusation the evidence does not support.
      const reason =
        `state '${p.path}' could not be read intact — the transport caps truncated it, so the ` +
        'value was never compared. Assert a narrower path, or a smaller field inside it';
      return { pass: false, failureReason: reason, inconclusive: reason };
    }
    if (result !== undefined) {
      const scopedSelection = asSelection(result);
      if (scopedSelection !== undefined) selection = scopedSelection;
    }
  }
  if (!selection.found) {
    return {
      pass: false,
      failureReason: `state path '${p.path}' not found in store '${storeName}'`,
      observed: `no path '${p.path}' in store '${storeName}'`,
      expected: `store '${storeName}' to expose '${p.path}'`,
      assertion: 'state.path-missing',
      evidence: { availableKeys: selection.availableKeys },
    };
  }
  /*
   * A PROPERTY assertion runs before equality and can stand alone.
   *
   * `satisfies` is what makes a generated value verifiable at all: its exact bytes differ every run
   * and are right every time, so `equals` can only ever be wrong about it. Both may be supplied and
   * then both must hold — `satisfies` narrows, it never excuses.
   */
  if (p.satisfies !== undefined) {
    const r = satisfiesProperty(selection.value, p.satisfies, baseline);
    if (true === r.unevaluated) {
      // Nothing was compared. `pass` stays false because nothing was proven, but a false nobody
      // could have made true is not a defect in the app — it is a reading we failed to take.
      return { pass: false, failureReason: r.because, inconclusive: r.because };
    }
    if (!r.ok) {
      return {
        pass: false,
        failureReason: `state '${p.path}' ${r.because}`,
        observed: `${p.path} = ${JSON.stringify(capDepth(selection.value, 0))}`,
        expected: `${p.path} to satisfy ${p.satisfies.property}`,
        assertion: `state.${p.satisfies.property}`,
        evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
      };
    }
    if (p.equals === undefined) {
      return {
        pass: true,
        evidence: {
          store: storeName,
          path: p.path,
          value: capDepth(selection.value, 1),
          satisfied: r.because,
        },
      };
    }
  }
  const want = p.equals === undefined ? '*' : p.equals;
  if (matchValue(selection.value, want)) {
    return {
      pass: true,
      evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
    };
  }
  return {
    pass: false,
    failureReason: `state '${p.path}' is ${JSON.stringify(capDepth(selection.value, 0))}, expected ${JSON.stringify(want)}`,
    observed: `${p.path} = ${JSON.stringify(capDepth(selection.value, 0))}`,
    expected: `${p.path} = ${JSON.stringify(want)}`,
    assertion: 'state.equals',
    evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
  };
}
