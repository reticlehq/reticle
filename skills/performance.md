# skills/performance.md — Performance

**Open when:** anything slow or memory-hungry. (Foundation II.3.)

## Iris's perf budget is the agent loop

look → act → assert should be **sub-second** and far cheaper (tokens) than a screenshot.
Two pressures: wall-clock latency and output token size.

## Event volume — the main risk

A busy SPA emits thousands of mutations. Defenses (all in the browser SDK):

- **Coalesce DOM mutations per animation frame.** A 200-node React re-render becomes a few
  semantic events, not 200. Never forward raw mutation records.
- **Filter at the source.** Drop style-only churn, ignore noise attributes. Emit semantic
  events only.
- **Bound everything.** `RingBuffer` caps by count and age. Body capture has a byte cap.
  No unbounded queue anywhere (Foundation: unbounded queries/queues kill prod).

## Token size — the snapshot

- Snapshots take `scope` (subtree), `mode` (`interactive`/`status`), and node/depth caps.
- `observe` returns a `summary` block first so the agent reasons over counts before pulling
  the full timeline. Filters narrow event types.

## Algorithmic hygiene

- Ref resolution / snapshot diffing must be O(n), not O(n²). Use `Map`/`Set` keyed by ref
  fingerprint — never nested `.find()` over node lists (the classic hidden O(n²)).
- String building (snapshot serialization): build an array and `join`, never `+=` in a loop.

## Don't pay for observers you don't use

Observers are independently togglable (`config.observers`). A scroll-heavy site enables the
scroll observer; a form-only flow doesn't. Off observers cost nothing.
