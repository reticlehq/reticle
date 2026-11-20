# @reticlehq/computer-use

The Reticle realm for a desktop application. An agent reads the application, acts on it, and gets back what the action changed. There is no SDK in the application and nothing to install in it.

This package is private. It is not on npm. It runs on macOS only.

## What it does

- **It reads the application through the accessibility tree of the operating system.** The agent gets one line for each element that is on the screen: `- button "Save" (ref=e5)`. This is the same format that the web realm gives for a page.
- **Each action reports its effect.** After an action the realm reads again and says what appeared, what went away and what changed. An action that changed nothing is a result of its own: `cu.ui.no-effect`.
- **It acts only where a person can act.** Before a press, the realm asks the operating system which element is on top at that place. If another view or another window covers the target, the realm refuses and names what is on top.
- **It does not use the pointer or the keyboard of the person at the machine.** A press is an accessibility action. Text is typed with key events that go to the application, not to the screen.
- **It counts the bytes the application wrote to disk.** The operating system keeps the count, so the application cannot change it. An action after which the count did not move wrote nothing, in any folder. An action that wrote bytes with no change in a watched folder wrote somewhere else, and the realm then answers "not known" and does not blame the application.
- **It can watch folders.** A file that an action writes becomes a `file.written` signal. A claim can then name the file, and not only the words that the application shows.

## Use it

Give the terminal Accessibility permission: System Settings, Privacy & Security, Accessibility.

Start the Reticle daemon, then join a running application to it:

```
reticle-computer-use --app Notes --watch ~/Documents/out
```

The command needs the Xcode command-line tools the first time, because it compiles its helper. It stays open until you stop it.

The application is now a Reticle session. The tools an agent already has for a web page work on it:

- `reticle_look { action: "page" }` gives the tree.
- `reticle_act_and_wait { ref, action, until }` acts and proves the consequence in one call.
- `reticle_act { steps }` does several actions in one call.

The session is not in the default list of sessions. Give its `sessionId` on each call. The command prints it.

A desktop application has no project of its own. Give `--project <folder>` with the folder that has the `.reticle.json` of the application, and its runs and flows go to that project. Without it they stay on this machine and do not reach the dashboard; the command says so.

To prove that a file was written, name the file:

```json
{ "until": { "kind": "signal", "name": "file.written", "dataMatches": { "file": "note.txt" } } }
```

## Actions

| Tool action | What the realm does |
| --- | --- |
| `click` | Presses the element. On a row of a table, chooses the row. |
| `fill` | Puts a value in the element. No key event is sent. |
| `type` | Sends one key event for each character. A text field that takes the keyboard selects its text first, so the typed text replaces it. |
| `press` | Sends one key with its modifiers: `Return`, `Meta+s`. |
| `scroll` | Moves the scroll bar. See below. |

Other actions are refused by name.

A `scroll` moves the scroll bar of the scroll area that holds the element, and sends no wheel event. `fraction` is the place of the bar, 0 to 1. `dy` moves the bar one step in its direction: the realm does not know the height of the content, so it cannot scroll by pixels.

## Limits

Read these before you rely on a result.

- **macOS only.** There is no reader for Windows or Linux.
- **Only the Space that is in front.** The accessibility interface lists the windows on the Space that the person looks at. An application on another Space reads as an application with no window. The realm says how many windows are not on the screen.
- **An application must give an accessibility tree.** An Electron application and a browser give very little until a switch is set in them. This realm does not set that switch. A canvas and a game have no elements to read.
- **A large window is slow to read.** The cost is for each element. A table is read only for the rows on the screen, and its line says how many rows are not shown.
- **An action takes about 600 ms.** The realm waits for 500 ms with no change before it calls an action finished. `RETICLE_AX_QUIET_MS` sets another time.
- **The realm trusts the place that an application gives for an element.** Some applications give a wrong place on a second display with a high resolution. The question "is this element on top" is then asked at the wrong place, and the realm refuses the action. It does not act on a guess.
- **Shortcuts use the key places of a US keyboard.**
- **A drag, a hover and a right-click are not built.**
- **The tree alone proves little.** The application draws the tree, so a text on the screen is the application's own word. Watch a folder and name the file when the action writes one.

## Check it

`native/mac/selfcheck.mjs` builds a small application and drives it through the realm. It opens a small window for a few seconds and does not take the keyboard.

```
node native/mac/selfcheck.mjs
```

`native/mac/measure.mjs` prints how long a read, a press and a refusal take on the same small application. It asserts nothing: use it to compare two builds on one machine.

`pnpm gate:conformance:computer-use` runs the scenarios of the Open Verification Protocol against the realm, with the same small application as the subject. It is not part of `pnpm gate:conformance`, which runs on Linux. One scenario fails today: the realm has no rule for a success message with no effect behind it, so it gives the right verdict with a weaker ground.

The check needs a quiet screen. When another window is over the small window, the realm refuses the action, and the check fails for that reason.
