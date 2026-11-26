// Boxes: an application with no accessibility tree under its window, for cu-bench.mjs. It draws
// three boxes, A, B and C, in an order that changes each run, as pixels only: a canvas, as a game
// or a remote desktop has. A click on a box writes its letter to clicked.txt in the folder given as
// the first argument.
//
//   swiftc -O bench/computer/boxes.swift -o /tmp/boxes && /tmp/boxes <folder>
import AppKit

let folder = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory()
let letters = ["A", "B", "C"].shuffled()

final class Canvas: NSView {
  override var isFlipped: Bool { true }
  func box(_ i: Int) -> NSRect { NSRect(x: 40 + i * 140, y: 60, width: 100, height: 100) }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.white.setFill()
    bounds.fill()
    for (i, letter) in letters.enumerated() {
      NSColor.systemTeal.setFill()
      NSBezierPath(roundedRect: box(i), xRadius: 8, yRadius: 8).fill()
      let words = NSAttributedString(
        string: letter,
        attributes: [.font: NSFont.boldSystemFont(ofSize: 40), .foregroundColor: NSColor.white])
      words.draw(at: NSPoint(x: box(i).midX - 13, y: box(i).midY - 24))
    }
  }

  override func mouseDown(with event: NSEvent) {
    let at = convert(event.locationInWindow, from: nil)
    for (i, letter) in letters.enumerated() where box(i).contains(at) {
      try? letter.write(toFile: folder + "/clicked.txt", atomically: true, encoding: .utf8)
    }
  }

  // Nothing of it is an element: only pixels.
  override func isAccessibilityElement() -> Bool { false }
  override func accessibilityChildren() -> [Any]? { [] }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(
  contentRect: NSRect(x: 200, y: 300, width: 480, height: 220),
  styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Boxes"
window.contentView = Canvas()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
