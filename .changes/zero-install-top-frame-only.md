### Fixed

- **`@reticlehq/server` — a leased page no longer writes Reticle's HUD into a rich-text editor's content.** The zero-install reader ran in every frame, so it mounted the HUD inside an editor's editing iframe. Saving the form then stored the HUD markup in the app's data. This was seen in Dolibarr product and project descriptions, on 2 of 7 saves that changed nothing. The reader now runs in the top frame only. The top frame still reads same-origin iframes, as before.
