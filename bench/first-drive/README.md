# First-drive / advertised-surface cost

The dominant standing cost of putting Reticle in front of an agent is not any single call — it is the **advertised tool surface, re-sent to the model on every turn**. This measures it from the real wire, so a surface change shows up as a number.

```bash
node bench/first-drive/measure.mjs   # deterministic, no agent/API cost
```

Requires the server built (`pnpm --filter @reticlehq/server build`). It spawns the MCP server and reads `tools/list`, which answers before any app connects — so it needs no browser, no app and no API key.

## Measured (2026-08-19)

| surface                            | tools | tokens/turn | chars  |
| ---------------------------------- | ----- | ----------- | ------ |
| **default** — what every user gets | 18    | **5,378**   | 21,510 |
| all — the extended surface         | 30    | 16,096      | 64,384 |

The default row is the one that matters: it is re-sent on every turn of every loop. Tokens are a 4-chars-per-token proxy, not a tokenizer count.

Neither surface advertises the whole registry. The advertised count is capped because editors budget tools across every connected MCP server (Cursor allows 40 in total); everything omitted stays callable through `reticle_run { tool, args }` and stays listed by `reticle_tools`.

## Why a fresh daemon per row

The surface is read from the environment **once, by the daemon, at startup**. Measuring both rows against one running daemon reports the first surface twice, which looks exactly like proof that the setting does nothing — a conclusion that has already been drawn once from that mistake. `measure.mjs` stops the daemon between rows for that reason.

## History

This measured a five-profile model (`core`/`standard`/`full`/`hybrid`/`dynamic`) that was retired when the profiles collapsed into one surface. The script had been importing a deleted module since, so it could not run at all, and the numbers in this file described tool counts that no longer existed. `bench-scripts-resolve.test.ts` now fails when a benchmark's imports rot, which is the check that would have caught it.
