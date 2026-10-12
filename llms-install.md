# Installing Reticle (for AI coding agents)

This file is for an agent installing Reticle on a user's machine — Cline, Roo Code, or any client that sets up MCP servers by reading a repository. Follow it in order and stop at the first failure.

Reticle takes **two steps**. Registering the MCP server is not enough on its own: the server talks to a bridge that the user's app must dial, and nothing is wired into the app until step 2 runs.

## Prerequisites

Node **20.11 or newer**. Check with `node --version`. If it is older, stop and tell the user to upgrade — nothing below will work.

## Step 1 — register the MCP server

Add this to the client's MCP configuration:

```json
{
  "mcpServers": {
    "reticle": {
      "command": "npx",
      "args": ["-y", "@reticlehq/server", "mcp"]
    }
  }
}
```

No API key, no environment variables, no account. The server runs locally over stdio.

> Once the package is on the machine the server answers `initialize` in about 4 seconds. The **first** run is the slow one, because `npx` downloads the package before the server starts, and that download can outlast a client's default connect timeout. If the first handshake times out, run `npm install -g @reticlehq/server` once and use `reticle mcp` as the command instead of the `npx` form — it then starts without the download.

## Step 2 — wire the user's app (once per project)

This is the step that is easy to miss. In the folder holding the app's `package.json`:

```bash
npx -y @reticlehq/server init
```

Or, if the CLI is installed globally, `reticle init`.

It detects the framework, installs the matching adapter and build plugin as dev dependencies, writes `.reticle.json`, adds the plugin to the build config, writes the `reticle-dev` module, then starts the dev server, opens the app and waits until it connects. That connection is the proof the install worked.

Useful variants:

```bash
reticle init --dry-run        # print the plan, write nothing
reticle init --app apps/web   # monorepo: wire one app
```

## Verify

```bash
reticle status
```

It worked when `init` lists the files it changed and reports that the app connected, and `status` agrees. Until both are true, the MCP tools have no app to look at and will say so rather than guess.

**If the dev server was already running**, restart it and reload the tab. It read the build config before `init` changed it, so it is still serving the app without Reticle.

## Try it without touching the user's project

```bash
reticle tutorial --run
```

Drives Reticle's own demo app end to end and modifies nothing of the user's.

## What the user gets

A tool surface for verifying a running web app from the inside — look at the live DOM, act on it, observe what the app actually did (network, routing, console, framework state), and assert against it. The result is a verdict with evidence rather than a screenshot. It also covers access control, accessibility, performance and SEO checks, and supports Vite, Next.js, Electron and Tauri.
