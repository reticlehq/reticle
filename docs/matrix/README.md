# Submitting a client-matrix record

[`MATRIX.md`](./MATRIX.md) says which MCP clients Reticle is known to work in. Right now most rows are **◐**: `init` writes a runnable entry where that client documents it, and **nobody has run that client**. Turning a ◐ into a ✅ takes about three minutes and is the single most useful thing an outside contributor can do for this project.

You do not tell us it works. You **run one command, run your client, and submit what came out**, the same shape as [CNCF's Kubernetes conformance](https://github.com/cncf/k8s-conformance) and for the same reason: a claim nobody can trace back to a machine and a commit cannot gate anything.

## The records are eight releases old

Everything in here was submitted against **2.5.0**. The repo ships **3.0.0**. Nothing has been re-measured since, so [`MATRIX.md`](./MATRIX.md) carries a banner saying so, and `matrix-freshness.test.ts` fails the unit gate if that banner is missing or names the wrong versions.

Two things follow. `apps/e2e/matrix.mjs` regenerates `MATRIX.md` and does not know about the banner, so **regenerating deletes it and the guard reddens**. That is deliberate: republishing stale rows should cost somebody a decision. And the guard goes green on its own the moment `docs/matrix/2.13.<something>/` holds one record, which is the outcome it is actually asking for.

## 1. The machine half (no client needed)

```bash
pnpm build
node apps/e2e/client-compat.mjs --only <client> --json /tmp/compat.json
```

That checks `init` writes a config where your client documents it, that it parses under **that client's own key**, and that the command inside it starts and advertises tools. It does **not** check that your client reads it, which is the whole reason step 2 exists.

## 2. The human half (this is the part that matters)

1. Run `npx @reticlehq/server init` in a real project.
2. **Restart your client.** Every one of them reads MCP config at startup; this is the step people skip and then report a bug about.
3. Ask it to list Reticle's tools. Note **how many** it lists.
4. Kill the daemon (`lsof -nP -iTCP:4400 -sTCP:LISTEN -t | xargs kill`) and use a Reticle tool again. Does the client recover on its own, or does it need a manual reconnect?
5. If anything failed, copy your client's error text **verbatim**. That sentence is worth more than the rest of the record put together; it is the only thing that says what your client actually thinks went wrong.

## 3. Submit it

Write `docs/matrix/<reticle-version>/<client>-<yourhandle>.json`:

```json
{
  "reticle": { "version": "2.5.0", "commit": "abc1234" },
  "client": { "id": "windsurf", "version": "1.2.3" },
  "host": { "os": "darwin 25.5.0", "node": "v22.14.0" },
  "checks": {
    "registered": true,
    "toolsVisible": 17,
    "survivedDaemonRestart": true,
    "clientError": ""
  },
  "verdict": "works",
  "by": "your-github-handle"
}
```

Validate it, regenerate the table, open a PR:

```bash
node apps/e2e/matrix.mjs --validate docs/matrix/<version>/<file>.json
node apps/e2e/matrix.mjs        # regenerates MATRIX.md
```

CI runs the same validator on every PR, so a malformed record fails before a human reads it.

## What the validator insists on, and why

- **`works` requires `checks.toolsVisible > 0`.** "It works" with no number is the self-report this whole flow exists to replace.
- **`broken` requires `checks.clientError`**, your client's own words, verbatim. A failure nobody can act on is worse than no record.
- **Every record needs a host and a version.** A cell nobody can place is decoration.

**A `broken` record is as welcome as a `works` one and passes exactly the same checks.** It is usually more useful: it is how we find out that a client changed its config path, or that our entry shape stopped being read. If your client does not work, that is the record we most want.
