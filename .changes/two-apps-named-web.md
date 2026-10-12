### Fixed

- **`@reticlehq/server` — two different apps whose package is `web` were linked to one dashboard project: link reused a project by name alone.** The link now records which repository and folder it is (a hash of the `origin` remote and the folder's path inside the checkout; neither leaves the machine), sends it when it creates a project, and does not reuse a project of the same name made for another repository. Every clone of one app agrees, so a clone still joins its own project.
