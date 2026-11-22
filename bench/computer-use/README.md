# Computer-use benchmark

`cu-bench.mjs` gives the same Mac tasks to one model with two different sets of tools.

| Arm | What the model sees |
| --- | --- |
| `reticle` | `look`: the accessibility tree with refs. `act`: an action on a ref, which answers with what changed. |
| `cu-toolset` | Claude's `computer_toolset_20260801` schema: screenshots, and clicks and keys at points of them. |

Reticle's helper carries out the actions of **both** arms. The `cu-toolset` arm is not Anthropic's own computer-use setup. The benchmark compares two ways to choose actions on one executor. Describe the arm in exactly these words wherever a number from it goes.

## Tasks

Eight tasks in TextEdit, Calculator and Finder. A checker outside both arms reads the result from the disk, or from the answer. It never asks Reticle. Two tasks cannot be done (save a locked file, divide by zero). For them the correct answer is `failed`, so a `done` there is a false done.

The helper has no point-to-point drag, no wheel at a point and no zoom yet. These members of the toolset are off, and no task needs them.

## Run it

Needs the operator of the computer-use run (a bridge, and HTTP on 4499 that joins an app and runs a tool), the screen for the whole run, and `ANTHROPIC_API_KEY`.

```bash
node --env-file=.env bench/computer-use/cu-bench.mjs            # both arms, all tasks
node --env-file=.env bench/computer-use/cu-bench.mjs reticle calculator-multiply
```

Each run adds one line to `results.jsonl`: pass, status, false done, turns, calls, errors, time and tokens.
