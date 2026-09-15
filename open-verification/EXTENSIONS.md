# Extensions

How to describe something this specification does not name without forking it, and what a receiver does with a member it has not seen.

**Normative keywords.** MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## What is open and what is closed

| Vocabulary | State | How to extend |
| --- | --- | --- |
| `Verdict` (`yes`, `no`, `unknown`, `no-fault`) | **CLOSED** | Not extensible. |
| `Ground` (the eleven clause codes of §7.1) | **CLOSED** | Not extensible. |
| Channel id (`src/vocabulary/channel.ts`) | Open | `x-` prefix |
| Anomaly kind (`src/vocabulary/verdict.ts`) | Open | `x-` prefix |
| Surface (`src/vocabulary/subject.ts`) | Open by design | `x-` prefix |
| Verdict reason | Open prose | Free string, non-normative |
| Predicate body, `startState`, `requires`, `ensures` | Opaque | Carried, never parsed |

The two closed vocabularies are closed for the same reason. A fifth verdict is always a way to say "yes, but", and the whole point of four is that ignorance cannot be rounded towards good news. A new ground implies a new clause in the adjudication order, and changing that order changes what "verified" means, which is a MAJOR change (see [VERSIONING.md](./VERSIONING.md)), never an extension.

The open ones are open because a channel, an anomaly or a surface is a fact about SOMEBODY'S world, and this specification cannot enumerate every world. Adding `voice` or `robot` to the named surface list would be a MAJOR change; `x-voice` is a Tuesday.

## Naming

An extension id MUST match `^x-[a-z0-9-]+$`. That pattern is enforced in the schemas, not in prose, so it reaches an implementation that never loads this package's code.

Within one codebase, `x-<thing>` is enough. For anything that crosses an organisational boundary, an extension id SHOULD carry a reverse-DNS owner: `x-com-example-thermal`, not `x-thermal`. There is no allocator (see below), so avoiding a collision is the extender's own job, and two vendors who both pick `x-thermal` produce two documents that validate identically and mean different things. The pattern forbids `.`, so reverse DNS is written with hyphens.

Command names on the reference transport are not ids and are not bound by that pattern. The conformance binding uses `x-conformance.plant`, and a vendor command SHOULD follow the same shape: `x-<owner>.<verb>`.

An extension channel MUST declare its independence and grade truthfully. The adjudication rules then apply to it unchanged, which is the whole benefit. Declaring an `x-` channel more trustworthy than §3 allows is not an extension, it is a false green.

## The receiver rule

A receiver MUST ignore any member it does not recognise, and MUST NOT fail because of it. An unrecognised member is not evidence for or against anything.

A receiver MUST reject a document whose members are conflicting or ambiguous: two members that cannot both be honoured, or one member whose meaning depends on which of two parsers reads it. Rejection means refusing to produce a verdict and saying why. It is `unknown`, never `no`: the document was unreadable, which is not a fact about the subject.

Tolerating ambiguity is how protocols rot, and the canonical demonstration is HTTP request smuggling. HTTP has two ways to state a body's length, `Content-Length` and `Transfer-Encoding`, and a message may carry both. Every implementation involved is individually reasonable and lenient; they simply disagree about which wins, so a proxy and the server behind it place the boundary between two requests in different places, and one request's body becomes the start of the next. Nobody wrote a bug. The leniency WAS the bug.

The same shape is available here whenever an `x-` member restates or contradicts something already named: a run declaring a channel grade and an `x-` member implying a different one is that message with two lengths. Reject it. Two readings of one document mean two verdicts nobody can compare.

## Graduation

An `x-` name becomes a named member of this specification when three things are true: two independent implementations use it with the same meaning; it is domain-independent, describable without knowing whether the subject is a page, a service or a robot; and a conformance scenario names it. Anything short of that is one vendor's vocabulary and belongs behind its prefix.

Graduation is additive, so it is a MINOR change. The `x-` spelling SHOULD keep working for at least one major after the named member appears, and removing it is MAJOR.

## What the registry is, and is not

`src/registry.ts` is a ledger IN CODE: the conformance profiles (`effect`, `in-realm`, `surface`), the channels each requires, and `ImplementationSchema`, the shape of an entry describing an implementation and the profile it claims.

It exists so an implementation can discover at startup that it claims a profile its declared channels cannot reach, rather than learning it from a failing scoreboard. Whether it EARNED the profile is the conformance suite's answer, never its own.

There is no registry SERVICE. SPEC §11 says so plainly: `Implementation` describes an entry, and nothing says where entries live. This version defines no submission process, no allocation authority for `x-` names, no uniqueness guarantee, and no list anybody can look you up in. If you need your name to be unique, make it unique yourself.
