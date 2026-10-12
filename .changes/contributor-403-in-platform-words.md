### Fixed

- **A permission the platform refuses is printed in its own words.** `reticle connect --project <new>` as a contributor is refused 403 because creating a project needs a maintainer, an admin or the owner; it was printed as "the platform refused your sign-in … Run `reticle login`". A 403 the platform explains as something other than a refused credential is now printed as it is worded, and nothing falls back to another project.
