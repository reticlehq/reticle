# tauri-smoke

A real Tauri v2 app used to dogfood Reticle on Tauri. Vite + React frontend, Rust commands over `invoke`, and a deliberately planted false green.

Needs a Rust toolchain (`rustup`) plus the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

## Run it

```bash
npx @reticlehq/server serve        # once, anywhere
pnpm --filter @reticlehq/tauri-smoke dev
```

The app connects to the daemon on its own — there is no URL to open. Confirm with `npx @reticlehq/server status`. Point it at another port with `RETICLE_PORT=4401`.

The first run compiles the Rust side and takes a few minutes.

## What it demonstrates

`src-tauri/src/main.rs` exposes three commands. `archive_todo` **always returns `Err`**, and the frontend's Archive button removes the row, writes "archived", and swallows the rejection. The UI, a screenshot, and a DOM assertion all agree the feature works:

```
reticle_snapshot             → the row is gone, status reads "archived"
reticle_network {status:500} → ipc://archive_todo  status 500
                                "archive is not implemented in the backend"
```

See [docs/desktop.mdx](../../docs/desktop.mdx).

## The Reticle wiring

- `src/main.tsx` — `reticle.connect()`. Nothing desktop-specific: a Tauri `invoke` travels as a real `fetch` to Tauri's `ipc://` protocol, so Reticle observes it with no extra wiring. It also reads Tauri's `Tauri-Response` header, since the transport answers HTTP 200 even for a command that returned `Err` — which is exactly the `archive_todo` case above.
- `src-tauri/tauri.conf.json` — the CSP `connect-src` must allow the bridge WebSocket. This is the one required Tauri-specific step; without it the webview blocks the connection silently.
