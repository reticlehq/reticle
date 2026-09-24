---
'@reticlehq/engine': patch
---

A throttled tab no longer downgrades a verdict its own evidence contradicts. The starved-tab caveat exists because a negative reading on a starved tab may mean "I could not look" - but inside a composite, a sibling arm that FOUND an element is direct proof that looking worked, on that tab, in that evaluation. Reported from the field as the sharpest form of the most frequent condition in the whole export: a negative arm inside `allOf` graded "unknown / this tab is throttled and has not rendered" in the same evaluation where three sibling arms returned rendered, visible, in-viewport elements.

Keeping the caveat there turned a real product failure into `unknown`, which an agent re-drives or walks away from, so the defect it was holding proof of never reached anybody.

Unchanged where nothing was seen: if no arm found anything, the tab may genuinely never have rendered and the caveat still applies. An arm unreadable for its own reason - an unparseable locator, a superseded window - stays unreadable however well its siblings did.
