### Added

- **`@reticlehq/server` — cloud sync carries page baselines and check strengths.** How each page normally behaves and how strong each flow's checks are were kept only on the machine that measured them. They now sync with the other derived records, so the cloud can tell a page that drifted from one that always behaved that way. Needs a cloud that accepts them.
