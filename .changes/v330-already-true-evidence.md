---
'@reticlehq/server': patch
---

An `already_true` verdict now says WHAT was already true. It tells an agent its assertion held before the action, so the action proved nothing - and the next question is always "true how?", which was unanswerable: the pre-action reading decided that bit and was then discarded. Afterwards the action has run and the state may have moved, so the one moment that mattered is gone.

It costs nothing to keep, because the pre-check already holds the reading. Present only when the answer is yes; a verdict that was genuinely caused carries its own evidence and needs no baseline beside it.
