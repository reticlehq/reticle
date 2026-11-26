# Computer benchmark

`cu-bench.mjs` gives the same Mac tasks to one model with two different sets of tools.

| Arm | What the model sees |
| --- | --- |
| `reticle` | `look`: the accessibility tree with refs. `act`: an action on a ref, which answers with what changed. |
| `cu-toolset` | Claude's `computer_toolset_20260801` schema: screenshots, and clicks and keys at points of them. |

Reticle's helper carries out the actions of **both** arms. The `cu-toolset` arm is not Anthropic's own computer-use setup. The benchmark compares two ways to choose actions on one executor. Describe the arm in exactly these words wherever a number from it goes.

## Tasks

Ten tasks in TextEdit, Calculator and Finder. Two of them arrange a window: put it on the left half of the screen, and minimize it. A checker outside both arms reads the result from the disk, from the answer, or from the window as System Events gives it. It never asks Reticle. Two tasks cannot be done (save a locked file, divide by zero). For them the correct answer is `failed`, so a `done` there is a false done.

Zoom, a button held down on its own, the middle click and the triple click are off in the toolset. No task needs them.

## Run it

Needs the operator of the computer run (a bridge, and HTTP on 4499 that joins an app and runs a tool), the screen for the whole run, and `ANTHROPIC_API_KEY`.

```bash
node --env-file=.env bench/computer/cu-bench.mjs            # both arms, all tasks
node --env-file=.env bench/computer/cu-bench.mjs reticle calculator-multiply
```

Each run adds one line to `results.jsonl`: pass, status, false done, turns, calls, errors, time and tokens.
