---
title: Let Reticle drive
description: Hand the whole drive to a model inside the daemon, and get the flows it recorded back, so every run after the first one replays with no model in the loop.
icon: steering-wheel
---

Driving an app is the expensive part of verifying one. Every snapshot, every act result and every observation lands in your agent's context and is re-read on every turn after, and none of it is kept: the next run starts from nothing and pays again.

`reticle_verify { action: "explore" }` moves the driving into the daemon. A model there drives your app through the same tool surface your agent uses, records what it drove as saved flows, and hands back a few lines.

```jsonc
reticle_verify {
  action: "explore",
  persona: "a returning customer checking out with a saved card"
}
// → { stopReason, steps, savedFlows: ["checkout"], summary, usage }
```

From the command line, on a project with nothing recorded yet:

```bash
npx @reticlehq/server verify http://localhost:3000 --persona "an admin revoking a teammate's seat"
```

## The flows are the point

A drive costs a model. A **saved flow costs nothing to run again**: `reticle_verify { action: "flows" }` replays every one of them deterministically, with no model anywhere in the loop, and re-resolves each step's anchor and asserts its recorded consequence.

So the drive is a one-off: pay for it once, and the journeys it recorded become the regression suite every later run replays. That is why the harness is told to record as it goes, and why a drive that saved nothing is reported as having proved nothing, however long it ran.

## What it needs

`ANTHROPIC_API_KEY` in the **daemon's** environment. Without it the action refuses and says so; every other part of Reticle is unaffected. Two other dials, both optional:

| Variable | What it does |
| --- | --- |
| `RETICLE_HARNESS_MODEL` | The model that drives. Defaults to a mid-tier one on purpose, for the reason below. |
| `RETICLE_HARNESS_MAX_STEPS` | Ceiling on model turns in one drive. Bounds cost, not value. |
| `RETICLE_HARNESS_BASE_URL` | A proxy or gateway instead of the default API host. |

## What it will not do

**It does not decide whether your app is correct.** The model chooses what to _try_; the engine decides what _happened_, from what it recorded. A model that graded its own driving would be scoring its own homework, and its verdict would be unfalsifiable. So the summary it writes is an account of what it drove, and nothing downstream grades from it.

That split is also why the default model is not the largest one available. The harness is exploring an interface and stating expectations, not reasoning about your business logic. If finding defects needed a frontier model _there_, the engine would not be doing its job.

**It really clicks.** A drive navigates, submits forms and mutates state, exactly like the crawl does. Point it at a preview or a dev environment, not production.

**It is never automatic.** `reticle verify` will not drive your app unless you ask with `--explore` or `--persona`, and it never drives a project that already has saved flows. Replaying those is the cheap path, and spending a model budget to re-discover what is already recorded would be the wrong trade.

## Give it a persona

A drive with no focus clicks around. A drive with a persona completes a journey, and a journey is what turns into a flow worth replaying:

- `"a first-time user signing up and inviting a teammate"`
- `"an admin revoking a seat, then checking the seat count"`
- `"a returning customer applying an expired discount code"`

Name the outcome, not the buttons. What breaks in real products is a chain: sign up, verify, invite, join. A chain fails at whichever link nobody walked.
