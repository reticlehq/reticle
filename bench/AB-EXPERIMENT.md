# A/B experiment — does Iris produce a better one-shot app?

> A reusable, measurable protocol to test whether an Iris-equipped agent ships a more _correct_ app in
> a single shot. Companion to `EMERGENT-COMPARISON.md` (the conceptual comparison) and `METHODOLOGY.md`
> (fairness controls). Honest by design — the constraint and the confounds are stated up front.

## The constraint (read first)

You **cannot inject the Iris skill into Emergent's generation loop** — Emergent is a captive platform
that builds with its own agents (E3) + built-in QA. So "two apps in Emergent, one with Iris, one
without" is not runnable. Choose the design by what you want to learn:

- **Design A — "does Iris help?" (recommended, clean):** same agent (Claude Code / Cursor), same prompt,
  run twice — **with** the Iris skill vs **without**. Iris is the only variable → isolates its effect.
- **Design B — "Emergent vs Iris-equipped agent" (product-level, confounded):** Emergent native (E3) vs
  Claude Code **+ Iris**, same prompt. Business-relevant, but model+platform differ from Iris, so it does
  **not** prove Iris is the cause. Use for marketing, not for a clean result.

"One-shot" = a single user prompt, no follow-ups. Both arms may self-correct _internally_ within that one
turn (Emergent's E3 and Iris both run verify/fix loops) — that's intended.

## The identical app prompt (paste verbatim into both arms)

```
Build a full-stack Expense Tracker web app (React frontend + a real backend with a
persistent database). Requirements:

1. Email/password sign-up and login. Wrong password must be rejected with a visible error.
2. A logged-in user can add an expense: amount (number), category (dropdown), note (text).
3. A new expense appears in the list immediately and persists in the database.
4. A running "Total" shows the exact sum of the visible expenses.
5. Deleting an expense removes it from the list AND updates the Total.
6. Validation: submitting with an empty or non-numeric amount shows an inline error and
   does NOT create an expense.
7. After a full page refresh, the user stays logged in and all expenses are still there.
8. Clicking "Add" once must create exactly one expense (no duplicates).

Make it actually work end to end. Do not use mock data.
```

Chosen so every requirement is a **silent-failure class** Iris targets: real persistence vs mock data,
list↔total desync, double-submit, validation, console errors.

## The Iris arm gets ONE extra line appended

```
Before telling me it's done, use Iris to verify EACH requirement against the running app:
assert the network call succeeds and fires exactly once, the store/DB actually updated, the
list and Total reflect it, and the console has no errors. Fix anything that fails, then report
exactly which requirements Iris verified as passing.
```

The control arm gets the base prompt only.

## Scorecard (score yourself against ground truth — don't trust the builder's word)

| #   | Requirement                               | How to verify objectively            | Arm A | Arm B |
| --- | ----------------------------------------- | ------------------------------------ | ----- | ----- |
| 1   | Auth works + wrong pw rejected            | try both                             | ☐     | ☐     |
| 2–3 | Add expense persists + shows              | add one, confirm present             | ☐     | ☐     |
| 4   | Total = exact sum                         | add 2–3, do the math                 | ☐     | ☐     |
| 5   | Delete updates list + total               | delete one                           | ☐     | ☐     |
| 6   | Validation blocks bad amount              | submit empty / "abc"                 | ☐     | ☐     |
| 7   | Survives refresh (real DB)                | reload, re-login                     | ☐     | ☐     |
| 8   | No double-submit                          | DevTools Network: one POST per click | ☐     | ☐     |
| —   | No console errors during all of the above | DevTools Console                     | ☐     | ☐     |

Record the two numbers that matter:

1. **Works score** — how many of 8 _actually_ pass (objective).
2. **False-green count** — how many the builder _claimed_ done/passing but actually fail. **The headline
   metric** — exactly what Iris drives to zero and the documented Emergent failure mode.
3. (Bonus) time + credits/tokens per arm.

**Hypothesis:** the Iris arm scores higher on Works and ~0 on False-green, because it caught and fixed
its own silent failures before declaring done — within the same single shot.

## Fairness controls

- Same prompt verbatim; fresh project each; no follow-up messages (one-shot).
- Same model in Design A (only the skill differs). In Design B, state plainly that model+platform differ.
- Define the 8 criteria before building; score blind if possible (a checker who didn't build it).
- Run 2–3 times per arm — single runs are noisy (LLMs are non-deterministic).
- Do **Design A first** — it's the only one that proves Iris is the cause.

## Results log (fill in)

| Date | Design | Arm | Run | Works /8 | False-green | Time | Cost | Notes |
| ---- | ------ | --- | --- | -------- | ----------- | ---- | ---- | ----- |
|      |        |     |     |          |             |      |      |       |
