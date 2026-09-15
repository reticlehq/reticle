# install — the two launchers, and how they are served

This directory holds the only thing a person runs before Reticle exists on their machine:

```bash
curl -fsSL https://reticle.sh/install.sh | sh     # macOS, Linux, and Windows under Git Bash or WSL
irm https://reticle.sh/install.ps1 | iex          # stock Windows PowerShell
```

Both are LAUNCHERS. Between them they do only the three things that cannot be Node, because Node may not exist yet:

1. is there a usable `node`?
2. `npm install -g @reticlehq/server`
3. hand every other decision to `reticle setup install`

Everything else — writing config, registering the MCP server with the agents on this machine, saying what happened, reporting the funnel — is `reticle setup install`, which is Node and exists **once**.

## Why two files and not one

The usual argument against a `.sh` and a `.ps1` is that they drift the first time somebody fixes a bug in one of them. That argument is sound, and it is why the logic is not here: there are three steps in each file and no decisions, so there is nearly nothing to drift.

The argument for the second file is that a stock Windows box has no `sh` at all. Without `install.ps1`, the platform with the most users is told to install Git Bash or WSL before it can run the command every doc shows. The prototype this replaced shipped a `.sh` and a `.cmd` for exactly that reason.

**If either launcher ever needs a fourth step, it belongs in `reticle setup install`, not in here twice.** That is the line that keeps the pair honest, and [`break-gates.yml`](../.github/workflows/break-gates.yml) checks both parse and stay ASCII on every OS.

## Rules both files follow

- **`main "$@"` / `Main @args` is the LAST line.** A `curl | sh` cut off mid-download otherwise runs whatever prefix arrived. This way a truncated file defines functions and runs none of them.
- **ASCII only.** `install.sh` once put a multibyte ellipsis against a variable name and `dash` swallowed the expansion whole, printing two broken bytes instead of the package name — bash was fine with it, which is exactly how a `curl | sh` bug reaches users. `install.ps1` is worse: Windows PowerShell reads a BOM-less `.ps1` as ANSI, so UTF-8 punctuation stops the file parsing at all.
- **Zero human input.** Nothing is asked. The common case is an agent following a link somebody pasted, and a prompt there is a hang nobody sees.
- **No runtime is installed for you.** A piped script that puts a language toolchain on somebody's machine without asking is not a thing to run, from us or from anybody. It names the install command for their platform and stops.
- **A pre-Node failure is written to `~/.reticle/install-trace.jsonl`,** because there is nothing yet that could report it. The CLI drains that file on a later install, so the funnel shows a retry after a failure. If they never install, nothing is ever sent.

## Hosting them on reticle.sh

The scripts must be served as **plain text over HTTPS, from a pinned tag, with a short cache**.

**Serve from a release tag, never from `main`.** `curl | sh` runs whatever is at the URL the instant somebody types it; a half-merged `main` is a broken install for everybody who arrives during the merge. Point the route at `refs/tags/vX.Y.Z` and move it as part of cutting a release.

**Headers that matter:**

| Header | Value | Why |
| --- | --- | --- |
| `Content-Type` | `text/plain; charset=utf-8` | Browsers should show it, not download it. People do read it first. |
| `Cache-Control` | `public, max-age=300` | Five minutes: a fix propagates quickly, and the origin is not hammered. |
| `X-Content-Type-Options` | `nosniff` | Nothing should ever guess this is HTML. |

**Redirects are fine, but keep `-L`.** The documented command already uses `curl -fsSL`, so a 302 to a tagged raw file works. `-f` is the important flag in that set: without it, curl pipes a 404 page into `sh`.

**The shape to prefer.** A Cloudflare Worker (or Pages Function) on `reticle.sh` that maps `/install.sh` and `/install.ps1` to this directory at the pinned tag. It costs nothing, terminates TLS on the apex, sets the headers above, and keeps the URL stable while the content moves with releases. Serving straight from `raw.githubusercontent.com` also works but puts a third party's hostname and caching behaviour in front of the first command anybody runs.

**Check what the CDN actually returns, not what the repo contains.** The published docs site has served pages several commits behind before. After a release:

```bash
curl -fsSI https://reticle.sh/install.sh          # 200, text/plain, the cache header you meant
curl -fsSL https://reticle.sh/install.sh | sh -n  # it parses as the shell that will run it
```
