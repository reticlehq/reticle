# skills/testing.md — TDD & Testing

**Open when:** before writing any feature code. (Maps to Foundation II.7.)

## The loop

UNDERSTAND → RED (failing test) → GREEN (minimum code) → REFACTOR (tests green).

Before coding, answer: valid inputs? invalid inputs (and the specific error)? boundary
conditions (at MAX, at MAX+1)? valid vs invalid state transitions? side effects?

## Runner

`vitest`. Co-locate unit tests as `*.test.ts` next to the source. `pnpm test:unit` runs
fast unit tests; integration/E2E (the bridge round-trip) run in CI.

## What Iris specifically must test

- **`@iris/protocol`**: every schema round-trips (parse(serialize(x)) === x) and rejects
  malformed messages. This is the contract — property-test it.
- **`RingBuffer`**: eviction by count and by age, `since`/`window` boundaries. **Inject
  `now`** — never let it read the clock. Deterministic tests, no fake timers.
- **Predicate engine (M2)**: each leaf predicate + combinators against synthetic event
  buffers; assert the _failure evidence_ shape, not just pass/fail.
- **Snapshot serializer (M1)**: against fixture DOM trees; stable refs across re-render.

## Mock vs fake

| Use            | When                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| **Mock**       | External boundaries we don't own (the MCP client, a site's WebMCP)            |
| **Fake**       | Our own infra — a fake in-memory transport instead of a real WS in unit tests |
| **Never mock** | Our own domain (RingBuffer, predicate engine) — test the real thing           |

## Property-based testing

Use `fast-check` (add when needed) for the protocol and predicate engine — auto-generates
adversarial inputs and shrinks failures to a minimal repro. Catches the empty-buffer,
off-by-one-cursor, and unicode-name cases unit tests miss.

## Test naming

`describe` and `it` strings must describe the observable behavior, not internal tracking
codes. Never use design-doc tags (`F1`, `N5`, `M8`, etc.) or version strings (`0.3.7`) in
test names — they mean nothing to a reader who wasn't in that planning session. Write what
the system does: `'resolves with dispatched:true when rAF never fires'` not
`'F1: settle is bounded'`. See `skills/conventions.md` for the full rule.

## Coverage ≠ correctness

Lines executed is not behavior verified. The real signal is mutation testing (`stryker`).
Don't chase a coverage number; test behavior and boundaries.

## Dogfooding

The ultimate test: point Iris at `apps/demo` and assert the 7 dashboard use cases from
`plan/ROADMAP.md`. That E2E lives in CI once M2 lands.
