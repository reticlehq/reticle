# CLI false-green scorecard — does a sealed verdict beat a disciplined agent?

> A checkpoint on the CLI realm. It answered **against the adapter** (6 of 8, two false greens), the two misses were fixed, and it now ties the disciplined agent at 8 of 8 with both controls still clean. `@reticlehq/cli-realm` remains `private` and unpublished — the score was one of the reasons to hold it, never the only one, and a tie on eight defects is not a reason to claim a name permanently.

Deterministic, with no model in the loop — the same shape as the web scorecard next door, and for the same reason: a fix-loop benchmark moves the agent and the checker at once and cannot say which one did the work. Eight defects and two controls, each injected into a tool that is otherwise correct, each exiting 0 and printing something confident.

Runner: `run.mjs`. Registry: `bugs.mjs`.

## Headline

|                  | exit-code | discipline | cli-realm |
| ---------------- | --------: | ---------: | --------: |
| Caught           |     1 / 8 |  **8 / 8** | **8 / 8** |
| **False greens** |     **7** |      **0** |     **0** |
| False positives  |     0 / 2 |      0 / 2 |     0 / 2 |

Before the two fixes below, the adapter caught 6 of 8 with two false greens. Both controls passed then and pass now — a fix that bought its catches with a false positive would be worth less than the misses it closed.

`exit-code` is what almost every CI pipeline does today, and it is worth the row: seven of eight defects sail straight through it.

**`discipline` is the Phase −1 skill with no package at all** — declare the path, snapshot, run, diff, refuse the exit code as evidence. It caught everything.

**`cli-realm` is the adapter**, adjudicated by the specification's own `adjudicate`. It caught six.

## The two it missed, what each one actually was, and what was done

**`writes-a-different-path`** — the tool wrote `out.txt.bak` instead of `out.txt`, and the arm passed it.

This was the MEASUREMENT under-stating the claim, not the adapter meeting it. `valueContains` is an unanchored substring over the rendered value, and the rendering is `JSON.stringify` — which the specification names and exports precisely so a disagreement about a substring has one place to be settled. A needle of `out.txt` is therefore satisfied by `out.txt.bak`, while `/out.txt"` — with the closing quote the renderer puts there — is satisfied by exactly one path. The other two arms both check the exact path; this arm was checking a prefix and scoring the difference as a win.

The trap is still real and still worth naming: every user writing a path claim will reach for the bare substring first, and it is wrong in the direction that manufactures greens. An exact form in `MatchTargetSchema` belongs on the protocol's list. Until it exists, a path claim has to carry its own delimiter, and `run.mjs` says so where it builds the needle.

**`writes-an-empty-file`** — the path exists and holds nothing.

This one WAS the adapter, and the fix does not cost the rule it was protecting. `cli.fs.written` said the same word about a zero-byte file as about a real one, and `summary` is the only part of a match that compares exactly — so no claim written over that summary could tell the two apart. An empty write now says `cli.fs.written-empty` instead.

The distinction that makes this legitimate: **the filesystem decides how many bytes a path holds; the tool decides what they are.** A size is `stat`, which is the same independent source that decides existence. Reading the BYTES would be actuation-derived and would let a `valueContains` over file content buy a `yes` — that is still refused, and clause 9 still catches it. So the adapter still cannot prove a claim about content, and it no longer has to: "the build produced `out.txt`" is not satisfied by an empty `out.txt` by default, which is what everyone writing that claim already meant.

## What this means

The split between existence and content is still right: `git push` writing a remote-tracking ref must not buy a proof that the push landed. What the first run showed is that the split had been drawn one notch too wide — file SIZE had been filed with content, and it belongs with existence.

Where that leaves the positioning, honestly:

- Against `exit-code`, which is the real incumbent, the adapter is a large improvement: 7 false greens to 0.
- Against a **disciplined agent with a shell**, it now ties on this corpus. A tie on eight defects is a tie, not a lead — the adapter's case is still the two things a shell cannot do (the network channel, interactive panels) plus the sealed rules and a portable artifact.
- The corpus has not grown since the first run, and a score that moved because two arms were fixed is weaker evidence than a score that held while the corpus grew. The next honest move is more defects, not another point.

## What would change the answer

A content claim needs a consequence-grade way to be made, and there may be one: content compared against a value the SUBJECT did not author — a lockfile, a checksum the build was given, a fixture committed beforehand. That is a claim about agreement with an independent source rather than about bytes, and it would be consequence-grade honestly. Unbuilt, and the obvious next question.

## Rules this scorecard obeys

A false-green figure always carries its denominator: eight defects, two controls. The controls are load-bearing — `healthy` and `slow-fork` must PASS, and a checker that flags either has produced a false positive, which costs more than a miss because a check that cries wolf stops being read. `slow-fork` is a tool behaving correctly whose effect outlives the process, and it is here because an earlier version of the adapter convicted it.

Nothing in the REGISTRY was tuned after seeing a score, and it was written before the first run. Two things outside it were changed after the first run and are named above rather than folded in quietly: one arm's predicate (it was not making the claim the other two made) and one summary in the adapter. A reader who thinks either is a thumb on the scale can read both diffs from this file.
