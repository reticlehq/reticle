### Fixed

- **`@reticlehq/server`, `@reticlehq/core` — the "not linked" Harness refusal spoke to the agent and the person in one sentence.** The HUD showed the person a sentence written for the agent ("drive the journey yourself with reticle_act_and_wait…"), it promised "10 free credits" (free credit is now granted once per person, so the engine cannot know the balance), and it did not say that the person runs the command. Now:
  - The agent gets the code `harness_not_linked` and `next` as data, beside a short sentence: `[{ "who": "human", "run": "reticle connect" }, { "who": "agent", "tool": "reticle_act_and_wait" }]`.
  - The HUD shows the person one sentence: "Connect your Reticle account to run the Harness: `reticle connect`."
  - The refusal is recognized by its code, not by its words, so rewording it no longer turns it into "this may be a defect in Reticle".
  - `reticle_session { action: "account" }` no longer promises "10 free credits" to a signed-out user either.
