### Fixed

- **`@reticlehq/browser` — a select inside its label could not be found by its name.** For `<label>Seats <select>…</select></label>`, Reticle named the select with the label's whole text, every option included ("Seats Select Under 20 …"). So `{ role: "combobox", name: "Seats" }` matched nothing, while a browser names it "Seats". The name now leaves out the control's own content, the same as a browser. A textarea inside its label is fixed the same way.
