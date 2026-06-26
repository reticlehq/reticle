# Human-in-the-loop control — watch, steer, end the session

When you run with the presenter on (`iris.connect({ present: true })`), the floating panel is a **two-way control surface**. You watch the agent's live transcript _and_ can steer it — pause it, send it a correction, or end the session — without leaving the page. There's also a clean, unmistakable "session ended" signal for both you and the agent.

## Watch the testing score climb (the live verdict tally)

The panel header shows a running **✓N ✗M** tally — the verdict score, live. It's hidden until the first verdict lands, then climbs as the agent verifies: every `iris_assert`, every replayed flow step, every pass/fail outcome bumps it, and the side that just grew **pops** so you _feel_ the green (or red) arrive. The cursor flies, the log streams the journey, and the score ticks up — you see the agent working and the result landing, not just a final checkmark. It persists when the session ends, so the last thing on screen is what this run actually verified. Green that's earned, not asserted.

## The constraint that shapes the design

MCP is **pull-based**: the agent only receives data when it calls a tool. Iris can't freeze the model mid-thought — but it **intercepts the agent's next tool call**, which is exactly when the agent would touch the page. That makes steering reliable:

- **Nudge** (a message, no pause) — your text is queued and rides back on the agent's **next** tool result as `guidance` (delivered once). The agent reads it and adjusts.
- **Pause** — the agent's next `iris_act` / `iris_act_and_wait` / `iris_act_sequence` **refuses to execute** and returns `{ paused: true, guidance: ["<your message>"], hint: "…" }`. The page is untouched until resume. _Read-only tools (snapshot/query/observe) still work_, so the agent can look while paused.
- **End** — the session is over; the panel shows "Session ended" and clears.

## From the panel (the human)

The floating panel (bottom-center, `present: true`) gives you:

- **Pause / Resume** — one toggle. Paused turns the panel + page border **amber** with a `PAUSED` badge.
- **Message box + send** — type a correction ("check the error state first"), hit Send (or Enter). Your message shows as a `🧑 you:` bubble in the transcript **and** is delivered to the agent.
- **End** — ends the session: panel turns **emerald**, shows `Session ended · <summary>`, then fades away.
- **Minimise (▾)** — collapse the panel to a bar that streams only the live line; click the bar to restore.
- **Flag a bug** — the button in the corner. Toggle it on, click the element that looks wrong, type what's wrong (⌘/Ctrl+Enter to send, Esc to back out). Iris pins a numbered marker, logs your flag in the panel, and hands the agent a structured mark.

## Flag a bug — annotate the mistake where you see it

You don't have to describe a bug in prose. **Point at it.** The flag captures the element's re-resolvable anchor _and_ the source `file:line` (when the framework stamped one), so the agent fixes the exact element and code — not a guess. The loop:

1. **You** flag the element and type the problem → Iris emits a `HUMAN_MARK`.
2. **The agent** drains it with `iris_review` — note + element label + `source: { file, line }` + a ready-to-act `fix` hint. `iris_sessions` also reports `pendingMarks` so the agent notices flags.
3. **The agent** opens the file, fixes it, and calls `iris_review({ resolve: "m1" })`.
4. **You** see **"✓ fixed: \<your note\>"** land in the panel. Flag → fix → confirmation.

See [`iris_review` in the usage guide](usage.md#iris_review--drain-the-bugs-the-human-flagged-on-the-page) for the tool shape. Suppress the button with `annotate: false` if you don't want it.

## From the agent (the tools)

| Tool | Args | Effect |
| --- | --- | --- |
| `iris_end_session` | `{ summary?, sessionId? }` | end the session; the panel shows "Session ended · summary" |
| `iris_resume` | `{ sessionId? }` | clear a pause and continue |
| `iris_messages` | `{ sessionId? }` | drain + read pending human messages (explicit poll) |
| `iris_review` | `{ resolve?, all?, sessionId? }` | list the bugs the human flagged; resolve one once fixed |

When paused, every action tool short-circuits with the human's guidance, so the agent learns of the pause on its very next action. The agent's expected behavior: **read the guidance, adjust the plan, then call `iris_resume`** (or wait for the human to click Resume). The agent can also end the run itself with `iris_end_session({ summary })` when it's done — either path shows the same "ended" state.

## Piggybacked guidance

Even without a pause, action/observe/assert results carry a `control` block when there's something to tell the agent:

```jsonc
{ since, dispatched, settled, result, control: { state: "active", guidance: ["looks good, keep going"] } }
```

`guidance` is drained (delivered once), so a hint never repeats. When the session is clean and the inbox empty, no `control` field is added — zero overhead on the happy path.

## Tell your agent to honor it

Add this to your operating prompt / `CLAUDE.md` (see the [Claude Code integration prompts](integrate-with-claude-code.md)):

> The human may pause you or send guidance from the Iris panel. On any `iris_act` result with `paused: true`, stop, read `guidance`, adjust, then call `iris_resume`. Treat a `control.guidance` field on any result as a live instruction from the human.
