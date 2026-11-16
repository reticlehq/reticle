### Fixed

- **`@reticlehq/engine` — a click that changed only the control's own text read `action-had-no-effect`.** A Copy button that swaps its label to "Copied" after the clipboard write resolves changes itself a moment after the act's settle window closes, so the in-page mutation counter read 0 and the verdict called the control dead while the same window showed the label change. A text or attribute change on the acted element's own ref now counts as the action doing something; churn on other elements still does not. Closes [#2318](https://github.com/reticlehq/reticle/issues/2318).
