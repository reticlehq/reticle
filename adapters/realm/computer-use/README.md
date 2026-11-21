# @reticlehq/computer-use

The Reticle realm for a desktop application. An agent reads the application, acts on it, and gets back what the action changed. There is no SDK in the application and nothing to install in it.

This package is private. It is not on npm. It runs on macOS only.

## What it does

- **It reads the application through the accessibility tree of the operating system.** The agent gets one line for each element that is on the screen: `- button "Save" (ref=e5)`. This is the same format that the web realm gives for a page.
- **Each action reports its effect.** After an action the realm reads again and says what appeared, what went away and what changed. An action that changed nothing is a result of its own: `cu.ui.no-effect`.
- **An effect is a change to what is on the screen.** An element with no size, such as an item of a closed menu, is not compared. The answer counts those changes apart, as `changedOffScreen`.
- **An element has the identifier its maker gave it.** The accessibility identifier of a native element, or the `id` of an element in a web view, is given as its test id. A saved flow then finds the element by it, also when several elements have the same role and name. An identifier that the toolkit made by itself is left out. With no identifier, a replay that finds two such elements presses none of them.
- **A change the application makes by itself is not an effect.** A clock or a tip that rotates changes with no action. The peer learns such a place from its looks between actions. A change there during an action is counted apart, as `changedByItself`. A place is one element: its parent, its role and its corner as seen from its parent, so it is the same place after the window was moved. When three or more places in one parent change by themselves, as the rows of a list that grows, the whole parent is such a place.
- **It acts only where a person can act.** Before a press, the realm asks the operating system which element is on top at that place. If another view or another window covers the target, the realm refuses and names what is on top.
- **It does not use the pointer or the keyboard of the person at the machine, unless a caller asks.** A press is an accessibility action. Text is typed with key events that go to the application, not to the screen. A caller that needs the real pointer or real keys asks for the foreground on that one action; see "The foreground".
- **It counts the bytes the application wrote to disk.** The operating system keeps the count, so the application cannot change it. The count is for the application's process and the processes it started. An action that wrote bytes with no change in a watched folder wrote somewhere else, and the realm then answers "not known" and does not blame the application. A count that did not move says that those processes wrote nothing. It does not prove that no file was written: a helper that the system runs for the application is not counted, and a process that the application started is not counted after it ends.
- **It reads the settings of the application.** A setting that an action changed is reported with its key and its values, as a `settings.changed` signal over the tools. It is often not on the screen and in no file that is watched. An application in a sandbox keeps its settings where the realm cannot read them; the realm then says nothing about settings, and that is not "no setting changed".
- **It sees that an action put something on the clipboard.** It reads only that the clipboard changed, never what is on it. Over the tools it is a `clipboard.changed` signal.
- **It can watch folders.** A file that an action writes becomes a `file.written` signal. A claim can then name the file, and not only the words that the application shows.

## What the person at the machine sees

The realm acts in the background, so the pointer of the person does not move. Two things on the screen say what the realm does:

- **A pointer of the realm's own.** An arrow, as a mouse has, in the colour of Reticle. It goes to the element the realm acts on, and a ring spreads from its tip when the realm acts: a light ring for an action, a red one for an action that was refused. A click goes through it.
- **The HUD, as in a browser.** The same parts in the same places, with the same colours and mark. At rest it is one circle at the bottom right, with the mark and a ring in the colour of the state: blue while the realm acts, amber while it waits or is paused, red after a refusal. A press opens it: the mark and the name, a row with the dot of the state, the action that runs and the two buttons, the last actions with what each one did, and a toolbar. **Pause** stops the realm: no action is done until the person presses the button again, and the agent is told why. **Stop** ends it: the realm does no more actions and leaves the application, as Ctrl-C on the command does.
- **A glow round the window the realm works in**, as the glow at the edge of a page in a browser: blue while an action runs, red when it was refused. It goes away a moment after the action.

The realm does not read its own window and does not act on it, so an agent cannot press the button of the person.

### Limits that only the person sets

An agent starts the command, so an agent picks its flags. The limits of the person at the machine are in a file of their own, `~/.reticle/computer-use.json`, and no flag lifts them:

```json
{ "backgroundOnly": true, "hud": true }
```

`backgroundOnly` forbids the real pointer and real keys. `hud` keeps the window and the pointer of the realm on the screen, also with `--no-hud`. After **Stop** in the window, the command writes `~/.reticle/computer-use.stopped`, and no application is joined until the person removes that file. A program with a shell can change a file, so these files say what the person wants; they are not a wall.

The window never takes the keyboard, and the person can move it. Give `--no-hud` on a machine with nobody at it.

## For an agent

Three steps. The application needs no project and no set-up of its own.

1. See what is open: `reticle-computer-use --list` prints `{"apps":[{"name","process"}]}`.
2. Join one, and leave the command running: `reticle-computer-use --app "<name>"`. It waits for the Reticle daemon when there is none yet, and then prints one line of JSON: `{"joined":true,"sessionId":"…","needsSessionId":true,"next":[…]}`. `next` says what to call. Add `--open` to start an application that is not open; it starts behind the application in front. When the person works in a full-screen Space, that window is on another Space and cannot be read: the answer then has `readable: false` and `why`, which says how to bring the application to the front.
3. Use the tools you have for a web page. `reticle_look { action: "page" }` gives the window. `reticle_act_and_wait { ref, action, until }` acts and proves the consequence.

Give the `sessionId` of that line on each call; `next` shows the calls with it. You set no switch for an Electron application: the command sets it. When an action is refused, the refusal says what to do: for a double-click, a hover, a drag or the menu bar, it says to send the action again with `args: { foreground: true }`.

## Use it

Give the terminal Accessibility permission: System Settings, Privacy & Security, Accessibility.

Start the Reticle daemon, then join a running application to it:

```
reticle-computer-use --app Notes --watch ~/Documents/out
```

The command waits for the daemon for 30 seconds when it is not there yet.

The command needs the Xcode command-line tools the first time, because it compiles its helper. It stays open until you stop it.

Give the name you see in the Dock, or the name of the process: `--app "Visual Studio Code"` and `--app Code` are the same application. When no application has that name, the command names the ones that are near it, or the ones that are open.

When it does not work, ask it why:

```
reticle-computer-use --app Notes --doctor
```

It checks the permission, the helper, the application and its windows, and the daemon. For each one that is wrong it says what to do.

The application is now a Reticle session. The tools an agent already has for a web page work on it:

- `reticle_look { action: "page" }` gives the tree.
- `reticle_act_and_wait { ref, action, until }` acts and proves the consequence in one call.
- `reticle_act { steps }` does several actions in one call.

A desktop application is in no project: give the `sessionId` that the command prints on each call. Its runs and flows stay on this machine. To put it in a project, give `--project <folder>` with the folder that has the `.reticle.json`; its runs and flows then go to that project. When a browser tab of the same project is connected too, still give the `sessionId`: a call with none goes to the session the daemon heard from last.

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
| `click` with `args.button: "right"` | Asks the element for the menu that a right-click gives. No pointer is used. |
| `dblclick`, `hover`, `drag`, `focus` | Use the real pointer, or bring the application to the front. Only with `args.foreground: true`. See "The foreground" below. |

Other actions are refused by name.

### The foreground

The realm works in the background: it does not take the pointer or the keyboard of the person at the machine, and the application stays where it is. Some things cannot be done that way: a double-click, a hover, a drag, a click on a control that takes only a real click, and the menu bar of an application that is not in front.

For those, give `args.foreground: true` on the action. The realm then brings the application to the front, moves the real pointer to the element and does the gesture as a person does. After it, the pointer and the application that was in front are put back. A `hover` and a `focus` leave things as they are, because what they are for is gone when the pointer or the application goes away.

- `click` with `foreground: true` is a real click. With `button: "right"` too, it is a real right-click.
- `drag` needs `args.to`: `{ ref }` for the middle of another element, or `{ x, y }` on the screen.
- `type` and `press` with `foreground: true` send real keys. A panel that the system draws for the application, such as the save panel, takes `fill` and `click` in the background, and takes a key only as a real key. A real key goes to whatever application has the keyboard, so the realm sends one only when the system says that the joined application has it. When it has not, no key is sent and the action is refused: use `focus` first.
- `focus` brings the application to the front and gives the element the keyboard. After it, the menu bar is on the screen and can be read and pressed.

The realm waits until the person at the machine has not typed or moved the pointer for a moment. When they do not stop in five seconds, it refuses the action and takes nothing.

An action that needs the foreground and did not get it is refused, and the refusal says how to ask. Join with `--background-only` and the realm never does it, whatever a caller asks.

A `scroll` moves the scroll bar of the scroll area that holds the element, and sends no wheel event. `fraction` is the place of the bar, 0 to 1. `dy` moves the bar one step in its direction: the realm does not know the height of the content, so it cannot scroll by pixels. A page in a Chromium browser has no scroll bar in its tree. There the realm sends one key to the application (`End`, `Home`, `PageDown` or `PageUp`), and the answer says `by: "key"` and names the key; it gives no `fraction`, because the place of the content is then not known. Both ways work while another application is in front. To scroll several times in one call, send the scrolls as the `steps` of `reticle_act_sequence`: a feed is then read once after them, and not once for each scroll.

### An application that gives no elements

A canvas, a game and some custom controls give nothing to read. For those:

1. `reticle_screenshot` takes a picture of the application's own window. It is the window alone, also when another window is over it. The terminal needs the Screen Recording permission for it.
2. `click`, `dblclick` or `hover` on the window, with `args: { foreground: true, at: { x, y } }`, acts at that point of the picture, in the pixels of the picture.

A picture proves little by itself. Name a file, a setting or the clipboard in `until` where the action has such an effect.

## Limits

Read these before you rely on a result.

- **macOS only.** There is no reader for Windows or Linux.
- **The screen must not be locked.** With the screen locked, macOS gives no window of any application. The realm says that the screen is locked; it does not say that the application has no window.
- **Only the Space that is in front.** The accessibility interface lists the windows on the Space that the person looks at. An application on another Space reads as an application with no window. The realm says how many windows are not on the screen.
- **A web view inside a native application is read.** The system web view (WebKit) gives its page as elements with no switch to set: headings, fields, buttons, links. It was tried on a small test application and on this repository's Tauri fixture (`apps/tauri-smoke`): the realm read the page, typed in a field, added an item and followed two route changes, with nothing set in the application. The first read of an application waits until two reads agree, because a web view makes its tree when it is first asked.
- **The bridge must have a pairing token.** With a token, the realm dials with no Origin header. A page in a browser cannot do that, so the bridge knows that the signals of this session are things the realm saw. With no token, the session is joined, and a signal with nothing else changing is not proof.
- **The realm reads one application.** It reads the elements, the settings and the disk count of the application it joined, and the folders you name. Of another application it reports only the name and the role of an element, when that application covers the target. It reports that the clipboard changed, and never what is on it.
- **The menu bar needs the application in front.** The menu bar of an application that is not in front is not on the screen. It is not read and cannot be pressed. A menu in the window (a pull-down button) works in any case.
- **An application that gives no accessibility tree is read as a picture.** A canvas and a game have no elements; see "An application that gives no elements". The realm then acts at a point, with the real pointer, and it cannot say what changed in the picture. A browser can give very little until a switch is set in it, and this realm does not set that switch.
- **An Electron application needs its switch for a press.** It shows its elements with no switch, answers "done" to a press, and does nothing. The command sets the accessibility switch that Electron documents for such tools, and sets it back when you stop. Give `--no-electron-switch` to leave the application as it is; the command then says that a press will do nothing. The switch is not in effect at once: for two or three seconds the application still loses a press. The command waits until the tree of the application has changed, and joins after that. The switch costs the application some speed. A command that is killed with no warning (`kill -9`) cannot set it back: the switch then stays on until the application is closed. This was measured on Electron 45.
- **A large window is slow to read.** The cost is for each element. A table is read only for the rows on the screen, and its line says how many rows are not shown.
- **An action with its proof takes about 350 ms through the tools.** The peer calls an action finished after 150 ms with no change, and it goes on looking: a change that comes later is sent when it comes. A caller of the realm class looks once, so it waits for 500 ms with no change; `RETICLE_AX_QUIET_MS` sets that time.

- **A read takes time with the size of the tree, and the answer does not.** Measured in Chrome on a feed page of this folder: 33 ms for a tree of 374 elements, and 63 ms for 874 elements after twenty scrolls. The lines an agent gets stayed at 56 (about 2 KB), because the posts that are scrolled out are not shown. So a long page costs the realm some time, and it costs the agent no more words. On a page of about 10,000 elements a read took 590 ms and a press with its proof took 2.4 s: the realm reads the whole tree before the action and until the page is quiet after it. The realm does not leave out the parts of a page that are scrolled out when it reads: an element with a fixed place on the screen, as a dialog, can be a child of a part that is scrolled out, and it would then be lost.
- **The realm trusts the place that an application gives for an element.** Some applications give a wrong place on a second display with a high resolution. The question "is this element on top" is then asked at the wrong place, and the realm refuses the action. It does not act on a guess.
- **Shortcuts use the key places of a US keyboard.**
- **A drag, a hover, a double-click and a real click take the pointer.** They work only with `args.foreground: true`. The tooltip of an element, which is what a person most often hovers for, is in the answer to `reticle_look { action: "element" }` as `help`: the realm reads it from the tree.
- **The save panel keeps its folder.** The realm fills the name and presses Save in the background. It cannot go to another folder that way: a whole path in the name field does not move the panel, and the system then writes a file whose name is that path, with a colon for each slash. To choose a folder a person types a key, and a key reaches the panel only as a real key, with the application in front. The key that opens "Go to the folder" works that way; typing the folder into that sheet is not proved yet.
- **The realm does not see paint.** "Can a person reach this element" is a question to the operating system about what element is at a point. It is not a look at the screen. A control that another view paints over, with nothing in the accessibility tree to say so, is still "reachable" for the realm, and a person does not see it. The fixture of this package had that defect, and every check passed. Take `reticle_screenshot` and look at the window when what a person sees is part of the claim.
- **The tree alone proves little.** The application draws the tree, so a text on the screen is the application's own word. Watch a folder and name the file when the action writes one.

## Check it

`native/mac/selfcheck.mjs` builds a small application and drives it through the realm. It opens a small window for a few seconds and does not take the keyboard.

`native/mac/ambientcheck.mjs` starts the same application with a clock that counts by itself, and drives it through the peer. It checks that a button that does nothing is not given the clock as its effect, and that a real effect is still counted.

`native/mac/electroncheck.mjs` starts a small Electron application and drives it through the peer. It checks that a press does nothing and says why with the switch off, that a press works with the switch on, and that a slow effect belongs to its own press. It is skipped when Electron is not installed.

`conformance/computer-use-journey.mjs` (run it with `node` from the root of the repository) does two whole journeys through a real bridge and the tools an agent has, and each step must be proved. On the Electron application it fills a field, adds a note, chooses from a list and checks a box. On the native application it fills a field and exports it, and the proof is the file on disk. It saves each journey as a flow, opens a new application, and replays the flow with no model; the replay of the export must write the file in a new folder. Last, the Harness drives the native application with a model that is a script: the check is on the Harness, its prompt for a desktop application and the tools as it calls them, and it costs nothing.

`conformance/computer-use-calculator.mjs` does a whole task on an application that Reticle did not write: the system Calculator works out 7 × 6. Each of the four presses is proved by what the display then shows. The task is saved as a flow, Calculator is closed and opened again, and the flow replays with no model. Then the Harness drives Calculator with a model that is a script: it gets the prompt for a desktop application, and each of its four presses is proved. It does not run when Calculator is open already.

`conformance/computer-use-browser.mjs` does a form in Google Chrome, on a page of this folder: it fills a field and presses a button, the press is proved by the note that comes on the page, and the saved flow replays with no model in a new Chrome. Chrome runs with a profile of that run. With `--safari` the same journey runs in Safari, which needs no switch. `conformance/computer-use-join.mjs` joins Chrome through `reticle-computer-use --app`, the command an agent runs, and proves a press: the command must set the switch by itself. A Chromium browser needs the same accessibility switch as an Electron application, and a second one: with the first alone, Chrome answers "done" to a press and the page gets no click. The join sets both. Chrome takes about four seconds before a press reaches the page, and the join waits for that.

A press after which the realm saw nothing (no change on the screen, on disk, in a setting or on the clipboard) carries `effect.note`. It says that `dispatched` is not `done`: an application can take a press and do nothing with it.

`native/mac/savepanelcheck.mjs` checks the save panel of the system, which most applications use to write a file. The realm reads the panel, fills the name and presses its Save, all in the background, and the proof is the file on disk.

`native/mac/hudcheck.mjs` checks the window of the realm: it shows the action and its effect, and Pause stops the realm. The check presses Pause as a person does: a second realm reads the window and presses its button.

`native/mac/pointercheck.mjs` (`pnpm --filter @reticlehq/computer-use check:pointer`) checks the real pointer: a click, a double-click, a right-click, a drag and a hover. It takes the pointer for a few seconds. The same command then runs `native/mac/keyscheck.mjs`: an application that was opened in the background comes to the front, and real keys go to it. It takes the keyboard for a few seconds.

The first three, the check of the window and the check of the save panel, one after the other, on a Mac with the Accessibility permission:

```
pnpm --filter @reticlehq/computer-use check:live
```

`native/mac/measure.mjs` prints how long a read, a press and a refusal take on the same small application. It asserts nothing: use it to compare two builds on one machine.

`pnpm gate:conformance:computer-use` runs the scenarios of the Open Verification Protocol against the realm, with the same small application as the subject. It is not part of `pnpm gate:conformance`, which runs on Linux. One scenario fails today: the realm has no rule for a success message with no effect behind it, so it gives the right verdict with a weaker ground.

The check needs a quiet screen. When another window is over the small window, the realm refuses the action, and the check fails for that reason.
