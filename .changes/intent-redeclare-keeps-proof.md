### Fixed

- **`@reticlehq/core`, `@reticlehq/server` — saying an intent again no longer erases that it was proved.** Declaring an intent that already existed replaced it with a fresh unproved one, so re-saving a flow — which re-declares and re-binds its intent — dropped the proof every time. Same wording now keeps the check and the proof; different wording records the amendment and clears the proof, because a changed promise has not been proved yet. Binding the identical check again changes nothing; binding a different one clears the proof for the same reason.
