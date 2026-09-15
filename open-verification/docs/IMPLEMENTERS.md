# Implementing the Open Verification Protocol

**Non-normative.** This is a guide, not a rule. It teaches one route through the protocol and binds nobody. Every requirement lives in [SPEC.md](../SPEC.md) and [CONFORMANCE.md](../CONFORMANCE.md), and where this file disagrees with those, they win.

## 1. Start with the vectors, not with the code

Before you build anything, find out whether you agree with the protocol about what evidence means. `vectors/adjudication.json` publishes eleven worked input/output pairs, one per ground of the adjudication order. No browser, no transport, no subject, no suite.

```ts
import { createRequire } from 'node:module';
import { myAdjudicate } from './my-adjudicator.js';

const require = createRequire(import.meta.url);
const { vectors } = require('open-verification/vectors/adjudication.json');

for (const { ground, input, expected } of vectors) {
  const got = myAdjudicate(input);
  if (got.verdict !== expected.verdict || got.ground !== expected.ground) {
    console.error(
      `${ground}: expected ${expected.verdict}/${expected.ground}, got ${got.verdict}/${got.ground}`,
    );
  }
}
```

Agreement on all eleven means you agree with the order, and a mismatch names the exact clause you differ on. Compare `verdict` and `ground` only. Never compare the prose in `reasons`: that is an implementation's own, and scoring against it would pin you to somebody else's vocabulary.

If you would rather not write an adjudicator at all, `adjudicate` is exported and you can use it directly. Adjudicator is one of the three conformance classes, so a verifier that only adjudicates somebody else's observations is a complete implementation.

## 2. Build a Witness first, then grow it into a Realm

`Realm extends Witness`, so building in that order costs nothing and stops you acquiring the ability to act before you can honestly observe.

**Stage one, the Witness.** Five methods, all abstract:

```ts
import { Witness } from 'open-verification';

class OrdersDb extends Witness {
  identity() {} // which running thing this is, and what invalidates evidence about it
  channels() {} // what you can see, and whether any of it is independent of the action
  openWindow(budgetMs) {} // when "done" happens from here
  observe(window) {} // what was seen in that window
  coverage(window) {} // what you could NOT see in it
}
```

`identity()` returns a `SubjectRef`: `surface`, an `instance` that changes when the thing it names is replaced, and optionally an `epoch`. `channels()` is a declaration and everything you later report is scored against it, so claiming a channel you cannot really read is the expensive lie here. `openWindow` is section 5, and `coverage()` is section 3.

**Stage two, the Realm.** Everything above, plus four more:

```ts
class MyRealm extends Realm {
  determinism() {} // reset, replayPrefix, time, observation, actions
  capabilities() {} // what an actor may ask for, in your domain's words
  describe(query?) {} // what is here now, as structure rather than an image
  protected dispatch(a) {} // do one thing, report that you did it, never that it worked
}
```

`determinism()` is the question a browser never has to ask: it says how your subject may be driven, so a caller can derive a resume strategy with `resumeStrategy()` instead of assuming a re-drive is free. On a service a `POST` is not idempotent, and `replayPrefix: 'unsafe'` is what stops a resume from re-sending a payment. `capabilities()` names domain verbs (`turn_off_device`), not transport verbs (`tap`). `dispatch` is protected because callers use the sealed `perform()`, which refuses undeclared capabilities on your behalf so that refusing is never something you can forget.

Six methods are optional, and declining them is a correct answer rather than a gap: `locate` (turn "the button called Pay" into handles, returning every match and choosing between none), `detect` (report anomalies), `photograph` (pixels), `applyFixture` and `captureFixture` (the state a suite starts from), and `mutate` (break the subject on purpose to grade your own flows). `src/reference/service-realm.ts` is a complete realm with no screen, written so implementers have one to read.

## 3. The three mistakes the shape is built to prevent

**Grading your own work.** There is no method on `Realm` that returns a verdict, and that is not an oversight: a realm deciding whether its own action succeeded is the thing under test marking its own paper. The temptation arrives as a convenience on top of `dispatch`, or as a `perform` that returns what it found rather than a receipt. Both collapse the separation everything else rests on. `detect` looks like an exception and is not: an anomaly is a disagreement, not a judgement, and it can only convict when one of the two channels is independent, which is checked on the adjudicator's side. Your realm cannot convict itself however hard it tries.

**Treating `unknown` as a pass.** `unknown` points an actor at better instrumentation, `no` points them at a bug, and folding the first into either neighbour is a false verdict produced before you observed anything. The usual accident is a default: an empty evidence array read as failure, an unevaluated predicate read as `false`, a missing `consequenceHeldBefore` read as `false`. `evaluate()` returns `undefined` for "nobody evaluated this" precisely so you have somewhere to put that, and `assertionsHeld` is three-valued for the same reason.

**Closing a window on a budget and calling it clean.** `budget-exhausted` is not a clean close, and a clean close is required for `yes` and for `no-fault`. The subtler half: "the verifier gave up" and "this realm cannot measure its close condition" are different facts. A hidden browser tab never flushes the frame quiescence is read from, and hidden is the normal state for agent-driven verification, so reporting an unmeasurable settle signal as `budget-exhausted` makes every backgrounded subject permanently unprovable. The honest report is a blind spot on `time`, which does not impeach a claim that never reads `time`.

## 4. One verification, end to end

Declare the claim before you act. `declaredAt: 'before-action'` is the difference between a check and a rationalisation, and clause 8 refuses a `yes` to anything written down afterwards.

```ts
const claim = {
  id: 'c1',
  statement: 'placing an order creates it',
  declaredAt: 'before-action',
  assertions: [{ id: 'a1', predicate: {}, reads: 'the order POST returns 201', channels: ['net'] }],
};
```

Open a window, act, and let the window close on its own condition:

```ts
const window = realm.openWindow(2000);
const receipt = await realm.perform({
  id: 'act1',
  actor: 'agent',
  capability: 'place_order',
  target: handle.ref,
  at: now(),
});
```

`receipt.dispatched` says the command was delivered. It says nothing about an order existing, and if `receipt.refused` is set, no evidence was going to arrive because nothing happened.

Then gather both halves, what you saw and what you could not see:

```ts
const observations = await realm.observe(window);
const coverage = await realm.coverage(window); // { window, observed: ['net'], blindSpots: [] }
```

Promote observations to evidence by attaching provenance, independence and grade. Evidence from `net` is `independent` and `consequence`-grade, which can pay for a `yes`. Evidence from `ui` is `actuation-derived` and `presence`-grade, which cannot, however much of it you have.

```ts
const result = adjudicate({
  claim,
  window,
  channels: realm.channels(),
  evidence,
  coverage,
  anomalies: [],
  assertionsHeld: assertionsHeld(claim.assertions, observations),
});
// { verdict: 'yes', grade: 'consequence', ground: 'proved', reasons: [...] }
```

Read the ground, not just the verdict. `proved` means every rung cleared. `no-independent-consequence` means your evidence was all the app agreeing with itself. `coverage-impeached` means a blind spot fell on a channel the claim needed, so the fix is instrumentation. `window-not-closed` means you stopped watching too early. Each ground is a different next move, which is why it is returned at all.

## 5. Where implementations honestly differ

**Window close conditions.** The one most people get wrong. Quiescence is one close condition, not the concept: a game never goes quiet, a service's truth often arrives after a `202`, a robot settles physically and a separate sensor confirms it. If your realm's "done" is not quiescence and you say it is, every asynchronous claim in your domain reports `unknown` forever and it looks like a limitation of the protocol rather than of your realm.

**Blind spot enumeration.** Which of the six kinds a gap is, and which channel it falls on, is judgement. Two rules keep it honest. An empty array is a positive claim, so omit the field entirely if you cannot enumerate. And do not judge relevance: a realm does not see the claim, so `impeaching` is the adjudicator's call once you have named the channel. Every implementation written against an earlier draft set `impeaching: false` everywhere and assumed somebody downstream would decide, while the adjudicator was filtering on that flag.

**Provenance classification.** `observed` is the ordinary case. The line worth guarding is `learned`: inferred from repetition, probabilistic, never sufficient alone. A learned belief may raise a question or downgrade a verdict to `unknown`, and the only route from `learned` to `authoritative` is promotion by a named person or specification, never a confidence threshold somebody picked. `confidence` on anything else is a category error, since either the observer saw it or it did not.

## 6. What to read next

- [SPEC.md](../SPEC.md) §7.1, the adjudication order, which is the part you must agree with.
- [CONFORMANCE.md](../CONFORMANCE.md) for the classes, profiles and suite, and its section 7 for the exact sentences you may and may not claim. There is no certification body and no mark.
- [EXTENSIONS.md](../EXTENSIONS.md) before inventing a channel or an anomaly kind: both are `x-` prefixed, with a receiver rule for members you do not recognise.
- [SECURITY.md](../SECURITY.md) for the trust model, [VERSIONING.md](../VERSIONING.md) for what a minor version may add, and [GOVERNANCE.md](../GOVERNANCE.md) for the vendor conflict it states rather than hides.
- `src/reference/service-realm.ts`, a working realm for a subject with no screen.
- `dist/schema/` if you are implementing in another language. The schemas are generated from the source, they are the contract, and you need none of this TypeScript.

Issues go to the repository named in `package.json`. The most useful thing you can send is a vector you disagree with and the ground you reached instead.
