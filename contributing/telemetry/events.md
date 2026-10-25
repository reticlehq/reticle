# Telemetry events

> **For contributors, not users.** This page documents the event schema, so that a person who changes Reticle sends the right shape. It contains no field data. Every id, number and value in the examples is fake.
>
> To learn what Reticle collects and how to turn it off, read the user page, [`docs/telemetry.md`](../../docs/telemetry.md). Read the rules in [`contract.md`](contract.md) before you change anything that sends an event.

`TelemetryEventKind` in `core/src/telemetry.ts` is the closed list of kinds. When this page and that file disagree, the file is correct and this page has a bug. Two guards hold the names: `server/src/guards/docs/telemetry-events-are-documented.test.ts` fails when a kind is missing from this page or from the user page, and `server/src/telemetry/telemetry-contract.test.ts` fails when a kind is missing from the contract.

| File | Defines |
| --- | --- |
| `core/src/telemetry.ts` | `TelemetryEventKind`, the envelope, and most payload blocks |
| `core/src/telemetry-session.ts` | `SessionSummarySchema`, `ProjectProfileSchema`, `MachineSnapshotSchema` |
| `core/src/telemetry-feedback.ts` | `FeedbackSchema`, `IdentitySchema` |
| `core/src/telemetry-signals.ts` | the `hud`, `link`, `harness`, `proxyExit`, `daemonDeath` and `wakeRefusal` blocks, the `spawnMethod` scalar, and the account and client fields |
| `core/src/telemetry-bug.ts` | `BugFoundSchema` |
| `server/src/telemetry/telemetry.ts` | `emit()`, which builds every event and flattens its block |

## How to read this page

- Each event has the same parts: **When**, **Why**, **Unit**, **Fields** and **Example**. Some have a **Trap**.
- **Unit** says what one row counts. Read it before you count rows.
- The example is the `properties` object of the PostHog `capture` call. `emit()` flattens each block under its own prefix: `verification.verified` arrives as `verification_verified`. The `versionChange` block arrives under the prefix `version_`.
- The examples show the fields of the event and a few envelope fields. Every event also carries the full envelope below.

## The envelope

`TelemetryEventSchema` wraps every event. These fields can be on any kind.

| Field | Type | Present | Meaning |
| --- | --- | --- | --- |
| `v` | literal `3` | always | `TELEMETRY_EVENT_VERSION`. It changes when the shape changes, so you can segment old senders. |
| `anonymousId` | string | always | A random UUID in `~/.reticle/telemetry-id`. It is the PostHog `distinct_id`: one machine, not one person. |
| `projectId` | string | always | A one-way hash of the normalised git origin, else the git root, else the package root, else the working directory. |
| `projectIdSource` | `ProjectIdSource` | always | `git_origin`, `git_root`, `package_root` or `cwd`. Only `git_origin` rows compare across machines. |
| `sessionId` | string | session-scoped kinds | One daemon run. See [Session scope](#session-scope). |
| `ts` | int | always | The client clock, epoch ms. |
| `version` | string | always | The Reticle version that sends the event. |
| `ci` | boolean | always | The `CI` variable is set. |
| `os` | string | always | `process.platform`. |
| `tzOffsetMin` | int | always | Minutes from UTC. No location. |
| `actor` | `TelemetryActor` | some kinds | `human` or `agent`. |
| `automation` | `AutomationHint` | when set | `agent_sandbox`, `ci_runner`, `container` or `hosted_workspace`. A hint, never a filter. |
| `installSource` | `InstallSource` | always | The declared install route: `skill_file`, `npx_skill`, `plugin`, `install_script`, `docs_site`, `readme`, `blog`, `cli_direct` or `unknown`. Read once per process: `.reticle.json` first, then `RETICLE_INSTALL_SOURCE`, then `~/.reticle/install-source`. |
| `internal` | `true` | team machines only | `RETICLE_INTERNAL=1`, or `~/.reticle/telemetry-internal` exists. Remove these rows from every user count. |
| `idEphemeral` | `true` | when the id file cannot be written | `anonymousId` is new in each process. Do not count these rows as people. |
| `accountState` | `TelemetryAccountState` | always | `signed_out`, `signed_in` or `linked`. |
| `linked` | boolean | always | The project reports to a workspace. |
| `workspaceId` | string | linked projects | The workspace's platform id. Never its name, never an email. |
| `client` | `AgentClient` | when known | Which coding agent, normalised. `other` for a name not on the list. |
| `launch` | `LaunchMethod` | always | `npx`, `global`, `project` or `other`. |
| `licenseId` | string | licensed builds, active key | An opaque licence id. |
| `licenseStatus` | `LicenseActivation` | licensed builds | `active`, `missing`, `invalid` or `expired`. |
| `licenseKeyPresent` | boolean | when set | A licence key is in the environment. Never the key. |
| `$process_person_profile` | `false` | always | PostHog makes no person profile. |
| `$geoip_disable`, `$ip` | `true`, `"0.0.0.0"` | always | They keep the request address and a location off the row. |
| `$session_id` | string | session-scoped kinds | A copy of `sessionId`, for the PostHog session views. |
| `$groups` | object | licensed builds | `{ "organization": <licenseId> }`. |

Each event then carries at most one payload block: `feedback`, `command` and `flags`, `session`, `project`, `verification`, `versionChange`, `crash`, `identity`, `connection`, `init`, `onboarding`, `bug`, `refusal`, `outage`, `instrumentation`, `hud`, `link`, `harness`, `proxyExit`, `daemonDeath` or `wakeRefusal`.

> `emit()` builds its event from a list of keys that it names. A block that is not on that list is dropped with no error. The contract says which lists to change when you add a block.

### Properties that PostHog adds

PostHog adds some properties at ingestion. Reticle does not send them. Do not read them as Reticle fields.

| Property                     | Note                                                   |
| ---------------------------- | ------------------------------------------------------ |
| `$geoip_*`                   | Older rows only. Current senders set `$geoip_disable`. |
| `$transformations_succeeded` | Pipeline bookkeeping. Ignore it.                       |

## Session scope

`isSessionScoped()` in `core/src/telemetry.ts` decides if an event carries `sessionId`. Fourteen kinds are session-scoped:

`daemon_started`, `daemon_stopped`, `session_progress`, `mcp_client_connected`, `app_instrumented`, `project_profiled`, `verification_completed`, `bug_found`, `tool_refused`, `runtime_crashed`, `feedback_submitted`, `hud_viewed`, `hud_signin_prompted`, `harness_run`.

The other kinds are one-shot or come from the MCP proxy process. A per-process id on `reticle status` joins to nothing, so it is not sent.

`mcp_connection_lost` and `mcp_proxy_exited` come from the proxy, not the daemon, so they carry no `sessionId`. They carry `proxyId` instead. To join an outage to a daemon run, find the `mcp_client_connected` row with the same `connection_proxyId`: that row carries the daemon's `sessionId`.

## Join keys

| Key | Joins | Note |
| --- | --- | --- |
| `anonymousId` | every event of one machine | Not a person. Ephemeral ids (`idEphemeral`) count processes. |
| `projectId` | every event of one project | Comparable across machines only when `projectIdSource` is `git_origin`. |
| `sessionId` | the events of one daemon run | Session-scoped kinds only. |
| `proxyId` | `mcp_connection_lost`, `mcp_proxy_exited` and `mcp_client_connected` of one proxy process | `mcp_client_connected` also carries the daemon's `sessionId`. |
| `workspaceId` | OSS events and the platform's own analytics | Linked projects only. |

## Legacy kinds that still arrive

Old installs still send these names. No current code sends them. Remove them from v3 charts, or segment on `v`.

| Kind | Schema | Meaning in that version |
| --- | --- | --- |
| `invoke` | v1 | The CLI binary ran. Not a tool call. |
| `tool` | v1 | One tool call. The session summary replaced it. |
| `session_start`, `session_end` | v1 | Process start and end. |
| `install` | v1 | First run. `reticle_installed` replaced it. |
| `key_validation_probe` | v1 | A licence probe. |
| `instrumentation_stalled` | v3 | Removed. Use `daemon_started` minus `app_instrumented`, joined on `sessionId`. |
| `identified` | v3 | Removed with `reticle identify`. It is still in `TelemetryEventKind`; see below. |

---

## reticle_installed

**When:** the first real command on a machine. A probe (`--version`, `--help`, `telemetry`) on a new machine does not send it. The probe leaves `~/.reticle/install-pending`, and the next real command sends the event. Sent from `reportCliRun` in `server/src/telemetry/cli-telemetry.ts`. **Why:** the install count, and the route that brought the install in. **Unit:** one machine, once. A machine whose id file cannot be written sends none. **Fields:** the envelope. `installSource` is read when the event is sent, so a marker that an earlier command declared and `~/.reticle/install-source` remembered is on the row.

> **Trap:** before 3.8.0 the event went out on the first command of any kind. Agents often run `--version` first with no marker, so many older rows read `unknown`. For an older machine, read its route from the first `installSource` that is not `unknown` on any of its events.

```json
{
  "v": 3,
  "version": "3.8.0",
  "ci": false,
  "os": "darwin",
  "tzOffsetMin": 60,
  "projectId": "aaaaaaaabbbbbbbbccccccccdddddddd",
  "projectIdSource": "git_origin",
  "installSource": "npx_skill",
  "accountState": "signed_out",
  "linked": false,
  "launch": "npx"
}
```

There is no uninstall event. npm 7 and pnpm run no uninstall script. Infer churn from inactivity.

## cli_command_run

**When:** a `reticle` subcommand runs. Not for the internal `_daemon` spawn, and not for `mcp`, the agent's transport. Sent from `reportCliRun` in `server/src/telemetry/cli-telemetry.ts`. **Why:** which commands people and agents use. `verify` and `gate` mean much more than `status`. **Unit:** one command run.

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | string | The subcommand, from the closed list of known commands. Anything else is `unknown`. |
| `flags` | string list, up to 16 | The names of the flags that were present. Never their values. |
| `actor` | `TelemetryActor` | `agent` when a coding agent's marker is in the environment, else `human`. Versions before 3.8.0 send no `actor`. |

```json
{ "command": "gate", "flags": ["--since"], "actor": "agent", "client": "claude_code" }
```

## daemon_started

**When:** the daemon comes up. Sent from `server/src/telemetry/daemon-telemetry.ts`. **Why:** the denominator of every rate per daemon run. **Unit:** one daemon run. Most runs are an MCP spawn that never sees an app. **Fields:** the envelope, with `sessionId`, and one scalar.

| Field | Type | Meaning |
| --- | --- | --- |
| `spawnMethod` | `DaemonSpawnMethod`, optional | How the parent started the daemon. `detached`: a detached child, the start on macOS and Linux. `wmi`: Windows only, started through WMI, outside the Job Object of the parent. `wmi_fallback`: Windows only, the WMI start failed and the parent used the detached start. On Windows a detached daemon stays in the job of its parent and stops when that job closes. Absent for a daemon that started in the foreground, and from older senders. |

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000001",
  "installSource": "plugin",
  "client": "claude_code",
  "spawnMethod": "wmi"
}
```

## project_profiled

**When:** 5 seconds after `daemon_started`, once for each run. Sent from `server/src/telemetry/daemon-telemetry.ts`. **Why:** the stack and size of the project, and how much of Reticle it uses. **Unit:** one daemon run. Deduplicate on `projectId` before you count projects.

| Field | Type | Meaning |
| --- | --- | --- |
| `stack` | string, optional | The framework from `package.json`. |
| `stackSource` | `cwd` or `workspace` | Where the stack was found. |
| `stackUnknownReason` | `StackUnknownReason`, optional | Why there is no `stack`. Present only when `stack` is absent. |
| `stackMajor` | int, optional | The major version only. |
| `size` | `ProjectSize` | `tiny`, `small`, `medium`, `large` or `huge`. |
| `monorepo` | boolean, optional |  |
| `git` | `GitState` | `none`, `local_only` or `remote`. |
| `forge` | `RepoForge`, optional | `github`, `gitlab`, `bitbucket`, `azure`, `sourcehut`, `codeberg` or `self_hosted`. Never a private host name. |
| `ageWeeks` | int, optional | Whole weeks since the first commit. |
| `flowCount`, `baselineCount`, `visualBaselineCount`, `runCount`, `capsuleCount` | int | How many of each artifact the project has. |
| `hasContract` | boolean | A `.reticle/contract.json` is checked in. |
| `initialized` | boolean, optional | `reticle init` ran here. Absent means an older sender, never `false`. |
| `appConnectedBefore` | boolean, optional | An app for this project and port connected before. Absent means not measured. |
| `featuresUsed` | string list, up to 24 | The feature families the project used. |
| `featureDepth` | number, 0 to 1 | The share of feature families in use. |

> **Trap:** a daemon that is killed in its first 5 seconds sends no `project_profiled`.

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000001",
  "project_stack": "next",
  "project_stackMajor": 15,
  "project_stackSource": "cwd",
  "project_size": "medium",
  "project_git": "remote",
  "project_forge": "github",
  "project_flowCount": 3,
  "project_runCount": 12,
  "project_initialized": true,
  "project_appConnectedBefore": true,
  "project_featuresUsed": ["flows"],
  "project_featureDepth": 0.25
}
```

## session_progress and daemon_stopped

**When:** `session_progress` goes out every 5 minutes from a live daemon that did something in that window, and once from the MCP proxy when its input ends (`server/src/telemetry/proxy-telemetry.ts`). `daemon_stopped` goes out once, at a clean exit, and the exit waits for it. Both are sent from `server/src/telemetry/daemon-telemetry.ts`. **Why:** what a session did, as one row for each window. **Unit:** one window (`session_progress`) or one clean exit (`daemon_stopped`).

The block is `session`, a `SessionSummary`. Every count is windowed: it counts only what happened since the last event of the same `sessionId`. A session's total is the sum over all its `session_progress` rows and its one `daemon_stopped` row. The contract has the full summing rule.

| Field | Type | Meaning |
| --- | --- | --- |
| `durationMs` | int | How long the daemon was up. |
| `toolCalls`, `toolCounts` | int, map | Tool calls this window, and the calls for each tool name. |
| `toolErrors`, `errors` | int, list | Failed calls, and their distinct error shapes: `fingerprint`, `count`, the message with variables removed, and `tool`. |
| `sdkFailures`, `sdkErrors` | int, list | Failures that the page SDK reported. |
| `verifications`, `bugsFound`, `bugKinds` | int, int, map | Verdicts and defects this window. |
| `noSessionErrors` | int, optional | Calls that failed because no app was there to reach. |
| `postSocketFailures`, `postRetriesSaved` | int, optional | Proxy POSTs that failed at the socket, and how many a retry saved. |
| `consecutiveRepeats` | map, optional | The longest run of back-to-back calls of each tool. |
| `abandonedActions` | int, optional | Actions with no verdict after them. |
| `toolParams` | map, optional | Which parameters each tool received, by name. |
| `connections` | map, optional | Browser and lease connection attempts, successes and failures. |
| `toolTiming` | map, optional | `totalMs` and `maxMs` for each tool. |
| `busyMs`, `browserMs`, `browserCommands`, `peakConcurrentTools` | int | Time in tools, time waiting on the browser, browser commands, most calls in flight. |
| `unknownToolCalls`, `unknownTools` | int, map | Calls for a tool that does not exist, and the names. |
| `machine` | `MachineSnapshot`, optional | Memory, load and CPU count. No host name, user or path. |
| `clients`, `clientVersions` | list, map | The MCP clients seen, and their versions. |
| `surface` | string, optional | The tool surface that was live. |
| `appConnects` | int | How many times a page SDK connected. **Session lifetime, not windowed.** `0` means no app ever connected to this daemon run. |
| `msToFirstApp` | int, optional | Ms from daemon start to the first app. |
| `toolCallsBeforeApp` | int, optional | Tool calls that came before the first app connected. **Session lifetime, not windowed.** Absent when there were none. With `appConnects: 0`, it is the shape of an agent that worked against a daemon with no app. |
| `sdkVersion` | string, optional | The SDK version of the last page that connected, from its handshake. Our release number, or `other`. |
| `feedbackPrompted` | int, optional | How often Reticle asked for feedback. |
| `errorClasses`, `errorsRecovered`, `errorsRepeated` | map, int, int | Error buckets, and whether the next call worked. |
| `nudgesShown` | map, optional | The platform and Harness advisories shown, by `AgentNudgeKind`. |
| `updateNudged`, `updateOffered` | boolean, string | An agent was told about a newer version, and which one. |
| `hudControls`, `hudViewMs`, `hudPanelMs`, `hudSlides`, `hudJourney`, `hudJourneyCut` | maps, list, `true` | How a person used the in-page HUD, by ids from the closed `HUD_CONTROLS`. |
| `final` | boolean | `true` on `daemon_stopped`, `false` on `session_progress`. |
| `endReason` | final only | `never_used`, `client_left`, `explored`, `verified` or `abandoned`. |
| `exit` | final only | `idle`, `signal` or `unknown`. |
| `endedWithVerdict` | boolean, final only | The session produced a verdict. Sent as `false`, not omitted. |
| `lifetimeToolCalls`, `lifetimeVerifications`, `lifetimeBugsFound` | int, final only | Totals for the whole run. Never sum them. |

> **Trap:** do not count sessions with `daemon_stopped` alone. Most of its rows are `endReason: never_used` with `exit: idle`: a daemon that started and timed out. A daemon that served a tool call does not idle-exit, so it rarely reaches a clean stop. Count runs with `daemon_started`. Count working runs as the `sessionId`s that have a `session_progress` row or a verdict.

> **Trap:** the proxy's `session_progress` comes from a different process. It has its own `sessionId` and carries only the proxy's counts.

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000001",
  "session_final": true,
  "session_durationMs": 1830000,
  "session_toolCalls": 2,
  "session_toolCounts": { "reticle_session": 2 },
  "session_toolErrors": 2,
  "session_noSessionErrors": 2,
  "session_verifications": 0,
  "session_appConnects": 0,
  "session_toolCallsBeforeApp": 2,
  "session_endReason": "abandoned",
  "session_exit": "idle",
  "session_endedWithVerdict": false,
  "session_lifetimeToolCalls": 2,
  "session_lifetimeVerifications": 0,
  "session_lifetimeBugsFound": 0
}
```

## verification_completed

**When:** a verdict tool returns a verdict (`runTool` in `server/src/surface/tools/invoke-tool.ts`), or the spec runner finishes a check (`server/src/telemetry/run-telemetry.ts`). **Why:** the north-star step: an app was verified. **Unit:** one verdict. Several producers share this kind.

| Field | Type | Meaning |
| --- | --- | --- |
| `via` | string | The tool that produced the verdict. |
| `verified` | string | `yes`, `no`, `unknown` or `no-fault`. Reticle's honesty grade. |
| `passed` | boolean | The assertion held. Not the same as `verified`. |
| `falseGreenCaught` | boolean | `passed` and `verified: no`: a green that another channel refuted. |
| `durationMs` | int, optional |  |
| `browser` | string, optional | `headless`, `headed` or `attached`. |
| `brand` | `BrowserBrand`, optional | `chrome`, `edge`, `arc`, `dia`, `brave`, `opera`, `firefox`, `safari` or `other`. Absent when the page did not say. |
| `reason` | `VerifiedReason`, optional | Which clause of the honesty rule decided the verdict. Absent means unclassified. |
| `uncleanLoss` | `CaptureLoss`, optional | What was lost when `reason` is `unclean_capture`. |
| `driven` | `VerificationDriver`, optional | `harness` when Reticle's own drive produced the verdict. |
| `sdkVersion` | string, optional | The page SDK version from its handshake: our release number, or `other`. Compare it with the envelope `version` to find verdicts on a page that is older than the daemon. |

> **Trap:** split the producers before you count. `browser: headless` with `via: reticle_flow_verify` is the spec runner. `driven: harness` is the Harness. A replay carries no `reason`. A scripted client can send thousands of verdicts in a day from one machine, so report verdict machines next to verdict rows.

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000002",
  "actor": "agent",
  "client": "codex",
  "verification_via": "reticle_act_and_wait",
  "verification_verified": "yes",
  "verification_passed": true,
  "verification_falseGreenCaught": false,
  "verification_reason": "proved",
  "verification_browser": "attached",
  "verification_brand": "chrome",
  "verification_durationMs": 640,
  "verification_sdkVersion": "3.7.1"
}
```

## bug_found

**When:** a tool result or a spec run contains a defect. Sent from `runTool` in `server/src/surface/tools/invoke-tool.ts` and from `server/src/telemetry/run-telemetry.ts`. **Why:** the value that Reticle delivers. **Unit:** one hit of one defect.

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | `BugSource` | `contradiction`, `crawl`, `replay` or `assertion`. |
| `kind` | string | The finding kind from core's vocabulary, for example `signal-contradicted`. |
| `falseGreen` | boolean | The defect looked like a success. |
| `tool` | string, optional | The tool that found it. |
| `repeat` | boolean | This kind was reported before in this session. |
| `attribution` | `BugAttribution` | `app`, `request`, `reticle` or `unclassified`. Always present. |
| `fingerprint` | string, optional | An 8-character hash of the kind and route. |
| `occurrence` | int, optional | Which hit of this `fingerprint` in the session, from 1. Count `occurrence: 1` for distinct defects. |

The payload never carries a selector, a URL or a description of the app.

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000002",
  "bug_kind": "ui-advanced-request-failed",
  "bug_source": "contradiction",
  "bug_tool": "reticle_act_and_wait",
  "bug_attribution": "app",
  "bug_falseGreen": false,
  "bug_repeat": false,
  "bug_fingerprint": "a1b2c3d4",
  "bug_occurrence": 1
}
```

## tool_refused

**When:** a tool refuses a call. Sent from `server/src/telemetry/tool-refused.ts`. At most 50 for each daemon run. **Why:** why an agent that drives does not reach a verdict. **Unit:** one refused call, first 50 in a run.

| Field | Type | Meaning |
| --- | --- | --- |
| `tool` | string | The tool that refused. |
| `reason` | `RefusalReason` | `no_session`, `no_match`, `unsupported`, `bad_args`, `not_ready` or `other`. |
| `noSessionReason` | `NoSessionReason`, optional | For `no_session` only: which situation. |
| `retried` | boolean | The call before this one was the same tool, also refused. |

> **Trap:** `noSessionReason` is absent on many `no_session` rows. Absent means the refusal named no situation, not that the cause was simple.

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000002",
  "refusal_tool": "reticle_assert",
  "refusal_reason": "no_session",
  "refusal_noSessionReason": "tab_gone",
  "refusal_retried": false
}
```

## mcp_client_connected

**When:** an MCP client completes its handshake and names itself. Once for each proxy process: a reconnect of the same proxy sends nothing. Sent from `server/src/telemetry/mcp-connection.ts`. **Why:** which agents attach, and what the agent saw when it arrived. **Unit:** one proxy process on one daemon run.

| Field | Type | Meaning |
| --- | --- | --- |
| `reconnect` | boolean | `false` for the first attach to this daemon, `true` after. |
| `daemonAgeMs` | int | How long the daemon was up before this attach. |
| `client` | string, optional | The client's own name, at most 64 characters. |
| `appConnected` | boolean, optional | An app was already attached. Absent means not measured. |
| `proxyId` | string, optional | The id of the proxy process that attached. The same id is on that proxy's `mcp_connection_lost` and `mcp_proxy_exited` rows. |

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000001",
  "client": "cursor",
  "connection_client": "cursor-vscode",
  "connection_reconnect": false,
  "connection_daemonAgeMs": 1200,
  "connection_appConnected": false,
  "connection_proxyId": "9a9a9a9a-0000-4000-8000-000000000001"
}
```

## mcp_connection_lost

**When:** the MCP proxy loses its daemon. At most once for each stage and class (benign or fault) in a proxy process. The planned idle exit sends no `first` row. Sent from `server/src/surface/mcp/faults/mcp-outage.ts`. **Why:** transport stability. **Unit:** one stage of one outage in one proxy process.

| Field | Type | Meaning |
| --- | --- | --- |
| `stage` | `OutageStage` | `first`, `budget_spent` or `recovered`. |
| `reason` | `OutageReason` | `sse_ended`, `daemon_shutdown`, `sse_error`, `sse_aborted`, `sse_closed`, `sse_reset`, `connect_error` or `other`. |
| `attempts` | int | Reconnects tried when this was reported. Always 1 on `first`. |
| `pendingLost` | int | In-flight tool calls the drop killed. Sent also when it is zero. |
| `errCode` | `OutageErrCode`, optional | `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `ETIMEDOUT` or `other`. |
| `responded` | boolean, optional | The stream got a response before it failed. |
| `proxyId` | string, optional | The proxy process. Join it to `connection_proxyId` on `mcp_client_connected` to find the daemon's `sessionId`, the client and the project. |

> **Trap:** `daemon_shutdown` is the planned idle exit, not a fault. Versions before 3.8.0 send a `first` row for it. Remove those rows before you read an outage rate. Count `first` with a matching `recovered` as a short drop, and `budget_spent` with no `recovered` as tools that did not come back.

```json
{
  "outage_stage": "first",
  "outage_reason": "sse_reset",
  "outage_attempts": 1,
  "outage_pendingLost": 1,
  "outage_errCode": "ECONNRESET",
  "outage_responded": true,
  "outage_proxyId": "9a9a9a9a-0000-4000-8000-000000000001"
}
```

## mcp_proxy_exited

**When:** the MCP proxy process ends: its input ended, it was idle, its client went away many times, or a wake failed. Sent from `server/src/telemetry/proxy-telemetry.ts`, and the exit waits for it. **Why:** how often the agent loses its tools because the proxy left. `mcp_connection_lost` cannot see this. **Unit:** one proxy process.

| Field       | Type              | Meaning                                                    |
| ----------- | ----------------- | ---------------------------------------------------------- |
| `reason`    | `ProxyExitReason` | `stdin_end`, `idle`, `client_gone_storm` or `wake_failed`. |
| `uptimeMs`  | int               | How long the proxy ran.                                    |
| `drops`     | int               | How many times it lost its daemon stream.                  |
| `toolCalls` | int               | How many `tools/call` requests it carried.                 |
| `proxyId`   | string, optional  | The proxy process.                                         |

```json
{
  "proxyExit_reason": "stdin_end",
  "proxyExit_uptimeMs": 5400000,
  "proxyExit_drops": 2,
  "proxyExit_toolCalls": 31,
  "proxyExit_proxyId": "9a9a9a9a-0000-4000-8000-000000000001"
}
```

## daemon_died_unclean

**When:** a daemon start finds the pidfile of a daemon that never stopped cleanly. Sent from `server/src/telemetry/proxy-telemetry.ts`, called from `spawnDaemon` in `server/src/command/daemon/daemon.ts`. **Why:** how often a daemon dies with no clean stop: a kill, a sleep, a crash. **Unit:** one dead daemon found.

| Field   | Type | Meaning                                                               |
| ------- | ---- | --------------------------------------------------------------------- |
| `ageMs` | int  | Time from the dead daemon's start to this discovery. No pid, no port. |

```json
{ "daemonDeath_ageMs": 7200000 }
```

## wake_refused

**When:** the proxy finds its daemon port held by a program that is not Reticle, or by a Reticle daemon for another project. Once for each proxy process. Sent from `server/src/telemetry/proxy-telemetry.ts`, called from `server/src/command/cli/mcp-command.ts`. **Why:** how often a wake is refused, and by what. **Unit:** one proxy process.

| Field      | Type                  | Meaning                       |
| ---------- | --------------------- | ----------------------------- |
| `presence` | `WakeRefusalPresence` | `foreign` or `other_project`. |

```json
{ "wakeRefusal_presence": "other_project" }
```

## app_instrumented

**When:** the first app session reaches this daemon run. Sent from `server/src/telemetry/app-instrumented.ts`. **Why:** the second half of the install: a page with the SDK reached the daemon. **Unit:** one daemon run.

| Field | Type | Meaning |
| --- | --- | --- |
| `initialized` | boolean | `reticle init` ran here. |
| `agentAttached` | boolean | An MCP client was attached when the app arrived. |
| `msToFirstApp` | int | How long the daemon was up with no app. |
| `firstEver` | boolean, optional | `true` only on the first `app_instrumented` for this machine and project, claimed on disk under `~/.reticle/firsts/`. |

The failure side is a set difference: `daemon_started` minus `app_instrumented`, joined on `sessionId`.

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000003",
  "instrumentation_initialized": true,
  "instrumentation_agentAttached": true,
  "instrumentation_msToFirstApp": 42000,
  "instrumentation_firstEver": true
}
```

## init_completed

**When:** `reticle init` ends, with success or failure. Sent from `server/src/telemetry/init-telemetry.ts`. **Why:** whether the install works outside our fixtures. **Unit:** one `init` run.

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean |  |
| `reason` | string, optional | The classified cause of a failure. Never a raw error or a path. |
| `stack` | string, optional | The framework that `init` found. |
| `mcpRegistered` | boolean, optional | The MCP registration step worked. |
| `confirmation` | `InitConfirmation`, optional | What `init` saw after it wrote files: `connected`, `no_daemon`, `no_session` or `no_page`. |
| `stop` | `InitStop`, optional | The step where a failed runtime `init` stopped. Only with `reason` `dev_server` or `app_connection`. |

```json
{
  "init_ok": false,
  "init_reason": "dev_server",
  "init_stop": "port_busy",
  "init_stack": "vite",
  "init_mcpRegistered": true,
  "installSource": "skill_file"
}
```

## onboarding_step

**When:** a step of the install script, the tour or the first run starts, completes, fails, is skipped or is abandoned. Sent from `server/src/telemetry/onboarding-funnel.ts`. The first-run steps of the daemon come from `server/src/telemetry/onboarding-firsts.ts`. **Why:** where setup stops. **Unit:** it depends on the step.

| Steps | Unit |
| --- | --- |
| `install/*` | one install-script run |
| `first_look`, `first_act`, `first_verdict`, `driven`, `app_connected`, `verdict_produced` | once for each machine and project, with `firstEver: true`. Once for each process when the home cannot be written. |
| `next_step_offered` | one offer, then one `completed` row when the agent's next call follows it |
| `flow_recorded` | once for each daemon run, status and reason |
| other steps | one CLI run |

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | `OnboardingPhase` | `install`, `onboard` or `first_run`. |
| `step` | closed enum | A step name from `OnboardingSteps` in `core/src/onboarding.ts`. |
| `status` | `OnboardingStepStatus` | `started`, `completed`, `failed`, `abandoned` or `skipped`. |
| `elapsedMs` | int, optional | Absent means not measured, never zero. |
| `reason` | string, optional | The classified cause of a failure. |
| `stack` | string, optional | The framework. |
| `unattended` | boolean, optional | Nobody was asked anything. |
| `firstEver` | boolean, optional | The first time this machine and project passed this step. |
| `offered` | `NextStepOffered`, optional | Only on `next_step_offered`: `lease` or `init_consent`. |
| `nextFollowed` | boolean, optional | Only on a `completed` `next_step_offered`: the agent's next call did the offered step. |

| Phase | Steps, in order |
| --- | --- |
| `install` | `script_started`, `runtime_ready`, `cli_installed`, `agents_detected`, `mcp_registered` |
| `onboard` | `tour_started`, `concept_shown`, `first_look`, `first_act`, `first_verdict` |
| `first_run` | `project_detected`, `next_step_offered`, `instrumented`, `app_connected`, `driven`, `flow_recorded`, `verdict_produced` |

> **Trap:** `first_verdict` and `verdict_produced` record the same fact from two phases. Use one of them.

```json
{
  "onboarding_phase": "first_run",
  "onboarding_step": "next_step_offered",
  "onboarding_status": "completed",
  "onboarding_offered": "init_consent",
  "onboarding_nextFollowed": true
}
```

## hud_viewed and hud_signin_prompted

**When:** a HUD page or the account menu opens (`hud_viewed`), or the HUD shows a sign-in or link ask (`hud_signin_prompted`). Sent from `server/src/telemetry/hud-events.ts`, deduplicated in `server/src/telemetry/hud-metrics.ts`. **Why:** which HUD pages people use, and who sees the sign-up ask. **Unit:** one page, or one prompt surface, for each daemon run. The Agent Log that the HUD opens by itself is not a view.

| Field | Type | Meaning |
| --- | --- | --- |
| `view` | `HudPanel`, `hud_viewed` only | `chat` (Agent Log), `flows`, `notes`, `harness`, `report` (Impact), `settings` or `account`. |
| `surface` | `HudPromptSurface`, `hud_signin_prompted` only | `rail`, `harness` or `header`. |
| `tabs` | `CountBucket` | Tabs with a HUD at that time. |

```json
{ "sessionId": "5e5e5e5e-0000-4000-8000-000000000003", "hud_view": "report", "hud_tabs": "1" }
```

## platform_linked

**When:** a project on this machine is bound to a workspace for the first time. Sent from `server/src/telemetry/platform-linked.ts`. **Why:** the join from open source to the platform. **Unit:** one new binding. A re-run against the same project sends nothing.

| Field | Type              | Meaning                     |
| ----- | ----------------- | --------------------------- |
| `via` | `PlatformLinkVia` | `connect`, `hud` or `link`. |

```json
{ "link_via": "connect", "workspaceId": "org_fake0001", "linked": true, "accountState": "linked" }
```

## harness_run

**When:** a Harness run starts, and again when it ends. Sent from `server/src/telemetry/harness-run.ts`. **Why:** the Harness funnel by source. **Unit:** one `started` and one `completed` row for each run.

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | `HarnessRunPhase` | `started` or `completed`. |
| `source` | `HarnessRunSource` | `agent`, `hud`, `dashboard`, `cli_try` or `plan`. |
| `hosted` | boolean | The platform drives the run. |
| `outcome` | `HarnessRunOutcome`, completed only | `proved`, `not_proved`, `failed`, `blocked` or `stopped`. |
| `journeys`, `replayed` | `CountBucket`, completed only | Journeys answered, and how many replayed with no model. |
| `reason` | `HarnessRunReason`, optional | On `blocked` or `failed`: `not_linked`, `platform_unreachable`, `harness_off`, `no_credits`, `not_entitled`, `version_skew`, `broken` or `other`. |

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000004",
  "harness_phase": "completed",
  "harness_source": "hud",
  "harness_hosted": true,
  "harness_outcome": "blocked",
  "harness_reason": "no_credits"
}
```

## version_changed

**When:** a start of any `reticle` process runs a version that differs from the last version that ran on this machine, kept in `~/.reticle/last-version`. Also when `reticle update` or `reticle rollback` changes the version. Sent from `reportCliRun` in `server/src/telemetry/cli-telemetry.ts` and from `server/src/command/update/updater.ts`. The updater records the new version, so its move is not sent a second time. **Why:** upgrade adoption, and whether the update nudge caused it. **Unit:** one version move on one machine. The first start on a machine records the version and sends nothing.

| Field | Type | Meaning |
| --- | --- | --- |
| `from` | string | The last version that ran. |
| `to` | string | The version that runs now. |
| `direction` | string | `update` or `rollback`. |
| `nudged` | boolean, optional | An agent was told about exactly this version in the last 7 days. |

> **Trap:** before 3.8.0 the event came only from the updater, and an upgrade through `npx @reticlehq/server@latest` sent nothing. For older versions, compare `version` on a machine's events over time.

```json
{
  "version_from": "3.7.0",
  "version_to": "3.8.0",
  "version_direction": "update",
  "version_nudged": true
}
```

## runtime_crashed

**When:** an uncaught exception or an unhandled rejection reaches the top of the daemon. Sent from `server/src/command/daemon/daemon-resilience.ts`. A client disconnect (`EPIPE`, `ECONNRESET`, `ERR_STREAM_DESTROYED`) is not a crash. **Why:** stability. **Unit:** one fatal error that the process saw.

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | string | `uncaught_exception` or `unhandled_rejection`. |
| `errorType` | string, optional | The constructor name. |
| `fingerprint` | string, optional | A hash of the type and our own frames. |
| `message` | string, up to 300 | The message with every variable part replaced by `*`. |
| `frames` | string list, up to 12 | Reticle frames only, as `function@file:line`. |
| `tool`, `breadcrumb` | string, list | The tool in flight, and the tool calls before it. |
| `nodeVersion`, `arch`, `machine` |  | The runtime and the machine state. |
| `syscall`, `errno`, `loopback`, `port` |  | For a network error: the call, the symbolic code, a loopback target, and `reticle` or `other`. |
| `internalFrame` | string, optional | The innermost Node frame, only when no Reticle frame was left. |

> **Limit:** a killed process (SIGKILL, out of memory, a closed terminal) sends nothing. `daemon_died_unclean` is the trace of those.

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000005",
  "crash_kind": "unhandled_rejection",
  "crash_errorType": "Error",
  "crash_message": "connect ECONNREFUSED *.*.*.*:*",
  "crash_fingerprint": "ffff0000",
  "crash_frames": ["bridge.connect@bridge.js:10"],
  "crash_syscall": "connect",
  "crash_errno": "ECONNREFUSED",
  "crash_loopback": true,
  "crash_port": "reticle"
}
```

## feedback_submitted

**When:** an agent calls `reticle_session { action: "feedback" }`, or a person runs `reticle feedback`. Sent from `server/src/telemetry/feedback.ts`. Never sent without one of those two acts. **Why:** the qualitative channel. The only event with free text. **Unit:** one report.

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | `FeedbackSource` | `agent` or `human`. |
| `kind` | `FeedbackKind` | `bug`, `gap`, `ambiguity`, `feature_request`, `improvement` or `experience`. |
| `text` | string, up to 4000 | The report, redacted on the machine. |
| `trace` | string, up to 8000 | Agent only: the calls behind the report. |
| `rating` | int 1 to 5, optional | Human only. |
| `need`, `impact`, `currentApproach` | string, optional | Why it is wanted, what gets better, and the workaround today. |
| `model`, `client`, `clientVersion` | string, optional | Self-reported by the agent, and the MCP client. |
| `stack`, `stackMajor`, `runtime`, `engine`, `driver`, `mcpScope` |  | Where it happened. |
| `contact` | string, optional | A reply address, sent only when the person gave it for this purpose (`reticle feedback --contact`, or an agent that relays an address the user typed). Checked by core's `isFeedbackContact`. The one personal value that telemetry carries. |

```json
{
  "sessionId": "5e5e5e5e-0000-4000-8000-000000000006",
  "feedback_source": "agent",
  "feedback_kind": "gap",
  "feedback_text": "The assert did not see the toast after the modal closed.",
  "feedback_client": "claude-code",
  "feedback_stack": "next",
  "feedback_mcpScope": "user"
}
```

## identified

**When:** never, in this version. The command that sent it, `reticle identify`, was removed. Older versions can still send it. **Why:** it joined an anonymous machine id to a person who chose to give one. **Unit:** one declaration.

| Field     | Type               | Meaning                                                 |
| --------- | ------------------ | ------------------------------------------------------- |
| `context` | `UsageContextKind` | `company`, `side_project`, `open_source` or `learning`. |
| `company` | string, optional   |                                                         |
| `email`   | string, optional   |                                                         |

Reticle never infers an identity from a git remote, a git email or anything else.

---

## Checks before you add or change an event

1. Write the **Unit** for the event. If one user action can send many rows, add a counter to the session summary.
2. Give every failure and every stop a closed `reason`.
3. Put `sessionId` on every event that a daemon run owns, or a join key such as `proxyId` on an event from another process.
4. Add the field to the core schema, to `emit()` and to the `blocks` map, as [`contract.md`](contract.md) says.
5. Add a live check to `apps/e2e/specs/telemetry-events-test.mjs` that asserts the fields.
6. Add the kind or the field to this page and to [`docs/telemetry.md`](../../docs/telemetry.md).
7. Run `pnpm verify`, then `pnpm test:e2e`.
