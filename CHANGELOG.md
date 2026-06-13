# Changelog

All notable changes to **`@syrin/iris`** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-06-11

First public release. Iris gives your coding agent **eyes** into your running web app and returns a
**verdict with evidence** instead of a screenshot.

### Added

- **The verify loop over MCP** — `look → act → observe → assert`. `iris_assert` evaluates a structured
  predicate against the live app and returns `{ pass, evidence, failureReason? }`, typically in ~100 tokens.
- **Six reaction types in one assert** — network calls, DOM changes, SPA navigation, console & errors
  (including "no errors during this flow"), animations, and app **signals**.
- **App signals** — `iris.signal()` lets your app emit the facts a screenshot can't see (the store
  committed, the webhook arrived); a bundled ESLint rule flags mutations that forgot to emit one.
- **Regression detection** — `iris_baseline_save` + `iris_diff` to catch silently removed elements or new
  console errors before they ship.
- **Source mapping** — DOM element → React component → `file:line`, on React 18/19 and Next.js (keeps SWC).
- **Autonomous crawler** (`iris_crawl`) that clicks every reachable control and classifies what breaks.
- **Declarative spec runner** (`@syrin/iris/test`) for signal-bound, headless verification specs.
- **The `iris` CLI** — bridge + MCP server, plus `iris drive` for a launched browser.
- **Single package, subpaths** — `@syrin/iris` ships the browser SDK (`.`), the server (`./server`), the
  spec runner (`./test`), source mapping (`./next`, `./babel`), and the lint rule (`./eslint`) — one install.

### Notes

- **Dev-only and localhost-only by default**; observers are additive and reversible, and the SDK is
  tree-shaken out of production. No telemetry.
- **Token efficiency** — a full verify loop is ~100 tokens vs ~7,300 for a full-tree snapshot (~73× on the
  common loop; ~1.8× full-tree-vs-full-tree). See [`docs/token-efficiency.md`](docs/token-efficiency.md)
  for the methodology and honest caveats.

[0.4.0]: https://github.com/syrin-labs/iris/releases/tag/v0.4.0
