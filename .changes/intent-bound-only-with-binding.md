### Fixed

- **An intent is `bound` only while a check is bound to it.** After a team decision kept other words, the record still said `state: "bound"` with no binding, so a check naming it proved nothing and said nothing, and the agent ended believing the agreed words were proved. A record whose check was taken off is declared again, and `reticle_intent` lists it as needing a binding.
