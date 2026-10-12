### Fixed

- **`@reticlehq/server` — a saved plan with a "Place order" flow could never pass from the dashboard, and the plan page called it failed.** A drive spec now carries `confirmDangerous`: a plan a person started (Run plan) replays its saved flows' own destructive steps, while any step the model decides keeps the guard and an agent's drive cannot set it. A replay the guard stops reads `not-taken`, with the reason, in the plan's journeys and steps, never `failed`.
