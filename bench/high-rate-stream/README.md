# high-rate-stream

**Job: measurement, not a gate.** This study measures how Reticle behaves on a page with a high-rate WebSocket, such as a trading app.

Prerequisite: `pnpm install` and `pnpm build` once. The script boots everything it needs: its own daemon on port 14460 and `apps/trading-stream` on port 14462. It does not touch a daemon on 4400.

```sh
node bench/high-rate-stream/measure.mjs            # all modes, rates 0,10,100,1000,5000, N=10
node bench/high-rate-stream/measure.mjs --n 3 --rates 0,1000 --modes inside-on
```

For each mode and tick rate, the script clicks **Buy** N times in each variant:

| Variant | Call |
| --- | --- |
| `a` | `reticle_act_and_wait` with no `until` |
| `text` | `until: { kind: "text", contains: "o-N Filled" }` |
| `sig` | `until: { kind: "signal", name: "order.filled", dataMatches: { orderId } }` (SDK modes only) |
| `observe` | `reticle_observe` after each `text` call, since that call's cursor |

Modes: `inside-off` (SDK, body capture off), `inside-on` (SDK, `VITE_RETICLE_CAPTURE_BODIES=1`), `outside` (no SDK, zero-install reader).

`control.mjs` is the uninstrumented control: plain Playwright, no SDK and no daemon. It shows whether the page itself keeps up at a rate, before a timeout is blamed on Reticle. Set `CHROMIUM_PATH` when the Chromium that this Playwright expects is not downloaded.

```sh
node bench/high-rate-stream/control.mjs --rates 0,1000,5000
```

Each row counts `verified` yes / no / unknown, the median and maximum time to a verdict, every loss field the result reports (`dropped`, `evicted`, `truncated` and similar), and whether the order frame and the ack frame show in the result text. Results go to `results/<timestamp>.json`, which git ignores.
