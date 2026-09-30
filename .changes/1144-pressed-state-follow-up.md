### Changed

- **`@reticlehq/core`, `@reticlehq/browser`: the documented element states include `pressed`.** A toggle button's `aria-pressed="true"` has been reported as `pressed` since #1144 landed, but the state lists in the predicate reference and the usage guide did not name it, so nobody knew to assert on it. Both lists now do, and a predicate-path test pins that `state: "pressed"` matches a pressed button and not an unpressed one.
