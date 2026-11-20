### Fixed

- **HUD — the settings switches had no accessible name.** Each switch and checkbox in the settings panel had no text and no `aria-label`. A screen reader said only "switch", and an accessibility audit of the app counted the HUD controls as unnamed. Each control now has the name of its setting as its `aria-label`.
