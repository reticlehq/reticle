# Conformance

How an implementation of the Open Verification Protocol establishes what it may truthfully claim, and what it may not. The keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. What conformance means here

Conformance means one thing: given the same evidence, your implementation reaches the same verdict as the normative adjudication order in [SPEC.md](./SPEC.md) section 7.1, and it declares truthfully what it could and could not see. It is an agreement about meaning, not about quality: that your `unknown` is the specification's `unknown`, and that your `yes` was paid for with independent, consequence-grade evidence over a cleanly closed window. It says nothing about whether you find real defects.

There is no certification body, no mark and no registry. You run the suite and publish what it says. The specification's author also sells an implementation, stated plainly in [GOVERNANCE.md](./GOVERNANCE.md).

## 2. Conformance classes

The classes follow the SPI split in `src/spi/`, and are about which interface you implement.

**Witness.** A vantage point that observes and cannot act. It MUST provide `identity()`, `channels()`, `openWindow()`, `observe()` and `coverage()`, MUST NOT return a constant `instance`, MUST declare each channel's independence and grade truthfully, and MUST report blind spots positively: an empty `coverage()` is a claim, not a default. A Witness MUST NOT expose any way to act.

**Realm.** A Witness that can also be driven. It MUST provide everything a Witness does, plus `determinism()`, `capabilities()`, `describe()` and a protected `dispatch()`. `dispatch()` MUST report only that an action was accepted, never that it worked. `perform()` is sealed, refuses undeclared capabilities on your behalf, and MUST NOT be overridden. `locate`, `detect`, `photograph`, `applyFixture`, `captureFixture` and `mutate` are OPTIONAL; declining them is a correct answer. A Realm MUST NOT expose any method returning a verdict: a realm that could decide whether its own action succeeded would be the thing under test grading its own work.

**Adjudicator.** A decision function over evidence. It MUST evaluate the eleven clauses of section 7.1 in order and MUST return the deciding `ground` beside the verdict. The grounds, in clause order: `nothing-declared`, `channel-not-observed`, `contradicted`, `assertion-failed`, `window-not-closed`, `coverage-impeached`, `suspicion-unresolved`, `declared-after-action`, `no-independent-consequence`, `already-true`, `proved`. Verdicts are `yes`, `no`, `unknown` and `no-fault`. Only grade `consequence` may buy a `yes`, and `unknown` MUST NOT be collapsed into either neighbour. `adjudicate()` in `src/spi/adjudicator.ts` is a reference implementation of that order, not the definition of it: where it disagrees with section 7.1, the defect is in the function. Establish agreement against `vectors/adjudication.json` rather than against the source, which is what makes an implementation in another language possible at all.

A conformant implementation MAY be any one of the three classes. Most are a Realm plus an Adjudicator, but a verifier that only adjudicates somebody else's observations is conformant as an Adjudicator alone.

## 3. Profiles

Profiles are the orthogonal axis: a class says which interface you implement, a profile says which channels you observe.

| Profile    | Channels required   |
| ---------- | ------------------- |
| `effect`   | `net`, `log`        |
| `in-realm` | + `state`, `signal` |
| `surface`  | + `ui`              |

`src/registry.ts` is normative here: `CHANNELS_REQUIRED`, `profileFromChannels` and `channelsMissingFor` let an implementation discover at startup that it claims a profile it cannot reach. Profiles are cumulative, earned from the bottom upward, and an implementation that cannot address things on screen reaches `effect` or `in-realm` honestly. It MUST be able to say so and remain conformant.

## 4. Running the suite

The suite has 16 scenarios, each drawn from a defect this project shipped and then fixed. Its core (`conformance/drive.mjs`, `conformance/score.mjs`, `conformance/scenarios/index.mjs`) imports no vendor code. You supply the subject, because the suite cannot plant a defect in an application it does not own. The binding is three methods:

```js
const client = {
  hello: async () => ({ channels: ['net', 'log'], commands: ['x-conformance.plant'] }),
  command: async (name, args) => ({ planted: true, claim: /* ... */ }),
  verify: async (claim) => ({ verdict: 'unknown', ground: 'coverage-impeached', reason: '...' }),
};

const report = await driveAll(client, {
  name: 'my-implementation',
  version: '0.1.0',
  platform: 'native',
  channels: ['net', 'log'],
  profile: 'effect',
});
```

`command` MUST answer `x-conformance.plant` with a scenario id, put your subject into that state, and return the claim to verify. Refusing a plant is legitimate and scores `absent`. How the methods reach your process is yours: a socket, a pipe, or a direct call. Only 8 of the 16 scenarios are plantable against the subject this repository supplies; that gap is the fixture, not the implementation.

## 5. Scoring

Outcomes are `passed`, `failed` and `absent`. **Absent is never a pass.** A refused plant, a throw and a timeout are all absent: nothing was learned, and calling any of them a failure would blame an implementation for the suite's inability to ask. Counting one as a pass is how a scoreboard stays perfect while testing less every month.

Three rules decide `profileEarned`: every scenario the profile requires MUST have passed, the negative control (`healthy-app-real-claim`) MUST have passed, and the profile's channels MUST be declared. The control is load-bearing, because almost every other scenario asks for something other than a confident yes, so an implementation answering "I could not tell" to everything would satisfy nearly all of them. A registration that disagrees with `hello()` aborts the run before a scenario is driven. `--gate` exits non-zero only when `failed > 0`: it gates regression, never the score.

Scenarios are compared on `ground`, never on wording: clauses 3 and 4 both return `no`, and comparing prose would score every implementation against this one's vocabulary.

## 6. Test vectors, the cheapest on-ramp

You can check the most important half of conformance in an afternoon, without the suite, a subject or a transport. `vectors/adjudication.json` ships 11 vectors, one per ground, generated from the reference adjudicator and pinned by a test so they cannot drift from it. It is published at the subpath `open-verification/vectors/adjudication.json`, and each vector is `{ ground, input, expected }`, where `expected` is the `{verdict, ground, grade?}` the reference returns.

Feed each `input` to your decision function and compare `verdict` and `ground`. Agreement on all 11 means you agree with the adjudication order; disagreement names the exact clause you differ on, the ground being the join key between a sentence in the specification, a schema and a test.

## 7. What you may claim

Truthful, given a run you can produce:

> "Conforms to the Open Verification Protocol v1 at the `effect` profile, as scored by the published conformance suite."

> "Agrees with the normative adjudication order of the Open Verification Protocol v1 on all 11 published adjudication vectors."

> "Implements the Open Verification Protocol `Realm` interface. Conformance not yet scored."

MUST NOT be claimed: "certified" or "officially conformant", since no body certifies anything; a profile whose channels you do not declare or whose scenarios scored `absent`; conformance from a run in which any scenario failed; "fully conformant" while `earned` is undefined in your report; or any suggestion that conformance implies accuracy, coverage or defect-detection ability.

An implementation SHOULD publish its report verbatim, including `couldNotBePlanted`, rather than a summary grade.

## 8. Known limitations

Stated plainly, because a specification hiding its gaps is worse than a short one.

1. **No second implementation exists.** One ships, by the specification's author: see SPEC section 11, "One realm ships here, and it is not the flagship". Until somebody else reaches a profile, there is no evidence this document describes anything other than one architecture.
2. **The conformance driver has no transport binding** (SPEC section 11, "The conformance suite has no transport binding"). Wiring the three methods to your process is yours; no reference binding for the transport sketched in section 12 exists.
3. **Clause 10 (`already-true`) is unreachable through the conformance binding.** The binding never supplies `consequenceHeldBefore`, so the `consequence-already-true` scenario cannot exercise the clause it names. The vector for that ground does, which is a second reason to start at section 6.
4. **The `conformance` package is not published to npm.** It is `"private": true` with no exports map, so import the driver by path from a checkout. The three files that matter, `conformance/drive.mjs`, `conformance/score.mjs` and `conformance/scenarios/index.mjs`, import nothing from the reference implementation and depend only on `open-verification`, so they are reusable as they stand. Only the two `run-*.mjs` launchers are implementation-specific.
5. **Two scenarios ship failing for the reference implementation** and stay on the list: `stale-data-in-a-nested-document` and `claim-reads-an-undeclared-channel`.
6. **The reference implementation does not execute this adjudication order in its shipped verdict path.** Reticle reaches its verdicts through its own decision function, not through `adjudicate()`, and the two are compared by a parity test rather than unified by a call. They agree on eight situations and differ on three, every difference in the same direction: Reticle proves something this specification leaves unproved.

   - A claim declared AFTER the action is `unknown` here (clause 2) and `yes` there. Reticle treats pre-registration as a strengthener rather than a precondition.
   - A claim supported only by `presence`-grade evidence is `unknown` here (clause 9) and `yes` there. This is the clause the protocol is built around, so it is the most consequential of the three.
   - A blind spot on a channel the claim READS is `unknown` here (clause 6) and `yes`-with-a-disclosure there. Reticle has no notion of which channels a claim reads, so it cannot ask the targeted question at all; the coarse one it can ask was measured too noisy to gate on.

   None is in the convicting direction: there is no situation where Reticle answers `no` and this specification answers otherwise. All three are recorded in the implementation's `engine/src/evidence/protocol-parity.test.ts`, which fails if a fourth appears or if one changes direction. They are gaps in the implementation, not in the specification, on the authority stated in SPEC section 1: where the two disagree, the defect is in the implementation. Closing the first two is a migration (every assertion would have to declare when it was written, and every proof would need consequence-grade evidence) rather than a bug fix, which is why they are disclosed instead of quietly closed.

   For a second implementer this is the most useful sentence in the document: **agreement with the 11 published vectors is a stronger statement than agreement with the reference implementation**, because on three clauses the reference implementation is the one that is wrong.
