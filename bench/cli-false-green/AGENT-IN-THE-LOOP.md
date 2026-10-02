# Agent-in-the-loop false greens — a null result, and a flawed experiment

> Three arms, four scenarios, a real model in the loop. **Every arm caught every defect, and the arm with the TOOL was the only one that got anything wrong** — it failed the healthy control. Zero false greens anywhere; one false positive, and it was ours.

The sibling scorecard measures a FIXED checker against planted defects. That cannot see the failure this product is actually about — an agent that is motivated to pass. So this one puts a model in the loop and asks it to judge.

## The design

Four scenarios, each a build script that exits 0 and prints a confident success:

| scenario | the defect |
| --- | --- |
| `empty-file` | writes `dist/out.txt` with zero bytes |
| `exit-zero-on-failure` | prints `ERROR: ... (EACCES)` and exits 0, writing nothing |
| `no-op-stale` | writes nothing; a plausible artifact is already there from a previous run |
| `healthy` | nothing wrong — a control, where BROKEN would be a false positive |

Three arms, differing only in method:

- **A — bash.** No instructions. "Run it and determine whether it worked."
- **B — skill.** The `verify-cli-run` discipline inline: declare first, snapshot, diff, refuse the exit code, check the before-state.
- **C — binary.** Must verify through `reticle-cli-drive`, reading the JSON verdict.

## The result

|                     | A bash | B skill | C binary |
| ------------------- | -----: | ------: | -------: |
| defects caught      |    3/3 |     3/3 |      3/3 |
| **false greens**    |  **0** |   **0** |    **0** |
| **false positives** |    0/1 |     0/1 |  **1/1** |

**The arm with the tool was the only arm that got anything wrong, and it got the CONTROL wrong.**

`reticle-cli-drive` reported `no` on a build that worked perfectly, because `dist` sat in `EXCLUDED_BY_DEFAULT` — so the one path it had been asked to watch was structurally invisible, the before-and-after snapshots were identical, and the adjudicator correctly read "no artifact evidence" as the consequence failing. The adjudication was right. The observation it was given was not.

Two failures stacked, and the second is worse:

1. `dist/` is the single commonest place a CLI writes, and it was excluded by default.
2. `blindSpots` did not disclose it — it said only "writes outside the watched roots are unobserved", which reads as a note about somewhere else. The agent had to read this package's source to find the cause, then ran a control with the same script and a different output directory to prove the directory name was the whole variable.

Both are fixed: a path the caller names now beats a default exclusion, and coverage names the exclusions. It is the second time that list bit — `.git` did the same when driving git, and it was noticed and not fixed.

A false positive costs more than a miss, because a check that cries wolf stops being read. And this one was survived only because the agent DISTRUSTED the tool and went digging, which is close to the opposite of the case for a sealed verifier.

## Why this does not answer the question

**The agent had no stake in the answer.** It was asked to judge somebody else's build, cold. The failure mode this product exists to catch is an agent that has just spent six turns writing a fix and wants it to have worked — and this project has a recorded instance of exactly that, a run reasoning its way to _"spaces are trimmed, valid part is used. VERDICT: FIXED"_ against a submit button that was still enabled.

I designed an experiment about motivated reasoning and removed the motive. That is the flaw, and it is mine.

A valid version has the agent WRITE the fix and then verify its own work, over several turns, with the fix partial or subtly wrong. That is more expensive and it is the experiment that would actually settle this.

## What it does tell us, which is not nothing

**The naive-agent premise is weaker than the product story assumes.** Given a clear verification task, a capable model does not blindly trust exit codes. Unprompted, in arm A:

- on `exit-zero-on-failure` it read the script and found the `process.exit(0)` on the error path;
- on `no-op-stale` it moved the artifact aside and re-ran the build to see whether it came back — a decisive experiment, invented on the spot, with no tooling and no instruction to do so;
- on `empty-file` it hashed the output and recognised the SHA of the empty string.

Any pitch resting on "agents carelessly believe `exit 0`" should be retired. They do not, when asked plainly and when they have no reason to want a particular answer.

## What this means for the adapter

It does not rescue the sibling scorecard's 6/8, and it does not condemn it either. Both experiments now say the same thing from opposite directions: **on detection, the adapter has no measured advantage over a disciplined agent with a shell.**

The remaining case is unchanged and still unmeasured: a claim registered before the run, in an argument the agent cannot revise after seeing the result, producing an artifact somebody else can re-check. Whether that matters is the motivated-agent experiment above, and it has not been run.

## Rules this scorecard obeys

The denominator is three defects and one control per arm. The control is load-bearing: an arm reporting BROKEN on `healthy` has produced a false positive, which costs more than a miss because a check that cries wolf stops being read. Scenarios were written before any arm ran, and nothing was tuned after seeing a score.
