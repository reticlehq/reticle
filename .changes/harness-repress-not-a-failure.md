### Fixed

- **The Harness never grades its own extra press as a failure of the app.** It saved an item (the POST held), the app emptied the field, and the driver pressed Save again declaring the same POST; that second press was filed as a high-severity issue against the app. A failed check on a control whose same claim already held earlier in the drive is now undecided, in the Harness's answer and in the run it records. (A press on a disabled control was made undecided earlier in this release.)
