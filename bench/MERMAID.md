# Does mermaid make Iris more token-efficient? (measured)

> A question came up: could representing Iris's agent-facing output as mermaid cut tokens? Rather
> than assert, we measured — a real `iris_snapshot` and a real flow verdict, each rendered in its
> native format and in a faithful mermaid equivalent, tokenized with `o200k`.

## Result

| Payload                             | native format                      | faithful mermaid                                     | mermaid vs native              |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `iris_snapshot` (161-node DOM tree) | 2000 tok (indented role/name tree) | 3607 tok (flowchart, node + parent edge per element) | **1.80× — mermaid loses**      |
| flow verdict (3 steps + drift)      | 95 tok (naive keyed JSON)          | 60 tok (stateDiagram)                                | 0.63× — mermaid wins _vs JSON_ |

## The honest read (it depends on data shape)

- **Deep/wide trees (DOM snapshots): the native indented tree wins by ~1.8×.** Indentation encodes
  hierarchy for free; mermaid must spend an explicit node id **and** an edge declaration per element.
  Switching snapshots to mermaid would be a ~80% token _regression_. Keep the tree.
- **Small graph/state-shaped data (a verdict, a route map, a state machine): mermaid beats _naive_
  JSON** — but that's a strawman. Keyed JSON repeats `"step"/"tool"/"anchor"` every row. The fair
  baseline is a terse line format, which beats mermaid too:

  ```
  verify-500 DRIFT
  0 login-submit ok
  1 nav-diagnostics ok
  2 fault-500 DRIFT testid_not_found→fault-404
  ```

  That's ~35 tokens — under mermaid's 60 and JSON's 95. Iris's real replay verdicts are already
  compact (~156–256 tok including the full envelope), so mermaid is not a win there either.

## Conclusion

**Mermaid is not a token-efficiency lever for Iris's agent-facing output.** It is a human-facing
_rendering_ syntax: its constant per-node/per-edge tax makes it denser-looking but token-heavier
than the formats Iris already uses (indented trees for structure, terse projections / TOON for
tabular data). The real levers stay what the benchmark has been pulling: lean tool defs, on-demand
loading, deterministic replay, terse default projections.

Where mermaid _is_ the right tool: **human artifacts** — the methodology diagram and the replay
flow in the docs/blog, where a person renders it. That's clarity, not token savings.

_Method: `o200k_base` (tiktoken), the same proxy used across the benchmark. The mermaid renderings
are faithful (every node + every parent-child relationship preserved), not strawmen. Reproduce by
capturing a snapshot and re-running the comparison; raw snapshot lives outside git (gitignored)._
