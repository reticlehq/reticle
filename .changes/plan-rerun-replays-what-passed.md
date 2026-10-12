### Fixed

- **A plan rerun replays the journeys that passed before.** A journey whose earlier run passed and saved its flows was re-driven by the model on every rerun, at a model's cost, and could then fail. The daemon now reads the plan's history: a journey that passed replays the flows it saved, the model drives its goal only when those replays decide nothing, and a replay that fails is reported as a regression, never re-driven into a pass.
