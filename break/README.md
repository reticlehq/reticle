# setup — the harness that judges the install

**Nothing in this directory installs Reticle.** Two other places do, and it is worth being precise about which, because this directory spent a release being mistaken for both:

| I want to…                       | Go to                                                   |
| -------------------------------- | ------------------------------------------------------- |
| install Reticle on a machine     | [`install/`](../install/) — `install.sh`, `install.ps1` |
| wire Reticle into a project      | `reticle init`, which lives in [`init/`](../init/)      |
| break either of those on purpose | here                                                    |

What lives here is the negative control: 26 hostile environments driven against the **shipped CLI** and the **real launchers**.

```bash
node break/break-matrix.mjs          # 26 hostile environments
node break/break-matrix.mjs --only <name>
```

## Why there is a harness at all

This directory used to hold `reticle.mjs` — a 2,000-line prototype that `init`'s runtime phase was ported from, with its own launchers, its own tests and its own CI jobs. It was deleted once the port was complete, and the deletion is what found the bug that matters here.

The scenario `a-bug-of-our-own-is-not-a-stack-trace` asserts that when setup has a bug of its own, the user gets one sentence and a tidy machine rather than a Node stack trace and an orphaned dev server. It passed on every run for months. It was pointed at the prototype, which had the handler; the shipped CLI never had it, and injecting a fault into `reticle init` dumped a raw trace. **A gate aimed at code no user runs is not a gate**, and this is the whole reason the matrix now drives `server/dist/command/cli.js` and `install/install.sh` and nothing else.

The two launcher scenarios (`node-missing`, `node-too-old`) still run a launcher rather than the CLI, and deliberately: `process.execPath` is an absolute path, so pointing them at `node dist/cli.js` does not make them fail — it makes them meaningless, because Node is found every time regardless of the PATH the scenario just constructed.

The matrix is POSIX-only by construction: its scenarios build fake `node`/`npx`/`claude` shims as `/bin/sh` scripts. Windows coverage of the same refusals lives in [`break-gates.yml`](../.github/workflows/break-gates.yml), which runs them against the CLI on all three operating systems.

## What the prototype established

The numbers below are why `init` works the way it does. They were measured against an agent following `SKILL.md` by hand, across five real apps, and they are the argument for one command rather than a procedure:

|                        | by hand    | one call                             |
| ---------------------- | ---------- | ------------------------------------ |
| cost                   | **$9.92**  | one child agent, or free on a re-run |
| model turns            | **176**    | 1                                    |
| wall clock             | **40 min** | ~1.5–5 min per app                   |
| produced a verdict     | **2 of 5** | see below                            |
| stopped to ask a human | **3 of 5** | never                                |

Almost none of the hand-driven time is compute. It is serialised model turns — run, read the report, decide, run again — plus one human round trip for an MCP client restart. Three of the five runs ended by asking someone to restart their client, having produced nothing to look at.

### The restart, and why the drive happens in a child process

A client reads its MCP server list once, at startup, and cannot reload it. That is not one client's quirk: Gemini's `/mcp reload` re-discovers from the map built at startup and does **not** re-read `settings.json`, so a newly added server needs a full restart there too. Only whatever launched the process can perform one, and only if it is still waiting.

But onboarding does not need the CALLER to have the tools — it needs _a_ process that has them. A child agent spawned after `init` reads the list `init` just wrote. No human round trip, no resume, no lost context. The caller gets its tools whenever it next starts, and by then the verdict exists.

Auto-restarting the caller is deliberately not attempted. Resuming a conversation needs its session id, and most CLIs do not tell a child what it is. A guessed relaunch opens an EMPTY session that looks exactly like success, which is the failure this whole path exists to prevent.

### What `init` does that a report-reader does not

- **Picks the app in a monorepo.** Wiring a monorepo ROOT writes config into a directory nothing serves, and leaves a `⚠` that reads like framework detection failing.
- **Restarts a stale dev server.** One started before the build config was edited keeps serving the old bundle: the wiring is correct and nothing connects, 100% of the time.
- **Waits for the server to actually serve.** A URL in a log is an announcement, not readiness — Next prints `- Local: …` before it can answer.
- **Drives the tab a human is looking at.** A daemon accumulates sessions; taking the first URL match drove whichever it listed first, usually the oldest, while the HUD played to an empty room.
- **Finishes the capabilities file** when the session reports `hasCapabilities:false`, before driving — otherwise `reticle_state` returns nothing and every verdict rests on the DOM alone.
- **Replays instead of re-driving** once a flow is saved. The first drive is a model choosing what to prove. Every one after it is `reticle verify`: deterministic, no model.

### Registering with the other agents

`init` registers the MCP server with the clients it finds, and `reticle setup mcp` does the same for the USER at install time, when there is no project yet. The rules both obey live in [`server/src/command/setup/agent-configs.ts`](../server/src/command/setup/agent-configs.ts):

- **A documented path is written even when the agent is absent**, so a later install is wired.
- **A path that cannot be evidenced is refused.** Cline's and Roo's live under VS Code globalStorage, which moves under Insiders, portable installs and a custom `--user-data-dir`. A config file at a guessed location is one nobody reads, which looks exactly like success.
- **Formats that cannot be merged safely are never rewritten** — TOML, JSONC carrying comments, or a YAML somebody else wrote. The snippet is printed instead.

Keys are per-client and getting one wrong writes a file the client silently ignores: Zed wants `context_servers`, Amp wants a dotted top-level `amp.mcpServers`, VS Code wants `servers`, and Continue's is a YAML _list_ whose items carry a `name`.
