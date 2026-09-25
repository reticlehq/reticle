### Fixed

- **`@reticlehq/browser`: Escape reaches an app's modal from a component library too.** The last release stopped the HUD taking Escape while a native `<dialog>` was open. Radix, MUI and headless-ui modals are `role="dialog"` elements with `aria-modal="true"`, and those still lost their Escape to the HUD and the onboarding tour. Both now leave Escape alone while any visible app modal is open, and when the app has already handled the key. Found in #1019 by @DivyamTalwar.
