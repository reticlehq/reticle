---
title: Setting Reticle up
description: 'What to pass `reticle init`, how to read what it gives back, and what to do when it cannot finish the job. Read this once, when you are setting up. The everyday loop is in SKILL.md.'
icon: wrench
---

You only need this page while you are setting Reticle up, which happens once per project. Once an app is connected, the everyday loop lives in `SKILL.md` and you never need to come back here.

**One command. It does all of it, and it ends with a verdict.**

```bash
RETICLE_INSTALL_SOURCE=skill_file npx @reticlehq/server@latest init --flow "<the journey worth proving>"
```

`@latest` is deliberate: `npx` caches, and a stale cached CLI is the most common silent setup failure. Never pin a version here.

That single command detects the framework and package manager, wires the build config, installs the SDK, registers the MCP server, starts the dev server, opens the app, waits for a session to connect from inside it, drives one flow, and saves it so every later check is one call with no model in the loop. It exits non-zero if it did not produce a verdict, and prints exactly what is left to do.

## What YOU decide, and pass in

The command reads the repository. It cannot read the request, and three things live only there. Decide them before you run it; do not walk any of them by hand.

| flag | what only you know |
| --- | --- |
| `--flow "<what>"` | which journey proves the thing the user asked for. Code can list the buttons; it cannot know checkout matters and the theme toggle does not. Naming it took one real app from a ten-minute timeout to 138 seconds, because the turns go into FINDING a flow. |
| `--env KEY=VALUE` | what the app needs to reach a usable state: the key from `.env.example`, the mock backend in the README, the variable that skips an auth wall. Repeatable. Without it a real app sits on a login screen and there is no flow to drive at all. |
| `--app <dir>` | which app in a monorepo. It can list the ones that are servable; only the request says which one is being worked on. |

**Ask the user nothing.** Not the framework, package manager, port, editor or MCP client: every one is answerable from the repo you are sitting in. Read `.env.example`, the README and `package.json`, decide, and say what you decided in one line.

**Never ask about the port.** There are two, and conflating them is a top setup failure. The dev-server port (3000, 5173) belongs to the project's own dev script. The bridge port (**4400**) is the daemon-to-SDK channel and defaults correctly.

## Then read what it gives you back

`⚠` lines and a non-zero exit are a to-do list, not a failed install. The command names the cause and prints the REMAINING steps from wherever it stopped, and it will not tell you to redo a phase that already worked. Do those, and re-run; re-running is safe.

**It is not finished until a verdict exists.** Writing files is not an install, and neither is a connected session. If it exits non-zero, the app is wired and something is still outstanding; say so plainly rather than reporting success.

**If the user gave you a license key**, see [License key](#license-key) below.

---

## If that command could not run it

**Do not choose this path.** It is not the thorough version of the one above; it is what you fall back to when the command physically could not do the work, and taking it by preference is how an install costs 176 turns instead of one. That is a measured figure, not a way of speaking.

Use it only when ONE of these is true, and you can say which:

- `init` exited without ever printing `starting:` or `▸ WATCH`, which means the CLI on this machine predates the runtime phases and stopped after writing files.
- `init` printed a to-do list, you did those things, re-ran it, and it stopped in the same place twice.
- There is no Node 18 or newer on this machine, so nothing can run.

Anything else is not a reason: not a `⚠` in the report, not a step you would rather do yourself, not a feeling that you should check its work. Re-run the command. It is idempotent, it reports what is already wired, and it names what is still outstanding.

When one of those three IS true, the whole manual procedure is one page:

```bash
curl https://docs.reticle.sh/install-manual.md      # register the MCP, wire the SDK, prove it
curl https://docs.reticle.sh/troubleshooting.md     # nothing connected, click did nothing, verdict unknown
```

**Vite + React**, **Next.js**, **Remix** and **Astro** are the frameworks with an app and a CI gate behind them, so their wiring is proven rather than assumed. **TanStack Start** is detected and given a client-only recipe, but nothing in CI proves it. The SDK is framework-agnostic and usually connects elsewhere, but say that honestly rather than reporting a proven install.

Do not reconstruct it from memory. Three things decide whether it works, and all three get skipped:

1. **The SDK must load in a RUNNING page.** Not wired in a config file: loaded, in a page a browser has open. This is the step the funnel dies on.
2. **A session must appear** on that app's own url. `reticle_sessions` returning an empty list has four causes with four different fixes, and its `next_action` names which one this is.
3. **A verdict must exist.** `reticle_act_and_wait` or `reticle_assert`, and nothing else. A drive that ends without one has no result however many tools it used.

## The dev server, whoever starts it

**A dev server already running when `init` ran does not have Reticle in its bundle.** It read `vite.config.ts` / `next.config.js` at boot; `init` edited that file afterwards. The process keeps serving the old bundle, the page loads without the SDK, no session appears, and every symptom points at the wiring you just correctly did. This is a 100% failure, not an intermittent one, and it is the single largest cause of an install that gets to step 4 and finds an empty list.

So, in this order:

1. **A dev server was already running?** Restart it, then hard-reload the tab. "Something is listening" does not mean the right bundle is served.
2. **Nothing was running?** Start it in the BACKGROUND and say so in one line. `reticle_sessions` gives you this project's own dev command in `next_action`; use that, never compose one. Started after `init`, it needs no restart. **`reticle init` may start it for you, and stops it again if setup fails**: a command somebody ran is attributable and stoppable where a daemon is not.

Stopping here to ask is how a setup turn ends with nothing verified.

The daemon deliberately will not do this for you. A build process started by a long-lived background daemon is invisible to the person whose machine it runs on and orphans when the daemon exits; a dev server YOU start is in the transcript, attributable, and stoppable.

Four guards, none optional:

1. **Never run two at once.** One dev server on the app's port. Restarting a stale one means stopping it first, not starting a second alongside it.
2. **Never guess the command.** It comes from `package.json` scripts. No recognisable dev script means say so and stop, not invent one.
3. **Never kill anything you did not start**, and never a daemon or a port holder. The one exception is the restart above, and say in one line that you did it.
4. **The permission prompt belongs to your host.** Never bypass, suppress or auto-approve it, and take a refusal as the answer. You have no business editing a permissions file yourself. `init` writes one rule, for the `reticle` server alone, and prints that it did.

---

## License key

Enterprise features are unlocked by a signed key, verified locally with Ed25519 and **no network call**. If the user hands you one, during setup or at any later point:

```bash
npx @reticlehq/server@latest init --license <key>
```

That writes `RETICLE_LICENSE_KEY` to the project's `.env` and adds `.env` to `.gitignore` if nothing there covers it. Do not do those two by hand: a key committed to git is a leaked credential, and it stays leaked after the file is removed. Confirm with `npx @reticlehq/server license`, which prints `active`, `eval`, `missing` or `expired`.

Never echo the key back in your reply, and never put it in a commit, a code comment, or a feedback report. The rest: `curl https://docs.reticle.sh/enterprise.md`.

---
