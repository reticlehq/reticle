# api — the backend the battery drives against

**Job: support infrastructure.** Not an app under test — it is the HTTP server the web e2e specs need so their requests hit something real, with real latency, real status codes and real failure modes.

- **Runs on** `:8787`, started by `apps/e2e/run-ci.sh`.
- **Gated by** the whole web battery (`pnpm test:e2e`) — several specs assert against its endpoints.
- **Also used by** the bench harnesses in `bench/`.

It deliberately serves broken endpoints (`/api/broken/*`: 404, 500, CORS, wrong format, wrong data) and a write that is not visible until `REFLECT_MS` has passed — an app that only ever succeeds cannot exercise a verification tool.

**Do not** grow this into a demo app. If you need UI, that is `bench-app`.
