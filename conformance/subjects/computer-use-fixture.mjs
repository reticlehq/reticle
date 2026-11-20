/**
 * The computer-use fixture application as a conformance subject: which control of
 * `adapters/realm/computer-use/native/mac/fixture.swift` plants which scenario.
 *
 * A scenario that is not here is one this subject cannot produce. The runner then refuses the
 * plant, and the scenario is scored `absent`, never `passed`.
 */
/** The title to put in the field first. With an empty title, Export writes an empty file. */
export const TITLE = 'Plan';

export const COMPUTER_USE_FIXTURE_SUBJECT = Object.freeze({
  // Export writes note.txt in the watched folder.
  'healthy-app-real-claim': { press: ['Export'] },

  // The file is there from the first press. The second press proves nothing about itself.
  'consequence-already-true': { press: ['Export'], warm: ['Export'], about: 'state' },

  // Fake says "Exported" and writes nothing.
  'effect-failed-surface-advanced': { press: ['Fake'] },

  // Later writes the file 800 ms after the press. The window is 300 ms.
  'verifier-ran-out-of-budget': { press: ['Later'], budgetMs: 300 },

  // Export writes to the folder the application was given. The realm watches another one.
  'outcome-in-an-unwatched-place': { press: ['Export'], watchElsewhere: true },

  // Dead does nothing, and nobody claimed that anything would happen.
  'nothing-declared': { press: ['Dead'], declareNothing: true },

  'claim-written-after-the-action': { press: ['Export'], declaredAfter: true },
});
