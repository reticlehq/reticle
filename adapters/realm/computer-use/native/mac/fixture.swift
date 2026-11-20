// A small application for the computer-use realm to drive. Each control is one case:
//   Save     changes the status text at once.
//   Slow     changes the status text after 400 ms.
//   Dead     does nothing.
//   Steps    changes the status text at once, and again 300 ms later.
//   Covered  works, but a view lies over it, so a person cannot click it.
//   Title    a text field. The Return key in it changes the status text.
//   Items    a table of three rows. To choose a row changes the status text.
//   Actions  a menu. Its items are not on the screen until it is open.
//   Remember a checkbox. It changes one setting of the application, and nothing on the screen but itself.
//   Volume   a slider. Its value is a number, not text.
//   Later    writes note.txt 800 ms after the press, and shows nothing.
//   Export   writes the title to note.txt in the folder given as the first argument, then says so.
//   Fake     says "Exported" and writes nothing.
// The window floats and the application never takes the keyboard, so a run does not disturb the
// person at the machine.
import AppKit

final class Cover: NSView {
  override func draw(_ dirtyRect: NSRect) {
    NSColor.windowBackgroundColor.setFill()
    dirtyRect.fill()
  }
  override func mouseDown(with event: NSEvent) {}
}

final class Fixture: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate {
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
      contentRect: NSRect(x: 80, y: 80, width: 360, height: 320), styleMask: [.titled],
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
    _ = button("Save", 20, #selector(save))
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
    let remember = NSButton(checkboxWithTitle: "Remember", target: self, action: #selector(remember))
    remember.frame = NSRect(x: 190, y: 52, width: 150, height: 20)
    window.contentView!.addSubview(remember)
    _ = button("Export", 20, #selector(export), y: 20)
    _ = button("Fake", 100, #selector(fake), y: 20)
    window.orderFrontRegardless()
  }

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
  @objc func fake() { status.stringValue = "Exported" }
  @objc func slow() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.status.stringValue = "Slow done" }
  }
}

let app = NSApplication.shared
let delegate = Fixture()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
