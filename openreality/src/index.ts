/**
 * The Open Verification Protocol.
 *
 * A protocol for establishing machine-verifiable evidence that an intended action produced a
 * claimed outcome in a real environment.
 *
 * Read `SPEC.md` for the normative document and `GOVERNANCE.md` for how it changes. To implement
 * it for a new kind of environment, extend `Realm` from `./spi/realm.js` — the compiler will tell
 * you what you have to answer, and the rules you must not break are already written.
 *
 * This package depends on `zod` and on nothing else. The JSON Schemas under `schema/` are
 * generated from these definitions at build time and are the language-neutral form of the same
 * contract, so an implementation in another language needs none of this code.
 */

export * from './vocabulary/subject.js';
export * from './vocabulary/channel.js';
export * from './vocabulary/determinism.js'; // DeterminismProfile / resumeStrategy — how a subject may be DRIVEN
export * from './vocabulary/fixture.js'; // FixtureRef / fixtureIsUsable — state a suite starts from
export * from './vocabulary/intent.js';
export * from './vocabulary/predicate.js';
export * from './vocabulary/realm-surface.js';
export * from './vocabulary/evidence.js';
export * from './vocabulary/verdict.js';
export * from './vocabulary/memory.js';
export * from './vocabulary/run.js';
export * from './spi/realm.js';
export * from './spi/witness.js'; // Witness — a vantage point that can look and cannot touch
export * from './spi/adjudicator.js';
export * from './registry.js';

// A working realm for something with no screen. Exported rather than kept as a sample, because a
// specification whose only implementation is the author's flagship has demonstrated nothing, and
// because an implementer asked to extend an eight-method abstract class deserves to read one that
// already does.
export * from './reference/service-realm.js';
