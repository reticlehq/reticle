### Fixed

- **A Run plan with no app tab opens one that carries the project, and never tells a linked account to connect.** The daemon opened the app's last known URL for the drive, but the tab carried the folder's `.reticle` root and no project, so a page that reports none landed in `unmatched/`, no credential resolved, and a linked Pro project was answered "a new account gets 10 free credits… run `reticle connect`". The tab the daemon opens now carries the project as well as the root, and a tab that belongs to no project drives on the daemon's own link.
