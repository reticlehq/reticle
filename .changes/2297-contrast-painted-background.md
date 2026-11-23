### Fixed

- **`@reticlehq/browser`: a text check read the wrong background for text on a positioned panel.** The contrast check read only the DOM ancestors of the text. Dark text on an absolutely positioned white panel inside a black frame was read against the black frame, so the check reported a contrast of about 1:1 and the verdict was `unknown`. The check now reads the colours painted under the centre of the text. When the hit test does not reach the text, it reads the ancestors as before. Closes [#2297](https://github.com/reticlehq/reticle/issues/2297).
