# trading-stream

**Job: benchmark target.** A Vite + React trading page on a high-rate WebSocket. `bench/high-rate-stream/measure.mjs` drives it. No gate runs it, because a live ticker floods a shared session (see rule 5 in `apps/README.md`).

- The tick rate is a URL knob: `/?rate=0` (off), `10`, `100`, `1000` or `5000` messages a second.
- Each tick writes the text of a price cell and sets its class (`up` or `down`).
- **Buy** sends `{"t":"order","orderId":"o-N"}`. About 100 ms later the server sends `{"t":"ack","orderId":"o-N","status":"filled"}`. The page then shows the row `o-N Filled` and emits the signal `order.filled`.

Environment: `RETICLE_PORT` (the daemon that the SDK dials, default 14460), `RETICLE_TOKEN`, `APP_PORT` (default 14462), `RETICLE_MODE=outside` (no SDK), `VITE_RETICLE_CAPTURE_BODIES=1` (record frame payloads).
