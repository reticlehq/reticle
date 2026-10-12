### Changed

- **A dangerous control the agent named by its own words, with the consequence declared, no longer needs `confirmDangerous`.** `reticle_act_and_wait { target: { role: "button", name: "Place order" }, until }` (and a journey step with `target` + `expect`) is confirmed by that declaration. A `ref` or `testid`, harmless words ("Continue" on a button that posts a delete), or no declared consequence still refuse. A Harness drive never takes this path; its outward-action guard is unchanged.
