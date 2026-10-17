### Fixed

- **`@reticlehq/browser` — with the HUD exposed, any words it showed could prove a text check.** The act strip line was fixed alone; a plan line, a persona or a finding on the HUD still answered a `text` query and a visible-text `until`, so a check could come back `yes` on words the app never rendered. A text claim now reads the app's words only, hatch open or not, at the one place queries collect elements and read visible text. The HUD's controls stay reachable by role and test id.
