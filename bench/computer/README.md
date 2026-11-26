# Computer benchmark

`cu-bench.mjs` gives the same Mac tasks to one model with two different sets of tools.

| Arm | What the model sees |
| --- | --- |
| `reticle` | `look`: the accessibility tree with refs. `act`: an action on a ref, which answers with what changed. |
| `cu-toolset` | Claude's `computer_toolset_20260801` schema: screenshots, and clicks and keys at points of them. |
| `cua-driver` | [cua-driver](https://github.com/trycua/cua), an open-source Mac driver: its own tools, from its own MCP server (`cua-driver mcp`), and its own executor. |

Reticle's helper carries out the actions of the `reticle` and `cu-toolset` arms. The `cu-toolset` arm is not Anthropic's own computer-use setup. Those two compare two ways to choose actions on one executor. The `cua-driver` arm is a whole other product: nothing of Reticle is in it. It leaves out only the tools that change cua-driver's settings or its recorder. Describe the arm in exactly these words wherever a number from it goes.

## Tasks

Ten tasks in TextEdit, Calculator and Finder. Two of them arrange a window: put it on the left half of the screen, and minimize it. A checker outside both arms reads the result from the disk, from the answer, or from the window as System Events gives it. It never asks Reticle. Two tasks cannot be done (save a locked file, divide by zero). For them the correct answer is `failed`, so a `done` there is a false done.

Zoom, a button held down on its own, the middle click and the triple click are off in the toolset. No task needs them.

## Run it

Needs the operator (`operator.mjs`: a bridge, and HTTP on 4499 that joins an app and runs a tool), the screen for the whole run, and `ANTHROPIC_API_KEY`. The `cua-driver` arm needs `cua-driver` 0.2 or later, with its Accessibility and Screen Recording permissions.

```bash
pnpm build && node bench/computer/operator.mjs &               # the operator
node --env-file=.env bench/computer/cu-bench.mjs            # every arm, every task
node --env-file=.env bench/computer/cu-bench.mjs reticle calculator-multiply
```

`BENCH_PROVIDER=openai` runs the arms with an OpenAI model (`gpt-5.4` unless `BENCH_MODEL` says another) on the Responses API, with `OPENAI_API_KEY`. There `openai-computer` takes the place of `cu-toolset`: OpenAI's own computer tool, whose clicks and keys Reticle's helper carries out.

```bash
BENCH_PROVIDER=openai node --env-file=.env bench/computer/cu-bench.mjs all
```

The two Calculator tasks are checked against the display of Calculator, read from System Events, and not only against the answer: a model can work out 1234 × 56 without Calculator.

Each run adds one line to `results.jsonl`: pass, status, false done, turns, calls, errors, time and tokens.
