# OpenReality

The rules Reticle is built on, published on their own so somebody can read them without installing anything.

## What it is

Two things, and nothing else.

**What a realm must be able to do.** A realm is the layer that lets a program interact with an environment: a browser page, a desktop window, a phone screen, anything an agent can act on and watch. There are four verbs, and each one names where the web realm already implements it, so this is a description of code that exists rather than a design nobody has written.

**What a verdict is allowed to say.** Four answers, not two: it held, it did not hold, I could not tell, and nothing was declared to prove. The third and fourth are the point. A system that can only say yes or no will say yes when it means "I did not see", and that is the failure this whole thing exists to prevent.

## The rule underneath both

**A realm reports what it did and what it saw. It never reports whether that proved anything.**

Whether a declared consequence held is decided from evidence on a channel other than the one that performed the action. An observation made on the same channel that acted is not evidence for it, and the honest answer there is "I could not tell", never "it worked".

That separation is the whole idea. A verdict that could be supplied by the thing being verified is not a verdict, and a realm that could return one would make every realm author a trusted party.

## Status

Early, and honest about it: the verbs are named and the verdict vocabulary is fixed, but this is one implementation's rules written down rather than a standard with several implementations behind it. Read [`docs/adapters.md`](../docs/adapters.md) in this repository for how to build against it today.
