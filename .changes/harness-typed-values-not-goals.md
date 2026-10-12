### Fixed

- **The Harness no longer grades a value it typed as the journey's goal.** "Type "Nina release 2" … ends when the page shows "Generated script"" graded the typed value as a goal and called it "no". A quoted value the drive filled or typed is an input; the journey's end (its last text to show) is still graded even when it was typed, and absence goals are unchanged.
- **A plan's results reach the platform after its goals are graded**, with `goalMet` on each journey, so the platform no longer hears "passed" for a journey whose goals then came back unmet.
