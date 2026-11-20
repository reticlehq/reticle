// A small application for the computer-use realm to drive. Each control is one case:
//   Save     changes the status text at once.
//   Slow     changes the status text after 400 ms.
//   Dead     does nothing.
//   Covered  works, but a view lies over it, so a person cannot click it.
//   Title    a text field. The Return key in it changes the status text.
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

final class Fixture: NSObject, NSApplicationDelegate {
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
      contentRect: NSRect(x: 80, y: 80, width: 360, height: 220), styleMask: [.titled],
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
