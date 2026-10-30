### Fixed

- **`@reticlehq/engine` — a check answered `no` when the page could not answer it.** When the page replied to an element or text check with an error, the engine read the reply as "no element matched". A `{ kind: "text", contains: "problems to fix" }` check then gave `verified: "no"` while `reticle_look` showed the text on the page. An agent that believes this "fixes" correct code. A failed reply now gives `unknown`, and the reason quotes the page's error.
