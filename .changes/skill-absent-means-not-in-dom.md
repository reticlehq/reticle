### Changed

- **`SKILL.md` — says what `absent` means, and to assert the requirement rather than a label.** `absent` means not in the DOM. A check that "the sidebar must not show the parent's text", written with `absent` alone, failed a correct app that kept the text hidden. The skill now says to add `visible: true` to assert that a thing is not shown, and to assert what the requirement names, not a label seen on one build: another correct build can name it differently.
