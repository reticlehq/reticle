// reticle-hud: what the person at the machine sees of the realm.
//
//   - A pointer of the realm's own: an arrow, as a mouse has, in the colour of Reticle. It goes
//     to the element the realm acts on, and a ring spreads from its tip when the realm acts. The
//     pointer of the person does not move for an action in the background, so without this
//     nothing on the screen says where the realm is.
//   - The HUD, as in a browser: the mark with a ring in the colour of the state, the application
//     that is joined, the last actions with what each one did, and a button to pause the realm.
//
// The program draws and reports. It never reads an application and never acts on one.
//
// One line of JSON on standard input for each thing to show:
//   {"t":"app","name":"Notes"}
//   {"t":"move","x":120,"y":300}          the middle of the element, in points from the top left
//   {"t":"act","text":"press button \"Save\""}
//   {"t":"effect","text":"2 changes","kind":"ok"}      kind: ok | none | refused
//   {"t":"hide"}                          the pointer goes away
// One line on standard output when the person presses a button: {"paused":true} or false for
// the pause, and {"stopped":true} for the stop. After a stop the realm leaves the application.
// The program ends when standard input closes.
import AppKit

func hex(_ value: UInt32, _ alpha: CGFloat = 1) -> NSColor {
  NSColor(
    srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
    blue: CGFloat(value & 0xff) / 255, alpha: alpha)
}

/// The design values, in one place. They are the tokens of the HUD in the browser
/// (`presenter-design-tokens.ts`, `presenter-shell-styles.ts`): the same ground, text, brand
/// colour, state colours, radii, sizes and motion.
enum Token {
  static let ground = hex(0x0b0b0c)
  static let surface = hex(0x151417, 0.9)
  static let hover = hex(0xffffff, 0.12)
  static let border = hex(0x3a3941)
  static let text = hex(0xf5f3ef)
  static let muted = hex(0xa6a29a)
  static let faint = hex(0x8b867d)
  static let brand = hex(0xf0872e)
  static let active = hex(0x3b82f6)
  static let idle = hex(0xeab308)
  static let ended = hex(0xef4444)
  static let radiusLarge: CGFloat = 14
  static let space1: CGFloat = 4
  static let space2: CGFloat = 8
  static let space3: CGFloat = 12
  static let edge: CGFloat = 20
  static let extraSmall = NSFont.systemFont(ofSize: 11, weight: .regular)
  static let small = NSFont.systemFont(ofSize: 12, weight: .regular)
  static let base = NSFont.systemFont(ofSize: 13, weight: .semibold)
  static let dockWidth: CGFloat = 320
  static let toolbarHeight: CGFloat = 44
  static let control: CGFloat = 36
  static let rowHeight: CGFloat = 34
  static let rows = 3
  static let glide = 0.32
  static let ease = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
  static let ripple = 0.45
  static let pointerRest = 4.0
  static let pointerBox: CGFloat = 64
  /// The tip of the arrow, from the top left of its box: the ring spreads from here.
  static let tip = NSPoint(x: 20, y: 20)
}

/// The arrow of a mouse, in the colour of Reticle, with a light edge and a soft shadow. A ring
/// spreads from its tip when the realm acts, as the ripple does in a browser.
final class ArrowView: NSView {
  var ring: CGFloat = 0 { didSet { needsDisplay = true } }
  var ringColor = Token.text
  override var isFlipped: Bool { true }
  override func draw(_ dirtyRect: NSRect) {
    let tip = Token.tip
    if ring > 0 {
      let reach = 6 + ring * 18
      ringColor.withAlphaComponent(0.55 * (1 - ring)).setStroke()
      let circle = NSBezierPath(
        ovalIn: NSRect(x: tip.x - reach, y: tip.y - reach, width: reach * 2, height: reach * 2))
      circle.lineWidth = 2
      circle.stroke()
    }
    // The outline of a pointer: the tip, down the left edge, the notch, the tail, and back.
    let shape: [(CGFloat, CGFloat)] = [
      (0, 0), (0, 21), (5.6, 16), (9.4, 24.6), (13, 23), (9.2, 14.6), (16.4, 14.6),
    ]
    let arrow = NSBezierPath()
    for (index, point) in shape.enumerated() {
      let at = NSPoint(x: tip.x + point.0, y: tip.y + point.1)
      if index == 0 { arrow.move(to: at) } else { arrow.line(to: at) }
    }
    arrow.close()
    arrow.lineJoinStyle = .round
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.45)
    shadow.shadowBlurRadius = 5
    shadow.shadowOffset = NSSize(width: 0, height: -2)
    shadow.set()
    Token.brand.setFill()
    arrow.fill()
    NSGraphicsContext.restoreGraphicsState()
    Token.text.setStroke()
    arrow.lineWidth = 1.6
    arrow.stroke()
  }
}

/// A round button of the toolbar: clear, and lighter under the pointer.
final class RoundButton: NSButton {
  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(
      NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self))
  }
  override func mouseEntered(with event: NSEvent) { layer?.backgroundColor = Token.hover.cgColor }
  override func mouseExited(with event: NSEvent) { layer?.backgroundColor = NSColor.clear.cgColor }
}

final class Hud: NSObject, NSApplicationDelegate {
  var pointer: NSWindow!
  let arrow = ArrowView(
    frame: NSRect(x: 0, y: 0, width: Token.pointerBox, height: Token.pointerBox))
  var panel: NSPanel!
  let halo = NSView()
  let title = NSTextField(labelWithString: "Reticle")
  let app = NSTextField(labelWithString: "")
  var pause: RoundButton!
  var stop: RoundButton!
  var stopped = false
  var log: [(action: NSTextField, effect: NSTextField)] = []
  var lines: [(action: String, effect: String, kind: String)] = []
  var paused = false
  var rest: Timer?
  var rippling: Timer?

  /// The colour of the state: the realm acts, the realm waits or is paused, the action was refused.
  func setState(_ color: NSColor) {
    halo.layer?.borderColor = color.withAlphaComponent(0.7).cgColor
    halo.layer?.shadowColor = color.cgColor
  }

  func text(_ field: NSTextField, _ font: NSFont, _ color: NSColor, _ frame: NSRect, in view: NSView) {
    field.font = font
    field.textColor = color
    field.frame = frame
    field.lineBreakMode = .byTruncatingTail
    view.addSubview(field)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // The pointer: over every window, and a click goes through it to what is under it.
    pointer = NSWindow(
      contentRect: arrow.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    pointer.isOpaque = false
    pointer.backgroundColor = .clear
    pointer.hasShadow = false
    pointer.ignoresMouseEvents = true
    pointer.level = .screenSaver
    pointer.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    pointer.contentView = arrow
    pointer.alphaValue = 0

    // The HUD: the card of the last actions, and the toolbar under it. It floats, it never takes
    // the keyboard, and the person can move it.
    let cardHeight = CGFloat(Token.rows) * Token.rowHeight + Token.space2 * 2
    let size = NSSize(
      width: Token.dockWidth, height: cardHeight + Token.space2 + Token.toolbarHeight)
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
    panel = NSPanel(
      contentRect: NSRect(
        x: screen.maxX - size.width - Token.edge, y: screen.minY + Token.edge, width: size.width,
        height: size.height),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.level = .floating
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .ignoresCycle, .fullScreenAuxiliary]
    let root = NSView(frame: NSRect(origin: .zero, size: size))
    panel.contentView = root

    func surface(_ frame: NSRect, _ radius: CGFloat) -> NSView {
      let view = NSView(frame: frame)
      view.wantsLayer = true
      view.layer?.backgroundColor = Token.surface.cgColor
      view.layer?.cornerRadius = radius
      view.layer?.borderWidth = 1
      view.layer?.borderColor = Token.border.cgColor
      root.addSubview(view)
      return view
    }

    // The toolbar: a pill, with the mark, the name, the application and the button.
    let bar = surface(
      NSRect(x: 0, y: 0, width: size.width, height: Token.toolbarHeight), Token.toolbarHeight / 2)
    halo.frame = NSRect(x: Token.space1, y: Token.space1, width: Token.control, height: Token.control)
    halo.wantsLayer = true
    halo.layer?.cornerRadius = Token.control / 2
    halo.layer?.backgroundColor = Token.ground.cgColor
    halo.layer?.borderWidth = 1
    halo.layer?.shadowOpacity = 0.6
    halo.layer?.shadowRadius = 7
    halo.layer?.shadowOffset = .zero
    bar.addSubview(halo)
    // The mark is a file beside the source of this program: the same paths as in the browser.
    let markFile = URL(fileURLWithPath: CommandLine.arguments[0])
      .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(
        "reticle-mark.svg")
    if let image = NSImage(contentsOf: markFile) {
      let mark = NSImageView(frame: halo.bounds.insetBy(dx: 9, dy: 9))
      mark.image = image
      mark.imageScaling = .scaleProportionallyUpOrDown
      halo.addSubview(mark)
    }
    text(title, Token.base, Token.text, NSRect(x: 50, y: 13, width: 56, height: 18), in: bar)
    text(app, Token.small, Token.muted, NSRect(x: 106, y: 13, width: 122, height: 17), in: bar)
    pause = RoundButton(title: "", target: self, action: #selector(togglePause))
    pause.isBordered = false
    pause.wantsLayer = true
    pause.layer?.cornerRadius = Token.control / 2
    pause.frame = NSRect(
      x: size.width - Token.control - Token.space1, y: Token.space1, width: Token.control,
      height: Token.control)
    bar.addSubview(pause)
    setPauseSign()
    // Stop, beside the pause: it ends the work of the realm on this application.
    stop = RoundButton(title: "", target: self, action: #selector(pressStop))
    stop.isBordered = false
    stop.wantsLayer = true
    stop.layer?.cornerRadius = Token.control / 2
    stop.frame = pause.frame.offsetBy(dx: -(Token.control + Token.space1), dy: 0)
    stop.image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
      Token.text.setFill()
      NSBezierPath(roundedRect: NSRect(x: 3.5, y: 3.5, width: 9, height: 9), xRadius: 1.5, yRadius: 1.5)
        .fill()
      return true
    }
    stop.setAccessibilityLabel("Stop")
    bar.addSubview(stop)

    // The card: the last actions, the newest at the bottom, each with what it did.
    let card = surface(
      NSRect(
        x: 0, y: Token.toolbarHeight + Token.space2, width: size.width, height: cardHeight),
      Token.radiusLarge)
    for row in 0..<Token.rows {
      let y = Token.space2 + CGFloat(Token.rows - 1 - row) * Token.rowHeight
      let action = NSTextField(labelWithString: "")
      let effect = NSTextField(labelWithString: "")
      text(
        action, Token.small, Token.text,
        NSRect(x: Token.space3, y: y + 15, width: size.width - Token.space3 * 2, height: 16),
        in: card)
      text(
        effect, Token.extraSmall, Token.muted,
        NSRect(x: Token.space3, y: y + 1, width: size.width - Token.space3 * 2, height: 14),
        in: card)
      log.append((action, effect))
    }
    lines = [("Waiting for an action", "", "none")]
    redraw()
    setState(Token.idle)
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

  /// The sign on the button: two bars to pause, a triangle to go on.
  func setPauseSign() {
    let sign = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
      Token.text.setFill()
      if self.paused {
        let play = NSBezierPath()
        play.move(to: NSPoint(x: 4.5, y: 2.5))
        play.line(to: NSPoint(x: 13, y: 8))
        play.line(to: NSPoint(x: 4.5, y: 13.5))
        play.close()
        play.fill()
      } else {
        NSBezierPath(roundedRect: NSRect(x: 3.5, y: 3, width: 3.2, height: 10), xRadius: 1, yRadius: 1)
          .fill()
        NSBezierPath(roundedRect: NSRect(x: 9.3, y: 3, width: 3.2, height: 10), xRadius: 1, yRadius: 1)
          .fill()
      }
      return true
    }
    pause.image = sign
    pause.setAccessibilityLabel(paused ? "Resume" : "Pause")
  }

  func redraw() {
    let shown = Array(lines.suffix(Token.rows))
    for (row, fields) in log.enumerated() {
      let line = row < shown.count ? shown[row] : ("", "", "none")
      let newest = row == shown.count - 1
      fields.action.stringValue = line.0
      fields.action.textColor = newest ? Token.text : Token.muted
      fields.effect.stringValue = line.1
      fields.effect.textColor =
        line.2 == "refused" ? Token.ended : (line.2 == "ok" ? Token.text : Token.faint)
    }
  }

  @objc func togglePause() {
    paused.toggle()
    setPauseSign()
    lines.append((paused ? "Paused by you" : "Going on", "", "none"))
    redraw()
    setState(Token.idle)
    print(paused ? "{\"paused\":true}" : "{\"paused\":false}")
    fflush(stdout)
  }

  @objc func pressStop() {
    guard !stopped else { return }
    stopped = true
    stop.isEnabled = false
    pause.isEnabled = false
    lines.append(("Stopped by you", "Reticle left the application", "refused"))
    redraw()
    setState(Token.ended)
    pointer.animator().alphaValue = 0
    print("{\"stopped\":true}")
    fflush(stdout)
  }

  /// A ring that spreads from the tip of the pointer, once.
  func ripple(_ color: NSColor) {
    rippling?.invalidate()
    arrow.ringColor = color
    let started = Date()
    rippling = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { timer in
      let part = CGFloat(Date().timeIntervalSince(started) / Token.ripple)
      self.arrow.ring = part >= 1 ? 0 : max(part, 0.01)
      if part >= 1 { timer.invalidate() }
    }
  }

  func show(_ say: [String: Any]) {
    switch say["t"] as? String {
    case "app":
      app.stringValue = say["name"] as? String ?? ""
    case "move":
      guard let x = say["x"] as? Double, let y = say["y"] as? Double else { return }
      // The realm gives points from the top left. AppKit counts from the bottom left.
      let top = NSScreen.screens.first?.frame.height ?? 0
      let target = NSPoint(x: x, y: top - y)
      // The HUD must not lie over what the realm acts on: the realm presses only what a person
      // could press, and it would refuse a control that is under the HUD. So the HUD goes to the
      // other side of the screen when the target is under it.
      if panel.frame.insetBy(dx: -Token.space3, dy: -Token.space3).contains(target),
        let screen = NSScreen.main?.visibleFrame
      {
        let left = panel.frame.midX > screen.midX
        panel.setFrameOrigin(
          NSPoint(
            x: left ? screen.minX + Token.edge : screen.maxX - panel.frame.width - Token.edge,
            y: panel.frame.origin.y))
      }
      // The tip of the arrow goes to the target.
      let to = NSPoint(x: target.x - Token.tip.x, y: target.y - (Token.pointerBox - Token.tip.y))
      pointer.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { move in
        move.duration = pointer.alphaValue > 0 ? Token.glide : 0
        move.timingFunction = Token.ease
        pointer.animator().setFrameOrigin(to)
        pointer.animator().alphaValue = 1
      }
      rest?.invalidate()
      rest = Timer.scheduledTimer(withTimeInterval: Token.pointerRest, repeats: false) { _ in
        self.pointer.animator().alphaValue = 0
      }
    case "act":
      guard !paused, !stopped else { return }
      lines.append((say["text"] as? String ?? "", "…", "none"))
      redraw()
      setState(Token.active)
      ripple(Token.text)
    case "effect":
      guard !lines.isEmpty else { return }
      let kind = say["kind"] as? String ?? "none"
      lines[lines.count - 1].effect = say["text"] as? String ?? ""
      lines[lines.count - 1].kind = kind
      redraw()
      setState(kind == "refused" ? Token.ended : Token.idle)
      if kind == "refused" { ripple(Token.ended) }
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
