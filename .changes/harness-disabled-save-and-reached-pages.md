### Fixed

- **A click on a disabled control no longer fails its declared consequence.** The Harness saved an item, the app cleared the field and disabled Save, and the model clicked Save again declaring a POST; the verdict was "no — observed no calls", a finding against an app that did its job. When the page reports the target was disabled at dispatch and the consequence did not follow, `reticle_act_and_wait` is now undecided and says the control was disabled.
- **The Harness looks for a journey's end on the pages the drive reached.** A goal shown on a page the drive visited and then left (the saved item on `/saved-items`, the drive ending on `/`) was reported "not found after searching /". The hunt now searches those pages too, newest first.
