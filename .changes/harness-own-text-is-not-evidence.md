### Fixed

- **`@reticlehq/server`: the Harness never proves a goal with text it wrote itself.** A drive asked to rename a saved plan stopped on the Plans list after two clicks and was graded proved on every quoted goal, because the plan it had just saved was named after the journey and that name quoted them all. A goal found only inside the journey, the plan's journeys or the names saved from them is now not found: the journey keeps looking for it, and if it is nowhere else it is not proved.
