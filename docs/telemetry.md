# Telemetry

Reticle collects a small amount of anonymous usage data to help us understand whether the tool is useful — which commands people run, which tools agents actually use, and whether people keep using Reticle after they try it. That's what this data is for, and all it is for: making the product better.

This page is the complete description of what is collected. If something is not listed here, it is not sent.

## The short version

- **Anonymous.** We cannot tell who you are, and we do not try.
- **No code, no app data.** Nothing from the app under test — no DOM, no network traffic, no console output, no source, no file paths — ever leaves your machine.
- **The one exception is feedback you deliberately send us**, and it is never collected passively. See [Feedback](#feedback) below.
- **Opt out any time**, permanently, with one command:

  ```bash
  reticle telemetry disable
  ```

## What is sent

Thirteen kinds of events, each a single small JSON object:

| Event | When | Extra data |
| --- | --- | --- |
| `reticle_installed` | The first time Reticle runs on a machine | — |
| `cli_command_run` | You run a `reticle` command | Which subcommand (`verify`, `status`, …) and which flags were present, by name |
| `daemon_started` | The local daemon starts | — |
| `daemon_stopped` | The local daemon stops | A summary of the session — see below |
| `verification_completed` | A verification produces a verdict | Whether it passed, and whether Reticle refused to call a passing check verified |
| `project_profiled` | Once per daemon start | The shape of the project — see below |
| `version_changed` | You update or roll back | The two version numbers, and which direction |
| `runtime_crashed` | The daemon hits an uncaught error | The error's type, **Reticle's own** stack frames, and the message with variables stripped — see below |
| `mcp_client_connected` | An agent attaches to the daemon | Whether it is a reconnect, and how long the daemon had been idle |
| `mcp_connection_lost` | The agent's MCP tools go away | Which stage (`first`, or `budget_spent` when it stopped retrying), the cause, and the attempt count. **At most twice per session** — one measured afternoon produced 547 reconnects, and an event each would bill for the pathology instead of measuring it |
| `init_completed` | `reticle init` finishes | Whether it worked, and a classified reason when it did not |
| `bug_found` | Reticle finds a defect in the app under test | The **kind** of defect (`signal-contradicted`, `console-error`, …) and how it was found — never what it was found in |
| `feedback_submitted` | **Only** when you or your agent explicitly send feedback | The report — see [Feedback](#feedback). The AGENT's call does not wait for the network: the receipt says `accepted` (validated, redacted, queued), never `sent`, and a delivery that then fails is reported back on the agent's next tool result. `reticle feedback` typed by a human still waits, because a person at a terminal is owed the real answer |
| `identified` | **Only** when you run `reticle identify` | What you chose to tell us — see [Telling us who you are](#telling-us-who-you-are) |

**There is no per-tool-call event.** Tool usage is counted in memory and leaves once, inside `daemon_stopped`, as a histogram like `{"reticle_act": 40, "reticle_assert": 12}`. That is counts of tool NAMES from a fixed list we define — never arguments, results, selectors, or URLs.

**Parameter and flag NAMES are collected; their VALUES are not.** We record that `reticle_act` was called with `ref` and `action`, and that you ran `reticle serve --headed --port`. We do not record what you set them to. This distinction is the whole safety property, and it is absolute for CLI flags: `--http-token` holds a secret, `--drive` holds a URL, `--storage-state` holds a file path, so no flag value is ever sent. For tool parameters there is one narrow exception — a short, explicit allowlist of parameters whose values are enums _we_ defined (`action: "click"`), listed in [`argument-shape.ts`](../packages/server/src/telemetry/argument-shape.ts). A value outside that allowlist reports as `other`, so a future schema change cannot quietly start forwarding free text. `reticle_act`'s `args` — the text being typed into your app, which on a login form is a password — is **never** in that allowlist.

`daemon_stopped` carries: how long the session ran, how many tool calls and of which tools, how long each tool took (total and worst case), how many failed, how many verifications ran, browser/lease connection attempts with their failure causes, and which MCP clients connected (`claude-code`, `cursor`).

It also carries a snapshot of the **machine's** state — our own process's memory, free and total system RAM, load average and CPU count — taken at shutdown and again on any crash. This is what separates "your machine ran out of memory" from "Reticle has a bug", which otherwise produce identical-looking failures. No hostname, no username, no paths, no process list.

### Bugs Reticle finds

When Reticle catches a defect in the app it is verifying, it records **that a class of defect was found** — never what it was found in. The event carries the kind (`signal-contradicted`, `duplicate-request`, `console-error`, …) and how it surfaced, and nothing else: no selector, no URL, no element, no description of your app or its behaviour.

This is the number we use to say whether Reticle works at all, and the one we would publish. It is counted conservatively on purpose — a defect explained by a contradiction is not also counted as a failed assertion, because an inflated number would be worse than none.

### Errors and crashes

The SDK that runs inside your page reports its own failures too — an observer that could not start, a patch that would not install. It does this over the **local bridge it is already connected to**; the SDK still makes no outbound request of its own, and the daemon decides what (if anything) is reported onward. What travels is our module name (`network_observer`), the error type, and the message with variables stripped — never your page's URL, and never anything from your app.

Errors are grouped by a **hash of the error's shape**, with every variable part removed first — so `no baseline named 'checkout-v3'` and `no baseline named 'login'` become one anonymous group and neither flow name is sent. Alongside the hash we send that stripped shape (`no baseline named *`) and the tool that produced it, because a hash on its own can be counted but never understood.

A crash additionally carries **Reticle's own stack frames** — `resolveAnchor@act-tools.js:142` — plus the tool that was running, the preceding tool names, and the Node version and CPU architecture. Those frames are our published npm code, readable by anyone who unpacks the tarball.

**Stack frames belonging to your application are dropped entirely**, along with node internals. In the example below only the two Reticle frames survive; your file, your function, and your home directory do not:

```
at doCheckout (/Users/ada/secret-app/src/checkout.tsx:42:9)   ← dropped
at resolveAnchor (…/@reticlehq/server/dist/tools/act-tools.js:142:19)   ← sent
```

**One narrow exception, for the crash that otherwise says nothing.** A refused connection — `connect ECONNREFUSED` — has a stack that is _entirely_ node internals, so the rule above correctly keeps nothing and the report arrives with no location at all. Those crashes now also carry the failing **syscall** (`connect`), the **errno** (`ECONNREFUSED`), whether the target was **loopback** (one boolean), whether the port was **one of Reticle's own** (the enum `reticle` / `other`), and the innermost frame naming **Node's own source** (`node:net:1637`).

The address and the port number are used to compute those two answers and are then discarded — neither is ever sent. The Node frame is a line in Node's published source, not yours: it says a connect failed rather than a DNS lookup, and carries nothing about your machine, your app, or your directory layout. The frame is included **only** when the crash is a system error and no Reticle frame survived — the report that would otherwise be blind.

`project_profiled` carries: the framework and its major version, a size **bucket** (`tiny` … `huge`, never a file count), whether it is a monorepo, its age in whole **weeks**, how many saved flows/baselines/runs exist, and which Reticle feature families have been used. It also carries whether the project has git at all, whether it has ever been pushed (`none` / `local_only` / `remote`), and which forge hosts it — `github`, `gitlab`, `bitbucket`, `azure`, `sourcehut`, `codeberg`, or just `self_hosted` for anything else. A private git host is usually `git.<company>.com`, so self-hosted repos report **only** that they are self-hosted, never the hostname.

This is how we learn whether people are getting value from the whole product or only a corner of it. No file names, no paths, no flow names, no dependency list.

Every event carries the same few fields:

| Field | What it is | What it is not |
| --- | --- | --- |
| `anonymousId` | A random UUID minted locally on first run, stored at `~/.reticle/telemetry-id` | Not derived from your name, email, hardware, or anything else about you |
| `projectId` | A one-way SHA-256 hash of the git origin URL, or of the directory path outside a repo | Not reversible — we can count _distinct_ projects, but not learn any project's name, URL, or location. Hashing the origin means one repo counts once instead of once per teammate and per clone |
| `actor` | Whether a person or an agent caused this — a typed `reticle` command is a person, an MCP tool call is the agent | Not a claim about _why_. Whether you asked your agent to verify, or it decided to, lives in a prompt Reticle never sees, and we do not guess |
| `sessionId` | A random id for this daemon run, held in memory and never written to disk | Not a device id and not persistent — a restarted daemon gets a new one. It only groups one run's own events together |
| `projectIdSource` | Whether `projectId` came from a shared git origin or from the local directory path | Not the origin or the path. It exists so we can tell when "how many people share this project" is a real measurement — outside a pushed repo there is nothing shared to hash, so those rows always show one user |
| `version` | The Reticle version running | — |
| `os` | The platform (`darwin` / `linux` / `win32`) | Not the OS version, hostname, or hardware |
| `ci` | Whether the run is inside CI | — |

There are no IP-based profiles, no cookies, no fingerprinting, and no person profiles: events are processed in "personless" mode, so they are never joined into an identity.

## What is never sent

Your code. Your app's DOM, network requests or responses, console logs, application state, or screenshots. File paths, project names, or git remote URLs. Your name, email, employer, or any account identifier. Environment variables. Anything typed into the app under test. The names of your flows, baselines, or tests. Error messages, and any stack frame belonging to your application.

A few of these are worth being explicit about, because they are the ones a product team is most tempted by:

- **We do not send your project's name or its GitHub URL.** `projectId` is a one-way hash. It lets us count distinct projects and see that a project came back next week; it cannot be turned back into a repository, and we cannot look you up from it.
- **We do not try to work out who you work for.** No domain sniffing, no email inference, no matching a repo against a company. If you _want_ us to know, [`reticle identify`](#telling-us-who-you-are) exists and you decide what it says.
- **We do not record what you asked your agent to verify.** The `verification_completed` event knows that a verification happened and how it turned out. The prompt behind it is not something Reticle can see, and we do not reconstruct it.

## Feedback

Reticle verifies apps for AI agents, and for a long time it had no way to hear when it got something wrong. An agent would hit a tool that misbehaved, work around it, and that knowledge would vanish at the end of the turn. The feedback channel is the fix — and because it is the only part of Reticle that transmits words someone wrote, it gets stricter rules than everything above.

**It is never passive.** There is no code path that sends feedback on its own. A `feedback` event exists only because one of these happened:

| Who | How | What it carries |
| --- | --- | --- |
| Your agent | Calls the `reticle_feedback` MCP tool — after a failure, **or to ask for a feature** | What it wrote: an analysis, or a request with the goal behind it, what would improve, and how it works around the gap today. Plus the model it is running, which it tells us because MCP cannot |
| You | Run `reticle feedback [--rating 1-5] [--bug] "your words"` | Your words and your rating |
| Your agent, before Reticle works | Runs `reticle feedback --agent --kind <bug\|gap\|ambiguity\|feature_request\|improvement> "what happened"` | The same words, filed from the shell. This exists for the phase where there is no daemon and no MCP tools — a failed `init`, half-finished wiring — which is the failure we are otherwise never told about |

Agents are instructed, in the tool description itself, never to include app source, secrets, or user data — to describe the failure in their own words instead.

**It is redacted before it leaves your machine.** Emails, credentials in URLs, `Authorization` headers and API-key assignments, recognizable vendor tokens (`sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`, JWTs), and home-directory paths are stripped and replaced with `[redacted]`. This runs client-side, in [`feedback.ts`](../packages/server/src/telemetry/feedback.ts), so you can read exactly what it removes rather than take our word for it. It is a safety net, not a guarantee — it cannot catch a secret that looks like an ordinary sentence, which is why the instruction above comes first.

**It shows you what it sends.** `reticle feedback` prints the exact payload before transmitting, and names any redaction rule that fired.

Alongside the report, a feedback event carries context about the environment it came from — never about you:

| Field | Example | Why |
| --- | --- | --- |
| `stack` / `stackMajor` | `next` / `15` | Which frameworks a bug actually affects. Major version only |
| `runtime` | `web`, `electron`, `tauri` | Desktop bugs look nothing like browser bugs |
| `engine` | `blink`, `gecko`, `webkit` | Coarse bucket, never the user-agent string |
| `driver` | `cdp`, `sdk` | Whether Reticle drove the page or observed your own browser |
| `client` | `claude-code`, `cursor` | The MCP client's own name from its handshake |
| `mcpScope` | `user`, `project` | How Reticle is registered |
| `kind` | `bug`, `gap`, `ambiguity`, `experience` | A defect, a blind spot, an undecidable verdict, or an overall take |

Plus the `version`, `os`, and `ci` fields every event carries. No paths, no project name, no dependency list, no user-agent string.

**It has its own off switch.** To keep the anonymous counters but never send free text:

```bash
RETICLE_FEEDBACK=0
```

Every switch in [Your choices](#your-choices) disables feedback too. If telemetry is off, feedback is off — and `reticle feedback` will tell you so rather than silently discard what you wrote.

## Telling us who you are

Everything above is anonymous, and stays that way unless you decide otherwise. If you want us to know who you are — to get support, to ask about an enterprise licence, or to be a design partner — there is one command, and running it is the only way it ever happens:

```bash
reticle identify --context company --company "Acme" --email you@acme.com
```

`--context` is the only required part, and `company | side_project | open_source | learning` is the whole vocabulary. You can say "this is a company" without naming it, or name it without leaving an email.

Before it sends anything, it prints what it will send and one thing worth reading carefully: **the identity is linked to this machine's anonymous id, so identifying yourself also connects the anonymous usage already recorded from this machine to what you enter.** That is what makes it useful to us, and it is why you are told before choosing rather than after.

To undo it:

```bash
reticle identify --forget
```

That deletes the local file and stops any further sends. To have what was already sent removed, email support@reticlehq.com.

## Where it goes

Events are sent over HTTPS to [PostHog](https://posthog.com) (US cloud), a product-analytics service acting as our data processor, and are used only in aggregate (counts, retention curves, tool popularity). We do not sell or share this data.

## Your choices

Telemetry is on by default and Reticle tells you so the first time it runs — once, in one line, with a pointer to this page. To see the current state at any time:

```bash
reticle telemetry status
```

Three ways to opt out, in whatever form fits your setup:

| Method | Scope |
| --- | --- |
| `reticle telemetry disable` | This machine, permanently (until `reticle telemetry enable`) |
| `RETICLE_TELEMETRY=0` | Wherever the variable is set — handy for CI or a fleet-wide profile |
| `DO_NOT_TRACK=1` | The [cross-tool convention](https://consoledonottrack.com) — Reticle honors it |

Opting out changes nothing about how Reticle works. A failed or blocked telemetry send never delays, alters, or fails a command either — sends are best-effort and asynchronous by design.

To also remove the locally stored random id, delete `~/.reticle/telemetry-id`.

## A note on data protection

The data described above is designed not to identify you: the only identifier is a locally minted random UUID, the project reference is a one-way hash, and no personal data is collected. We collect it on the basis of our legitimate interest in understanding and improving Reticle, we minimize what is collected to the fields listed here, and we honor every opt-out signal above. If you believe something in this design falls short of that intent, please open an issue — that is a bug, and we will treat it as one.

Any change to what is collected will be listed on this page and called out in the release notes of the version that introduces it.
