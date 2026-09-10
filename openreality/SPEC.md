# OpenReality, version 1

A specification for checking whether something an agent did to a running program actually did what it was supposed to do.

It is deliberately small. Everything here is implemented today, and nothing is here that is not.

---

## 1. What this is for

An agent changes some code, then says it works. Usually nobody checks. When something does check, it is normally the agent looking at its own output — which proves that it produced output, and nothing else.

OpenReality describes the parts you need so that "it works" can be checked from outside the thing making the claim:

- a **realm**, which can do things to a running program and see what happened
- a **wire**, which carries what the realm saw to whoever is deciding
- a **verdict**, which is the decision, in a vocabulary that includes "I could not tell"

---

## 2. A realm

A realm is the layer that lets an agent interact with one kind of environment. A browser tab is a realm. An Electron window is a different one. A phone would be another.

Every realm answers four questions, and only these four:

| Verb | The question | Example, on the web |
| --- | --- | --- |
| `describe` | What is here right now? | Read the page into a list of things you can point at. |
| `act` | Do this. | Click, type, scroll, navigate. |
| `watch` | What happened as a result? | DOM changes, network calls, console errors, state changes. |
| `photograph` | Show me. | Take a picture, when a picture is the only honest answer. |

Everything a realm reports is scoped to a **window**: a bounded stretch of time, with a beginning and an end, holding what was seen in it. A window is not an implementation detail. An observation with no window cannot be argued with -- "the request went out" is not checkable unless you can say _when_, and relative to what. So every observation belongs to a window, and any verdict built from observations is a claim about that window and no other.

**A realm never returns a verdict.** It reports what it did and what it saw. Whether that proves anything is decided elsewhere, from evidence on a channel other than the one that acted. A realm that could return a verdict would be the thing under test grading its own work.

### Saying what you cannot do

A realm declares what it can do when it connects. Anything it has not declared, it must **refuse** -- never attempt, never approximate, never guess.

This is not politeness, it is the main defence against a false pass. An implementation that quietly does something adjacent to what was asked produces a result that looks like evidence and is not. A refusal is a worse experience and a better answer.

Reticle refuses for six reasons today, and the one that matters most here is `unsupported`: a rich-text surface it cannot honestly drive, a disabled field, a destructive control. It says so rather than clicking something nearby.

A realm that pretends to have taken a picture is worse than one that admits it cannot.

---

## 3. The wire

Four kinds of message travel between the realm and whoever is deciding:

| Kind             | Direction       | Meaning                                   |
| ---------------- | --------------- | ----------------------------------------- |
| `hello`          | realm → decider | I am here, and this is what I can do.     |
| `command`        | decider → realm | Do this.                                  |
| `command_result` | realm → decider | Here is what happened when I did.         |
| `event`          | realm → decider | Something happened that nobody asked for. |

The current protocol version is **1**.

Every message and every event payload has a schema. Those schemas are the normative part of this specification, and they live in `@reticlehq/core` — one definition, checked at both ends, rather than a copy in a document that drifts from the code. A check in this repository fails if the table above stops matching them.

---

## 4. A verdict

A verdict is one of four things. The last two matter as much as the first two.

| Verdict    | Meaning                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| `yes`      | It happened, and the evidence is independent of the action that caused it.        |
| `no`       | It did not happen, or two channels disagree about whether it did.                 |
| `unknown`  | Nobody could tell. The evidence was missing, stale, or came from the wrong place. |
| `no-fault` | Nothing was declared, so there was nothing to prove.                              |

**`unknown` is a real answer, not a rounding error.** An implementation that turns "I could not see" into `yes` is worse than no implementation, because it costs you the one thing you came for. The same is true of `no-fault`: reporting success because nobody asked a question is how a check becomes decoration.

### The independence rule

Evidence for a consequence must not come from the same channel that performed the action.

If you click a button and the same click handler tells you it worked, you have learned that the handler ran. You have not learned that anything happened. This is the single rule that separates a verdict from a rationalisation, and any implementation that drops it is not implementing this specification.

---

## 5. Anomalies

A verdict answers a question somebody asked. An **anomaly** is something worth knowing that nobody asked about: an observation in the window that no claim covers, and that contradicts something else in the same window.

Two examples, both of which Reticle finds today:

- The screen moved forward to a success page while a request in the same window failed. Somebody swallowed a rejection.
- The app returned `200` and reported a failure _inside_ the response body.

Nobody declared either. Both are real, both are found by looking at one window and noticing two things that cannot both be true, and neither depends on knowing what kind of application this is.

This is deliberately part of the specification rather than a product feature. It is the only part of the model that produces something the person did not ask for, and it is the part that is genuinely independent of domain -- which makes it the piece most worth agreeing on across implementations. Reticle ships twenty-three kinds of contradiction today.

---

## 6. What this does NOT specify yet

Stated plainly, because a specification that hides its gaps is worse than a short one:

- **No transport is required.** Reticle uses a WebSocket. Nothing here says you must.
- **No conformance suite.** There is no test you can run against your realm to be told whether it conforms. Today the only way to find out is to read `adapters/realm/dom` and compare.
- **No version negotiation.** Both ends assume version 1. There is no rule for what a version 2 should do when it meets a version 1.
- **No registry.** Nothing says how a decider discovers which realms exist.
- **Verdicts cannot be revised.** Evidence can arrive after a verdict is given: a request that was still in flight settles, a page that had not finished finishes. A later verdict should be able to supersede an earlier one, and there is no way to say so. Today a verdict is final the moment it is made, which is an unsoundness rather than a missing convenience.
- **A verdict does not carry its window.** The model above says a verdict is a claim about one window; the artifact Reticle writes does not record which one. That makes a stored verdict harder to argue with than a live one.
- **Capability declaration is coarse.** A realm says whether it has a capability registry at all. There is no per-verb list, so a decider cannot tell in advance which of the four will be refused -- it finds out by asking and being turned down.

Each of those is a real gap. They are listed rather than glossed because somebody deciding whether to implement this deserves to know what they would be building on.
