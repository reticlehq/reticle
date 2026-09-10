---
title: Reading a file Reticle wrote earlier
description: What to do when a file on disk was written by a different version, and why repairing it is sometimes the wrong answer.
---

Reticle keeps a few files: what it has learned about your project, which runs happened, where your projects live, the flows you saved. Every one of them carries a version number.

Sooner or later a version of Reticle opens a file written by a different one. This is the rule for what happens next, and it was written after two places got it wrong in ways nobody would have noticed.

## The rule

**Damage is repaired. A file from another version is left alone.**

| what was found | what to do | why |
| --- | --- | --- |
| the file is missing | create it | nothing to lose |
| it is not valid JSON | replace it | nothing in it can be read, by us or by anybody else |
| it is valid, and from a version we do not know | **stop, and say so** | it is intact, and the version that wrote it can still read it |

The middle and bottom rows look the same from inside the code: both are "the file did not parse". That is exactly why this goes wrong. They need opposite handling.

## Why the difference matters

Imagine a file that got cut in half by a machine losing power mid-write. One person, one file. There is nothing in it to save, and refusing to work would strand them for no gain. Repair it.

Now imagine a new version of Reticle that changed the format. Every one of those files, on every machine, becomes unreadable at the same moment, and **every one of them is perfectly intact.** Repair them and you have overwritten real history that the version which wrote it could still have read.

The second case looks like the first, happens to everybody at once, and destroys something. That is why "just start fresh, it is only a cache" is a decision to make carefully rather than a default.

## Where this bit us

Two places, both found while preparing v3.

**Recording a run.** Reading a damaged `project.json` fell back to an empty one and wrote it back, so a version change would have silently deleted your run history on the first run after upgrading. Nothing failed, so nobody would have looked.

**Registering a project.** Reticle keeps one file in your home directory listing every project it knows about. Adding a project meant reading that file, adding a line, and writing it back. A file it could not read became a file with one project in it, and every other project you had set up was gone. This happened during `reticle init`, which is what you run right after upgrading.

## If you are adding a file

Three things.

Give it a version number, and add it to `packages/server/src/on-disk-versions.test.ts`. That test fails when any version changes, so the change cannot happen without somebody deciding what becomes of the files already out there.

Tell the two failure cases apart when you read it. `ProjectReadError` shows the shape: `MALFORMED` for damage, `WRONG_VERSION` for a file from elsewhere. One message for both sends somebody hunting a typo in a healthy file.

And prefer adding a field to changing one. A reader that ignores fields it does not recognise, and a writer that preserves them, will survive most version changes without anything special. `.reticle.json` does this: fields nobody recognises are copied through untouched.
