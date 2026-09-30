### Fixed

- **`@reticlehq/engine` — an `absent` or `not` check could pass before the thing it rules out happened.** A wait settled on its first passing reading, and a claim that something did NOT happen is true at the start of every window. So a clean-console check passed on a page whose `console.error` landed a few milliseconds later, most often on a slower page or machine. Absence and negation now hold for the same short confirmation window an exact count already did, and fail if the ruled-out event arrives in it. The cost is that window, on those checks only.
