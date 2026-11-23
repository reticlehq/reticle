### Fixed

- **`@reticlehq/server` — a flow with a bad step anchor failed to parse with no hint.** A component anchor with `of: 1` gave `flow_parse_failed` and "flow file is malformed", so an agent removed fields until the file parsed. Now the error names the step, the anchor field and the reason, for example `at step 0 anchor field "of": Too small: expected number to be >=2`. A component anchor with `nth` and `of` (2 or more) still parses. Part of [#2431](https://github.com/reticlehq/reticle/issues/2431).
