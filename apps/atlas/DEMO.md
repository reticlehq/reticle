# Atlas as the public demo

Atlas is the app a visitor points Reticle at when they have no app of their own to try. It is the hard fixture described in [README.md](README.md), served as a production build with Reticle instrumented in it, so verdicts carry `file:line` source pointers.

## Run it

From the repository root:

```bash
docker build -f apps/atlas/Dockerfile -t atlas-demo .
docker run -p 8080:8080 atlas-demo
```

- `PORT` sets the listen port. The default is `8080`.
- `ATLAS_RESET_MS` sets how often all visitor changes are wiped back to the seed data. The default is every 30 minutes.
- `GET /healthz` answers `ok`.
- There are no secrets. All state is in memory and shared by every visitor until the next reset.

Without Docker: `pnpm --filter @reticlehq/atlas build:demo && pnpm --filter @reticlehq/atlas start`.

## How a visitor connects

The page dials the Reticle daemon on the visitor's own machine. `reticle try <demo url>` is the intended path: it opens the page in a window it controls, and when the page's own SDK has not connected it supplies the connection itself.

To drive it from your own daemon, start that daemon with the build's public pairing token and the demo's origin:

```bash
RETICLE_TOKEN=atlas-public-demo RETICLE_ALLOWED_ORIGINS=https://<demo host> npx @reticlehq/server serve
```

The token is public on purpose. While that daemon runs, any page that knows the token can connect to it. Neither path has been tested against a deployed host yet.

## Demo journeys

| Journey | Controls |
| --- | --- |
| Filter shipments by status | `filter-all`, `filter-draft`, `filter-dispatched`, `filter-in_transit`, `filter-delivered`, `filter-held` |
| Search by reference | `search` |
| Page through results | `prev`, `next` |
| Scroll the virtualised list | `viewport` |
| Dispatch a shipment | `dispatch-<id>` |
| Hold several shipments at once | row selection, then `hold-selected`, which reports in `notice` |
| Acknowledge from the embedded panels | `open-shadow-ack`, `closed-shadow-ack` |
| Start and stop storage churn | `write-storm` |

## Defects a demo drive should surface

None are listed yet. This file lists only defects verified in `GROUND-TRUTH.md`, by driving the running app and watching what it does. That file has not been written. Until it is, a demo should claim no expected findings, and whatever a drive reports has to be checked by hand before anyone repeats it.
