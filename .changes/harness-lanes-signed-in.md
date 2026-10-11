### Fixed

- **`@reticlehq/server` — a Harness plan's lanes started signed out.** Each lane leased a new browser that was not signed in, so a journey behind sign-in spent the whole run on `/login`. Lanes now start from what the caller's tab holds (its cookies and storage, seeded before the first navigation); when that cannot be copied, the lanes take turns in the caller's tab and the Harness log says so. A lane is graded where it drove: a goal any lane proved is proved, instead of being judged on the caller's tab.
- **`@reticlehq/server` — a persona's password in parentheses was typed with the bracket.** `(…, password: x!)` filled `x!)` and every sign-in was refused. An unquoted password stops at a closing bracket or a sentence's full stop.
