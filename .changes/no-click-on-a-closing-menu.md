### Fixed

- **`@reticlehq/browser` — an act could land on a menu that was closing.** A click meant for the next menu landed on an item of the previous one while it animated shut (`data-state="closed"`) and reassigned an issue nobody had asked to change. An act aimed inside a menu, listbox, dialog or tooltip that is closing is refused with the reason; a trigger whose own menu is closed is still clicked, since that is how the menu opens.
