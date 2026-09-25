### Fixed

- **`@reticlehq/server`: a replayed step that expects an element to be gone passes when it is gone.** A saved expectation such as `{ kind: "element", query: { testid: "toast" }, absent: true }` was replayed as "the toast must be present", so dismissing it failed on the correct outcome. The absence is now checked, and an element that stayed is still reported as drift. Pointed out by @DivyamTalwar in #1016.
