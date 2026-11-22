// A small application for the computer-use realm to drive. Each control is one case:
//   Save     changes the status text at once. It has a tooltip.
//   Slow     changes the status text after 400 ms.
//   Dead     does nothing.
//   Steps    changes the status text at once, and again 300 ms later.
//   Covered  works, but a view lies over it, so a person cannot click it.
//   Title    a text field. The Return key in it changes the status text.
//   Items    a table of three rows. To choose a row changes the status text.
//   Actions  a menu. Its items are not on the screen until it is open.
//   Remember a checkbox. It changes one setting of the application, and nothing on the screen but itself.
//   Copy     puts the title on the clipboard, and changes nothing on the screen.
//   Volume   a slider. Its value is a number, not text.
//   Later    writes note.txt 800 ms after the press, and shows nothing.
//   Export   writes the title to note.txt in the folder given as the first argument, then says so.
//   Fake     says "Exported" and writes nothing.
//   Quit     ends the application 100 ms after the press, as a crash does.
//   SaveAs   opens the save panel of the system, in the folder given as the first argument, and
//            writes the title to the file the person names there.
//   Pad      says which gesture of the real pointer it got: click, double, right, hover, dragged.
//   Clock    a count that goes up every 400 ms with no action. Only with a second argument `clock`.
// The window floats and the application never takes the keyboard, so a run does not disturb the
// person at the machine.
import AppKit

final class Cover: NSView {
  // Its own bounds, and not the rectangle it is given: a view does not cut what it draws to its
  // bounds on a new macOS, and the rectangle can be much of the window. This view then painted
  // over the controls beside it, and a person saw half of the window empty.
  override func draw(_ dirtyRect: NSRect) {
    NSColor.windowBackgroundColor.setFill()
    bounds.fill()
  }
  override func mouseDown(with event: NSEvent) {}
}

/// A view that says which gesture of the pointer it got. Only the real pointer reaches it.
final class Pad: NSView {
  var say: (String) -> Void = { _ in }
  var downAt: NSPoint?
  override func draw(_ dirtyRect: NSRect) {
    NSColor.controlAccentColor.withAlphaComponent(0.25).setFill()
    bounds.fill()
  }
  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(
      NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self))
  }
  override func mouseEntered(with event: NSEvent) { say("Pad: hover") }
  override func mouseDown(with event: NSEvent) {
    downAt = event.locationInWindow
    say(event.clickCount >= 2 ? "Pad: double" : "Pad: click")
  }
  override func mouseUp(with event: NSEvent) {
    guard let from = downAt else { return }
    let dx = Int((event.locationInWindow.x - from.x).rounded())
    if abs(dx) > 5 { say("Pad: dragged \(dx)") }
  }
  override func rightMouseDown(with event: NSEvent) { say("Pad: right") }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class Fixture: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate,
  NSBrowserDelegate
{
  let items = ["Alpha", "Beta", "Gamma"]
  let table = NSTableView()

  func numberOfRows(in tableView: NSTableView) -> Int { items.count }
  func tableView(_ tableView: NSTableView, viewFor column: NSTableColumn?, row: Int) -> NSView? {
    NSTextField(labelWithString: items[row])
  }
  func tableViewSelectionDidChange(_ notification: Notification) {
    if table.selectedRow >= 0 { status.stringValue = "Chosen: \(items[table.selectedRow])" }
  }

  var window: NSWindow!
  let field = NSTextField(frame: NSRect(x: 20, y: 170, width: 320, height: 24))
  let status = NSTextField(labelWithString: "Ready")

  func button(_ title: String, _ x: CGFloat, _ action: Selector?, y: CGFloat = 110) -> NSButton {
    let b = NSButton(title: title, target: self, action: action)
    b.frame = NSRect(x: x, y: y, width: 80, height: 32)
    window.contentView!.addSubview(b)
    return b
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 80, y: 80, width: 450, height: 320),
      // A window a person can resize and make small, for windowcheck.mjs. The other checks keep
      // the plain window that they were written for.
      styleMask: ProcessInfo.processInfo.environment["RETICLE_FIXTURE_RESIZABLE"] == nil
        ? [.titled] : [.titled, .resizable, .miniaturizable],
      backing: .buffered, defer: false)
    window.title = "Reticle Fixture"
    window.level = .floating
    // On every Space and over a full-screen application: the person at the machine can change
    // Space while a check runs, and a window left on another Space is one nobody can click.
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    field.setAccessibilityLabel("Title")
    field.target = self
    field.action = #selector(entered)
    status.frame = NSRect(x: 20, y: 60, width: 320, height: 24)
    status.setAccessibilityIdentifier("status")
    window.contentView!.addSubview(field)
    window.contentView!.addSubview(status)
    button("Save", 20, #selector(save)).toolTip = "Saves the title"
    _ = button("Slow", 100, #selector(slow))
    _ = button("Dead", 180, nil)
    let covered = button("Covered", 260, #selector(save))
    window.contentView!.addSubview(Cover(frame: covered.frame))
    let slider = NSSlider(value: 0, minValue: 0, maxValue: 1, target: nil, action: nil)
    slider.frame = NSRect(x: 190, y: 24, width: 150, height: 24)
    slider.setAccessibilityLabel("Volume")
    window.contentView!.addSubview(slider)
    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("Item"))
    column.title = "Item"
    column.width = 300
    table.addTableColumn(column)
    table.dataSource = self
    table.delegate = self
    table.setAccessibilityLabel("Items")
    let scroll = NSScrollView(frame: NSRect(x: 20, y: 210, width: 320, height: 96))
    scroll.documentView = table
    window.contentView!.addSubview(scroll)
    let actions = NSPopUpButton(frame: NSRect(x: 20, y: 140, width: 110, height: 26), pullsDown: true)
    actions.addItems(withTitles: ["Actions", "Mark done", "Mark open"])
    actions.item(at: 1)?.target = self
    actions.item(at: 1)?.action = #selector(markDone)
    actions.setAccessibilityLabel("Actions")
    window.contentView!.addSubview(actions)
    _ = button("Steps", 140, #selector(steps), y: 138)
    _ = button("Later", 230, #selector(later), y: 138)
    _ = button("Copy", 350, #selector(copyTitle), y: 110)
    let remember = NSButton(checkboxWithTitle: "Remember", target: self, action: #selector(remember))
    remember.frame = NSRect(x: 190, y: 52, width: 150, height: 20)
    window.contentView!.addSubview(remember)
    _ = button("Export", 20, #selector(export), y: 20)
    _ = button("Fake", 100, #selector(fake), y: 20)
    _ = button("Quit", 350, #selector(quit), y: 20)
    _ = button("SaveAs", 350, #selector(saveAs), y: 60)
    let pad = Pad(frame: NSRect(x: 350, y: 150, width: 90, height: 50))
    pad.setAccessibilityElement(true)
    pad.setAccessibilityRole(.button)
    pad.setAccessibilityLabel("Pad")
    pad.say = { [weak self] words in self?.status.stringValue = words }
    window.contentView!.addSubview(pad)
    if CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "clock" {
      // In a group of its own: the realm learns the PLACE that changes, and the place of a
      // label that lies in the window is the whole window.
      let box = NSView(frame: NSRect(x: 350, y: 60, width: 90, height: 24))
      box.setAccessibilityElement(true)
      box.setAccessibilityRole(.group)
      box.setAccessibilityLabel("Clock")
      let tick = NSTextField(labelWithString: "Tick 0")
      tick.frame = box.bounds
      box.addSubview(tick)
      window.contentView!.addSubview(box)
      var count = 0
      Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
        count += 1
        tick.stringValue = "Tick \(count)"
      }
    }
    window.orderFrontRegardless()
    if ProcessInfo.processInfo.environment["RETICLE_FIXTURE_COLUMNS"] != nil { showColumns() }
  }

  /// A column view of 500 files, as Finder shows a folder, for columncheck.mjs.
  var columns: NSWindow?
  func showColumns() {
    let shown = NSWindow(
      contentRect: NSRect(x: 560, y: 80, width: 420, height: 260), styleMask: [.titled],
      backing: .buffered, defer: false)
    shown.title = "Columns"
    shown.level = .floating
    let browser = NSBrowser(frame: NSRect(x: 0, y: 0, width: 420, height: 260))
    browser.delegate = self
    browser.target = self
    browser.action = #selector(picked)
    shown.contentView!.addSubview(browser)
    shown.orderFrontRegardless()
    columns = shown
  }
  @objc func picked(_ sender: NSBrowser) {
    status.stringValue = "Picked: \((sender.selectedCell() as? NSCell)?.stringValue ?? "")"
  }
  func browser(_ sender: NSBrowser, numberOfChildrenOfItem item: Any?) -> Int {
    item == nil ? 500 : 0
  }
  func browser(_ sender: NSBrowser, child index: Int, ofItem item: Any?) -> Any { "File \(index)" }
  func browser(_ sender: NSBrowser, isLeafItem item: Any?) -> Bool { item != nil }
  func browser(_ sender: NSBrowser, objectValueForItem item: Any?) -> Any? { item }

  @objc func saveAs() {
    let panel = NSSavePanel()
    let folder = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory()
    panel.directoryURL = URL(fileURLWithPath: folder)
    panel.nameFieldStringValue = "untitled.txt"
    panel.beginSheetModal(for: window) { answer in
      guard answer == .OK, let url = panel.url else {
        self.status.stringValue = "Not saved"
        return
      }
      try? self.field.stringValue.write(to: url, atomically: true, encoding: .utf8)
      self.status.stringValue = "Saved as \(url.lastPathComponent)"
    }
  }
  @objc func quit() { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) } }
  @objc func save() { status.stringValue = "Saved: \(field.stringValue)" }
  @objc func export() {
    let folder = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory()
    try? field.stringValue.write(toFile: folder + "/note.txt", atomically: true, encoding: .utf8)
    status.stringValue = "Exported"
  }
  @objc func entered() { status.stringValue = "Entered: \(field.stringValue)" }
  @objc func markDone() { status.stringValue = "Marked done" }
  @objc func steps() {
    status.stringValue = "Working"
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.status.stringValue = "Steps done" }
  }
  @objc func later() {
    let folder = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory()
    let text = field.stringValue
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      try? text.write(toFile: folder + "/note.txt", atomically: true, encoding: .utf8)
    }
  }
  @objc func remember(_ sender: NSButton) {
    UserDefaults.standard.set(sender.state == .on, forKey: "remember")
  }
  /// Puts the title on the clipboard, and shows nothing. A check names its own clipboard in the
  /// environment, so that the clipboard of the person at the machine is not written over.
  @objc func copyTitle() {
    let name = ProcessInfo.processInfo.environment["RETICLE_AX_PASTEBOARD"] ?? ""
    let board = name.isEmpty ? NSPasteboard.general : NSPasteboard(name: NSPasteboard.Name(name))
    board.clearContents()
    board.setString(field.stringValue, forType: .string)
  }
  @objc func fake() { status.stringValue = "Exported" }
  @objc func slow() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.status.stringValue = "Slow done" }
  }
}

let app = NSApplication.shared
let delegate = Fixture()
app.delegate = delegate
// With RETICLE_FIXTURE_REGULAR it is an ordinary application that can come to the front and take
// the keyboard, for the check of real keys. That check takes the keyboard for a moment.
app.setActivationPolicy(
  ProcessInfo.processInfo.environment["RETICLE_FIXTURE_REGULAR"] == "1" ? .regular : .accessory)
app.run()
