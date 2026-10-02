// The four flows both suite harnesses run, declared ONCE.
//
// They used to be declared twice — once in `suite-rre.mjs`, which RECORDS and saves them, and once
// in `compiled-suite-vs-replay.mjs`, which asks for them back by name. The two drifted: the
// comparison asked for `suite-console`, a flow that has never existed under any harness. Replay can
// only be handed flows that were saved, so it scored at most 3/4 by construction, while the
// Playwright arm runs its own inline steps and needs no saved flow at all — so it scored 4/4 and
// the comparison read as a defeat that was really a typo (#1074).
//
// One list, imported by both, makes that particular disagreement unsayable rather than guarded
// against. `steps` is what the recorder replays; `view`/`tap` is the same thing flattened for a
// hand-written Playwright script, derived here so the two can never say different things either.
export const SUITE_FLOWS = [
  {
    name: 'suite-500',
    steps: [{ view: 'diagnostics' }, { tap: 'fault-500' }],
    oracle: { signal: 'fault:injected' },
  },
  {
    name: 'suite-shape',
    steps: [{ view: 'diagnostics' }, { tap: 'fault-wrong-data' }],
    oracle: { signal: 'fault:injected' },
  },
  { name: 'suite-route', steps: [{ view: 'compose' }], oracle: { testid: 'compose-generate' } },
  {
    name: 'suite-404',
    steps: [{ view: 'diagnostics' }, { tap: 'fault-404' }],
    oracle: { signal: 'fault:injected' },
  },
];

/** The same flows as a compiled script sees them: one view to open, one optional control to tap. */
export const suiteSteps = () =>
  SUITE_FLOWS.map((f) => ({
    name: f.name,
    view: f.steps.find((s) => s.view !== undefined)?.view ?? null,
    tap: f.steps.find((s) => s.tap !== undefined)?.tap ?? null,
  }));
