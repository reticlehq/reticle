### Fixed

- **`@reticlehq/server` — the OpenAI harness driver could not take a single turn on its own default model.** `gpt-5.6-luna` (and every current small GPT tier) answers HTTP 400 to a Chat Completions request that carries tools while reasoning is on, and every driving turn carries tools. The driver now sends `reasoning_effort: "none"`.

### Changed

- **`@reticlehq/server` — a Jev drive types field values with GPT when OpenAI is configured.** Jev picks every step but cannot write text, so the few fields its label heuristic cannot guess were filled by Anthropic, or by "reticle harness". GPT is now asked first, and a linked machine reaches it through the platform with its `rk_live_` key — so a Jev drive needs no provider key on the machine. Anthropic remains the fallback for a machine that holds only that key.
