### Fixed

- **`@reticlehq/server`: a state path can read `.size` on a Set or Map, and a miss says what the collection holds.** Before, `selectedIds.size` on a Set missed and reported `availableKeys: []` and `totalKeys: 0`, stating as fact that a populated collection was empty. Named members of a Set can be checked for membership, and a Map's string keys are listed. Contributed by @vaibhav8a in #954; @tagadearpit's #945 fixed the same thing.
