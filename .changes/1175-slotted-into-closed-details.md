### Fixed

- **`@reticlehq/browser`: content slotted into a closed `<details>` inside a component's shadow root reads hidden.** Light-DOM content renders at its slot. The visibility walk went from a slotted element straight to the host and never passed the `<details>` around the slot, so `reticle_look` and `state: "visible"` reported it visible while the disclosure was closed. The walk now follows `assignedSlot`, and a `<summary>` slotted into the same disclosure stays visible. Closes [#1175](https://github.com/reticlehq/reticle/issues/1175).
