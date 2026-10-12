### Security

- **`@reticlehq/server` — `reticle_record stop` handed the recorded password back to the agent in plain text.** The flow saved from a recording already carried `<redacted: supply at replay>` for a credential field, but the compiled program `stop` returns showed the value as typed, so the secret entered the agent's transcript. `stop` now returns the program redacted by the same rule as the saved flow; an in-session replay still types the real value.
