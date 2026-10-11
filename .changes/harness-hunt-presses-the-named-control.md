### Fixed

- **`@reticlehq/server`: the Harness presses the control the journey names before wandering.** A drive asked to "press Run plan" stood on the plan's page with the button in view, pressed the workspace switcher beside it instead, left its menu open over the page and went searching other pages. Looking for a journey's end now tries the controls the journey names on the page first, then toggles, then links away; closes any menu it opened that did not hold the goal; and reads a page's controls after it has settled, not while it is still loading.
