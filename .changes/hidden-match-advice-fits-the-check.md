### Fixed

- **`@reticlehq/engine` — the hidden-match advice named a field the element check refuses.** Every `hidden_match` answer said "add `visible: true`", which an element check rejects. An element check is now told to add `state: "visible"`, a text check `visible: true`.
