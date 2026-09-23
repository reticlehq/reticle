# CLI false-green scorecard — does a sealed verdict beat a disciplined agent?

> A checkpoint on the CLI realm, and it answers **against the adapter**. Read this before building anything else on top of `@reticlehq/cli-realm` — which is not published yet, and is marked `private` until the result below has been acted on.

Deterministic, with no model in the loop — the same shape as the web scorecard next door, and for the same reason: a fix-loop benchmark moves the agent and the checker at once and cannot say which one did the work. Eight defects and two controls, each injected into a tool that is otherwise correct, each exiting 0 and printing something confident.

Runner: `run.mjs`. Registry: `bugs.mjs`.

## Headline

|                  | exit-code | discipline | cli-realm |
| ---------------- | --------: | ---------: | --------: |
| Caught           |     1 / 8 |  **8 / 8** |     6 / 8 |
| **False greens** |     **7** |      **0** |     **2** |
| False positives  |     0 / 2 |      0 / 2 |     0 / 2 |

`exit-code` is what almost every CI pipeline does today, and it is worth the row: seven of eight defects sail straight through it.

**`discipline` is the Phase −1 skill with no package at all** — declare the path, snapshot, run, diff, refuse the exit code as evidence. It caught everything.

**`cli-realm` is the adapter**, adjudicated by the specification's own `adjudicate`. It caught six.

## The two the adapter missed, and neither is a bug in the adapter

**`writes-a-different-path`** — the tool wrote `out.txt.bak` instead of `out.txt`. The claim matched with `valueContains: 'out.txt'`, and `out.txt.bak` contains `out.txt`. A substring match over a path passes for every path that has the target as a prefix.

This is a trap the protocol hands its users. `MatchTargetSchema` offers `summary` plus `valueContains` and nothing else, so a path claim has no exact form to be written in. Every user of this adapter will write that predicate, and it is wrong in the direction that manufactures greens. It belongs on the list of protocol findings, not on the list of things to paper over here.

**`writes-an-empty-file`** — the path exists and holds nothing.

This one is the design doing exactly what it was built to do, and costing us. `x-artifact` carries existence and is consequence-grade; `x-artifact-content` carries the bytes and is actuation-derived, because nothing outside the tool's own code path decides them. So the adapter **cannot prove a claim about content**. The assertion it can express is "a file appeared", and a file did.

The `discipline` checker catches it by reading the file and looking at the bytes — which is precisely the actuation-derived evidence the adapter declines to count. **The rigorous thing refuses the weak evidence and catches less. The pragmatic thing uses it and catches more.**

## What this means

The split between existence and content is still right: `git push` writing a remote-tracking ref must not buy a proof that the push landed. But the cost was underweighted in the plan, and it is not small — **most claims a user actually wants to make about a build tool are claims about content**, and this adapter tops those out at presence grade.

So the honest positioning is narrower than the plan's:

- Against `exit-code`, which is the real incumbent, the adapter is a large improvement (7 false greens to 2).
- Against a **disciplined agent with a shell**, it is currently worse on this corpus.

The adapter's remaining case is the two things a shell cannot do — the network channel and interactive panels — plus the sealed rules and a portable artifact. That case is real and it is not "catches more bugs".

## What would change the answer

A content claim needs a consequence-grade way to be made, and there may be one: content compared against a value the SUBJECT did not author — a lockfile, a checksum the build was given, a fixture committed beforehand. That is a claim about agreement with an independent source rather than about bytes, and it would be consequence-grade honestly. Unbuilt, and the obvious next question.

## Rules this scorecard obeys

A false-green figure always carries its denominator: eight defects, two controls. The controls are load-bearing — `healthy` and `slow-fork` must PASS, and a checker that flags either has produced a false positive, which costs more than a miss because a check that cries wolf stops being read. `slow-fork` is a tool behaving correctly whose effect outlives the process, and it is here because an earlier version of the adapter convicted it.

Nothing here was tuned after seeing a score. The registry was written before the first run.
