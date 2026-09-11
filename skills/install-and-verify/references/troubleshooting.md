# Troubleshooting

## `reticle_sessions` returns an empty list

This is the most common failure by a wide margin, and it almost always means **the SDK is not in the page**.

Start by reading the `why` field on the empty result. The daemon can see whether a session was ever here, whether a dev server is listening, and whether this project has been through `init`. Work the checklist only if `why` leaves you unsure.

**If nothing is listening, start the dev server yourself**: the project's own script from `package.json`, in the background, with one line to the user saying it is running and how to stop it. Never start a second one, never guess the command, never kill anything, and leave the permission prompt to your host.

**If something IS listening, do not tell the user to start a dev server.** They are running one. That answer ends the conversation with nothing fixed; the cause is below.

### 1. Is the SDK imported and called in the app entry?

Read the files. Do not trust the `init` report.

- Vite: `reticle()` in the `plugins` array of `vite.config.*`. The plugin injects the connect itself; there is no import in `main.tsx` to look for.
- Next.js: `withReticle` wrapping the export in `next.config.*`, plus a `reticle-dev.tsx` that is actually mounted in the root layout or `_app.tsx`. A file that exists and is never rendered is the usual shape of this failure.
- Anything else: a dev-guarded `reticle.connect()` in the entry module. See [setup.md](setup.md).

**Read the browser console.** The SDK announces its own failures.

- `[Reticle] could not reach the bridge at ws://localhost:<port>` means the SDK loaded fine and the daemon or port is wrong. Skip to items 3 and 4. The message names the port the app is dialling.
- `[Reticle] Reticle is disabled outside localhost unless allowNonLocalhost is explicitly enabled` means item 3 below.
- **No `[Reticle]` line at all** means the SDK never loaded. That is this item.

### 2. Is the dev server actually serving that entry?

- **A config change needs a dev server restart.** Vite does not hot-reload `vite.config.ts`. A server that was already running keeps serving an app with no SDK in it, silently. Restart it, then hard-reload the tab. The same applies to any framework that registers plugins from a directory: Nuxt does not pick up a newly created plugin file on a running server.
- **A production build will never connect.** The SDK is dev-only by design. Check the user is on `npm run dev`, not a `preview` or `start` of a built bundle.
- Confirm the tab's URL is the app this project serves, and not a stale tab pointed at an old port.

### 3. Is the connect guarded on `hostname === 'localhost'`?

This is the failure that leaves **every other check healthy**. The daemon is up, the port is right, the SDK is wired, `doctor` is all green, and the refusal happens in the page.

- The guard is false on every non-localhost dev host: a hosts-file alias, a LAN IP, a tunnel, a white-label or multi-tenant or cookie-domain setup.
- `window` does not exist during SSR, so on any server-rendered framework the guard throws or the branch never runs.

Replace it with the framework's build-time dev flag (`import.meta.env.DEV`, `process.env.NODE_ENV !== 'production'`, `import.meta.dev`) plus a client-only boundary.

If the app really is served from a non-localhost origin in dev, the SDK refuses to connect until told:

```ts
reticle.connect({ allowNonLocalhost: true });
```

### 4. Is the bridge port the same number on both sides?

The app's bridge port must equal the daemon's.

- App side: `reticle({ port: N })` in `vite.config.ts`, or `connect({ url: 'ws://localhost:N/reticle' })`. Omitted means `4400`.
- Daemon side: `.reticle.json` `"port"` or `RETICLE_PORT`. Omitted means `4400`.

They must be the same number, and it must **not** be the dev server port. Simplest fix: remove the port from both and let them default to `4400`.

Check the daemon is actually up on that port:

```bash
npx @reticlehq/server status   # lists running daemons and connected sessions
```

Nothing there means the daemon was never launched (restart the client) or it is on a different port than the app.

### 5. Missing pairing token

Only on paths with no build step to inline it (plain static HTML). The bridge rejects a connect without a token and the console says "bridge refused the connection: authentication failed". Pass it in the call; see setup.md.

## The `reticle_*` tools disappeared mid-session

The MCP proxy lost its stream to the daemon. It reconnects on its own and replays the handshake, so this usually heals without anyone doing anything. `npx @reticlehq/server status` confirms the daemon stayed up.

`~/.reticle/mcp-proxy.log` records every drop and reconnect with a reason (`sse_ended`, `sse_error`, `connect_error`) and the attempt number. It is the only place this is visible; the disconnect is silent from your side.

If the tools stay gone, the proxy has stopped retrying, not stopped serving. Call a tool again: the next request wakes it and starts a daemon. If a call still fails, use the CLI for anything that does not need the tools: `npx @reticlehq/server status | doctor | open | drive`.

## "Failed to reconnect to reticle: -32000"

The `reticle mcp` proxy exited before the MCP handshake completed.

1. **Stale npx cache is the most common cause.** `npx` may keep running an old `@reticlehq/server` after a new one is published, and a version mismatch between proxy and daemon makes the proxy exit immediately.

   ```bash
   npx --yes @reticlehq/server@latest version
   npx @reticlehq/server stop
   ```

   Then restart the client. `/mcp` does not respawn the stdio proxy; only a restart does.

2. **A Stop hook killing the daemon between turns.** Check `~/.claude/settings.json` for a hook running `reticle stop`. Remove it. The daemon must stay alive across turns; killing it forces a cold spawn on every reconnect, and a spawn slower than 10 seconds times the proxy out.

3. **The daemon is crashing on startup.** `tail -30 ~/.reticle/daemon-4400.log` and look for `reticle_daemon_start_failed` or `reticle_mcp_daemon_unavailable`. If the port is taken, `lsof -i :4400` to find the process.

4. **A project-level MCP config overriding the user-level one.** Check with `claude mcp list`; it should show `reticle -> npx @reticlehq/server mcp` with no `--port` and no pinned version. If a project `.mcp.json` or `.claude/mcp.json` pins a version in its args, move it aside and re-register:

   ```bash
   claude mcp add reticle -s user -- npx @reticlehq/server mcp
   ```

Tell the user which one it was.

## Multiple projects, port conflicts

`reticle mcp` reads `.reticle.json` in the current working directory, so agents in different project directories reach different daemons automatically. Give each project its own port when running several at once, and remember to set the same number in the build config.

```bash
npx @reticlehq/server stop --port 4400
npx @reticlehq/server status
```

Killing a daemon by port from the shell needs care: `lsof -ti tcp:4400 | xargs kill -9` also kills the `reticle mcp` proxy, which is the usual cause of a self-inflicted "MCP disconnected". Use `lsof -ti tcp:4400 -sTCP:LISTEN`, or just `npx @reticlehq/server stop`.

## No Chromium or Playwright is needed

Reticle does not download Chromium for normal agent workflows. The SDK runs inside the user's own browser and you see the DOM, network, console and state through the WebSocket bridge. Playwright is only installed if you explicitly call `npx @reticlehq/server serve --drive <url>` or `npx @reticlehq/server verify`, which launch an autonomous browser for unattended automation.

To attach to a browser the user already has open:

```bash
# once, by the user:
# /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
RETICLE_CDP_URL=http://localhost:9222 npx @reticlehq/server mcp
```

## Report it

Any of these that cost you more than a minute is worth one call:

```
reticle_feedback { kind: "bug" | "gap" | "ambiguity", text: "what happened" }
```

or, if the tools are unreachable:

```bash
npx @reticlehq/server feedback --agent --kind bug "what happened"
```
