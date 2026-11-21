# bench-app — the primary app under test

**Job: integration proof (Vite + React) AND benchmark target.** It carries two of the three jobs, which is why its name understates it — it is the app most specs and every token benchmark drive.

- **Runs on** `:4310` in the battery (`:4312` standalone), started by `apps/e2e/run-ci.sh`.
- **Gated by** `real-world-tests`, `crawl-test`, `scroll-find-test`, `multi-agent-lease-test` and more.
- **Also the target of** `bench/harness/*` for token-cost measurement.
- **`static.html`** is a second Vite entry with the same Reticle wiring and no React tree. `replay-hydration-test` proves that replay does not wait for a hydration that cannot come (#1654).

It wires Reticle by hand (babel plugin + reading the pairing token) rather than through the Vite plugin, which is deliberate: it proves the manual path works. `apps/atlas` proves the plugin path.

**Do not** fold other fixtures into it. The vanilla apps are vanilla on purpose, and `atlas` has its own uninstrumented A/B mode this app does not.
