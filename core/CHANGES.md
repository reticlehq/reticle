# What changed on the wire

Reticle is installed as separate pieces: a small library inside the app, a background process on the machine, and the server an AI agent talks to. They only work together while they agree on the same set of words: the messages they exchange, the commands one sends the other, the actions that can be asked for, and the kinds of event the app sends back. That agreement is the **wire contract**.

This file is the history of that contract, newest first. It exists because software written against it lives outside this repository, and "something changed" is not enough for whoever maintains it. They need to know what.

## How an entry gets here

The fingerprint is a short code worked out from the contract itself. Nobody types it or bumps it: add a command, rename an event, and it changes on its own. Refactor something internal and it does not.

`core/src/contract-changes.test.ts` recomputes it and compares it with the top entry here. Change the contract and that test goes red until an entry is added, so this file cannot quietly fall behind the thing it describes.

Entries are only ever added at the top. An old entry describes what the contract looked like then, which stays true no matter what happens later, so editing one would make this a worse record than no record.

### Adding an entry

1. Run `pnpm --filter @reticlehq/core build`, which prints nothing about the fingerprint. Then run the test above. It fails and tells you the code it computed.
2. Add a row at the top with that code, today's date, and one sentence saying what changed.
3. Write the sentence for somebody who maintains a program that talks to Reticle and cannot see this repository. "Added `snapshot` command" is useful. "Refactored the message layer" is not.

If a change means older versions can no longer talk to this one, say so in the sentence. There is no separate column for it, because a column with one value in five years is a column people stop reading.

## History

| fingerprint | date | what changed |
| --- | --- | --- |
| `e23e52a1` | 2026-09-26 | One new kind of event the page sends: `hud.used`, which reports that a person used Reticle's own in-page panel. Its data is `{ control?, toggle?, view?, panel? }`: `control` is the name of a panel control from the closed list `HUD_CONTROLS` (anything else fails validation), `toggle` is `"on"` or `"off"` for a switch, `view` is `"bubble"`, `"collapsed"` or `"expanded"`, and `panel` is `"chat"`, `"settings"`, `"report"` or `"none"`. It is usage telemetry, not evidence about the app: the bridge takes it off before the event buffer, so it never appears in an agent's reads or a verdict. Nothing was removed or renamed; a program written against the previous contract keeps working and should ignore the new kind as it would any other. |
| `f7a141bb` | 2026-09-24 | One new kind of event the app sends back: `field.change`, which reports that a form field's value moved. Its data is `{ field, kind, length, value?, redacted? }` — `field` is the field's test id, else its form name, else its accessible name; `kind` is `"change"` for a committed edit and `"input"` for a settled burst of typing; `length` is the length of the real value and is ALWAYS present. `value` is omitted and `redacted: true` set instead when the field is a password, its name looks like a credential, or its `autocomplete` says payment, so a form's contents are never recorded for those. This channel exists because nothing else could see a value change: the DOM watcher reports attribute changes, and every modern framework sets the input's property rather than its attribute. Nothing was removed or renamed, and a program written against the previous contract keeps working — it will simply see an event kind it does not know, which it should ignore as it would any other. |
| `e265693f` | 2026-09-14 | Four new actions an app can be asked to perform: `tap` (a real touch sequence — `pointerdown` with `pointerType:"touch"`, `touchstart`, `touchend`, `pointerup`, then the click a touch device synthesises; `args.holdMs` makes it a long press), `scroll` (a container scroll by `args.dy`/`args.dx`, where a NEGATIVE value scrolls back up or left — the previous scroll only ever stepped down), `zoom` (page zoom, which the in-page SDK REFUSES because CSS cannot change the layout viewport; it needs a driven browser), and two additions to `press`: `args.holdMs` holds a key down and emits the `repeat:true` keydowns a browser sends while it is held, and `args.keys` presses several keys together and releases them in reverse. Nothing was removed or renamed: every existing action, argument and event is unchanged, so a program written against the previous contract keeps working. |
| `44dd42e2` | 2026-09-10 | First recorded fingerprint. The contract itself is unchanged; this is the point from which changes to it are written down. |
