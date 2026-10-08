---
title: Let Reticle drive
description: Hand the whole drive to the Reticle Harness on the platform, and get back the flows it recorded, so every run after the first one replays with no model in the loop.
icon: steering-wheel
---

Driving an app is the expensive part of verifying one. Every snapshot, every act result and every observation lands in your agent's context and is re-read on every turn after, and none of it is kept: the next run starts from nothing and pays again.

`reticle_verify { action: "explore" }` hands the driving to the Reticle Harness. It decides on the Reticle platform, and the daemon on your machine executes each step through the same tool surface your agent uses, records what it drove as saved flows, and hands back a few lines. It needs a linked project (`reticle connect`).

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

## It replays before it drives

A drive reads `.reticle` first: every saved flow with the consequence that must still hold, and every signal and testid your app declares that no flow has ever asserted. It builds a plan from that before it opens its eyes on a page.

With no persona, anything already recorded is **replayed**, deterministically, with no model call at all, and only the gaps are driven (see the plan below). With a persona, it drives that journey and replays nothing else: the saved flows have nothing to do with the journey you named. So a second run over the same app is mostly free, and the model budget is spent on the part nobody has proved yet rather than on rediscovering what is already on disk. A replay that goes red is reported as a regression; one that DRIFTS is reported separately, because the app moved under the recording and that needs re-anchoring rather than a code change.

Every journey a drive walks is saved, whatever happens to the drive, including one that broke, ran out of budget, or whose model simply stopped asking for tools.

## The platform plans the drive

The platform plans every drive (link the project once with `reticle connect`, or set `RETICLE_API_KEY` in CI). With a persona or without one, it proposes the people worth being, orders the saved flows, finds where they branch, and writes into each journey the product rules that apply to it, read from your project's own intents. The rules tell the Harness what the journey is for and where it ends (a journey that names Settings is not finished before Settings). They are not checked as assertions: a rule like "the row shows refunded" is guidance, and the checks are the consequences each step declares. Your machine sends what the project knows, with each saved step as a short hash and never the values it typed. It runs the plan it gets back and reports what happened. The plan is checked before it runs, and a plan that fails the checks is dropped. Every decision while it drives is the platform's too: your machine executes each step it is handed and reports what happened.

## With no persona, it writes a plan first

Called with no `persona`, explore writes the whole drive down before it starts, as a drive plan:

- **Journeys.** Each saved flow worth replaying, plus one open journey for each persona the platform proposes, for the request the user declared (`reticle_run { tool: "reticle_intent", args: { action: "declare" } }`), and for each intent nobody has proved. Replays need no model; only open journeys reach one.
- **Order.** A flow that `needs` another runs after it. An open journey runs after the flow everything else needs, usually sign-in.
- **Lanes.** Each journey nothing else needs gets a lane holding what it needs, in order. Lanes run side by side, each in its own leased browser context, four at a time. A journey that needs one from another lane waits for it, and is blocked if that journey failed. A prerequisite that commits something (a payment, an email) runs in one lane only, and the others wait on it rather than commit it twice.
- **Branches.** Flows that start with the same steps become one journey. The shared steps are driven once and marked as a checkpoint, then each flow continues from that point. Every flow after the first replays back to the checkpoint first, so none of them starts from the page the previous one left.

The plan appears at the top of the HUD's Agent Log: one row per lane, a card per journey, the running journey opened to its steps, and each card marked as it passes, fails or is blocked. The tool's answer carries one line per journey.

Two `reticle_flow_replay` arguments make the branches possible, and you can use them directly. `to` stops before a step. `at` continues at a step on the page as it is, without driving the steps before it. A part-way replay checks the steps it drove and records nothing about the flow as a whole.

## What it needs

**A project on the Reticle platform.** Every plan includes the Harness: Free comes with monthly Harness credits, one per decision the Harness makes. Run `reticle connect` once in your app's folder. The Harness runs on the platform: planning, personas, and every choice of what to press next. A model key of your own does not drive it, and a machine with no platform link gets the refusal and the way to fix it.

| Variable | What it does |
| --- | --- |
| `RETICLE_API_KEY` | For CI, where nobody ran `reticle connect`. Locally the daemon uses the key `connect` stored in `~/.reticle/credentials.json`; either way it is what asks the platform to drive. |
| `RETICLE_HARNESS_MAX_STEPS` | Ceiling on steps in one drive. Bounds cost, not value. |
| `RETICLE_SECRET_<FIELD>` | The value for a secret field, such as `RETICLE_SECRET_AUTH_PASSWORD` for a field named `auth-password`. Only the field's NAME goes to the platform. The value is typed in on your machine and never sent. |

**What you see.** The HUD's Agent Log marks the moment the Harness takes over ("Reticle Harness is driving") and gives its steps their own colour, so you can tell its work from your agent's. Each Harness drive is recorded as its own run, named for its journey and credited to the Harness, beside your agent's run. Any "double-quoted text" in a persona must be on the page when the journey ends, and is checked.

## How it decides

The platform drives with Jev, a System One model that answers typed questions and cannot write. Every choice is a selection from candidates read off the page: which element, which tool, what consequence to claim. Three rules sit around those choices, because each one was a drive that stopped short or claimed nothing:

- A journey that names a page it has not reached ("then turn on automatic refunds in Settings") is not finished. The Harness goes there instead of stopping.
- A dialog whose destructive action already ran is closed rather than treated as the end of the journey.
- A control the destructive-action gate refused is a write, so the Harness always claims a request or a signal for it. A save the server rejects then fails visibly instead of passing as nothing to prove.

## Turning it off, and who pays for it

A project linked to a Reticle workspace reads two things from it before a drive starts, and honours both:

- **The switch.** Autonomous driving can be turned off per project, from the HUD's Reticle Harness switch or the dashboard (Settings → Verification model). A drive then refuses and says where to turn it back on. Switched off while a platform drive is running, the drive stops at its next turn with `stopReason: "stopped"`, keeps what it drove, and says so in the Agent Log. Everything else is unaffected, including the tools your own agent drives with.
- **Credits.** Every workspace gets Harness credits each 30 days: Free 500, Pro 4,800 a seat, Enterprise as agreed. One credit is one decision the Harness makes. The HUD shows how many are left; once they are spent a drive is refused with that number and the way to get more.

If only the settings endpoint is unreachable, the on/off switch and the credit check do not block a drive: an unreachable settings endpoint is not a reason to lose a feature you were never told to stop using. The drive itself still needs the platform, so with no connection at all it is refused with the reason.

## What it will not do

**It does not decide whether your app is correct.** The model chooses what to _try_; the engine decides what _happened_, from what it recorded. A model that graded its own driving would be scoring its own homework, and its verdict would be unfalsifiable. So the summary it writes is an account of what it drove, and nothing downstream grades from it.

That split is also why the platform's model is not the largest one available. The harness is exploring an interface and stating expectations, not reasoning about your business logic. If finding defects needed a frontier model _there_, the engine would not be doing its job.

**It really clicks.** A drive navigates, submits forms and mutates state, exactly like the crawl does. Point it at a preview or a dev environment, not production.

**It is never automatic.** `reticle verify` will not drive your app unless you ask with `--explore` or `--persona`, and it never drives a project that already has saved flows. Replaying those is the cheap path, and spending a model budget to re-discover what is already recorded would be the wrong trade.

## Give it a persona

A drive with no focus clicks around. A drive with a persona completes a journey, and a journey is what turns into a flow worth replaying:

- `"a first-time user signing up and inviting a teammate"`
- `"an admin revoking a seat, then checking the seat count"`
- `"a returning customer applying an expired discount code"`

Name the outcome, not the buttons. What breaks in real products is a chain: sign up, verify, invite, join. A chain fails at whichever link nobody walked.
