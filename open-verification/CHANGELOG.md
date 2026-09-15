# Changelog

Notable changes to the **`open-verification`** package and to the **Open Verification Protocol** it publishes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Two numbers appear in every heading and they are not the same number. The **package** version is semver over the published TypeScript distribution. The **protocol** version, stamped as `OVP_VERSION`, is the specification an artifact was produced under. A package major may break the code an implementer imports while the protocol stands still, and most implementers import nothing. [VERSIONING.md](./VERSIONING.md) names all four numbers in play.

## [Unreleased]

Nothing yet. Changes arrive through [CHANGE-PROCESS.md](./CHANGE-PROCESS.md), and one touching the adjudication order arrives with the test vector proving an implementation can still agree with it.

## [3.0.0] — 2026-09-13 · protocol 1.0 · wire 1 · flow grammar 2

### Changed

- **The package left the vendor's npm scope.** `@reticlehq/openverification` is now `open-verification`, and the directory moved from `openverification/` to `open-verification/` at the same time. A specification published under the scope of the company that sells an implementation of it reads as that company's internal contract, whatever the licence says. The licence is unchanged at Apache-2.0 and the protocol did not move. Anything importing the old name must change its dependency; nothing about the schemas, the adjudication order or the wire moved underneath it.

- **The specification is now the authority, and `adjudicate()` is a reference implementation of it.** Section 7.1 used to read the other way round: "the reference implementation of this order is `adjudicate()`. Where an implementation disagrees with it, that function is what this specification means." That made the section unreviewable: it settled every disagreement by reading TypeScript, which a second implementation in another language cannot do, and it is precisely the vendor-decides failure [GOVERNANCE.md](./GOVERNANCE.md) names. It now says the document decides and a disagreement is a defect in the implementation. **The inversion was only safe because agreement became checkable rather than asserted**: the vectors below let an implementation establish agreement without reading the reference at all, and drift between prose and function shows up as a failing vector instead of an argument.

- **The normative keywords are pinned to BCP 14 with the RFC 8174 all-capitals clamp**, and the document states that everything in it is normative unless a section says otherwise. RFC 8174 exists because RFC 2119's "often capitalized" left the question arguable, and an arguable requirement is one two implementations read differently. A lower-case "should" here now provably binds nobody.

### Fixed

- **Two entries in section 11, "what this does not specify", had become false.** A list of gaps is the part a reader trusts most and the part that rots first, because closing a gap and deleting its entry are separate acts. The entry saying a driver could not resolve a reference is closed: `locate?()` on `Realm` is OPTIONAL and returns handles a later action can take, and it stays on the list struck through because the trade it leaves open is real. The entry saying no predicate language exists is corrected too: four evaluable forms are specified, `count`, `present`, `absent` and `measure`, published as `predicate.json`. Anything outside those four remains opaque, carried with a human rendering.

### Added

- **`vectors/adjudication.json`, eleven worked adjudication vectors, one per ground.** Each is `{ ground, input, expected }`, generated from the reference adjudicator and pinned to it by a test so the two cannot drift. This is the cheapest on-ramp the protocol has: no suite, no subject, no transport, no browser, just eleven inputs fed to your decision function. Agreement on all eleven means you agree with the adjudication order, and a disagreement names the exact clause you differ on, the ground being the join key between a sentence, a schema and a test.

- **Documents that were previously assumed rather than written.** [CONFORMANCE.md](./CONFORMANCE.md) states what conforming means, the classes, the profiles and the exact sentences you may and may not claim. [VERSIONING.md](./VERSIONING.md) separates the four version numbers. [EXTENSIONS.md](./EXTENSIONS.md) names which vocabularies are open, the `x-` naming rule and the receiver rule for unknown members. [SECURITY.md](./SECURITY.md) states the trust model and what this version does not defend against. `docs/GLOSSARY.md` and `docs/IMPLEMENTERS.md` carry the vocabulary and the implementer's path. Each existed before only as something a reader could infer from SPEC.md and get wrong.

- **Thirty JSON Schemas published to `dist/schema/*.json`**, at `$id` base `https://open-verification.dev/schema/v1`, generated from `src/` at build time rather than authored. The `v1` there is the PROTOCOL major, not the package major. An implementation in another language needs none of this TypeScript: validate against the schemas, check yourself against the vectors.

### Known limitations

Recorded for the same reason section 11 exists: a specification hiding its gaps is worse than a short one.

- **No second independent implementation exists.** One ships, written by this specification's author. Until somebody else reaches a profile there is no evidence this document describes anything other than one architecture, and that event is what [GOVERNANCE.md](./GOVERNANCE.md) makes the precondition for donating the specification to a neutral foundation.
- **The conformance driver has no transport binding.** The scenarios, the scoring and the driver exist and are tested; how the driver reaches your process is yours to wire, and no reference binding for the wire in section 12 exists.
- **Clause 10, `already-true`, is unreachable through the conformance binding.** The binding never supplies `consequenceHeldBefore`, so the scenario named for that ground cannot exercise the clause. The vector for it does, which is a second reason to start from the vectors rather than the suite.
- **`adjudicate()` has exactly one caller in the reference implementation's own monorepo, and that caller is the conformance binding rather than the product's verdict path.** The function the specification calls normative is driven by the thing that scores conformance, not by the thing that ships verdicts to users.
