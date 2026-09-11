---
title: Docs for agents
description: Fetch any page as plain Markdown, pull the whole site as one file, or hand a page straight to your agent.
icon: robot
---

Append `.md` to any Reticle docs URL to get that page as plain Markdown, or fetch [`https://docs.reticle.sh/llms.txt`](https://docs.reticle.sh/llms.txt) for the index of every page. No API key, no scraper, no HTML parser.

The site lives at **`https://docs.reticle.sh`**. Everything below is a plain HTTP GET.

## Fetch one page

Append `.md` to any documentation URL and you get the source Markdown, with the page's frontmatter and no site chrome:

```bash
curl https://docs.reticle.sh/getting-started.md
curl https://docs.reticle.sh/agent-cheatsheet.md
curl https://docs.reticle.sh/usage.md
```

### What comes back

Every Markdown page is prepended with two things before its content, so a single fetch orients you without a second call:

```
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.reticle.sh/llms.txt
> Use this file to discover all available pages before exploring further.

> ## Agent Instructions
> Reticle is a dev-only, localhost-only verification layer for AI coding agents...
> Only `reticle_act_and_wait` and `reticle_assert` produce a verdict...
> A verdict of `verified: "unknown"` is not a pass...
> Package names are scoped `@reticlehq/*` and the CLI is `reticle`...

# reticle_query
...
```

The four rules are the ones worth knowing before you drive anything, and they arrive whether or not you asked for them. You do not have to read this page first.

The slug is the filename in [`docs/`](https://github.com/reticlehq/reticle/tree/main/docs), so `docs/token-efficiency.md` in the repo is `/token-efficiency` on the site and `/token-efficiency.md` as raw text.

## Fetch the index, or everything

| URL | What it is | Use it when |
| --- | --- | --- |
| [`/llms.txt`](https://docs.reticle.sh/llms.txt) | Every page title and URL, and nothing else | You want to pick the right page before spending tokens on it |
| [`/llms-full.txt`](https://docs.reticle.sh/llms-full.txt) | The entire documentation as one file (hundreds of KB, and growing) | You are seeding a context window or an index once |

Start with `llms.txt`. It is small enough to read in full and tells you which single page answers the question, which is almost always cheaper than pulling `llms-full.txt`.

## Pull a page into your harness

Every page has a menu in its top-right corner: copy the page as Markdown, or open it directly in Claude, ChatGPT, Cursor or VS Code with the source already attached. That is the fastest route when a human is driving and wants the agent to have the page.

> None of this is Reticle itself. These endpoints serve the **documentation**. Reticle runs on your machine and verifies your app; you get it with `npx @reticlehq/server init`. See [Getting started](/getting-started).

## Which page to read

You rarely need more than one.

| You want to | Read |
| --- | --- |
| Install Reticle and get a first verdict | [Getting started](/getting-started) |
| Get fluent in one screen | [Agent cheat sheet](/agent-cheatsheet) |
| Look up a specific tool, flag, or workflow | [Complete usage guide](/usage) |
| Understand what Reticle is doing under the hood | [Architecture](/architecture) |
| Wire it into a desktop app | [Desktop apps](/desktop) |
| Make the checks repeatable in CI | [Specs for CI](/testing) |
| Work on Reticle itself | [Gates](/gates), then [System map](/system-map) |
