# @reticlehq/computer-use

The Reticle realm for a desktop application. An agent reads the application, acts on it, and gets back what the action changed. There is no SDK in the application and nothing to install in it.

This package is private. It is not on npm. It runs on macOS only.

## What it does

- **It reads the application through the accessibility tree of the operating system.** The agent gets one line for each element that is on the screen: `- button "Save" (ref=e5)`. This is the same format that the web realm gives for a page.
- **Each action reports its effect.** After an action the realm reads again and says what appeared, what went away and what changed. An action that changed nothing is a result of its own: `cu.ui.no-effect`.
- **An effect is a change to what is on the screen.** An element with no size, such as an item of a closed menu, is not compared. The answer counts those changes apart, as `changedOffScreen`.
- **A change the application makes by itself is not an effect.** A clock or a tip that rotates changes with no action. The peer learns such a place from its looks between actions. A change there during an action is counted apart, as `changedByItself`. A place is one element: its parent, its role and its corner on the screen. When three or more places in one parent change by themselves, as the rows of a list that grows, the whole parent is such a place.
- **It acts only where a person can act.** Before a press, the realm asks the operating system which element is on top at that place. If another view or another window covers the target, the realm refuses and names what is on top.
- **It does not use the pointer or the keyboard of the person at the machine.** A press is an accessibility action. Text is typed with key events that go to the application, not to the screen.
- **It counts the bytes the application wrote to disk.** The operating system keeps the count, so the application cannot change it. The count is for the application's process and the processes it started. An action that wrote bytes with no change in a watched folder wrote somewhere else, and the realm then answers "not known" and does not blame the application. A count that did not move says that those processes wrote nothing. It does not prove that no file was written: a helper that the system runs for the application is not counted, and a process that the application started is not counted after it ends.
- **It reads the settings of the application.** A setting that an action changed is reported with its key and its values, as a `settings.changed` signal over the tools. It is often not on the screen and in no file that is watched. An application in a sandbox keeps its settings where the realm cannot read them; the realm then says nothing about settings, and that is not "no setting changed".
- **It sees that an action put something on the clipboard.** It reads only that the clipboard changed, never what is on it. Over the tools it is a `clipboard.changed` signal.
- **It can watch folders.** A file that an action writes becomes a `file.written` signal. A claim can then name the file, and not only the words that the application shows.

## Use it

Give the terminal Accessibility permission: System Settings, Privacy & Security, Accessibility.

Start the Reticle daemon, then join a running application to it:

```
reticle-computer-use --app Notes --watch ~/Documents/out
```

The command needs the Xcode command-line tools the first time, because it compiles its helper. It stays open until you stop it.

When it does not work, ask it why:

```
reticle-computer-use --app Notes --doctor
```

It checks the permission, the helper, the application and its windows, and the daemon. For each one that is wrong it says what to do.

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

When no folder is watched, a claim can still ask if the application wrote to disk at all. The operating system counts the bytes:

```json
{ "until": { "kind": "signal", "name": "disk.wrote" } }
```

With `"count": 0` the same claim says that the application's own processes wrote nothing. That is weak evidence: a helper of the system can write for the application.

## Actions

| Tool action | What the realm does |
| --- | --- |
| `click` | Presses the element. On a row of a table, chooses the row. |
| `fill` | Puts a value in the element, then reads it. A text field that did not take the value (a field in a web view) gets keys: all its text is selected, and the value is typed. The action fails if the field still holds another value. |
| `type` | Sends one key event for each character. A text field that takes the keyboard selects its text first, so the typed text replaces it. |
| `press` | Sends one key with its modifiers: `Return`, `Meta+s`. |
| `clear` | A `fill` with no text. |
| `check`, `uncheck` | Presses a checkbox or a radio button, then reads its state. Sends nothing when the box is in that state already, and says so (`alreadyAtValue`). Fails when the box did not change. |
| `submit` | Sends the Return key to the element. |
| `select` | For a pop-up: presses it, reads its choices, and presses the one named in `value`. When that choice is not there, it closes the pop-up and names the choices that are. A list in a web view does not name its choices: the realm types the name into the list, reads the value, and puts the old choice back when the keys went to another one. |
| `scroll` | Moves the scroll bar. See below. |

Other actions are refused by name.

A `scroll` moves the scroll bar of the scroll area that holds the element, and sends no wheel event. `fraction` is the place of the bar, 0 to 1. `dy` moves the bar one step in its direction: the realm does not know the height of the content, so it cannot scroll by pixels.

## Limits

Read these before you rely on a result.

- **macOS only.** There is no reader for Windows or Linux.
- **Only the Space that is in front.** The accessibility interface lists the windows on the Space that the person looks at. An application on another Space reads as an application with no window. The realm says how many windows are not on the screen.
- **A web view inside a native application is read.** The system web view (WebKit) gives its page as elements with no switch to set: headings, fields, buttons, links. It was tried on a small test application and on this repository's Tauri fixture (`apps/tauri-smoke`): the realm read the page, typed in a field, added an item and followed two route changes, with nothing set in the application. The first read of an application waits until two reads agree, because a web view makes its tree when it is first asked.
- **The bridge must have a pairing token.** With a token, the realm dials with no Origin header. A page in a browser cannot do that, so the bridge knows that the signals of this session are things the realm saw. With no token, the session is joined, and a signal with nothing else changing is not proof.
- **The realm reads one application.** It reads the elements, the settings and the disk count of the application it joined, and the folders you name. Of another application it reports only the name and the role of an element, when that application covers the target. It reports that the clipboard changed, and never what is on it.
- **The menu bar needs the application in front.** The menu bar of an application that is not in front is not on the screen. It is not read and cannot be pressed. A menu in the window (a pull-down button) works in any case.
- **An application must give an accessibility tree.** A canvas and a game have no elements to read. A browser can give very little until a switch is set in it, and this realm does not set that switch.
- **An Electron application needs its switch for a press.** It shows its elements with no switch, answers "done" to a press, and does nothing. `reticle-computer-use` says so when it joins one. Give `--electron-switch`: the realm sets the accessibility switch that Electron documents for such tools, and sets it back when you stop. The switch costs the application some speed. A command that is killed with no warning (`kill -9`) cannot set it back: the switch then stays on until the application is closed. This was measured on Electron 45.
- **A large window is slow to read.** The cost is for each element. A table is read only for the rows on the screen, and its line says how many rows are not shown.
- **An action with its proof takes about 350 ms through the tools.** The peer calls an action finished after 150 ms with no change, and it goes on looking: a change that comes later is sent when it comes. A caller of the realm class looks once, so it waits for 500 ms with no change; `RETICLE_AX_QUIET_MS` sets that time.
- **The realm trusts the place that an application gives for an element.** Some applications give a wrong place on a second display with a high resolution. The question "is this element on top" is then asked at the wrong place, and the realm refuses the action. It does not act on a guess.
- **Shortcuts use the key places of a US keyboard.**
- **A drag, a hover and a right-click are not built.**
- **The tree alone proves little.** The application draws the tree, so a text on the screen is the application's own word. Watch a folder and name the file when the action writes one.

## Check it

`native/mac/selfcheck.mjs` builds a small application and drives it through the realm. It opens a small window for a few seconds and does not take the keyboard.

`native/mac/ambientcheck.mjs` starts the same application with a clock that counts by itself, and drives it through the peer. It checks that a button that does nothing is not given the clock as its effect, and that a real effect is still counted.

`native/mac/electroncheck.mjs` starts a small Electron application and drives it through the peer. It checks that a press does nothing and says why with the switch off, that a press works with the switch on, and that a slow effect belongs to its own press. It is skipped when Electron is not installed.

All three, one after the other, on a Mac with the Accessibility permission:

```
pnpm --filter @reticlehq/computer-use check:live
```

`native/mac/measure.mjs` prints how long a read, a press and a refusal take on the same small application. It asserts nothing: use it to compare two builds on one machine.

`pnpm gate:conformance:computer-use` runs the scenarios of the Open Verification Protocol against the realm, with the same small application as the subject. It is not part of `pnpm gate:conformance`, which runs on Linux. One scenario fails today: the realm has no rule for a success message with no effect behind it, so it gives the right verdict with a weaker ground.

The check needs a quiet screen. When another window is over the small window, the realm refuses the action, and the check fails for that reason.
