### Fixed

- **A `reticle_act {steps}` step nobody could judge no longer fails the journey.** A step whose click left the app for an external page was graded "no" with "session disconnected" observed, and a step whose target was missing answered "no" beside "Nothing was acted on and no verdict is possible". Both are now undecided and the answer says why; a step that was seen to fail still decides "no".
