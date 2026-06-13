# Iris Skill — give this to your coding agent

This folder contains a single skill file (`SKILL.md`) that teaches a coding agent how to
integrate Iris into your project in about 10 minutes — fully automated, no manual steps.

## What happens when you use it

The agent will:

1. Ask you five quick questions about your stack (framework, package manager, dev URL, etc.)
2. Create `.mcp.json` so it gains Iris browser tools automatically on the next session.
3. Install `@syrin/iris` and wire up the SDK into your app's dev entry point.
4. Validate the connection — confirm it can see your running browser tab.
5. Register your testable surface (testids, signals, stores) and persist a `.iris/contract.json`.
6. Optionally: record a first flow of your most important user journey.

After that, the agent tests its own work by default — no separate instructions needed.

## How to install

### Claude Code

```bash
# Copy the skill to Claude Code's skills folder
cp -r skill/ ~/.claude/skills/iris/
```

Then in any project, ask your agent:

```
/iris
```

### Other agents (Cursor, Windsurf, etc.)

Copy `SKILL.md` to wherever your agent loads skill/context files, or paste its contents
directly into a system-prompt or rules file. The content is plain markdown — it works in
any agent that can read instructions.

## Who is this for

Anyone using a coding agent (Claude Code, Cursor, Windsurf, Claude Desktop, …) to build
a web app and wanting the agent to verify its own work against the real running UI —
not against unit tests or screenshots.

Works with: **React (18/19), Next.js, Vue 3, Svelte, SvelteKit, Remix, vanilla JS.**

## The other `dev-skills/` folder in this repo

If you are looking at the Iris repository, you will also see a `dev-skills/` folder.
That folder is **internal engineering reference** for people contributing to Iris itself —
TypeScript patterns, testing conventions, architecture decisions. It is not for users.

This folder (`skill/`) is what you want if you are **using** Iris.

| Folder        | For                                           | Contents                             |
| ------------- | --------------------------------------------- | ------------------------------------ |
| `skill/`      | Iris users — integrate Iris into your project | This file, the integration playbook  |
| `dev-skills/` | Iris contributors — build Iris itself         | TypeScript/testing/architecture docs |

## Learn more

- [Getting started guide](../docs/getting-started.md)
- [Complete usage guide](../docs/usage.md)
- [Integration patterns](../docs/integration-patterns.md)
- [Flows & self-healing](../docs/flows.md)
