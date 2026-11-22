# Long-horizon plan, live

`live-plan.mjs` runs a plan of the Harness (`@reticlehq/harness`, in `../reticle-harness`) end to end on this machine. It uses no model.

| Step                             | Realm                  | Proof                              |
| -------------------------------- | ---------------------- | ---------------------------------- |
| Clear Calculator                 | desktop (computer use) | the display reads `0`              |
| Compute 1234 × 56 in Calculator  | desktop (computer use) | the text `69,104` is on the screen | (and was not there before the step) |
| Read the result from the display | desktop                | the board value fits `69,?104`     |
| Write the value to a file        | terminal               | the file holds the value           |

The plan runner routes each step, runs its calls through Reticle's tools on an in-process bridge (port 14460), checks each proof itself (a consequence that is there before its step fails the step: Calculator starts with its last result on the display), and writes each event to a ledger file. A second run without `--fresh` goes on from that ledger.

```bash
node bench/long-horizon/live-plan.mjs --fresh
```

Needs the Accessibility permission, `pnpm build` in this repository, and `npm run build` in `../reticle-harness`. Calculator comes to the front for a moment.
