# What changed on the wire

Reticle is installed as separate pieces: a small library inside the app, a background process on the machine, and the server an AI agent talks to. They only work together while they agree on the same set of words: the messages they exchange, the commands one sends the other, the actions that can be asked for, and the kinds of event the app sends back. That agreement is the **wire contract**.

This file is the history of that contract, newest first. It exists because software written against it lives outside this repository, and "something changed" is not enough for whoever maintains it. They need to know what.

## How an entry gets here

The fingerprint is a short code worked out from the contract itself. Nobody types it or bumps it: add a command, rename an event, and it changes on its own. Refactor something internal and it does not.

`packages/core/src/contract-changes.test.ts` recomputes it and compares it with the top entry here. Change the contract and that test goes red until an entry is added, so this file cannot quietly fall behind the thing it describes.

Entries are only ever added at the top. An old entry describes what the contract looked like then, which stays true no matter what happens later, so editing one would make this a worse record than no record.

### Adding an entry

1. Run `pnpm --filter @reticlehq/core build`, which prints nothing about the fingerprint. Then run the test above. It fails and tells you the code it computed.
2. Add a row at the top with that code, today's date, and one sentence saying what changed.
3. Write the sentence for somebody who maintains a program that talks to Reticle and cannot see this repository. "Added `snapshot` command" is useful. "Refactored the message layer" is not.

If a change means older versions can no longer talk to this one, say so in the sentence. There is no separate column for it, because a column with one value in five years is a column people stop reading.

## History

| fingerprint | date | what changed |
| --- | --- | --- |
| `44dd42e2` | 2026-09-10 | First recorded fingerprint. The contract itself is unchanged; this is the point from which changes to it are written down. |
