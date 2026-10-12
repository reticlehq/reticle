### Fixed

- **A Harness answer no longer says proved beside goals it did not reach.** Passed journeys over `goalMet: false` read "PROVED — 1 of 1 journey(s) passed" and `proved: true` while every goal said "no"; the run's verdict now follows its goals as well as its journeys, in the answer, the result block and the summary alike.
- **One goal that a text check cannot read no longer fails the others.** The goals were checked with one joint assertion, so a typed value (a field's value, which a text check does not read) turned every goal "no", including the end text the page showed. When the joint check fails each goal is checked on its own, and a goal the page showed when looked at is undecided rather than "no".
