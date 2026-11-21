// reticle-hud: what the person at the machine sees of the realm.
//
//   - A pointer of the realm's own: a reticle that goes to the element the realm acts on. The
//     pointer of the person does not move for an action in the background, so without this
//     nothing on the screen says where the realm is.
//   - A small window, as the HUD in a browser: the application that is joined, what the realm
//     does now, what that did, and a button to pause the realm.
//
// The program draws and reports. It never reads an application and never acts on one.
//
// One line of JSON on standard input for each thing to show:
//   {"t":"app","name":"Notes"}
//   {"t":"move","x":120,"y":300}          the middle of the element, in points from the top left
//   {"t":"act","text":"press button \"Save\""}
//   {"t":"effect","text":"2 changes","kind":"ok"}      kind: ok | none | refused
//   {"t":"hide"}                          the pointer goes away
// One line on standard output when the person presses the button: {"paused":true} or false.
// The program ends when standard input closes.
import AppKit

/// The design values, in one place. They follow the HUD in the browser.
enum Token {
  static let ground = NSColor(srgbRed: 0.043, green: 0.043, blue: 0.059, alpha: 0.94)
  static let text = NSColor(srgbRed: 0.98, green: 0.98, blue: 0.98, alpha: 1)
  static let quiet = NSColor(srgbRed: 0.98, green: 0.98, blue: 0.98, alpha: 0.6)
  static let accent = NSColor(srgbRed: 0.655, green: 0.545, blue: 0.98, alpha: 1)
  static let good = NSColor(srgbRed: 0.29, green: 0.87, blue: 0.5, alpha: 1)
  static let bad = NSColor(srgbRed: 0.97, green: 0.44, blue: 0.44, alpha: 1)
  static let line = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.12)
  static let radius: CGFloat = 14
  static let gap: CGFloat = 12
  static let small = NSFont.systemFont(ofSize: 11, weight: .medium)
  static let body = NSFont.systemFont(ofSize: 13, weight: .regular)
  static let strong = NSFont.systemFont(ofSize: 13, weight: .semibold)
  static let panel = NSSize(width: 300, height: 104)
  static let reticle: CGFloat = 44
  static let glide = 0.14
  static let pointerRest = 4.0
}

/// The reticle: a ring, four ticks and a point. A dark edge under it keeps it readable on a
/// light window.
final class ReticleView: NSView {
  var color = Token.accent { didSet { needsDisplay = true } }
  override func draw(_ dirtyRect: NSRect) {
    let middle = NSPoint(x: bounds.midX, y: bounds.midY)
    let ring: CGFloat = 12
    func strokes(_ width: CGFloat, _ paint: NSColor) {
      paint.setStroke()
      let circle = NSBezierPath(
        ovalIn: NSRect(x: middle.x - ring, y: middle.y - ring, width: ring * 2, height: ring * 2))
      circle.lineWidth = width
      circle.stroke()
      for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
        let tick = NSBezierPath()
        tick.move(to: NSPoint(x: middle.x + dx * (ring - 4), y: middle.y + dy * (ring - 4)))
        tick.line(to: NSPoint(x: middle.x + dx * (ring + 6), y: middle.y + dy * (ring + 6)))
        tick.lineWidth = width
        tick.stroke()
      }
    }
    strokes(4, NSColor.black.withAlphaComponent(0.45))
    strokes(2, color)
    color.setFill()
    NSBezierPath(ovalIn: NSRect(x: middle.x - 2, y: middle.y - 2, width: 4, height: 4)).fill()
  }
}

final class Hud: NSObject, NSApplicationDelegate {
  var pointer: NSWindow!
  let reticle = ReticleView(frame: NSRect(x: 0, y: 0, width: Token.reticle, height: Token.reticle))
  var panel: NSPanel!
  let app = NSTextField(labelWithString: "")
  let doing = NSTextField(labelWithString: "Waiting for an action")
  let effect = NSTextField(labelWithString: "")
  var pause: NSButton!
  var paused = false
  var rest: Timer?

  func label(_ field: NSTextField, _ font: NSFont, _ color: NSColor, _ frame: NSRect) {
    field.font = font
    field.textColor = color
    field.frame = frame
    field.lineBreakMode = .byTruncatingTail
    panel.contentView!.addSubview(field)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // The pointer: over every window, and a click goes through it to what is under it.
    pointer = NSWindow(
      contentRect: reticle.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    pointer.isOpaque = false
    pointer.backgroundColor = .clear
    pointer.hasShadow = false
    pointer.ignoresMouseEvents = true
    pointer.level = .screenSaver
    pointer.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    pointer.contentView = reticle
    pointer.alphaValue = 0

    // The window: it floats, it never takes the keyboard, and the person can move it.
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
    panel = NSPanel(
      contentRect: NSRect(
        x: screen.maxX - Token.panel.width - Token.gap, y: screen.minY + Token.gap,
        width: Token.panel.width, height: Token.panel.height),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.level = .floating
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .ignoresCycle, .fullScreenAuxiliary]
    let ground = NSView(frame: NSRect(origin: .zero, size: Token.panel))
    ground.wantsLayer = true
    ground.layer?.backgroundColor = Token.ground.cgColor
    ground.layer?.cornerRadius = Token.radius
    ground.layer?.borderWidth = 1
    ground.layer?.borderColor = Token.line.cgColor
    panel.contentView = ground

    let mark = ReticleView(frame: NSRect(x: Token.gap - 8, y: 64, width: 36, height: 36))
    ground.addSubview(mark)
    let name = NSTextField(labelWithString: "Reticle")
    label(name, Token.strong, Token.text, NSRect(x: 44, y: 74, width: 80, height: 18))
    label(app, Token.small, Token.quiet, NSRect(x: 104, y: 74, width: 120, height: 16))
    label(doing, Token.body, Token.text, NSRect(x: Token.gap, y: 42, width: 276, height: 18))
    label(effect, Token.small, Token.quiet, NSRect(x: Token.gap, y: 16, width: 276, height: 16))

    pause = NSButton(title: "Pause", target: self, action: #selector(togglePause))
    pause.isBordered = false
    pause.wantsLayer = true
    pause.layer?.cornerRadius = 6
    pause.layer?.borderWidth = 1
    pause.layer?.borderColor = Token.line.cgColor
    setPauseTitle("Pause")
    pause.frame = NSRect(x: Token.panel.width - 70 - Token.gap, y: 72, width: 70, height: 20)
    ground.addSubview(pause)
    panel.orderFrontRegardless()

    // One line of JSON for each thing to show. Read off the main thread; draw on it.
    Thread.detachNewThread {
      while let line = readLine() {
        guard let data = line.data(using: .utf8),
          let say = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }
        DispatchQueue.main.async { self.show(say) }
      }
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }

  /// The words of the button, in the colour of the window: a plain button was grey on the dark ground.
  func setPauseTitle(_ words: String) {
    pause.attributedTitle = NSAttributedString(
      string: words, attributes: [.foregroundColor: Token.text, .font: Token.small])
  }

  @objc func togglePause() {
    paused.toggle()
    setPauseTitle(paused ? "Resume" : "Pause")
    doing.stringValue = paused ? "Paused by you" : "Waiting for an action"
    doing.textColor = paused ? Token.bad : Token.text
    print(paused ? "{\"paused\":true}" : "{\"paused\":false}")
    fflush(stdout)
  }

  func show(_ say: [String: Any]) {
    switch say["t"] as? String {
    case "app":
      app.stringValue = say["name"] as? String ?? ""
    case "move":
      guard let x = say["x"] as? Double, let y = say["y"] as? Double else { return }
      // The realm gives points from the top left. AppKit counts from the bottom left.
      let top = NSScreen.screens.first?.frame.height ?? 0
      let to = NSPoint(x: x - Token.reticle / 2, y: top - y - Token.reticle / 2)
      reticle.color = Token.accent
      pointer.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { move in
        move.duration = pointer.alphaValue > 0 ? Token.glide : 0
        pointer.animator().setFrameOrigin(to)
        pointer.animator().alphaValue = 1
      }
      rest?.invalidate()
      rest = Timer.scheduledTimer(withTimeInterval: Token.pointerRest, repeats: false) { _ in
        self.pointer.animator().alphaValue = 0
      }
    case "act":
      guard !paused else { return }
      doing.stringValue = say["text"] as? String ?? ""
      doing.textColor = Token.text
      effect.stringValue = "…"
      effect.textColor = Token.quiet
    case "effect":
      effect.stringValue = say["text"] as? String ?? ""
      let kind = say["kind"] as? String
      let color = kind == "ok" ? Token.good : (kind == "refused" ? Token.bad : Token.quiet)
      effect.textColor = color
      reticle.color = kind == "refused" ? Token.bad : (kind == "ok" ? Token.good : Token.accent)
    case "hide":
      pointer.animator().alphaValue = 0
    default: break
    }
  }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let hud = Hud()
application.delegate = hud
application.run()
