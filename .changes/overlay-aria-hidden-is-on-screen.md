### Fixed

- **`@reticlehq/browser` — a control behind an open menu was graded `hidden_match` while it was on screen.** An open Radix menu or dialog marks the rest of the page `aria-hidden` (and `data-aria-hidden`), which hides it from assistive tech, not from the screen; the header's project picker and the menu's items read as hidden. That overlay marking no longer counts as hidden for visibility; an app's own `aria-hidden` still does.
